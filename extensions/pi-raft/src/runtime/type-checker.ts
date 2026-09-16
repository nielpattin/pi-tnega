import path from "node:path";
import ts from "typescript";

export interface RaftTypeError {
  line: number;
  column: number;
  message: string;
}

export interface RaftTypeCheckResult {
  errors: RaftTypeError[];
  javascript?: string;
  sourceMap?: string;
}

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: false,
  noImplicitAny: false,
  strictNullChecks: false,
  strictFunctionTypes: false,
  strictBindCallApply: false,
  alwaysStrict: false,
  strictPropertyInitialization: false,
  noImplicitThis: false,
  useUnknownInCatchVariables: false,
  noEmit: false,
  sourceMap: true,
  skipLibCheck: true,
  lib: ["lib.es2022.d.ts"],
};

// Structural mistakes always surface. Type-correctness codes stay suppressed
// for the approximated `Pi*` core-tool surfaces, where they would fire on calls
// the runtime accepts; Raft's own `Raft*Args` types are generated from the
// same schemas the registry validates, so a mismatch there cannot dispatch.
const TYPE_CORRECTNESS_CODES = new Set<number>([
  2339, 2551, 2322, 2345, 2367, 2531, 2532, 18047, 18048, 7006, 7008, 7019, 7031, 7032, 7033, 7034,
]);

// Assignability and property errors stay suppressed for the approximated core-tool
// types, but are reported when the call is declared with one of Raft's own action
// argument types: those are generated from the schemas the registry validates, so a
// mismatch there is a call that cannot dispatch.
const EXACT_ARGUMENT_CODES = new Set<number>([2322, 2345, 2339]);

// "Object literal may only specify known properties, and 'x' does not exist in type 'T'."
const EXCESS_PROPERTY_CODE = 2353;

const EXACT_RAFT_ARGUMENT_TYPE_PATTERN = /Raft[A-Z]\w*Args/;

const deepestNodeAt = (source: ts.SourceFile, position: number): ts.Node => {
  let deepest: ts.Node = source;
  const visit = (node: ts.Node): void => {
    if (position < node.getStart(source) || position >= node.getEnd()) return;
    deepest = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return deepest;
};

const declaresExactRaftArgument = (declaration: unknown): boolean => {
  const parameter = (declaration as { parameters?: readonly { type?: ts.TypeNode }[] } | undefined)
    ?.parameters?.[0];
  const typeNode = parameter?.type;
  return typeNode !== undefined && EXACT_RAFT_ARGUMENT_TYPE_PATTERN.test(typeNode.getText());
};

let nextCheckerId = 0;

export const normalizeTypeScriptPath = (fileName: string): string => fileName.replaceAll("\\", "/");

/** Guest programs execute inside this wrapper; user code starts on wrapped line 2. */
const wrapRaftGuestCode = (code: string): string => `async function __piRaftMain() {\n${code}\n}\n`;

class RaftTypeChecker {
  readonly #guestFile: string;
  readonly #declarationFile: string;
  readonly #baseHost = ts.createCompilerHost(compilerOptions, true);
  readonly #stableFiles = new Map<string, ts.SourceFile>();
  readonly #declarationSource: ts.SourceFile;
  readonly #host: ts.CompilerHost;
  #sourceText = "";
  #sourceFile: ts.SourceFile;
  #program: ts.Program | undefined;

  constructor(readonly declarations: string) {
    const id = ++nextCheckerId;
    this.#guestFile = normalizeTypeScriptPath(path.resolve(`/__pi_raft_guest_${id}.ts`));
    this.#declarationFile = normalizeTypeScriptPath(path.resolve(`/__pi_raft_globals_${id}.d.ts`));
    this.#sourceFile = ts.createSourceFile(this.#guestFile, "", ts.ScriptTarget.ES2022, true);
    this.#declarationSource = ts.createSourceFile(
      this.#declarationFile,
      declarations,
      ts.ScriptTarget.ES2022,
      true,
    );
    const isGuestFile = (fileName: string): boolean =>
      this.#baseHost.getCanonicalFileName(normalizeTypeScriptPath(fileName)) ===
      this.#baseHost.getCanonicalFileName(this.#guestFile);
    const isDeclarationFile = (fileName: string): boolean =>
      this.#baseHost.getCanonicalFileName(normalizeTypeScriptPath(fileName)) ===
      this.#baseHost.getCanonicalFileName(this.#declarationFile);
    this.#host = {
      ...this.#baseHost,
      fileExists: (fileName) =>
        isGuestFile(fileName) || isDeclarationFile(fileName) || this.#baseHost.fileExists(fileName),
      readFile: (fileName) => {
        if (isGuestFile(fileName)) return this.#sourceText;
        if (isDeclarationFile(fileName)) return this.declarations;
        return this.#baseHost.readFile(fileName);
      },
      getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
        if (isGuestFile(fileName)) return this.#sourceFile;
        if (isDeclarationFile(fileName)) return this.#declarationSource;
        const cached = this.#stableFiles.get(fileName);
        if (cached) return cached;
        const source = this.#baseHost.getSourceFile(
          fileName,
          languageVersion,
          onError,
          shouldCreateNewSourceFile,
        );
        if (source) this.#stableFiles.set(fileName, source);
        return source;
      },
    };
  }

  /** Declared argument type of the call a diagnostic sits in, when it is a Raft arg type. */
  #declaredArgumentTypeNode(
    diagnostic: ts.Diagnostic,
    program: ts.Program,
  ): ts.TypeNode | undefined {
    if (diagnostic.start === undefined) return undefined;
    const call = ts.findAncestor(
      deepestNodeAt(this.#sourceFile, diagnostic.start),
      ts.isCallExpression,
    );
    if (call === undefined) return undefined;
    const declaration = program.getTypeChecker().getResolvedSignature(call)?.declaration;
    const parameter = (
      declaration as { parameters?: readonly { type?: ts.TypeNode }[] } | undefined
    )?.parameters?.[0];
    const typeNode = parameter?.type;
    return typeNode !== undefined && declaresExactRaftArgument({ parameters: [parameter] })
      ? typeNode
      : undefined;
  }

  #reportsExactArgumentDiagnostic(diagnostic: ts.Diagnostic, program: ts.Program): boolean {
    if (!EXACT_ARGUMENT_CODES.has(diagnostic.code)) return false;
    return this.#declaredArgumentTypeNode(diagnostic, program) !== undefined;
  }

  // TypeScript reports an excess object-literal property without naming the accepted
  // ones, so a caller that guesses a field learns only what is wrong. Raft's argument
  // types are generated from the same schemas the registry validates, so the declared
  // properties are exactly the accepted keys and belong in the message.
  #acceptedArgumentProperties(
    diagnostic: ts.Diagnostic,
    program: ts.Program,
  ): readonly string[] | undefined {
    if (diagnostic.code !== EXCESS_PROPERTY_CODE) return undefined;
    const typeNode = this.#declaredArgumentTypeNode(diagnostic, program);
    if (typeNode === undefined) return undefined;
    const names = program
      .getTypeChecker()
      .getTypeAtLocation(typeNode)
      .getProperties()
      .map((property) => property.getName());
    return names.length > 0 ? names : undefined;
  }

  check(code: string): RaftTypeCheckResult {
    this.#sourceText = wrapRaftGuestCode(code);
    this.#sourceFile = ts.createSourceFile(
      this.#guestFile,
      this.#sourceText,
      ts.ScriptTarget.ES2022,
      true,
    );
    const program = ts.createProgram({
      rootNames: [this.#declarationFile, this.#guestFile],
      options: compilerOptions,
      host: this.#host,
      ...(this.#program ? { oldProgram: this.#program } : {}),
    });
    this.#program = program;
    const diagnostics = [
      ...program.getSyntacticDiagnostics(this.#sourceFile),
      ...program
        .getSemanticDiagnostics(this.#sourceFile)
        .filter(
          (diagnostic) =>
            !TYPE_CORRECTNESS_CODES.has(diagnostic.code) ||
            this.#reportsExactArgumentDiagnostic(diagnostic, program),
        ),
    ];
    const errors = diagnostics.map((diagnostic) => {
      const accepted = this.#acceptedArgumentProperties(diagnostic, program);
      const message =
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n") +
        (accepted ? ` Accepted properties: ${accepted.join(", ")}.` : "");
      if (!diagnostic.file || diagnostic.start === undefined) {
        return { line: 0, column: 0, message };
      }
      const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      return { line: Math.max(1, position.line), column: position.character + 1, message };
    });
    if (errors.length > 0) return { errors };

    let javascript: string | undefined;
    let sourceMap: string | undefined;
    program.emit(this.#sourceFile, (fileName, content) => {
      if (fileName.endsWith(".js.map")) sourceMap = content;
      else if (fileName.endsWith(".js")) javascript = content;
    });
    return { errors, ...(javascript ? { javascript } : {}), ...(sourceMap ? { sourceMap } : {}) };
  }
}

const checkerCache = new Map<string, RaftTypeChecker>();
const MAX_CHECKERS = 4;

const checkerFor = (declarations: string): RaftTypeChecker => {
  const cached = checkerCache.get(declarations);
  if (cached) {
    checkerCache.delete(declarations);
    checkerCache.set(declarations, cached);
    return cached;
  }
  const checker = new RaftTypeChecker(declarations);
  checkerCache.set(declarations, checker);
  while (checkerCache.size > MAX_CHECKERS) {
    const oldest = checkerCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    checkerCache.delete(oldest);
  }
  return checker;
};

export interface RaftTranspileResult {
  code: string;
  sourceMap?: string;
}

export const transpileRaftCodeWithSourceMap = (code: string): RaftTranspileResult => {
  const result = ts.transpileModule(wrapRaftGuestCode(code), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      sourceMap: true,
    },
  });
  return {
    code: result.outputText,
    ...(result.sourceMapText ? { sourceMap: result.sourceMapText } : {}),
  };
};

export const typeCheckRaftCode = (code: string, declarations: string): RaftTypeCheckResult =>
  checkerFor(declarations).check(code);

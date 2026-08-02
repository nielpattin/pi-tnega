import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
   renderCallGraphCall,
   renderCallGraphResult,
   renderSearchCall,
   renderSearchResult,
   renderSymbolCall,
   renderSymbolResult,
   renderAstGrepCall,
   renderAstGrepResult,
   renderAstReplaceCall,
   renderAstReplaceResult,
   renderOutlineCall,
   renderOutlineResult
} from "./tui.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import type { KeybindingsConfig } from "@earendil-works/pi-tui";

function lines(component: { render(width: number): string[] }): string {
   return component.render(240).join("\n");
}

const collapsed = { expanded: false, isPartial: false };
const expanded = { expanded: true, isPartial: false };

function result(value: unknown) {
   return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: undefined };
}

const previousKeybindings = getKeybindings();

function makeKeybindings(userBindings: Record<string, string | string[] | undefined> = {}) {
   return new KeybindingsManager(
      {
         ...TUI_KEYBINDINGS,
         "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" }
      },
      userBindings as KeybindingsConfig
   );
}

describe("tool result TUI rendering", () => {
   beforeAll(() => setKeybindings(makeKeybindings()));
   afterAll(() => setKeybindings(previousKeybindings));
   it("collapses code search to a summary and expands to show snippets", () => {
      const value = {
         query: "login",
         elapsed: 0.125,
         hits: [
            { path: "src/auth.ts", startLine: 1, endLine: 3, score: 0.9, snippet: "function login() {}" },
            { path: "src/session.ts", startLine: 8, endLine: 10, score: 0.8, snippet: "function createSession() {}" }
         ]
      };

      const collapsedLines = lines(renderSearchResult(result(value), collapsed));
      expect(collapsedLines).toContain("2 hits took 125ms");
      expect(collapsedLines).not.toContain("[1]");
      expect(collapsedLines).not.toContain("src/auth.ts");
      expect(collapsedLines).not.toContain("function login() {}");
      expect(collapsedLines).not.toContain("function createSession() {}");
      expect(collapsedLines.split("\n")).toHaveLength(1);

      const expandedLines = lines(renderSearchResult(result(value), expanded));
      expect(expandedLines).toContain("function login() {}");
      expect(expandedLines).toContain("function createSession() {}");
      expect(lines(renderSearchResult(result(value), { expanded: false, isPartial: true }))).toContain("Searching...");
   });

   it("collapses symbol search to a summary and expands to show declarations", () => {
      const value = {
         symbol: "login",
         elapsed: 0.002,
         hits: [
            { symbol: "login", path: "src/auth.ts", startLine: 1, endLine: 3, snippet: "function login() {}" },
            { symbol: "createSession", path: "src/session.ts", startLine: 8, endLine: 10, snippet: "function createSession() {}" }
         ]
      };

      const collapsedLines = lines(renderSymbolResult(result(value), collapsed));
      expect(collapsedLines).toContain("2 hits took 2ms");
      expect(collapsedLines).not.toContain("[1]");
      expect(collapsedLines).not.toContain("src/auth.ts");
      expect(collapsedLines).not.toContain("function login() {}");
      expect(collapsedLines).not.toContain("function createSession() {}");
      expect(collapsedLines.split("\n")).toHaveLength(1);

      const expandedLines = lines(renderSymbolResult(result(value), expanded));
      expect(expandedLines).toContain("function login() {}");
      expect(expandedLines).toContain("function createSession() {}");
      expect(lines(renderSymbolResult(result(value), { expanded: false, isPartial: true }))).toContain("Searching...");
   });

   it("collapses outline results to a summary and expands to show symbol rows", () => {
      const plainTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown as Theme;
      const value = {
         path: "src/data.ts",
         files: 1,
         truncated: false,
         elapsed: 0.004,
         symbols: [
            { symbol: "User", kind: "interface", path: "src/data.ts", startLine: 1, endLine: 3 },
            { symbol: "DEFAULT_CONFIG", kind: "variable", path: "src/data.ts", startLine: 10, endLine: 10 }
         ]
      };

      const collapsedLines = lines(renderOutlineResult(result(value), collapsed));
      expect(collapsedLines).toContain("2 symbols took 4ms");
      expect(collapsedLines).not.toContain("[1]");
      expect(collapsedLines.split("\n")).toHaveLength(1);

      const expandedLines = lines(renderOutlineResult(result(value), expanded));
      expect(expandedLines).toContain("interface User");
      expect(expandedLines).toContain("variable DEFAULT_CONFIG");
      expect(expandedLines).toContain("src/data.ts:1-3");

      const call = lines(renderOutlineCall({ path: "src/data.ts" }, plainTheme));
      expect(call).toContain("code_outline");
      expect(call).toContain('"src/data.ts"');
   });

   it("shows the kind filter on symbol search calls", () => {
      const plainTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown as Theme;
      const call = lines(renderSymbolCall({ symbol: "Handler", kind: "class" }, plainTheme));
      expect(call).toContain("code_symbol_search Handler kind=class");
   });

   it("collapses call graph results to a summary and expands to show edges", () => {
      const value = {
         symbol: "login",
         direction: "callees",
         elapsed: 1.2,
         edges: [
            { callerSymbol: "login", calleeSymbol: "validate", callerPath: "src/auth.ts", calleePath: "src/auth.ts" },
            { callerSymbol: "login", calleeSymbol: "logSession", callerPath: "src/auth.ts", calleePath: "src/auth.ts" }
         ]
      };

      const collapsedLines = lines(renderCallGraphResult(result(value), collapsed));
      expect(collapsedLines).toContain("2 edges took 1.2s");
      expect(collapsedLines).not.toContain("[1]");
      expect(collapsedLines).not.toContain("login → validate");
      expect(collapsedLines).not.toContain("src/auth.ts → src/auth.ts");
      expect(collapsedLines).not.toContain("login → logSession");
      expect(collapsedLines.split("\n")).toHaveLength(1);

      const expandedLines = lines(renderCallGraphResult(result(value), expanded));
      expect(expandedLines).toContain("login → validate");
      expect(expandedLines).toContain("login → logSession");
      expect(expandedLines).toContain("src/auth.ts → src/auth.ts");
      expect(lines(renderCallGraphResult(result(value), { expanded: false, isPartial: true }))).toContain("Tracing...");
   });

   it("shows the page indicator when results span multiple pages", () => {
      const plainTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown as Theme;
      const value = {
         query: "login",
         elapsed: 0.05,
         total: 25,
         page: 2,
         pageSize: 10,
         totalPages: 3,
         hits: Array.from({ length: 10 }, (_, i) => ({
            path: `src/f${i}.ts`,
            startLine: 1,
            endLine: 3,
            score: 0.9,
            snippet: "x"
         }))
      };
      const collapsedLines = lines(renderSearchResult(result(value), collapsed));
      expect(collapsedLines).toContain("10 hits took 50ms page 2/3");
      expect(collapsedLines.split("\n")).toHaveLength(1);

      const pagedCall = lines(renderSearchCall({ query: "login", page: 2 }, plainTheme));
      expect(pagedCall).toContain("code_search \"login\" page=2");
   });

   it("uses distinct semantic colors and Pi's expand hint", () => {
      const colors = {
         toolTitle: "TITLE",
         accent: "ACCENT",
         success: "SUCCESS",
         warning: "WARNING",
         dim: "DIM",
         toolOutput: "OUTPUT",
         muted: "MUTED"
      };
      const theme = {
         fg: (color: keyof typeof colors, text: string) => `<${colors[color]}>${text}</${colors[color]}>`,
         bold: (text: string) => `<BOLD>${text}</BOLD>`
      } as unknown as Theme;

      const call = lines(renderSearchCall({ query: "login", topK: 5, path: "src" }, theme));
      expect(call).toContain("<TITLE><BOLD>code_search</BOLD></TITLE>");
      expect(call).toContain("<ACCENT>\"login\"</ACCENT>");
      expect(call).toContain("<DIM>path=src</DIM>");

      const output = lines(
         renderSearchResult(
            result({
               query: "login",
               elapsed: 0.125,
               hits: [{ path: "src/auth.ts", startLine: 1, endLine: 3, score: 0.9, snippet: "function login() {}" }]
            }),
            expanded,
            theme
         )
      );
      expect(output).toContain("<SUCCESS>1 hit</SUCCESS>");
      expect(output).toContain("<OUTPUT>function login() {}</OUTPUT>");
      expect(output).toContain("(<DIM>ctrl+o</DIM><MUTED> to collapse</MUTED>)");

      const symbolCall = lines(renderSymbolCall({ symbol: "login" }, theme));
      expect(symbolCall).toContain("<TITLE><BOLD>code_symbol_search</BOLD></TITLE>");
      expect(symbolCall).toContain("<ACCENT>login</ACCENT>");

      const graphCall = lines(renderCallGraphCall({ symbol: "login", direction: "callers" }, theme));
      expect(graphCall).toContain("<TITLE><BOLD>code_call_graph</BOLD></TITLE>");
      expect(graphCall).toContain("<ACCENT>login</ACCENT>");
   });

   it("renders the exact AgentToolResult content shape used by Pi", () => {
      const toolResult = {
         content: [
            {
               type: "text" as const,
               text: JSON.stringify({
                  query: "validateCredentials",
                  elapsed: 0.01,
                  hits: [{ path: "src/auth.ts", startLine: 5, endLine: 7, score: 0.99, snippet: "return validateCredentials();" }]
               })
            }
         ],
         details: undefined,
         isError: false
      };

      expect(lines(renderSearchResult(toolResult, expanded))).toContain("return validateCredentials();");
   });

   it("parses content JSON even when Pi fills details with an empty object (error path)", () => {
      const toolResult = {
         content: [
            {
               type: "text" as const,
               text: JSON.stringify({ symbol: "runTool", direction: "callers", elapsed: 0.002, edges: [] })
            }
         ],
         details: {},
         isError: false
      };
      const out = lines(renderCallGraphResult(toolResult, collapsed));
      expect(out).toContain("0 edges took 2ms");
   });

   it("surfaces the tool error instead of faking an empty result", () => {
      const errResult = {
         content: [
            {
               type: "text" as const,
               text: 'The "to" argument must be of type string. Received undefined'
            }
         ],
         details: {},
         isError: true
      };

      const graphOut = lines(renderCallGraphResult(errResult, collapsed, undefined, { isError: true }));
      expect(graphOut).toContain('The "to" argument must be of type string');
      expect(graphOut).not.toContain("0 edges");

      const searchOut = lines(renderSearchResult(errResult, collapsed, undefined, { isError: true }));
      expect(searchOut).toContain('The "to" argument must be of type string');
      expect(searchOut).not.toContain("0 hits");

      const symbolOut = lines(renderSymbolResult(errResult, collapsed, undefined, { isError: true }));
      expect(symbolOut).toContain('The "to" argument must be of type string');
   });

   it("renders ast_grep calls and results in the same single-Text pattern", () => {
      const plainTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown as Theme;
      const call = lines(renderAstGrepCall({ pattern: "console.log", lang: "ts", topK: 20 }, plainTheme));
      expect(call).toContain("code_ast_grep");
      expect(call).toContain('"console.log"');
      expect(call).toContain("lang=ts");

      const value = {
         pattern: "console.log",
         lang: "ts",
         elapsed: 0.04,
         matches: [
            { path: "src/a.ts", start_line: 10, end_line: 10, snippet: "console.log(\"hi\");" },
            { path: "src/b.ts", start_line: 3, end_line: 3, snippet: "console.log(\"bye\");" }
         ]
      };
      const collapsedLines = lines(renderAstGrepResult(result(value), collapsed));
      expect(collapsedLines).toContain("2 hits took 40ms");
      expect(collapsedLines).not.toContain("[1]");
      expect(collapsedLines).not.toContain("src/a.ts");
      expect(collapsedLines).not.toContain("src/b.ts");
      expect(collapsedLines.split("\n")).toHaveLength(1);

      const expandedLines = lines(renderAstGrepResult(result(value), expanded));
      expect(expandedLines).toContain("src/b.ts");
      expect(lines(renderAstGrepResult(result(value), { expanded: false, isPartial: true }))).toContain("Searching...");
   });

   it("renders ast_replace results with counts and per-file stats only", () => {
      const plainTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown as Theme;
      const call = lines(renderAstReplaceCall({ pattern: "console.log", rewrite: "logger.info", lang: "ts", dryRun: true }, plainTheme));
      expect(call).toContain("code_ast_replace");
      expect(call).toContain('"console.log" → "logger.info" (dry run) lang=ts');

      const value = {
         pattern: "console.log",
         rewrite: "logger.info",
         dryRun: true,
         files: 2,
         totalMatches: 12,
         elapsed: 1.2,
         results: [
            { file: "src/a.ts", matches: 10, added: 24, removed: 6, diff: "--- a/src/a.ts\n+++ b/src/a.ts\n-log(x)\n+logger.info(x)" },
            { file: "src/b.ts", matches: 2, added: 1, removed: 1, diff: "--- a/src/b.ts\n+++ b/src/b.ts\n-log(x)\n+logger.info(x)" }
         ]
      };
      const collapsedLines = lines(renderAstReplaceResult(result(value), collapsed));
      expect(collapsedLines).toContain("2 files 12 matches");
      expect(collapsedLines).toContain("took 1.2s");
      // Collapsed: only the summary line, no file rows, no diffs.
      expect(collapsedLines).not.toContain("[1]");
      expect(collapsedLines).not.toContain("src/a.ts 10 matches +24/-6");
      expect(collapsedLines).not.toContain("src/b.ts 2 matches +1/-1");
      expect(collapsedLines).not.toContain("logger.info(x)");
      expect(collapsedLines.split("\n")).toHaveLength(1);

      // Expanded: stat rows for every file, diffs never rendered.
      const expandedLines = lines(renderAstReplaceResult(result(value), expanded));
      expect(expandedLines).toContain("src/a.ts 10 matches +24/-6");
      expect(expandedLines).toContain("src/b.ts 2 matches +1/-1");
      expect(expandedLines).not.toContain("logger.info(x)");
      expect(expandedLines).not.toContain("-log(x)");
      expect(expandedLines).not.toContain("+382 lines");
      expect(lines(renderAstReplaceResult(result(value), { expanded: false, isPartial: true }))).toContain("Previewing...");

      const errOut = lines(
         renderAstReplaceResult(
            {
               content: [{ type: "text" as const, text: "boom" }],
               details: {},
               isError: true
            },
            collapsed,
            undefined,
            { isError: true }
         )
      );
      expect(errOut).toContain("boom");
   });

   it("explains zero matches when expanded and collapses ast_replace to the summary", () => {
      const zeroCollapsed = lines(
         renderAstReplaceResult(
            result({ pattern: "runTool", rewrite: "x", dryRun: true, files: 0, totalMatches: 0, elapsed: 0.01, results: [] }),
            collapsed
         )
      );
      expect(zeroCollapsed).toContain("0 files 0 matches");
      expect(zeroCollapsed.split("\n")).toHaveLength(1);

      const zeroExpanded = lines(
         renderAstReplaceResult(
            result({ pattern: "runTool", rewrite: "x", dryRun: true, files: 0, totalMatches: 0, elapsed: 0.01, results: [] }),
            expanded
         )
      );
      expect(zeroExpanded).toContain("(no literal matches");
      expect(zeroExpanded).toContain("metavariables like $MSG");

      const many = Array.from({ length: 10 }, (_, i) => ({ file: `src/f${i}.ts`, matches: 1, added: 1, removed: 1 }));
      const manyLines = lines(
         renderAstReplaceResult(result({ pattern: "p", rewrite: "r", dryRun: true, files: 10, totalMatches: 10, elapsed: 0.1, results: many }), collapsed)
      );
      expect(manyLines).toContain("10 files 10 matches");
      expect(manyLines).not.toContain("src/f0.ts");
      expect(manyLines).not.toContain("2 more files");
   });
});

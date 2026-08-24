import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import { randomBytes } from "node:crypto";
import { discoverCandidates } from "./lock";
import { IdeBridgeConnection } from "./bridge";
import { formatRangeMention, formatSelectionContext, toWorkspaceRelativePath, type SelectionSnapshot } from "./format";
import type { Diagnostic, DiagnosticRequest, LockCandidate, OpenFile } from "./protocol";
import { formatCompletionValue, sortOpenFiles } from "./autocomplete";

const STATUS_KEY = "pi-ide-pro";
const WIDGET_KEY = "pi-ide-pro-selection";
const CUSTOM_SELECTION_TYPE = "Selected code";
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 2_000;

interface Runtime {
   ctx?: ExtensionContext;
   cwd?: string;
   sessionId: string;
   enabled: boolean;
   connection?: IdeBridgeConnection;
   candidate?: LockCandidate;
   candidates: LockCandidate[];
   files: OpenFile[];
   selection?: SelectionSnapshot;
   selectionKey?: string;
   selectionPending: boolean;
   status: "idle" | "connecting" | "connected" | "disconnected" | "disabled";
   reconnectAttempts: number;
   reconnectTimer?: ReturnType<typeof setTimeout>;
   autocompleteRegistered: boolean;
}

export default function piIdePro(pi: ExtensionAPI): void {
   const runtime: Runtime = {
      sessionId: randomBytes(4).toString("hex"),
      enabled: true,
      candidates: [],
      files: [],
      selectionPending: false,
      status: "idle",
      reconnectAttempts: 0,
      autocompleteRegistered: false
   };

   function updateUi(ctx = runtime.ctx): void {
      if (!ctx?.hasUI) return;
      const footer = `IDE: ${runtime.sessionId} ${runtime.status}`;
      ctx.ui.setStatus(STATUS_KEY, footer);

      if (!runtime.selection) {
         ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "aboveEditor" });
         return;
      }
      const mention = formatRangeMention(runtime.selection).slice(1);
      ctx.ui.setWidget(WIDGET_KEY, [`${runtime.selectionPending ? "⇡" : "✓"} ${mention}`], {
         placement: "aboveEditor"
      });
   }

   function setSelection(snapshot: SelectionSnapshot | undefined): void {
      if (!snapshot || snapshot.ranges.length === 0) {
         runtime.selection = undefined;
         runtime.selectionKey = undefined;
         runtime.selectionPending = false;
         updateUi();
         return;
      }
      const key = JSON.stringify({
         filePath: snapshot.filePath,
         workspaceFolder: snapshot.workspaceFolder,
         ranges: snapshot.ranges.map((range) => ({ selection: range.selection, length: range.text.length }))
      });
      if (runtime.selectionKey === key) return;
      runtime.selection = snapshot;
      runtime.selectionKey = key;
      runtime.selectionPending = true;
      updateUi();
   }

   function setStatus(status: Runtime["status"], ctx?: ExtensionContext): void {
      runtime.status = status;
      updateUi(ctx);
   }

   function registerAutocomplete(ctx: ExtensionContext): void {
      if (runtime.autocompleteRegistered) return;
      runtime.autocompleteRegistered = true;
      ctx.ui.addAutocompleteProvider((baseProvider) => new VscodeAutocompleteProvider(baseProvider, runtime));
   }

   async function connect(ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
      runtime.ctx = ctx;
      runtime.cwd = ctx.cwd;
      runtime.candidates = await discoverCandidates(ctx.cwd);
      const candidate = runtime.candidates[0];
      if (!candidate) {
         runtime.candidate = undefined;
         runtime.connection?.disconnect();
         runtime.connection = undefined;
         runtime.files = [];
         setStatus("disconnected", ctx);
         return;
      }

      runtime.connection?.disconnect();
      runtime.candidate = candidate;
      setStatus("connecting", ctx);
      const connection = new IdeBridgeConnection(candidate, ctx.cwd, runtime.sessionId, {
         onSelection: (snapshot) => setSelection(snapshot),
         onOpenFiles: (files) => {
            runtime.files = sortOpenFiles(files);
         },
         onDisconnected: () => {
            if (runtime.connection !== connection) return;
            runtime.connection = undefined;
            setStatus(runtime.enabled ? "disconnected" : "disabled");
            scheduleReconnect();
         },
         onDiagnosticRequest: (request) => handleDiagnosticRequest(pi, runtime, request as DiagnosticRequest)
      });
      runtime.connection = connection;

      try {
         await connection.connect();
         runtime.reconnectAttempts = 0;
         runtime.files = sortOpenFiles(await connection.getOpenFiles());
         setStatus("connected", ctx);
      } catch {
         if (runtime.connection === connection) runtime.connection = undefined;
         setStatus("disconnected", ctx);
         scheduleReconnect();
      }
   }

   function scheduleReconnect(): void {
      if (
         !runtime.enabled ||
         runtime.reconnectTimer ||
         runtime.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS ||
         !runtime.ctx
      )
         return;
      runtime.reconnectAttempts += 1;
      runtime.reconnectTimer = setTimeout(() => {
         runtime.reconnectTimer = undefined;
         if (runtime.enabled && runtime.ctx) void connect(runtime.ctx);
      }, RECONNECT_DELAY_MS);
   }

   function clearRuntime(ctx?: ExtensionContext): void {
      if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
      runtime.reconnectTimer = undefined;
      runtime.connection?.disconnect();
      runtime.connection = undefined;
      runtime.selection = undefined;
      runtime.selectionKey = undefined;
      runtime.selectionPending = false;
      runtime.files = [];
      if (ctx?.hasUI) {
         ctx.ui.setStatus(STATUS_KEY, undefined);
         ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "aboveEditor" });
      }
   }

   pi.on("session_start", async (_event, ctx) => {
      runtime.enabled = true;
      runtime.reconnectAttempts = 0;
      runtime.ctx = ctx;
      registerAutocomplete(ctx);
      await connect(ctx);
   });

   pi.on("session_shutdown", (_event, ctx) => {
      clearRuntime(ctx);
   });

   pi.on("before_agent_start", (_event, ctx) => {
      runtime.ctx = ctx;
      if (!runtime.enabled || !runtime.selection || !runtime.selectionPending) return undefined;
      runtime.selectionPending = false;
      updateUi(ctx);
      return {
         message: {
            customType: CUSTOM_SELECTION_TYPE,
            content: formatSelectionContext(runtime.selection),
            display: true,
            details: runtime.selection
         }
      };
   });

   registerCommands(pi, runtime, connect, clearRuntime);
}

class VscodeAutocompleteProvider implements AutocompleteProvider {
   constructor(
      private readonly base: AutocompleteProvider,
      private readonly runtime: Runtime
   ) {}

   async getSuggestions(
      lines: string[],
      cursorLine: number,
      cursorCol: number,
      options: { signal: AbortSignal; force?: boolean }
   ): Promise<AutocompleteSuggestions | null> {
      const line = lines[cursorLine] ?? "";
      const beforeCursor = line.slice(0, cursorCol);
      const match = beforeCursor.match(/(^|[\s"'=])@(?:"([^"\n]*)|([^\s]*)$)/);
      if (!match) return this.base.getSuggestions(lines, cursorLine, cursorCol, options);
      const prefix = match[0].slice(match[1].length);
      const query = (match[2] ?? match[3] ?? "").toLowerCase();
      const files = sortOpenFiles(this.runtime.files)
         .map((file) => ({ file, path: toWorkspaceRelativePath(file.filePath, file.workspaceFolder) }))
         .filter(({ file, path }) => fuzzyMatch(query, path) || fuzzyMatch(query, basename(file.filePath)))
         .slice(0, 10);
      const vscodeItems: AutocompleteItem[] = files.map(({ file, path }) => {
         const selection = this.runtime.selection;
         const isSelectedFile = selection?.filePath === file.filePath && selection.ranges[0];
         const value = formatCompletionValue({
            filePath: file.filePath,
            workspaceFolder: file.workspaceFolder,
            range: isSelectedFile
               ? {
                    start: selection.ranges[0].selection.start.line,
                    end: selection.ranges[0].selection.end.line
                 }
               : undefined,
            quoted: prefix.startsWith('@"')
         });
         return {
            value,
            label: basename(file.filePath),
            description: `${path}${file.isActive ? " ★" : ""}${file.isDirty ? " ●" : ""}`
         };
      });

      const baseSuggestions = await this.base.getSuggestions(lines, cursorLine, cursorCol, options);
      const existing = new Set(vscodeItems.map((item) => item.value.toLowerCase()));
      const baseItems = (baseSuggestions?.items ?? [])
         .filter((item) => !existing.has(item.value.toLowerCase()))
         .slice(0, 5);
      return { prefix, items: [...vscodeItems, ...baseItems] };
   }

   applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) {
      return this.base.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
   }

   shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean {
      const provider = this.base as AutocompleteProvider & {
         shouldTriggerFileCompletion?: (lines: string[], cursorLine: number, cursorCol: number) => boolean;
      };
      return provider.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
   }
}

function fuzzyMatch(query: string, target: string): boolean {
   if (!query) return true;
   let index = 0;
   const lowerTarget = target.toLowerCase();
   for (const character of query) {
      index = lowerTarget.indexOf(character, index);
      if (index < 0) return false;
      index += 1;
   }
   return true;
}

function registerCommands(
   pi: ExtensionAPI,
   runtime: Runtime,
   connect: (ctx: ExtensionContext | ExtensionCommandContext) => Promise<void>,
   clearRuntime: (ctx?: ExtensionContext) => void
): void {
   pi.registerCommand("ide", {
      description: "Manage Pi IDE Pro",
      getArgumentCompletions: (prefix) => {
         const values = ["status", "problems", "list", "off"];
         const matches = values.filter((value) => value.startsWith(prefix));
         return matches.length ? matches.map((value) => ({ value, label: value })) : null;
      },
      handler: async (args, ctx) => {
         const [command, ...rest] = args.trim().split(/\s+/).filter(Boolean);
         if (!command) {
            runtime.enabled = true;
            runtime.reconnectAttempts = 0;
            await connect(ctx);
         } else if (command === "status") {
            const workspace = runtime.candidate?.workspaceFolder ?? "none";
            const bridgeName = runtime.candidate?.lock.name ?? "no VS Code";
            ctx.ui.notify(
               `Pi IDE Pro ${runtime.sessionId}\nStatus: ${runtime.status}\nVS Code: ${bridgeName}\nWorkspace: ${workspace}`,
               "info"
            );
         } else if (command === "list") {
            const candidates = await discoverCandidates(ctx.cwd);
            ctx.ui.notify(
               candidates.length
                  ? candidates.map((item) => `${item.lock.name}\n  ${item.workspaceFolder}\n  ${item.path}`).join("\n")
                  : "No matching VS Code workspaces found.",
               "info"
            );
         } else if (command === "off") {
            runtime.enabled = false;
            runtime.status = "disabled";
            clearRuntime(ctx);
            ctx.ui.setStatus(STATUS_KEY, `IDE: ${runtime.sessionId} disabled`);
         } else if (command === "problems") {
            if (!runtime.connection) {
               ctx.ui.notify("No matching VS Code workspace is connected.", "warning");
               return;
            }
            const diagnostics = await runtime.connection.getDiagnostics();
            const showAll = rest[0] === "all";
            const active = runtime.files.find((file) => file.isActive)?.filePath;
            const filtered = diagnostics.filter((diagnostic) => showAll || !active || diagnostic.filePath === active);
            if (filtered.length === 0) {
               ctx.ui.notify("No VS Code problems found.", "info");
               return;
            }
            ctx.ui.setEditorText(filtered.map(formatDiagnostic).join("\n"));
            ctx.ui.notify(`Loaded ${filtered.length} VS Code problem(s).`, "info");
         } else {
            ctx.ui.notify("Usage: /ide [status|problems [all]|list|off]", "warning");
         }
      }
   });
}

function formatDiagnostic(diagnostic: Diagnostic): string {
   const source = diagnostic.source ? ` ${diagnostic.source}:` : "";
   return `${toWorkspaceRelativePath(diagnostic.filePath, diagnostic.workspaceFolder)}:${diagnostic.line}:${diagnostic.column} ${diagnostic.severity}${source} ${diagnostic.message}`;
}

function handleDiagnosticRequest(pi: ExtensionAPI, runtime: Runtime, request: DiagnosticRequest): void {
   const context = formatDiagnosticRequest(request);
   if (request.action === "send-diagnostic") {
      runtime.ctx?.ui.setEditorText(context);
      runtime.ctx?.ui.notify("VS Code diagnostic context added to the Pi editor.", "info");
      return;
   }
   if (runtime.ctx && !runtime.ctx.isIdle()) {
      pi.sendUserMessage(context, { deliverAs: "followUp" });
   } else {
      pi.sendUserMessage(context);
   }
}

function formatDiagnosticRequest(request: DiagnosticRequest): string {
   const lines = [`File: ${request.filePath}`, `Trigger range: L${request.triggerRange.start.line + 1}`];
   for (const [index, diagnostic] of request.diagnostics.entries()) {
      lines.push(
         "",
         `Diagnostic ${index + 1}:`,
         `- Severity: ${diagnostic.severity}`,
         `- Message: ${diagnostic.message}`
      );
      if (diagnostic.source) lines.push(`- Source: ${diagnostic.source}`);
      if (diagnostic.selectedText) lines.push("- Selected text:", "```", diagnostic.selectedText, "```");
      if (diagnostic.contextLines?.length)
         lines.push("- Context lines:", ...diagnostic.contextLines.map((line) => `${line.line + 1}: ${line.text}`));
   }
   return `Analyze the following VS Code diagnostics and try to fix them:\n\n${lines.join("\n")}`;
}

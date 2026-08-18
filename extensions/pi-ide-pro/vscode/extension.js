const vscode = require("vscode");
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { WebSocketServer } = require("ws");
const { formatLogLine } = require("./logging");

let httpServer;
let websocketServer;
let token;
let externalUri;
let lockPath;
let status;
let outputChannel;
let debounceTimer;
const clients = new Map();

const home = process.env.USERPROFILE || process.env.HOME || require("node:os").homedir();
const lockDir = path.join(home, ".pi", "pi-ide-pro", "lock");
const diffDir = path.join(os.tmpdir(), "pi-ide-pro-diffs");

function log(level, message) {
   outputChannel?.appendLine(formatLogLine(level, message));
}

function workspaceFolders() {
   return (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
}

function isInside(parent, child) {
   const relative = path.relative(path.resolve(parent), path.resolve(child));
   return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function openDiffUri(uri) {
   log("info", `Received diff URI: ${uri.toString()}`);
   if (uri.path !== "/open-diff") return;
   const query = new URLSearchParams(uri.query);
   const leftPath = query.get("left");
   const rightPath = query.get("right");
   if (
      !leftPath ||
      !rightPath ||
      !isInside(diffDir, leftPath) ||
      !fs.existsSync(leftPath) ||
      !fs.existsSync(rightPath)
   ) {
      log("warn", `Rejected diff link. left=${leftPath ?? "missing"} right=${rightPath ?? "missing"}`);
      return;
   }

   try {
      await vscode.commands.executeCommand(
         "vscode.diff",
         vscode.Uri.file(leftPath),
         vscode.Uri.file(rightPath),
         `Pi IDE Pro: ${path.basename(rightPath)}`,
         { preview: false }
      );
      log("info", `Opened diff: ${rightPath}`);
   } catch (error) {
      log("error", `Could not open diff: ${error.message}`);
   }
}

function clientMatchesWorkspace(client) {
   return workspaceFolders().some((folder) => isInside(folder, client.cwd));
}

function writeLockFile(port) {
   fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
   const data = {
      version: 1,
      name: "Pi IDE Pro VS Code",
      host: "127.0.0.1",
      port,
      authToken: token,
      externalUri,
      workspaceFolders: workspaceFolders(),
      pid: process.pid,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
   };
   lockPath = path.join(lockDir, `vscode-${process.pid}-${port}.lock`);
   const temporary = `${lockPath}.${Date.now()}.tmp`;
   fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
   fs.renameSync(temporary, lockPath);
   log("debug", `Lock file updated: ${lockPath}`);
}

async function getExternalUri() {
   const uri = await vscode.env.asExternalUri(
      vscode.Uri.parse(`${vscode.env.uriScheme}://nielpattin.pi-ide-pro/open-diff`)
   );
   return uri.toString();
}

function removeLockFile() {
   if (lockPath) {
      try {
         fs.unlinkSync(lockPath);
      } catch {}
      log("debug", `Lock file removed: ${lockPath}`);
      lockPath = undefined;
   }
}

function getOpenFiles() {
   const files = new Map();
   const active = vscode.window.activeTextEditor?.document.uri.toString();
   const add = (document, tab) => {
      if (!document || document.uri.scheme !== "file") return;
      const key = document.uri.toString();
      if (files.has(key)) return;
      files.set(key, {
         filePath: document.uri.fsPath,
         workspaceFolder: vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath,
         languageId: document.languageId,
         isDirty: document.isDirty || Boolean(tab?.isDirty),
         isActive: key === active || Boolean(tab?.isActive)
      });
   };
   for (const editor of vscode.window.visibleTextEditors) add(editor.document);
   for (const document of vscode.workspace.textDocuments) add(document);
   for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
         const input = tab.input;
         if (input && input.uri && input.uri.scheme === "file")
            add({ uri: input.uri, languageId: "unknown", isDirty: tab.isDirty }, tab);
      }
   }
   return [...files.values()];
}

function getSelection() {
   const editor = vscode.window.activeTextEditor;
   if (!editor || editor.document.uri.scheme !== "file") return undefined;
   const ranges = editor.selections
      .filter((selection) => !selection.isEmpty)
      .map((selection) => ({
         text: editor.document.getText(selection),
         selection: {
            start: { line: selection.start.line, character: selection.start.character },
            end: { line: selection.end.line, character: selection.end.character }
         }
      }));
   if (ranges.length === 0) return undefined;
   return {
      source: "vscode",
      filePath: editor.document.uri.fsPath,
      workspaceFolder: vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.fsPath,
      languageId: editor.document.languageId,
      ranges
   };
}

function getDiagnostics() {
   const result = [];
   for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
      if (uri.scheme !== "file") continue;
      const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === uri.toString());
      for (const diagnostic of diagnostics) {
         const start = diagnostic.range.start;
         const end = diagnostic.range.end;
         const contextLines = document ? getContextLines(document, diagnostic.range) : [];
         result.push({
            filePath: uri.fsPath,
            workspaceFolder: vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath,
            severity:
               diagnostic.severity === vscode.DiagnosticSeverity.Error
                  ? "error"
                  : diagnostic.severity === vscode.DiagnosticSeverity.Warning
                    ? "warning"
                    : diagnostic.severity === vscode.DiagnosticSeverity.Information
                      ? "information"
                      : "hint",
            message: diagnostic.message,
            source: diagnostic.source,
            code: typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code,
            line: start.line + 1,
            column: start.character + 1,
            endLine: end.line + 1,
            endColumn: end.character + 1,
            selectedText: document ? document.getText(diagnostic.range) : undefined,
            contextLines,
            relatedInformation: diagnostic.relatedInformation?.map((item) => ({
               filePath: item.location.uri.fsPath,
               line: item.location.range.start.line + 1,
               column: item.location.range.start.character + 1,
               message: item.message
            }))
         });
      }
   }
   return result;
}

function getContextLines(document, range) {
   const lines = [];
   const start = Math.max(0, range.start.line - 2);
   const end = Math.min(document.lineCount - 1, range.end.line + 2);
   for (let line = start; line <= end; line += 1) {
      lines.push({
         line,
         text: document.lineAt(line).text,
         isPrimary: line >= range.start.line && line <= range.end.line
      });
   }
   return lines;
}

function decodeRaw(raw) {
   if (Buffer.isBuffer(raw)) return raw.toString("utf8");
   if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
   return Buffer.from(raw).toString("utf8");
}

function send(socket, value) {
   if (socket.readyState === 1) socket.send(JSON.stringify(value));
}

function broadcast(value) {
   for (const client of clients.values()) send(client.socket, value);
}

function clientsForWorkspace() {
   return [...clients.values()]
      .filter(clientMatchesWorkspace)
      .map(({ sessionId, cwd, connectedAt }) => ({ sessionId, cwd, connectedAt }));
}

function publishClients() {
   broadcast({ jsonrpc: "2.0", method: "clients_changed", params: { clients: clientsForWorkspace() } });
   updateStatus();
}

function updateStatus(selectionState) {
   if (!status) return;
   const matching = clientsForWorkspace();
   const selection = selectionState || getSelection();
   const range = selection?.ranges?.[0];
   const rangeText = range
      ? ` L${range.selection.start.line + 1}${range.selection.start.line === range.selection.end.line ? "" : `-L${range.selection.end.line + 1}`}`
      : "";
   status.text = `$(plug) Pi IDE Pro ${matching.length} Pi${rangeText}`;
   status.tooltip = matching.length
      ? `Connected Pi sessions: ${matching.map((client) => `${client.sessionId} (${client.cwd})`).join(", ")}`
      : "No matching Pi session connected";
}

function openFile(filePath, line) {
   const uri = vscode.Uri.file(filePath);
   return vscode.workspace.openTextDocument(uri).then((document) =>
      vscode.window.showTextDocument(document, {
         selection: new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, line - 1), 0)
      })
   );
}

function diagnosticPayload(document, range, diagnostics) {
   return {
      action: "fix",
      filePath: document.uri.fsPath,
      workspaceFolder: vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath,
      triggerRange: {
         start: { line: range.start.line, character: range.start.character },
         end: { line: range.end.line, character: range.end.character }
      },
      diagnostics: diagnostics.map(
         (diagnostic) =>
            getDiagnostics().find(
               (item) =>
                  item.filePath === document.uri.fsPath &&
                  item.line === diagnostic.range.start.line + 1 &&
                  item.message === diagnostic.message
            ) || {
               filePath: document.uri.fsPath,
               severity: diagnostic.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning",
               message: diagnostic.message,
               line: diagnostic.range.start.line + 1,
               column: diagnostic.range.start.character + 1,
               endLine: diagnostic.range.end.line + 1,
               endColumn: diagnostic.range.end.character + 1,
               selectedText: document.getText(diagnostic.range),
               contextLines: getContextLines(document, diagnostic.range)
            }
      )
   };
}

async function sendDiagnostic(action, document, range, diagnostics) {
   const matching = clientsForWorkspace();
   if (matching.length === 0) return;
   let client = matching[0];
   if (matching.length > 1) {
      const choice = await vscode.window.showQuickPick(
         matching.map((item) => ({ label: item.sessionId, description: item.cwd, item })),
         { placeHolder: "Choose a Pi session" }
      );
      if (!choice) return;
      client = choice.item;
   }
   const target = clients.get(client.sessionId);
   if (!target) return;
   const payload = diagnosticPayload(document, range, diagnostics);
   log("info", `Sending ${action} diagnostic to Pi session ${client.sessionId}`);
   payload.action = action;
   send(target.socket, { jsonrpc: "2.0", method: "diagnostic_request", params: { request: payload } });
}

function registerDiagnostics(context) {
   const provider = {
      provideCodeActions(document, range, codeActionContext) {
         const diagnostics = codeActionContext.diagnostics.filter(
            (item) =>
               item.severity === vscode.DiagnosticSeverity.Error || item.severity === vscode.DiagnosticSeverity.Warning
         );
         if (diagnostics.length === 0 || clientsForWorkspace().length === 0) return [];
         const fix = new vscode.CodeAction("Pi: Fix it", vscode.CodeActionKind.QuickFix);
         fix.diagnostics = diagnostics;
         fix.command = {
            command: "pi-ide-pro.fixDiagnostic",
            title: fix.title,
            arguments: [document, range, diagnostics]
         };
         const sendAction = new vscode.CodeAction("Pi: Send diagnostic", vscode.CodeActionKind.QuickFix);
         sendAction.diagnostics = diagnostics;
         sendAction.command = {
            command: "pi-ide-pro.sendDiagnostic",
            title: sendAction.title,
            arguments: [document, range, diagnostics]
         };
         return [fix, sendAction];
      }
   };
   context.subscriptions.push(
      vscode.languages.registerCodeActionsProvider({ scheme: "file" }, provider, {
         providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
      }),
      vscode.commands.registerCommand("pi-ide-pro.fixDiagnostic", (document, range, diagnostics) =>
         sendDiagnostic("fix", document, range, diagnostics)
      ),
      vscode.commands.registerCommand("pi-ide-pro.sendDiagnostic", (document, range, diagnostics) =>
         sendDiagnostic("send-diagnostic", document, range, diagnostics)
      )
   );
}

function scheduleBroadcast() {
   if (debounceTimer) clearTimeout(debounceTimer);
   debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      const selection = getSelection();
      broadcast({
         jsonrpc: "2.0",
         method: selection ? "selection_changed" : "selection_cleared",
         params: selection || { source: "vscode", reason: "no-selection" }
      });
      broadcast({ jsonrpc: "2.0", method: "open_files_changed", params: { files: getOpenFiles() } });
      updateStatus(selection);
   }, 100);
}

function handleRpc(socket, value) {
   if (value.method === "initialize") {
      const client = value.params?.client;
      if (!client?.sessionId || typeof client.cwd !== "string") return;
      clients.set(client.sessionId, { socket, sessionId: client.sessionId, cwd: client.cwd, connectedAt: Date.now() });
      log("info", `Pi session connected: ${client.sessionId} (${client.cwd})`);
      send(socket, {
         jsonrpc: "2.0",
         id: value.id,
         result: {
            protocolVersion: 1,
            server: { name: "Pi IDE Pro VS Code", ide: "vscode" },
            selection: getSelection(),
            files: getOpenFiles()
         }
      });
      publishClients();
      return;
   }

   const client = [...clients.values()].find((item) => item.socket === socket);
   if (!client) return;
   if (value.method === "get_open_files") send(socket, { jsonrpc: "2.0", id: value.id, result: getOpenFiles() });
   else if (value.method === "get_diagnostics")
      send(socket, { jsonrpc: "2.0", id: value.id, result: getDiagnostics() });
   else if (value.method === "get_clients")
      send(socket, { jsonrpc: "2.0", id: value.id, result: clientsForWorkspace() });
   else if (value.method === "open_file") {
      openFile(value.params.filePath, value.params.line)
         .then(() => send(socket, { jsonrpc: "2.0", id: value.id, result: true }))
         .catch((error) => {
            log("error", `Could not open file: ${error.message}`);
            send(socket, { jsonrpc: "2.0", id: value.id, error: { code: -1, message: error.message } });
         });
   } else if (value.method === "send_diagnostic") {
      const target = clients.get(value.params.clientSessionId);
      if (!target) {
         send(socket, {
            jsonrpc: "2.0",
            id: value.id,
            error: { code: -1, message: "Pi session is no longer connected" }
         });
         return;
      }
      send(target.socket, { jsonrpc: "2.0", method: "diagnostic_request", params: { request: value.params.request } });
      log("info", `Forwarded diagnostic request to Pi session ${value.params.clientSessionId}`);
      send(socket, { jsonrpc: "2.0", id: value.id, result: true });
   }
}

function startServer(context) {
   token = crypto.randomBytes(32).toString("hex");
   outputChannel = vscode.window.createOutputChannel("Pi IDE Pro");
   context.subscriptions.push(
      outputChannel,
      vscode.window.registerUriHandler({ handleUri: (uri) => void openDiffUri(uri) })
   );
   log("info", "Pi IDE Pro VS Code companion starting");
   httpServer = http.createServer((request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname === "/open-file" && url.searchParams.get("token") === token) {
         openFile(url.searchParams.get("path"), Number(url.searchParams.get("line") || 1))
            .then(() => {
               response.writeHead(204);
               response.end();
            })
            .catch((error) => {
               log("error", `Could not open file: ${error.message}`);
               response.writeHead(404);
               response.end();
            });
         return;
      }
      response.writeHead(404);
      response.end();
   });
   websocketServer = new WebSocketServer({
      server: httpServer,
      verifyClient: ({ req }, done) => done(req.headers["x-pi-ide-pro-authorization"] === token, 401, "Unauthorized")
   });
   websocketServer.on("error", (error) => log("error", `WebSocket server error: ${error.message}`));
   websocketServer.on("connection", (socket) => {
      socket.on("message", (raw) => {
         try {
            handleRpc(socket, JSON.parse(decodeRaw(raw)));
         } catch (error) {
            log("error", `RPC message failed: ${error instanceof Error ? error.message : String(error)}`);
         }
      });
      socket.on("error", (error) => log("error", `WebSocket error: ${error.message}`));
      socket.on("close", () => {
         for (const [id, client] of clients) {
            if (client.socket !== socket) continue;
            clients.delete(id);
            log("info", `Pi session disconnected: ${id}`);
         }
         publishClients();
      });
   });
   httpServer.on("error", (error) => log("error", `HTTP server error: ${error.message}`));
   httpServer.listen(0, "127.0.0.1", async () => {
      try {
         externalUri = await getExternalUri();
         log("debug", `External URI configured: ${externalUri}`);
      } catch (error) {
         log("warn", `Could not configure external URI: ${error.message}`);
      }
      writeLockFile(httpServer.address().port);
      log("info", `Pi IDE Pro listening on localhost:${httpServer.address().port}`);
   });

   status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
   status.name = "Pi IDE Pro";
   status.command = "pi-ide-pro.showConnections";
   status.show();
   context.subscriptions.push(status);
   context.subscriptions.push(
      vscode.commands.registerCommand("pi-ide-pro.showConnections", () => {
         const matching = clientsForWorkspace();
         vscode.window.showInformationMessage(
            matching.length
               ? matching.map((client) => `${client.sessionId}: ${client.cwd}`).join("\n")
               : "No matching Pi sessions connected"
         );
      })
   );
   registerDiagnostics(context);
   updateStatus();
}

function stopServer() {
   log("info", "Pi IDE Pro VS Code companion stopping");
   if (debounceTimer) clearTimeout(debounceTimer);
   for (const client of clients.values()) client.socket.close();
   clients.clear();
   websocketServer?.close();
   httpServer?.close();
   removeLockFile();
   status?.dispose();
   websocketServer = undefined;
   httpServer = undefined;
   status = undefined;
}

function activate(context) {
   startServer(context);
   context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(scheduleBroadcast),
      vscode.window.onDidChangeTextEditorSelection(scheduleBroadcast),
      vscode.window.tabGroups.onDidChangeTabs(scheduleBroadcast),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
         scheduleBroadcast();
         if (lockPath) writeLockFile(httpServer.address().port);
      }),
      { dispose: stopServer }
   );
}

function deactivate() {
   stopServer();
}

module.exports = { activate, deactivate };

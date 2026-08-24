export const PROTOCOL_VERSION = 1;
export const AUTH_HEADER = "x-pi-ide-pro-authorization";
export const LOCK_EXTENSION = ".lock";

export interface Position {
   line: number;
   character: number;
}

export interface SelectionRange {
   text: string;
   selection: { start: Position; end: Position };
}

export interface SelectionSnapshot {
   source: "vscode" | "nvim";
   filePath: string;
   workspaceFolder?: string;
   languageId: string;
   ranges: SelectionRange[];
}

export interface OpenFile {
   filePath: string;
   workspaceFolder?: string;
   languageId: string;
   isDirty: boolean;
   isActive: boolean;
}

export interface Diagnostic {
   filePath: string;
   workspaceFolder?: string;
   severity: "error" | "warning" | "information" | "hint";
   message: string;
   source?: string;
   code?: string | number;
   line: number;
   column: number;
   endLine: number;
   endColumn: number;
   selectedText?: string;
   contextLines?: Array<{ line: number; text: string; isPrimary: boolean }>;
   relatedInformation?: Array<{ filePath: string; line: number; column: number; message: string }>;
}

export interface WorkspaceInfo {
   name: string;
   workspaceFolders: string[];
}

export interface LockFile {
   version: 1;
   name: string;
   host: "127.0.0.1";
   port: number;
   authToken: string;
   workspaceFolders: string[];
   pid: number;
   createdAt: string;
   updatedAt: string;
}

export interface LockCandidate {
   path: string;
   lock: LockFile;
   mtimeMs: number;
   workspaceFolder: string;
}

export interface InitializeParams {
   protocolVersion: number;
   client: { name: string; version: string; sessionId: string; cwd: string };
}

export interface RpcRequest {
   jsonrpc: "2.0";
   id: number | string;
   method: string;
   params?: unknown;
}

export interface RpcResponse {
   jsonrpc: "2.0";
   id: number | string;
   result?: unknown;
   error?: { code: number; message: string };
}

export interface RpcNotification {
   jsonrpc: "2.0";
   method: string;
   params?: unknown;
}

export interface DiagnosticRequest {
   action: "fix" | "send-diagnostic";
   filePath: string;
   workspaceFolder?: string;
   diagnostics: Diagnostic[];
   triggerRange: { start: Position; end: Position };
}

export interface PiClientInfo {
   sessionId: string;
   cwd: string;
   connectedAt: number;
}

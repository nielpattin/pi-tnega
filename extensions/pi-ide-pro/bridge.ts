import { WebSocket, type RawData } from "ws";
import type {
   Diagnostic,
   LockCandidate,
   OpenFile,
   PiClientInfo,
   RpcNotification,
   RpcResponse,
   SelectionSnapshot
} from "./protocol";

export interface BridgeCallbacks {
   onSelection?: (snapshot: SelectionSnapshot | undefined) => void;
   onOpenFiles?: (files: OpenFile[]) => void;
   onDisconnected?: (reason: string) => void;
   onClients?: (clients: PiClientInfo[]) => void;
   onDiagnosticRequest?: (request: unknown) => void;
}

function decodeRawData(raw: RawData): string {
   if (typeof raw === "string") return raw;
   if (Buffer.isBuffer(raw)) return raw.toString("utf8");
   if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
   return Buffer.from(raw).toString("utf8");
}

export class IdeBridgeConnection {
   private socket?: WebSocket;
   private nextId = 1;
   private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
   private closedByUser = false;

   constructor(
      readonly candidate: LockCandidate,
      private readonly cwd: string,
      private readonly sessionId: string,
      private readonly callbacks: BridgeCallbacks
   ) {}

   get isOpen(): boolean {
      return this.socket?.readyState === WebSocket.OPEN;
   }

   async connect(timeoutMs = 5_000): Promise<void> {
      this.closedByUser = false;
      const socket = new WebSocket(`ws://${this.candidate.lock.host}:${this.candidate.lock.port}`, {
         handshakeTimeout: timeoutMs,
         headers: { "x-pi-ide-pro-authorization": this.candidate.lock.authToken }
      });
      this.socket = socket;

      await new Promise<void>((resolve, reject) => {
         let settled = false;
         const timer = setTimeout(() => finish(new Error("Timed out connecting to Pi IDE Pro")), timeoutMs);
         const cleanup = () => {
            clearTimeout(timer);
            socket.off("open", onOpen);
            socket.off("error", onError);
         };
         const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) {
               if (this.socket === socket) this.socket = undefined;
               socket.once("error", () => undefined);
               socket.terminate();
               reject(error);
            } else {
               resolve();
            }
         };
         const onOpen = () => finish();
         const onError = (error: Error) => finish(error);
         socket.once("open", onOpen);
         socket.once("error", onError);
      });

      socket.on("message", (raw) => this.handleMessage(decodeRawData(raw)));
      socket.on("close", (_code, reason) => {
         if (this.socket !== socket) return;
         this.socket = undefined;
         const message = reason.toString() || (this.closedByUser ? "closed" : "disconnected");
         for (const pending of this.pending.values()) pending.reject(new Error(message));
         this.pending.clear();
         this.callbacks.onDisconnected?.(message);
      });
      socket.on("error", () => undefined);

      const initial = (await this.request("initialize", {
         protocolVersion: 1,
         client: { name: "Pi IDE Pro", version: "0.1.0", sessionId: this.sessionId, cwd: this.cwd }
      })) as { selection?: SelectionSnapshot; files?: OpenFile[] };
      this.callbacks.onSelection?.(initial.selection);
      if (initial.files) this.callbacks.onOpenFiles?.(initial.files);
   }

   disconnect(): void {
      this.closedByUser = true;
      for (const pending of this.pending.values()) pending.reject(new Error("closed"));
      this.pending.clear();
      this.socket?.close();
      this.socket = undefined;
   }

   async getOpenFiles(): Promise<OpenFile[]> {
      return (await this.request("get_open_files")) as OpenFile[];
   }

   async getDiagnostics(): Promise<Diagnostic[]> {
      return (await this.request("get_diagnostics")) as Diagnostic[];
   }

   async openFile(filePath: string, line: number): Promise<void> {
      await this.request("open_file", { filePath, line });
   }

   async getClients(): Promise<PiClientInfo[]> {
      return (await this.request("get_clients")) as PiClientInfo[];
   }

   async sendDiagnostic(clientSessionId: string, request: unknown): Promise<void> {
      await this.request("send_diagnostic", { clientSessionId, request });
   }

   private request(method: string, params?: unknown): Promise<unknown> {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN)
         return Promise.reject(new Error("Pi IDE Pro is disconnected"));
      const id = this.nextId++;
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      return new Promise((resolve, reject) => {
         this.pending.set(id, { resolve, reject });
      });
   }

   private handleMessage(text: string): void {
      let value: RpcResponse | RpcNotification;
      try {
         value = JSON.parse(text) as RpcResponse | RpcNotification;
      } catch {
         return;
      }

      if ("id" in value && typeof value.id === "number") {
         const pending = this.pending.get(value.id);
         if (!pending) return;
         this.pending.delete(value.id);
         if (value.error) pending.reject(new Error(value.error.message));
         else pending.resolve(value.result);
         return;
      }

      if (!("method" in value)) return;
      const params = value.params as Record<string, unknown> | undefined;
      if (value.method === "selection_changed" && params)
         this.callbacks.onSelection?.(params as unknown as SelectionSnapshot);
      if (value.method === "selection_cleared") this.callbacks.onSelection?.(undefined);
      if (value.method === "open_files_changed" && Array.isArray(params?.files)) {
         this.callbacks.onOpenFiles?.(params.files as OpenFile[]);
      }
      if (value.method === "clients_changed" && Array.isArray(params?.clients)) {
         this.callbacks.onClients?.(params.clients as PiClientInfo[]);
      }
      if (value.method === "diagnostic_request") this.callbacks.onDiagnosticRequest?.(params?.request);
   }
}

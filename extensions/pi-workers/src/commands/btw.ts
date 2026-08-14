import {
   buildSessionContext,
   createAgentSession,
   DefaultResourceLoader,
   getAgentDir,
   ModelRuntime,
   SessionManager,
   SettingsManager,
   type AgentSession,
   type AgentSessionEvent,
   type ExtensionAPI,
   type ExtensionCommandContext,
   type Theme
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {
   Input,
   Key,
   matchesKey,
   truncateToWidth,
   visibleWidth,
   wrapTextWithAnsi,
   type Component,
   type Focusable,
   type KeybindingsManager,
   type OverlayHandle,
   type TUI
} from "@earendil-works/pi-tui";

type SessionMessage = AgentSession["messages"][number];
type BtwSession = {
   readonly session: AgentSession;
   readonly displayStartIndex: number;
};

type BtwOverlayRuntime = {
   handle?: OverlayHandle;
   component?: BtwChatOverlay;
   finish?: () => void;
   closed: boolean;
};

function textContent(content: unknown): string {
   if (typeof content === "string") return content;
   if (!Array.isArray(content)) return "";
   return content
      .flatMap((part): string[] => {
         if (!part || typeof part !== "object") return [];
         const value = part as { type?: string; text?: unknown };
         return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
      })
      .join("\n");
}

function toolArgumentsPreview(value: unknown): string {
   if (value === undefined) return "";
   if (typeof value === "string") return value;
   if (value && typeof value === "object") {
      const path = (value as { path?: unknown }).path;
      if (typeof path === "string") return path;
      const command = (value as { command?: unknown }).command;
      if (typeof command === "string") return command;
   }
   try {
      const encoded = JSON.stringify(value);
      if (!encoded || encoded === "{}") return "";
      return encoded.length > 120 ? `${encoded.slice(0, 117)}...` : encoded;
   } catch {
      return "[unserializable arguments]";
   }
}

function toolResultPreview(message: SessionMessage): string {
   if (message.role !== "toolResult") return "";
   const text = textContent(message.content).trim();
   if (!text) return "(no tool output)";
   return text.length > 800 ? `${text.slice(0, 797)}...` : text;
}

/**
 * Build the main-session handoff from completed side-chat exchanges only.
 * Thinking, tool activity, failures, metadata, and incomplete turns are excluded.
 */
export function buildBtwHandoff(messages: ReadonlyArray<SessionMessage>, instructions = ""): string {
   const exchanges: Array<{ user: string; assistant: string }> = [];
   let pendingUser = "";

   for (const message of messages) {
      if (message.role === "user") {
         pendingUser = textContent(message.content).trim();
         continue;
      }
      if (message.role !== "assistant" || message.stopReason !== "stop" || !pendingUser) continue;

      const assistant = textContent(message.content).trim();
      if (!assistant) continue;
      exchanges.push({ user: pendingUser, assistant });
      pendingUser = "";
   }

   const body = exchanges.map(({ user, assistant }) => `User: ${user}\nAssistant: ${assistant}`).join("\n\n");
   if (!body) return "";

   return [
      "## BTW side-conversation handoff",
      "The user explicitly injected these completed exchanges from their independent BTW chat.",
      instructions ? `### Handoff instruction\n${instructions}` : "",
      body
   ]
      .filter(Boolean)
      .join("\n\n");
}

/** Render ordinary Pi messages into the BTW chat transcript. */
export function buildBtwTranscriptLines(messages: ReadonlyArray<SessionMessage>): string[] {
   const lines: string[] = [];
   const pushBlock = (label: string, text: string) => {
      if (lines.length > 0) lines.push("");
      lines.push(label);
      for (const line of text.split("\n")) lines.push(`  ${line}`);
   };

   for (const message of messages) {
      if (message.role === "user") {
         const text = textContent(message.content).trim();
         if (text) pushBlock("You", text);
         continue;
      }

      if (message.role === "assistant") {
         for (const part of message.content) {
            if (part.type === "thinking" && part.thinking.trim()) {
               pushBlock("Thinking", part.thinking);
            } else if (part.type === "text" && part.text.trim()) {
               pushBlock("Assistant", part.text);
            } else if (part.type === "toolCall") {
               const preview = toolArgumentsPreview(part.arguments);
               pushBlock("Tool", `${part.name}${preview ? ` · ${preview}` : ""}`);
            }
         }
         if (message.stopReason === "error" && message.errorMessage) {
            pushBlock("Error", message.errorMessage);
         } else if (message.stopReason === "aborted" && message.errorMessage) {
            pushBlock("Aborted", message.errorMessage);
         }
         continue;
      }

      if (message.role === "toolResult") {
         pushBlock(
            message.isError ? `Tool error · ${message.toolName}` : `Tool result · ${message.toolName}`,
            toolResultPreview(message)
         );
      }
   }

   return lines.length > 0 ? lines : ["Start a side conversation."];
}

function styleTranscriptLine(line: string, theme: Theme): string {
   if (line === "You") return theme.fg("accent", theme.bold(line));
   if (line === "Assistant") return theme.fg("success", theme.bold(line));
   if (line === "Thinking") return theme.fg("warning", theme.bold(line));
   if (line === "Tool" || line.startsWith("Tool result")) return theme.fg("muted", theme.bold(line));
   if (line === "Error" || line === "Aborted" || line.startsWith("Tool error")) {
      return theme.fg("error", theme.bold(line));
   }
   if (line.startsWith("  ")) return theme.fg("text", line);
   return theme.fg("dim", line);
}

export interface CreateBtwChatSessionOptions {
   readonly createSessionFn?: typeof createAgentSession;
}

/** Create a standard Pi coding session without extension or system-prompt overrides. */
export async function createBtwChatSession(
   ctx: ExtensionCommandContext,
   options: CreateBtwChatSessionOptions = {}
): Promise<BtwSession> {
   if (!ctx.model) throw new Error("No active model selected for /btw.");

   const agentDir = getAgentDir();
   const settingsManager = SettingsManager.create(ctx.cwd, agentDir, {
      projectTrusted: ctx.isProjectTrusted()
   });
   const resourceLoader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir,
      settingsManager,
      noExtensions: true
   });
   await resourceLoader.reload();

   const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json")
   });
   for (const providerId of ctx.modelRegistry.getRegisteredProviderIds()) {
      const nativeProvider = ctx.modelRegistry.getRegisteredNativeProvider(providerId);
      if (nativeProvider) {
         modelRuntime.registerNativeProvider(nativeProvider);
         continue;
      }
      const providerConfig = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
      if (providerConfig) modelRuntime.registerProvider(providerId, providerConfig);
   }

   const { session } = await (options.createSessionFn ?? createAgentSession)({
      cwd: ctx.cwd,
      agentDir,
      modelRuntime,
      model: ctx.model,
      thinkingLevel: ctx.thinkingLevel,
      sessionManager: SessionManager.inMemory(ctx.cwd),
      settingsManager,
      resourceLoader
   });

   const seedMessages = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages;
   if (seedMessages.length > 0) {
      session.agent.state.messages = seedMessages as typeof session.agent.state.messages;
   }

   return { session, displayStartIndex: seedMessages.length };
}

export class BtwChatOverlay implements Component, Focusable {
   private readonly input = new Input();
   private scrollOffset = 0;
   private followTail = true;
   private viewportHeight = 8;
   private _focused = false;

   get focused(): boolean {
      return this._focused;
   }

   set focused(value: boolean) {
      this._focused = value;
      this.input.focused = value;
   }

   constructor(
      private readonly tui: TUI,
      private readonly theme: Theme,
      private readonly keybindings: KeybindingsManager,
      private readonly readMessages: () => ReadonlyArray<SessionMessage>,
      private readonly readStatus: () => string,
      private readonly readSessionInfo: () => string,
      private readonly onSubmit: (value: string) => void,
      private readonly onClose: () => void
   ) {
      this.input.onSubmit = (value) => {
         const text = value.trim();
         if (!text) return;
         this.input.setValue("");
         this.followTail = true;
         this.onSubmit(text);
         this.tui.requestRender();
      };
      this.input.onEscape = this.onClose;
   }

   requestRender(): void {
      this.tui.requestRender();
   }

   setDraft(value: string): void {
      this.input.setValue(value);
   }

   getDraft(): string {
      return this.input.getValue();
   }

   private frame(content: string, innerWidth: number): string {
      const fitted = truncateToWidth(content, innerWidth, "");
      const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(fitted)));
      return `${this.theme.fg("border", "│")}${fitted}${padding}${this.theme.fg("border", "│")}`;
   }

   private scroll(delta: number): void {
      if (delta < 0) this.followTail = false;
      this.scrollOffset = Math.max(0, this.scrollOffset + delta);
      this.tui.requestRender();
   }

   handleInput(data: string): void {
      if (matchesKey(data, Key.escape)) {
         this.onClose();
         return;
      }
      if (matchesKey(data, Key.ctrl("c"))) {
         if (this.input.getValue()) {
            this.input.setValue("");
            this.tui.requestRender();
         } else {
            this.onClose();
         }
         return;
      }
      if (this.keybindings.matches(data, "tui.editor.pageUp")) {
         this.scroll(-Math.max(1, this.viewportHeight - 1));
         return;
      }
      if (this.keybindings.matches(data, "tui.editor.pageDown")) {
         this.scroll(Math.max(1, this.viewportHeight - 1));
         return;
      }
      this.input.handleInput(data);
      this.tui.requestRender();
   }

   render(width: number): string[] {
      const dialogWidth = Math.max(1, width);
      const innerWidth = Math.max(1, dialogWidth - 2);
      const terminalRows = this.tui.terminal.rows || 30;
      const dialogHeight = Math.max(14, Math.min(32, Math.floor(terminalRows * 0.78)));
      const chromeHeight = 8;
      this.viewportHeight = Math.max(6, dialogHeight - chromeHeight);

      const transcript = buildBtwTranscriptLines(this.readMessages()).flatMap((line) =>
         wrapTextWithAnsi(styleTranscriptLine(line, this.theme), innerWidth)
      );
      const maxScroll = Math.max(0, transcript.length - this.viewportHeight);
      if (this.followTail) this.scrollOffset = maxScroll;
      else this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
      if (this.scrollOffset >= maxScroll) this.followTail = true;

      const visible = transcript.slice(this.scrollOffset, this.scrollOffset + this.viewportHeight);
      const hiddenAbove = this.scrollOffset;
      const hiddenBelow = Math.max(0, maxScroll - this.scrollOffset);
      const scrollInfo = hiddenAbove || hiddenBelow ? ` · ↑${hiddenAbove} ↓${hiddenBelow}` : "";
      const border = (left: string, fill: string, right: string) =>
         this.theme.fg("border", `${left}${fill.repeat(innerWidth)}${right}`);
      const lines = [border("┌", "─", "┐")];
      lines.push(this.frame(this.theme.fg("accent", this.theme.bold(" BTW · Pi chat ")), innerWidth));
      lines.push(this.frame(this.theme.fg("dim", `${this.readSessionInfo()}${scrollInfo}`), innerWidth));
      lines.push(border("├", "─", "┤"));
      for (const line of visible) lines.push(this.frame(line, innerWidth));
      while (lines.length < this.viewportHeight + 4) lines.push(this.frame("", innerWidth));
      lines.push(border("├", "─", "┤"));
      lines.push(this.frame(this.theme.fg("warning", this.readStatus()), innerWidth));

      const inputLine = this.input.render(innerWidth)[0] ?? "";
      lines.push(this.frame(inputLine, innerWidth));
      lines.push(this.frame(this.theme.fg("dim", "Enter send · /btw:inject move · PgUp/PgDn · Esc"), innerWidth));
      lines.push(border("└", "─", "┘"));
      return lines.map((line) => truncateToWidth(line, dialogWidth, ""));
   }

   invalidate(): void {
      this.input.invalidate();
   }
}

class BtwChatController {
   private chat?: BtwSession;
   private unsubscribe?: () => void;
   private overlay?: BtwOverlayRuntime;
   private status = "Ready for a side question.";
   private draft = "";
   private commandContext?: ExtensionCommandContext;

   constructor(private readonly pi: ExtensionAPI) {}

   async open(ctx: ExtensionCommandContext, initialPrompt: string): Promise<void> {
      if (ctx.mode !== "tui") {
         ctx.ui.notify("/btw requires Pi's interactive TUI.", "error");
         return;
      }
      this.commandContext = ctx;
      await this.ensureSession(ctx);
      this.ensureOverlay(ctx);
      if (initialPrompt.trim()) void this.submit(initialPrompt.trim());
   }

   private async ensureSession(ctx: ExtensionCommandContext): Promise<void> {
      if (this.chat) return;
      this.status = "Opening Pi chat...";
      this.chat = await createBtwChatSession(ctx);
      this.unsubscribe = this.chat.session.subscribe((event) => this.handleSessionEvent(event));
      this.status = "Ready for a side question.";
   }

   private visibleMessages(): ReadonlyArray<SessionMessage> {
      if (!this.chat) return [];
      const messages = this.chat.session.messages.slice(this.chat.displayStartIndex);
      const streaming = this.chat.session.agent.state.streamingMessage;
      return streaming ? [...messages, streaming] : messages;
   }

   private sessionInfo(): string {
      if (!this.chat?.session.model) return "No model";
      return `${this.chat.session.model.provider}/${this.chat.session.model.id} · thinking ${this.chat.session.thinkingLevel}`;
   }

   private handleSessionEvent(event: AgentSessionEvent): void {
      if (event.type === "tool_execution_start") {
         this.status = `Running ${event.toolName}...`;
      } else if (event.type === "auto_retry_start") {
         this.status = "Retrying provider request...";
      } else if (event.type === "compaction_start") {
         this.status = "Compacting side-session context...";
      } else if (event.type === "agent_end") {
         this.status = "Ready for a follow-up.";
      }
      this.overlay?.component?.requestRender();
   }

   private ensureOverlay(ctx: ExtensionCommandContext): void {
      if (this.overlay?.handle) {
         this.overlay.handle.setHidden(false);
         this.overlay.handle.focus();
         this.overlay.component!.focused = true;
         this.overlay.component!.requestRender();
         return;
      }

      const runtime: BtwOverlayRuntime = { closed: false };
      this.overlay = runtime;
      void ctx.ui
         .custom<void>(
            (tui, theme, keybindings, done) => {
               runtime.finish = done;
               const component = new BtwChatOverlay(
                  tui,
                  theme,
                  keybindings,
                  () => this.visibleMessages(),
                  () => this.status,
                  () => this.sessionInfo(),
                  (value) => void this.submit(value),
                  () => this.closeOverlay()
               );
               component.focused = true;
               component.setDraft(this.draft);
               runtime.component = component;
               return component;
            },
            {
               overlay: true,
               overlayOptions: {
                  anchor: "center",
                  width: "78%",
                  maxHeight: "78%",
                  margin: 1
               },
               onHandle: (handle) => {
                  runtime.handle = handle;
                  handle.focus();
               }
            }
         )
         .catch((error) => {
            if (this.overlay === runtime) this.overlay = undefined;
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
         });
   }

   private closeOverlay(): void {
      const runtime = this.overlay;
      if (!runtime || runtime.closed) return;
      runtime.closed = true;
      this.draft = runtime.component?.getDraft() ?? "";
      runtime.handle?.hide();
      runtime.finish?.();
      if (this.overlay === runtime) this.overlay = undefined;
   }

   private async submit(prompt: string): Promise<void> {
      const chat = this.chat;
      const ctx = this.commandContext;
      if (!chat || !ctx) return;

      const injectMatch = prompt.match(/^\/btw:inject(?:\s+([\s\S]*))?$/);
      if (injectMatch) {
         await this.inject(ctx, injectMatch[1]?.trim() ?? "");
         return;
      }

      this.status = chat.session.isStreaming ? "Queued follow-up..." : "Thinking...";
      this.overlay?.component?.requestRender();
      try {
         await chat.session.prompt(prompt, {
            source: "extension",
            ...(chat.session.isStreaming ? { streamingBehavior: "followUp" as const } : {})
         });
         const last = chat.session.messages.toReversed().find((message) => message.role === "assistant");
         this.status =
            last?.role === "assistant" && last.stopReason === "error"
               ? (last.errorMessage ?? "Provider request failed.")
               : "Ready for a follow-up.";
      } catch (error) {
         this.status = error instanceof Error ? error.message : String(error);
      }
      this.overlay?.component?.requestRender();
   }

   async inject(ctx: ExtensionCommandContext, instructions: string): Promise<void> {
      const chat = this.chat;
      if (!chat) {
         ctx.ui.notify("No BTW conversation to inject.", "warning");
         return;
      }
      if (chat.session.isStreaming) {
         ctx.ui.notify("Wait for the BTW response to finish before injecting it.", "warning");
         return;
      }

      const handoff = buildBtwHandoff(chat.session.messages.slice(chat.displayStartIndex), instructions);
      if (!handoff) {
         ctx.ui.notify("No completed BTW exchange to inject.", "warning");
         return;
      }

      if (ctx.isIdle()) this.pi.sendUserMessage(handoff);
      else this.pi.sendUserMessage(handoff, { deliverAs: "followUp" });

      this.closeOverlay();
      await this.disposeChat();
      ctx.ui.notify("Injected completed BTW exchanges into the main session.", "info");
   }

   private async disposeChat(): Promise<void> {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      const chat = this.chat;
      this.chat = undefined;
      this.commandContext = undefined;
      this.status = "Ready for a side question.";
      if (!chat) return;
      try {
         await chat.session.abort();
      } catch {
         // Session disposal remains best-effort during parent shutdown.
      }
      chat.session.dispose();
   }

   async dispose(): Promise<void> {
      this.closeOverlay();
      await this.disposeChat();
   }
}

/** Register the independent modal `/btw` chat. */
export function registerBtwCommand(pi: ExtensionAPI): void {
   const controller = new BtwChatController(pi);
   pi.registerCommand("btw", {
      description: "Open an independent Pi chat in a centered modal",
      handler: async (args, ctx) => {
         try {
            await controller.open(ctx, args);
         } catch (error) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
         }
      }
   });
   pi.registerCommand("btw:inject", {
      description: "Move completed BTW exchanges into the main session",
      handler: async (args, ctx) => {
         await controller.inject(ctx, args.trim());
      }
   });
   pi.on("session_shutdown", async () => {
      await controller.dispose();
   });
}

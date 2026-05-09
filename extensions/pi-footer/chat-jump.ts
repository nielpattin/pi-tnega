import { matchesConfiguredShortcut } from "./shortcuts.ts";
import type { ChatJumpRole, ChatJumpDirection, ChatJumpShortcutAction } from "./helpers";
import { CHAT_JUMP_SHORTCUTS } from "./helpers";
import type { PowerlineShortcuts } from "./helpers";

export type { ChatJumpRole, ChatJumpDirection, ChatJumpShortcutAction };

export function getChatJumpShortcutAction(
   data: string,
   resolvedShortcuts: PowerlineShortcuts,
): ChatJumpShortcutAction | null {
   return (
      CHAT_JUMP_SHORTCUTS.find(({ shortcutKey }) => matchesConfiguredShortcut(data, resolvedShortcuts[shortcutKey]))
         ?.action ?? null
   );
}

export function isChatMessageComponentForRole(component: unknown, role: ChatJumpRole): boolean {
   const componentName = typeof component === "object" && component !== null ? component.constructor?.name : undefined;
   if (role === "assistant") {
      return componentName === "AssistantMessageComponent";
   }
   return componentName === "UserMessageComponent" || componentName === "SkillInvocationMessageComponent";
}

export function renderLineCount(component: unknown, width: number): number {
   if (typeof component !== "object" || component === null) return 0;
   const render = Reflect.get(component, "render");
   if (typeof render !== "function") return 0;
   const lines = render.call(component, width);
   return Array.isArray(lines) ? lines.length : 0;
}

export function collectMessageStartLines(
   component: unknown,
   width: number,
   role: ChatJumpRole,
   offset: number,
): { targets: number[]; lineCount: number } {
   const lineCount = renderLineCount(component, width);
   if (isChatMessageComponentForRole(component, role)) {
      return { targets: [offset], lineCount };
   }

   const children = typeof component === "object" && component !== null ? Reflect.get(component, "children") : null;
   if (!Array.isArray(children) || children.length === 0) {
      return { targets: [], lineCount };
   }

   const targets: number[] = [];
   let childOffset = offset;
   let childrenLineCount = 0;
   for (const child of children) {
      const result = collectMessageStartLines(child, width, role, childOffset);
      targets.push(...result.targets);
      childOffset += result.lineCount;
      childrenLineCount += result.lineCount;
   }

   return { targets, lineCount: Math.max(lineCount, childrenLineCount) };
}

export function collectChatMessageStartLines(role: ChatJumpRole, tuiRef: any): number[] {
   const children = Array.isArray(tuiRef?.children) ? tuiRef.children : [];
   const width = Math.max(1, tuiRef?.terminal?.columns ?? 80);
   const targets: number[] = [];
   let offset = 0;

   for (const child of children) {
      const result = collectMessageStartLines(child, width, role, offset);
      targets.push(...result.targets);
      offset += result.lineCount;
   }

   return [...new Set(targets)].sort((a, b) => a - b);
}

export function jumpToChatMessage(
   ctx: any,
   role: ChatJumpRole,
   direction: ChatJumpDirection,
   fixedEditorCompositor: any,
   tuiRef: any,
): void {
   if (!fixedEditorCompositor) {
      ctx.ui.notify("Chat message jumps require /powerline fixed-editor on", "warning");
      return;
   }

   const targets = collectChatMessageStartLines(role, tuiRef);
   const label = role === "assistant" ? "LLM" : "user";
   if (targets.length === 0) {
      ctx.ui.notify(`No ${label} messages found`, "info");
      return;
   }

   const jumped =
      direction === "previous"
         ? fixedEditorCompositor.jumpToPreviousRootTarget(targets)
         : fixedEditorCompositor.jumpToNextRootTarget(targets);
   if (!jumped) {
      ctx.ui.notify(`No ${direction} ${label} message`, "info");
   }
}

export function jumpChatToBottom(ctx: any, fixedEditorCompositor: any): void {
   if (!fixedEditorCompositor) {
      ctx.ui.notify("Chat bottom jump requires /powerline fixed-editor on", "warning");
      return;
   }
   fixedEditorCompositor.jumpToRootBottom();
}

export function followSubmittedEditorToBottom(fixedEditorCompositor: any): void {
   fixedEditorCompositor?.jumpToRootBottom();
}

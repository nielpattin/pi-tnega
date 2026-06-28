import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
   AssistantMessageComponent,
   BashExecutionComponent,
   BranchSummaryMessageComponent,
   CompactionSummaryMessageComponent,
   CustomMessageComponent,
   InteractiveMode,
   ToolExecutionComponent,
   UserMessageComponent
} from "@earendil-works/pi-coding-agent";

import { installTreeXNativePatches } from "./treex-component.js";

export default function treeXExtension(pi: ExtensionAPI): void {
   const unpatch = installTreeXNativePatches(InteractiveMode, {
      assistantMessageComponent: AssistantMessageComponent,
      bashExecutionComponent: BashExecutionComponent,
      branchSummaryMessageComponent: BranchSummaryMessageComponent,
      compactionSummaryMessageComponent: CompactionSummaryMessageComponent,
      customMessageComponent: CustomMessageComponent,
      toolExecutionComponent: ToolExecutionComponent,
      userMessageComponent: UserMessageComponent
   });

   pi.on("session_shutdown", () => unpatch());
}

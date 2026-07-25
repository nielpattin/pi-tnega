/**
 * /vibe toggle command orchestration (Algorithm D).
 */

import { isDirectorTool, restoreVibeState } from "../services/VibeState.js";

export interface PiVibeFacade {
   getActiveTools: () => string[];
   setActiveTools: (tools: string[]) => void;
   getAllTools: () => string[];
   appendEntry: (type: string, data: any) => void;
   getEntries: () => any[];
   setStatusWidget: (text?: string) => void;
}

export interface VibeStateInterface {
   isVibeActive: () => boolean;
   setVibeActive: (active: boolean) => void;
   terminateVibeSessions: () => void;
}

export function handleVibeCommand(facade: PiVibeFacade, vibeState: VibeStateInterface): string {
   const active = vibeState.isVibeActive();

   if (!active) {
      // ENTER ON
      // 1. getActiveTools()
      const currentActive = facade.getActiveTools();
      // 2. baseline = filter out vibe_*
      const savedTools = currentActive.filter((name) => !name.startsWith("vibe_"));
      // 3. appendEntry("vibe-state", { savedTools, timestamp })
      facade.appendEntry("vibe-state", { savedTools, timestamp: Date.now() });
      // 4. setActiveTools(directorToolNames)
      const allTools = facade.getAllTools();
      const directorTools = allTools.filter(isDirectorTool);
      facade.setActiveTools(directorTools);
      // 5. enable hard guard / setVibeActive(true)
      vibeState.setVibeActive(true);
      // 6. status widget "🎬 vibe"
      facade.setStatusWidget("🎬 vibe");

      return "Vibe mode activated";
   } else {
      // LEAVE OFF
      // 1. getEntries()
      const entries = facade.getEntries();
      const allTools = facade.getAllTools();
      // 2. restore via existing restoreVibeState (LAST vibe-state + getAllTools intersection)
      const restored = restoreVibeState(entries, allTools);
      // 3. setActiveTools(restored)
      facade.setActiveTools(restored);
      // 4. setVibeActive(false); terminateVibeSessions
      vibeState.setVibeActive(false);
      vibeState.terminateVibeSessions();
      // 5. clear widget
      facade.setStatusWidget(undefined);

      return "Vibe mode deactivated";
   }
}

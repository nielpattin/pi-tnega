import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./src/config";
import { compileCompactionSummary, type CompactionFileOps } from "./src/core/compaction";
import { registerSessionInspector } from "./src/inspection/register-session-inspector";

function agentDirectory(): string {
   const configured = process.env.PI_CODING_AGENT_DIR?.trim();
   return configured || join(homedir(), ".pi", "agent");
}

/** Register deterministic compaction and incremental inspection of its source session. */
export default function compactionExtension(pi: ExtensionAPI): void {
   registerSessionInspector(pi);
   pi.on("session_before_compact", async (event) => {
      try {
         const config = await loadConfig(agentDirectory());
         if (!config.enabled) return undefined;

         const preparation = event.preparation;
         const removed = [...(preparation.messagesToSummarize ?? []), ...(preparation.turnPrefixMessages ?? [])];
         const fileOps: CompactionFileOps = {
            readFiles: [...(preparation.fileOps?.read ?? [])],
            modifiedFiles: [...(preparation.fileOps?.written ?? []), ...(preparation.fileOps?.edited ?? [])]
         };
         const compiled = compileCompactionSummary({
            messagesToSummarize: removed,
            previousSummary: preparation.previousSummary,
            fileOps,
            limits: config.compaction
         });
         if (!compiled.ok) return undefined;

         const tokensBefore = preparation.tokensBefore;
         const estimatedTokensAfter = compiled.value.estimatedTokens;
         const reductionPercent =
            tokensBefore > 0 ? Math.max(0, Math.round((1 - estimatedTokensAfter / tokensBefore) * 100)) : 0;
         return {
            compaction: {
               summary: compiled.value.summary,
               firstKeptEntryId: preparation.firstKeptEntryId,
               tokensBefore,
               details: {
                  deterministic: true,
                  sections: compiled.value.sections,
                  tokensBefore,
                  estimatedTokensAfter,
                  reductionPercent
               }
            }
         };
      } catch {
         return undefined;
      }
   });
}

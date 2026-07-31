import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AtomicSkillChangeWriter } from "./src/apply/writer.ts";
import { DefaultSkillTogglePlanner } from "./src/apply/planner.ts";
import { DefaultSkillLocator } from "./src/discovery/skill-locator.ts";
import { MinimalFrontmatterPatcher } from "./src/frontmatter/patcher.ts";
import { SimpleFrontmatterCodec } from "./src/frontmatter/parser.ts";
import { DefaultSkillInventory } from "./src/inventory/loader.ts";
import { NodeFileSystem } from "./src/ports/fs.ts";
import { runToggleSkillsCommand } from "./src/command.ts";

export default function piSkillToggle(pi: ExtensionAPI) {
   const fs = new NodeFileSystem();
   const codec = new SimpleFrontmatterCodec();
   const patcher = new MinimalFrontmatterPatcher();
   const locator = new DefaultSkillLocator(fs);
   const inventory = new DefaultSkillInventory(locator, fs, codec);
   const planner = new DefaultSkillTogglePlanner(fs, codec, patcher);
   const writer = new AtomicSkillChangeWriter(fs);

   pi.registerCommand("toggle-skills", {
      description: "Toggle whether skills are agent-invocable or manual-only",
      handler: async (_args, ctx) => {
         await runToggleSkillsCommand(ctx, { inventory, planner, writer });
      }
   });
}

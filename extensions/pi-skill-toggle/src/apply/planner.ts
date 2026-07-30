import type { FileSystem } from "../ports/fs.ts";
import type { FrontmatterCodec } from "../frontmatter/parser.ts";
import type { FrontmatterPatcher } from "../frontmatter/patcher.ts";
import type { SkillChange, SkillDraft, SkillRecord } from "../types.ts";
import { hasDuplicateDisableModelInvocation } from "../frontmatter/validation.ts";
import { classifyInvocationMode } from "../inventory/classifier.ts";

export interface SkillTogglePlanner {
   plan(records: SkillRecord[], drafts: SkillDraft[]): Promise<SkillChange[]>;
}

export class DefaultSkillTogglePlanner implements SkillTogglePlanner {
   constructor(
      private readonly fs: FileSystem,
      private readonly codec: FrontmatterCodec,
      private readonly patcher: FrontmatterPatcher
   ) {}

   async plan(records: SkillRecord[], drafts: SkillDraft[]): Promise<SkillChange[]> {
      const recordById = new Map(records.map((record) => [record.id, record]));

      const changes = await Promise.all(
         drafts.map(async (draft) => {
            const record = recordById.get(draft.skill.id);
            if (!record || !record.editable) return undefined;

            const raw = await this.fs.readFile(record.filePath);
            const doc = this.codec.parse(raw);
            if (!doc.hasFrontmatter) return undefined;

            const currentMode = classifyInvocationMode(doc);
            const needsNormalization = hasDuplicateDisableModelInvocation(doc);
            if (currentMode === draft.desiredMode && !needsNormalization) return undefined;

            const patch = this.patcher.patchInvocationMode(doc, draft.desiredMode);
            if (patch.oldText === patch.newText) return undefined;

            return {
               skill: { ...record, mode: currentMode },
               filePath: record.filePath,
               from: currentMode,
               to: draft.desiredMode,
               patch
            };
         })
      );

      return changes.filter((change): change is SkillChange => change !== undefined);
   }
}

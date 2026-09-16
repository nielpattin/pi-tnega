import type { Skill } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "./skill-block.js";

const SKILL_SECTION_HEADING =
  "The following skills provide specialized instructions for specific tasks.";
const CWD_MARKER = "\nCurrent working directory:";

/**
 * Pi omits its entire skill catalog when the active tool set lacks a tool named
 * `read`. Raft always keeps Pi's native tools active, so the catalog is
 * restored from the skills Pi discovered rather than re-derived.
 */
export const restoreSkillsInPrompt = (systemPrompt: string, skills: readonly Skill[]): string => {
  const section = formatSkillsForPrompt([...skills]);
  // Replace the catalog, not just its loader sentence: a previous catalog may
  // advertise skills for a different kernel.
  const start = systemPrompt.indexOf(SKILL_SECTION_HEADING);
  const end = start < 0 ? -1 : systemPrompt.indexOf("</available_skills>", start);
  if (start >= 0 && end >= 0) {
    return (
      systemPrompt.slice(0, start) +
      section.trimStart() +
      systemPrompt.slice(end + "</available_skills>".length)
    );
  }
  if (!section) return systemPrompt;

  const cwdIndex = systemPrompt.lastIndexOf(CWD_MARKER);
  if (cwdIndex < 0) return `${systemPrompt}${section}`;
  return `${systemPrompt.slice(0, cwdIndex)}${section}${systemPrompt.slice(cwdIndex)}`;
};

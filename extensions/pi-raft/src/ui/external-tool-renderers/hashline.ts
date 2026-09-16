import type { Theme } from "@earendil-works/pi-coding-agent";
import { markDiffLine } from "../diff-background.js";
import type { ExternalToolAudit, ExternalToolRenderBody, ExternalToolRenderer } from "./types.js";

const HASHLINE_ROW = /^([ +-])([^│]{4})│(.*)$/;

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const resultDetails = (audit: ExternalToolAudit): Record<string, unknown> | undefined => {
  const result = recordOf(audit.result);
  return recordOf(result?.details) ?? result;
};

const diffText = (audit: ExternalToolAudit): string | undefined => {
  const details = resultDetails(audit);
  const diff = details?.diff;
  return typeof diff === "string" && diff.length > 0 ? diff : undefined;
};

// The rows are the format, not the tool: any diff made of `anchor│content` rows
// renders the same way, so Raft never has to know which extension produced it.
const hasAnchorRows = (text: string): boolean =>
  text.split(String.fromCharCode(10)).some((line) => HASHLINE_ROW.test(line));

const isAnchorRowAudit = (audit: ExternalToolAudit): boolean => {
  const diff = diffText(audit);
  return diff !== undefined && hasAnchorRows(diff);
};

const safeLine = (line: string): string => line.replaceAll(String.fromCharCode(27), "␛");

const normalizeHashlineRow = (line: string, theme: Theme): string => {
  const match = HASHLINE_ROW.exec(line);
  if (!match) return safeLine(line);
  const marker = match[1]!;
  const content = safeLine(match[3]!);
  const kind = marker === "+" ? "add" : marker === "-" ? "remove" : undefined;
  const color =
    marker === "+" ? "toolDiffAdded" : marker === "-" ? "toolDiffRemoved" : "toolDiffContext";
  const rendered = theme.fg(color, `${marker} ${content}`);
  return kind ? markDiffLine(kind, rendered) : rendered;
};

export const anchorRowRenderer: ExternalToolRenderer = {
  id: "anchor-row-diff",
  matches: isAnchorRowAudit,
  callDetail(audit) {
    if (!isAnchorRowAudit(audit)) return undefined;
    const path = audit.args?.path;
    return typeof path === "string" ? path : "";
  },
  renderBody(audit, theme, context): ExternalToolRenderBody | undefined {
    if (!isAnchorRowAudit(audit)) return undefined;
    const diff = diffText(audit);
    if (!diff) return undefined;
    const lines = diff.replaceAll(String.fromCharCode(13), "").split(String.fromCharCode(10));
    while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
    const shown = lines.slice(0, context.maxLines).map((line) => normalizeHashlineRow(line, theme));
    return { lines: shown, hidden: Math.max(0, lines.length - shown.length) };
  },
};

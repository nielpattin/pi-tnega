import { relative, sep } from "node:path";

export interface Position {
   line: number;
   character: number;
}

export interface SelectionRange {
   text: string;
   selection: { start: Position; end: Position };
}

export interface SelectionSnapshot {
   filePath: string;
   workspaceFolder?: string;
   languageId: string;
   ranges: SelectionRange[];
}

export function toWorkspaceRelativePath(filePath: string, workspaceFolder?: string): string {
   if (!workspaceFolder) return filePath.replaceAll("\\", "/");
   const value = relative(workspaceFolder, filePath);
   if (!value || value.startsWith("..")) return filePath.replaceAll("\\", "/");
   return value.split(sep).join("/");
}

export function formatLineRange(range: SelectionRange): string {
   const start = range.selection.start.line + 1;
   const end = range.selection.end.line + 1;
   return start === end ? `L${start}` : `L${start}-L${end}`;
}

export function formatRangeMention(snapshot: SelectionSnapshot): string {
   const path = toWorkspaceRelativePath(snapshot.filePath, snapshot.workspaceFolder);
   const first = snapshot.ranges[0];
   return first ? `@${path}#${formatLineRange(first)}` : `@${path}`;
}

export function formatSelectionContext(snapshot: SelectionSnapshot): string {
   const path = toWorkspaceRelativePath(snapshot.filePath, snapshot.workspaceFolder);
   const rangeLines = snapshot.ranges.map((range, index) => {
      const label = snapshot.ranges.length === 1 ? "Range" : `Range ${index + 1}`;
      return `${label}: ${formatLineRange(range)}`;
   });
   const codeBlocks = snapshot.ranges.map((range) => `\`\`\`${snapshot.languageId}\n${range.text}\n\`\`\``);

   return [
      "<pi-ide-pro-selection>",
      `File: ${path}`,
      ...rangeLines,
      `Language: ${snapshot.languageId}`,
      "",
      ...codeBlocks,
      "</pi-ide-pro-selection>"
   ].join("\n");
}

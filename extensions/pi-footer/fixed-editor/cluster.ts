import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const CURSOR_MARKER = "\x1b_pi:c\x07";

export interface FixedEditorClusterInput {
   width: number;
   terminalRows: number;
   statusLines?: string[];
   topLines?: string[];
   editorLines: string[];
   secondaryLines?: string[];
   transcriptLines?: string[];
   lastPromptLines?: string[];
   /** When true, the transcript overlay covers the entire root (chat) area. */
   bashModeActive?: boolean;
}

export interface FixedEditorCursor {
   row: number;
   col: number;
}

export interface FixedEditorClusterRender {
   lines: string[];
   cursor: FixedEditorCursor | null;
   /** Row index (0-based, relative to cluster top) where transcript begins. -1 if no transcript. */
   transcriptStartRow: number;
   /** Number of rows the transcript occupies. 0 if no transcript. */
   transcriptRowCount: number;
}

function normalizeLines(lines: string[] | undefined, width: number): string[] {
   if (!lines || width <= 0) return [];

   return lines
      .filter((line) => line !== undefined && line !== null)
      .map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "", true) : line));
}

function takeTail(lines: string[], count: number): string[] {
   if (count <= 0) return [];
   return lines.length <= count ? lines : lines.slice(lines.length - count);
}

function capEditorLines(lines: string[], count: number): string[] {
   if (count <= 0) return [];
   if (lines.length <= count) return lines;

   const cursorRow = lines.findIndex((line) => line.includes(CURSOR_MARKER));
   if (cursorRow !== -1) {
      const start = Math.max(0, Math.min(cursorRow - count + 1, lines.length - count));
      return lines.slice(start, start + count);
   }

   const selectedRow = lines.findIndex((line) =>
      line
         .replace(/\x1b\[[0-9;]*m/g, "")
         .trimStart()
         .startsWith("→ "),
   );
   if (selectedRow === -1) {
      return lines.slice(0, count);
   }

   const start = Math.max(0, Math.min(selectedRow - Math.floor(count / 2), lines.length - count));
   return lines.slice(start, start + count);
}

function extractCursor(lines: string[]): { lines: string[]; cursor: FixedEditorCursor | null } {
   let cursor: FixedEditorCursor | null = null;
   const cleaned = lines.map((line, row) => {
      const markerIndex = line.indexOf(CURSOR_MARKER);
      if (markerIndex === -1) return line;

      if (!cursor) {
         cursor = {
            row,
            col: visibleWidth(line.slice(0, markerIndex)),
         };
      }

      return line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);
   });

   return { lines: cleaned, cursor };
}

export function renderFixedEditorCluster(input: FixedEditorClusterInput): FixedEditorClusterRender {
   const width = Math.max(1, input.width);
   const maxRows = Math.max(1, input.terminalRows - 1);

   const statusLines = normalizeLines(input.statusLines, width);
   const topLines = normalizeLines(input.topLines, width);
   const editorSource = normalizeLines(input.editorLines, width);
   const secondaryLines = normalizeLines(input.secondaryLines, width);
   const transcriptLines = normalizeLines(input.transcriptLines, width);
   const lastPromptLines = normalizeLines(input.lastPromptLines, width);

   const editorLines = capEditorLines(editorSource, maxRows);
   let remaining = maxRows - editorLines.length;

   const top = takeTail(topLines, remaining);
   remaining -= top.length;

   const secondary = takeTail(secondaryLines, remaining);
   remaining -= secondary.length;

   const lastPrompt = takeTail(lastPromptLines, remaining);
   remaining -= lastPrompt.length;

   const status = takeTail(statusLines, remaining);
   remaining -= status.length;

   // Transcript fills whatever space is left after all other sections.
   const transcript = takeTail(transcriptLines, remaining);

   const { lines, cursor } = extractCursor([
      ...transcript,
      ...status,
      ...top,
      ...editorLines,
      ...secondary,
      ...lastPrompt,
   ]);
   const hasTranscript = transcript.length > 0 || input.bashModeActive;

   return {
      lines,
      cursor,
      transcriptStartRow: hasTranscript ? 0 : -1,
      transcriptRowCount: transcript.length,
   };
}

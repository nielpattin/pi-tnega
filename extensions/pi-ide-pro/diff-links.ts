export function collectChangedLines(patch: string): number[] {
   const lines: number[] = [];
   const pattern = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)/gm;
   let match: RegExpExecArray | null;
   while ((match = pattern.exec(patch)) !== null) {
      const line = Number(match[1]);
      if (Number.isFinite(line) && line > 0 && !lines.includes(line)) lines.push(line);
   }
   return lines;
}

export function createVscodeDiffUrl(
   leftPath: string,
   rightPath: string,
   targetUri = "vscode://nielpattin.pi-ide-pro/open-diff"
): string {
   const uri = new URL(targetUri);
   uri.searchParams.set("left", leftPath);
   uri.searchParams.set("right", rightPath);
   return uri.toString();
}

export function reconstructOriginalContent(currentContent: string, patch: string): string | undefined {
   const currentLines = currentContent.split("\n");
   const patchLines = patch.split(/\r?\n/);
   const hunks: Array<{ newStart: number; lines: string[] }> = [];
   let hunk: { newStart: number; lines: string[] } | undefined;

   for (const line of patchLines) {
      const header = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      if (header) {
         hunk = { newStart: Number(header[1]), lines: [] };
         hunks.push(hunk);
      } else if (hunk && (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-"))) {
         hunk.lines.push(line);
      }
   }
   if (hunks.length === 0) return undefined;

   const originalLines: string[] = [];
   let currentIndex = 0;
   for (const currentHunk of hunks) {
      const hunkStart = Math.max(0, currentHunk.newStart - 1);
      if (hunkStart < currentIndex || hunkStart > currentLines.length) return undefined;
      originalLines.push(...currentLines.slice(currentIndex, hunkStart));
      currentIndex = hunkStart;

      for (const line of currentHunk.lines) {
         if (line === "\\ No newline at end of file") continue;
         const marker = line[0];
         const content = line.slice(1);
         if (marker === " ") {
            if (currentLines[currentIndex] !== content) return undefined;
            originalLines.push(currentLines[currentIndex]);
            currentIndex += 1;
         } else if (marker === "+") {
            currentIndex += 1;
         } else if (marker === "-") {
            originalLines.push(content);
         }
      }
   }

   originalLines.push(...currentLines.slice(currentIndex));
   return originalLines.join("\n");
}

export function osc8(url: string, text: string): string {
   return `\u001b]8;;${url}\u001b\\${text}\u001b]8;;\u001b\\`;
}

export function appendEditLinks(diff: string, lines: number[], createUrl: (line: number) => string): string {
   if (lines.length === 0) return diff;
   const links = lines.map((line, index) =>
      osc8(createUrl(line), `file changed: L${line}${lines.length > 1 ? ` (${index + 1})` : ""}`)
   );
   return `${diff}\n${links.join("\n")}`;
}

export interface LogViewerOptions {
   lines?: number;
   head?: boolean;
   grep?: string;
   cursor?: number;
   stream?: "stdout" | "stderr" | "both";
   follow?: boolean;
   timeoutSec?: number;
}

export interface LogPaginatedResult {
   lines: string[];
   cursor: number;
   totalLines: number;
}

export function filterLogLines(lines: string[], grep?: string): string[] {
   if (!grep || grep.trim().length === 0) {
      return lines;
   }

   try {
      const regex = new RegExp(grep, "i");
      return lines.filter((line) => regex.test(line));
   } catch {
      const lowerGrep = grep.toLowerCase();
      return lines.filter((line) => line.toLowerCase().includes(lowerGrep));
   }
}

export function paginateLogLines(lines: string[], options?: LogViewerOptions): LogPaginatedResult {
   const totalLines = lines.length;
   const limit = options?.lines !== undefined && options.lines > 0 ? options.lines : totalLines;

   if (options?.head === true) {
      const start = Math.max(0, options.cursor ?? 0);
      const end = Math.min(start + limit, totalLines);
      const sliced = lines.slice(start, end);
      return {
         lines: sliced,
         cursor: end,
         totalLines
      };
   }

   // Tail mode (default)
   if (options?.cursor !== undefined) {
      const start = Math.max(0, options.cursor);
      const end = Math.min(start + limit, totalLines);
      const sliced = lines.slice(start, end);
      return {
         lines: sliced,
         cursor: end,
         totalLines
      };
   }

   const start = Math.max(0, totalLines - limit);
   const end = totalLines;
   const sliced = lines.slice(start, end);
   return {
      lines: sliced,
      cursor: end,
      totalLines
   };
}

export function formatMultiProcessLogLines(processEntries: Array<{ name: string; lines: string[] }>): string[] {
   const formatted: string[] = [];
   for (const entry of processEntries) {
      for (const line of entry.lines) {
         if (line.length > 0 || entry.lines.length === 1) {
            formatted.push(`[${entry.name}] ${line}`);
         }
      }
   }
   return formatted;
}

export function selectLogStream(
   stdoutText: string,
   stderrText: string,
   stream: "stdout" | "stderr" | "both" = "stdout"
): string[] {
   if (stream === "stderr") {
      return stderrText.split("\n");
   }
   if (stream === "both") {
      const outLines = stdoutText.length > 0 ? stdoutText.split("\n") : [];
      const errLines = stderrText.length > 0 ? stderrText.split("\n") : [];
      return [...outLines, ...errLines];
   }
   return stdoutText.split("\n");
}

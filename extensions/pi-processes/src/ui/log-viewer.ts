import { DEFAULT_PROCESS_SNAPSHOT_LINES, MAX_PROCESS_SNAPSHOT_BYTES, MAX_PROCESS_SNAPSHOT_LINES } from "../domain.js";

export interface LogViewerOptions {
   lines?: number;
   before?: number;
   grep?: string;
   stream?: "stdout" | "stderr" | "both";
}

type LogStream = "stdout" | "stderr";

export function formatProcessLogTime(timestamp: number): string {
   const date = new Date(timestamp);
   return [date.getHours(), date.getMinutes(), date.getSeconds()]
      .map((part) => String(part).padStart(2, "0"))
      .join(":");
}

export interface LogLine {
   line: string;
   sequence: number;
   stream: LogStream;
   timestamp?: number;
}

/** A bounded log window and the bookmark for its preceding window. */
export interface PaginatedLogLines {
   lines: LogLine[];
   before?: number;
}

export function filterLogLinesWithStreams(lines: LogLine[], grep?: string): LogLine[] {
   if (!grep || grep.trim().length === 0) return lines;

   try {
      const regex = new RegExp(grep, "i");
      return lines.filter((line) => regex.test(line.line));
   } catch {
      const lowerGrep = grep.toLowerCase();
      return lines.filter((line) => line.line.toLowerCase().includes(lowerGrep));
   }
}

export function paginateLogLinesWithStreams(lines: LogLine[], options?: LogViewerOptions): PaginatedLogLines {
   const requestedLimit = options?.lines === undefined ? DEFAULT_PROCESS_SNAPSHOT_LINES : Math.floor(options.lines);
   const limit = Math.min(
      MAX_PROCESS_SNAPSHOT_LINES,
      Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_PROCESS_SNAPSHOT_LINES)
   );
   const before = options?.before;
   const eligible = before === undefined ? lines : lines.filter((line) => line.sequence < before);
   const window = eligible.slice(Math.max(0, eligible.length - limit));
   const bounded = takeTailWithinByteLimit(window);
   const first = bounded[0];
   const hasEarlier = first !== undefined && eligible.some((line) => line.sequence < first.sequence);

   return {
      lines: bounded,
      ...(hasEarlier && first ? { before: first.sequence } : {})
   };
}

function takeTailWithinByteLimit(lines: LogLine[]): LogLine[] {
   const selected: LogLine[] = [];
   let bytes = 0;

   for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index];
      if (!line) continue;
      const lineBytes = Buffer.byteLength(line.line, "utf8") + 1;
      if (selected.length > 0 && bytes + lineBytes > MAX_PROCESS_SNAPSHOT_BYTES) break;
      selected.push(line);
      bytes += lineBytes;
   }

   return selected.toReversed();
}

export function selectTimestampedLogLines(
   stdoutLines: ReadonlyArray<{ line: string; sequence: number; timestamp: number }>,
   stderrLines: ReadonlyArray<{ line: string; sequence: number; timestamp: number }>,
   stream: "stdout" | "stderr" | "both" = "both"
): LogLine[] {
   if (stream === "stdout") return stdoutLines.map((entry) => ({ ...entry, stream: "stdout" }));
   if (stream === "stderr") return stderrLines.map((entry) => ({ ...entry, stream: "stderr" }));
   return [
      ...stdoutLines.map((entry) => ({ ...entry, stream: "stdout" as const })),
      ...stderrLines.map((entry) => ({ ...entry, stream: "stderr" as const }))
   ].toSorted((left, right) => left.sequence - right.sequence || left.timestamp - right.timestamp);
}

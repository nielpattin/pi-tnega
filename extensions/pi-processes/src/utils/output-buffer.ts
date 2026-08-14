export interface OutputView {
   text: string;
}

export interface TimestampedOutputLine {
   readonly line: string;
   readonly sequence: number;
   readonly timestamp: number;
}

function createLocalSequence(): () => number {
   let sequence = 0;
   return () => {
      sequence++;
      return sequence;
   };
}

export class TimestampedOutputBuffer {
   private lines: TimestampedOutputLine[] = [];
   private pending = "";
   private pendingSequence: number | undefined;
   private pendingTimestamp: number | undefined;
   private retainedBytes = 0;

   constructor(
      private readonly maxRetainedBytes: number,
      private readonly nextSequence: () => number = createLocalSequence()
   ) {}

   push(chunk: string, timestamp = Date.now()): void {
      const normalized = chunk.replace(/\r\n?/g, "\n");
      if (normalized.length === 0) return;
      const parts = `${this.pending}${normalized}`.split("\n");
      this.pending = parts.pop() ?? "";
      for (const line of parts) {
         this.pushLine(line, this.pendingTimestamp ?? timestamp, this.pendingSequence ?? this.nextSequence());
         this.pendingSequence = undefined;
         this.pendingTimestamp = undefined;
      }
      if (this.pending.length > 0 && this.pendingSequence === undefined) {
         this.pendingSequence = this.nextSequence();
         this.pendingTimestamp = timestamp;
      }
   }

   view(): TimestampedOutputLine[] {
      const visible = [...this.lines];
      if (this.pending.length > 0) {
         this.pendingSequence ??= this.nextSequence();
         visible.push({
            line: this.pending,
            sequence: this.pendingSequence,
            timestamp: this.pendingTimestamp ?? Date.now()
         });
      }
      return visible;
   }

   private pushLine(line: string, timestamp: number, sequence: number): void {
      let retainedLine = line;
      let bytes = Buffer.byteLength(retainedLine, "utf8") + 1;
      if (bytes > this.maxRetainedBytes) {
         const raw = Buffer.from(retainedLine, "utf8");
         let start = Math.max(0, raw.length - Math.max(1, this.maxRetainedBytes - 1));
         while (start < raw.length && (raw[start] & 0xc0) === 0x80) start++;
         retainedLine = raw.subarray(start).toString("utf8");
         bytes = Buffer.byteLength(retainedLine, "utf8") + 1;
      }
      this.lines.push({ line: retainedLine, sequence, timestamp });
      this.retainedBytes += bytes;
      while (this.retainedBytes > this.maxRetainedBytes && this.lines.length > 1) {
         const evicted = this.lines.shift();
         if (evicted) this.retainedBytes -= Buffer.byteLength(evicted.line, "utf8") + 1;
      }
   }
}

export class OutputBuffer {
   private chunks: string[] = [];
   private retainedBytes = 0;
   private cachedText: string | undefined = "";

   constructor(private readonly maxRetainedBytes: number) {}

   push(chunk: string) {
      if (chunk.length === 0) return;
      let bytes = Buffer.byteLength(chunk, "utf8");
      if (bytes > this.maxRetainedBytes) {
         this.chunks = [];
         this.retainedBytes = 0;
         const raw = Buffer.from(chunk, "utf8");
         let start = raw.length - this.maxRetainedBytes;
         while (start < raw.length && (raw[start] & 0xc0) === 0x80) start++;
         chunk = raw.subarray(start).toString("utf8");
         bytes = raw.length - start;
      }
      this.chunks.push(chunk);
      this.retainedBytes += bytes;
      while (this.retainedBytes > this.maxRetainedBytes && this.chunks.length > 1) {
         const evicted = this.chunks.shift();
         if (evicted === undefined) break;
         const evictedBytes = Buffer.byteLength(evicted, "utf8");
         this.retainedBytes -= evictedBytes;
      }
      this.cachedText = undefined;
   }

   view(): OutputView {
      this.cachedText ??= this.chunks.join("");
      return { text: this.cachedText };
   }
}

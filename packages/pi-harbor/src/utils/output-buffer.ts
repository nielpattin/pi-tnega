export interface OutputView {
   text: string;
   totalBytes: number;
   truncatedBytes: number;
   spillPath?: string;
}

export class OutputBuffer {
   private chunks: string[] = [];
   private retainedBytes = 0;
   private cachedText: string | undefined = "";
   version = 0;
   totalBytes = 0;
   truncatedBytes = 0;
   spillPath?: string;

   private readonly maxRetainedBytes: number;
   private readonly spill?: (chunk: string) => void;

   constructor(maxRetainedBytes: number, spill?: (chunk: string) => void) {
      this.maxRetainedBytes = maxRetainedBytes;
      this.spill = spill;
   }

   push(chunk: string) {
      if (chunk.length === 0) return;
      let bytes = Buffer.byteLength(chunk, "utf8");
      this.totalBytes += bytes;
      this.spill?.(chunk);
      if (bytes > this.maxRetainedBytes) {
         this.truncatedBytes += this.retainedBytes;
         this.chunks = [];
         this.retainedBytes = 0;
         const raw = Buffer.from(chunk, "utf8");
         let start = raw.length - this.maxRetainedBytes;
         while (start < raw.length && (raw[start] & 0xc0) === 0x80) start++;
         this.truncatedBytes += start;
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
         this.truncatedBytes += evictedBytes;
      }
      this.cachedText = undefined;
      this.version++;
   }

   view(): OutputView {
      this.cachedText ??= this.chunks.join("");
      return {
         text: this.cachedText,
         totalBytes: this.totalBytes,
         truncatedBytes: this.truncatedBytes,
         spillPath: this.spillPath
      };
   }
}

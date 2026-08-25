/** Options for bounded transcript retention. */
export interface TranscriptBounds {
   /** Maximum number of entries retained. */
   readonly maxEntries?: number;
   /** Maximum bytes retained across entry text. */
   readonly maxBytes?: number;
   /** Maximum bytes retained for one entry. */
   readonly maxEntryBytes?: number;
}

function truncateUtf8(value: string, maxBytes: number): string {
   if (maxBytes <= 0) return "";
   const buffer = Buffer.from(value, "utf8");
   if (buffer.length <= maxBytes) return value;
   let end = maxBytes;
   while (end > 0) {
      while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
      const result = buffer.subarray(0, end).toString("utf8");
      if (Buffer.byteLength(result, "utf8") <= maxBytes) return result;
      end--;
   }
   return "";
}

const ENTRY_TRUNCATION_MARKER = "\n[transcript entry truncated]";

/**
 * Bound transcript entries while preserving the first entry and newest tail.
 *
 * @param entries - Transcript entries with textual content.
 * @param options - Entry and byte bounds.
 * @returns A bounded copy of the transcript entries.
 */
export function boundTranscript<T extends { readonly text: string }>(
   entries: ReadonlyArray<T>,
   options: TranscriptBounds = {}
): T[] {
   const maxEntries = Math.max(1, options.maxEntries ?? Number.POSITIVE_INFINITY);
   const maxBytes = Math.max(1, options.maxBytes ?? Number.POSITIVE_INFINITY);
   const maxEntryBytes = Math.max(1, Math.min(maxBytes, options.maxEntryBytes ?? maxBytes));
   const selected =
      entries.length <= maxEntries ? [...entries] : [entries[0], ...entries.slice(-Math.max(1, maxEntries - 1))];
   const bounded: T[] = [];
   let totalBytes = 0;
   for (const entry of selected) {
      const remaining = maxBytes - totalBytes;
      if (remaining <= 0) break;
      const entryCap = Math.min(maxEntryBytes, remaining);
      const text = truncateUtf8(entry.text, entryCap);
      const boundedText =
         text === entry.text
            ? text
            : Buffer.byteLength(ENTRY_TRUNCATION_MARKER, "utf8") < entryCap
              ? `${truncateUtf8(entry.text, entryCap - Buffer.byteLength(ENTRY_TRUNCATION_MARKER, "utf8"))}${ENTRY_TRUNCATION_MARKER}`
              : truncateUtf8(ENTRY_TRUNCATION_MARKER, entryCap);
      bounded.push({ ...entry, text: boundedText });
      totalBytes += Buffer.byteLength(boundedText, "utf8");
   }
   return bounded;
}

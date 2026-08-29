interface CacheEntry<T> {
   readonly value: T;
   readonly expiresAt: number;
}

export class MemoryCache<T> {
   private readonly storage = new Map<string, CacheEntry<T>>();

   constructor(
      private readonly maxEntries = 100,
      private readonly defaultTtlMs = 5 * 60 * 1000
   ) {}

   get(key: string): T | undefined {
      const entry = this.storage.get(key);
      if (!entry) return undefined;
      if (Date.now() > entry.expiresAt) {
         this.storage.delete(key);
         return undefined;
      }
      return entry.value;
   }

   set(key: string, value: T, ttlMs = this.defaultTtlMs): void {
      if (this.storage.size >= this.maxEntries) {
         const firstKey = this.storage.keys().next().value;
         if (firstKey !== undefined) {
            this.storage.delete(firstKey);
         }
      }
      this.storage.set(key, {
         value,
         expiresAt: Date.now() + ttlMs
      });
   }

   has(key: string): boolean {
      return this.get(key) !== undefined;
   }

   clear(): void {
      this.storage.clear();
   }
}

// tests/_bootstrap.mjs — loads extension TypeScript into node:test.
// Copy of .pi/skills/tdd/assets/_bootstrap.mjs. Gitignored, never commit tests/.
import { readdirSync } from "node:fs";

async function loadJiti() {
  try {
    return await import("jiti");
  } catch {
    // jiti is a transitive dep of pi (not hoisted by pnpm): resolve from the pnpm store.
    const pnpm = new URL("../node_modules/.pnpm/", import.meta.url);
    const entry = readdirSync(pnpm).find((d) => d.startsWith("jiti@"));
    if (!entry) {
      throw new Error("jiti not found in node_modules/.pnpm. Run pnpm install first.");
    }
    return await import(new URL(`./${entry}/node_modules/jiti/lib/jiti.mjs`, pnpm).href);
  }
}

const { createJiti } = await loadJiti();
export const jiti = createJiti(import.meta.url);

// Load an extension module by path relative to the repo root.
// Example: loadExtension("extensions/pi-acks/src/account-store.ts")
export function loadExtension(relativeToRepoRoot) {
  return jiti.import(new URL(`../${relativeToRepoRoot}`, import.meta.url).href);
}

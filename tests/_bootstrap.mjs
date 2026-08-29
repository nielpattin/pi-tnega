// Shared extension test loader via jiti
import { readdirSync } from "node:fs";

async function loadJiti() {
  try {
    return await import("jiti");
  } catch {
    const pnpm = new URL("../node_modules/.pnpm/", import.meta.url);
    const entry = readdirSync(pnpm).find((name) => name.startsWith("jiti@"));
    if (!entry) throw new Error("jiti is not installed");
    return import(new URL(`./${entry}/node_modules/jiti/lib/jiti.mjs`, pnpm).href);
  }
}

const { createJiti } = await loadJiti();
export const jiti = createJiti(import.meta.url);
export function loadExtension(relativePath) {
  return jiti.import(new URL(`../${relativePath}`, import.meta.url).href);
}

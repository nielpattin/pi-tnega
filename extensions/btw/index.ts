import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBtwCommand } from "./src/btw.ts";

export * from "./src/btw.ts";

/** Register the independent BTW side-chat extension. */
export default function btwExtension(pi: ExtensionAPI): void {
   registerBtwCommand(pi);
}

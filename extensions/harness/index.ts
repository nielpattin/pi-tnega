/** Harness: Single entry that boots all 5 subsystems. Auto-discovered via extensions/harness/index.ts */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import taste from "./taste";
import toolValidator from "./tool-validator";
import hookSystem from "./hook-system";

export default function (pi: ExtensionAPI) {
   taste(pi);
   // toolValidator(pi);
   // hookSystem(pi);
}

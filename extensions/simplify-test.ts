import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

interface SimplifyMode {
   value: string;
   label: string;
   description: string;
}

const SIMPLIFY_MODES: readonly SimplifyMode[] = [
   {
      value: "readability",
      label: "readability",
      description: "Make code easier to read and follow.",
   },
   {
      value: "naming",
      label: "naming",
      description: "Improve variable, function, and type names.",
   },
   {
      value: "types",
      label: "types",
      description: "Reduce type complexity and tighten signatures.",
   },
   {
      value: "tests",
      label: "tests",
      description: "Simplify test setup and assertions.",
   },
   {
      value: "docs",
      label: "docs",
      description: "Rewrite explanations and comments more clearly.",
   },
   {
      value: "performance",
      label: "performance",
      description: "Remove unnecessary work and reduce overhead.",
   },
];

function getModeCompletions(prefix: string): AutocompleteItem[] | null {
   const query = prefix.trim().toLowerCase();
   const matches = SIMPLIFY_MODES.filter((mode) => {
      if (!query) {
         return true;
      }
      return mode.value.includes(query) || mode.description.toLowerCase().includes(query);
   }).map((mode) => ({
      value: mode.value,
      label: mode.label,
      description: mode.description,
   }));

   return matches.length > 0 ? matches : null;
}

async function handleSimplifyTest(args: string, ctx: ExtensionCommandContext): Promise<void> {
   const selectedMode = args.trim().toLowerCase();
   if (selectedMode) {
      const validMode = SIMPLIFY_MODES.find((mode) => mode.value === selectedMode);
      if (!validMode) {
         ctx.ui.notify(
            `Unknown simplify mode: ${selectedMode}. Try one of: ${SIMPLIFY_MODES.map((mode) => mode.value).join(", ")}`,
            "warning",
         );
         return;
      }

      ctx.ui.notify(`Autocomplete test selected: ${validMode.value}`, "info");
      return;
   }

   const selection = await ctx.ui.select(
      "Simplify test",
      SIMPLIFY_MODES.map((mode) => `${mode.value} - ${mode.description}`),
   );
   if (!selection) {
      return;
   }

   ctx.ui.notify(`Selector test selected: ${selection.split(" - ")[0]}`, "info");
}

export default function simplifyTestExtension(pi: ExtensionAPI): void {
   pi.registerCommand("simplify-test", {
      description: "Test slash-command argument autocomplete for simplify-style commands",
      getArgumentCompletions: getModeCompletions,
      handler: handleSimplifyTest,
   });
}

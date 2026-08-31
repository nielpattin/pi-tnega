import test from "node:test";
import assert from "node:assert/strict";
import { loadExtension } from "../_bootstrap.mjs";

const workerProfiles = await loadExtension("extensions/pi-worker-flows/src/services/worker-profiles.ts");
const childSession = await loadExtension("extensions/pi-worker-flows/src/shared/child-session.ts");
const transcriptUi = await loadExtension("extensions/pi-worker-flows/src/shared/transcript-ui.ts");
const workerProfilesPanel = await loadExtension("extensions/pi-worker-flows/src/ui/worker-profiles-panel.ts");

test("CHILD_EXCLUDED_TOOL_NAMES excludes nested worker and workflow tools", () => {
   const excluded = childSession.CHILD_EXCLUDED_TOOL_NAMES;
   assert.ok(excluded.includes("workflow"));
   assert.ok(excluded.includes("ask_user"));
   assert.ok(excluded.includes("worker_spawn"));
   assert.ok(excluded.includes("worker_list"));
   assert.ok(excluded.includes("worker_recover"));
   assert.ok(excluded.includes("worker_cancel"));
});

test("DISABLED_NESTED_TOOLS in profiles panel excludes nested worker and workflow tools", () => {
   const disabled = workerProfilesPanel.DISABLED_NESTED_TOOLS;
   assert.ok(disabled.has("workflow"));
   assert.ok(disabled.has("ask_user"));
   assert.ok(disabled.has("worker_spawn"));
   assert.ok(disabled.has("worker_list"));
   assert.ok(disabled.has("worker_recover"));
   assert.ok(disabled.has("worker_cancel"));
});

test("librarian profile is configured with pi-web-access tools", () => {
   const profiles = workerProfiles.listBuiltInAgentProfiles();
   const librarian = profiles.find((p) => p.name === "librarian");

   assert.ok(librarian, "librarian profile should be present");
   assert.equal(librarian.name, "librarian");
   assert.deepEqual(librarian.tools, ["web_search", "fetch_content", "web_research", "outline_site", "read"]);
   assert.ok(librarian.systemPrompt.includes("Primary Sources Only"));
   assert.ok(librarian.systemPrompt.includes("Zero Hallucination Policy"));
   assert.ok(librarian.systemPrompt.includes("Temporal & Version Precision"));
});

test("getChildExtensionPathsForTools resolves pi-web-access extension", () => {
   const tools = ["web_search", "fetch_content"];
   const paths = childSession.getChildExtensionPathsForTools(tools, process.cwd());

   assert.equal(paths.length, 1);
   assert.ok(paths[0].includes("pi-web-access"));
});

test("transcript UI formats argument summaries for pi-web-access tools", () => {
   assert.equal(
      transcriptUi.toolArgumentSummary("web_search", { query: "TypeScript 5.8" }),
      "TypeScript 5.8"
   );
   assert.equal(
      transcriptUi.toolArgumentSummary("fetch_content", { url: "https://docs.example.com" }),
      "https://docs.example.com"
   );
   assert.equal(
      transcriptUi.toolArgumentSummary("web_research", { query: "Diffusion models" }),
      "Diffusion models"
   );
   assert.equal(
      transcriptUi.toolArgumentSummary("outline_site", { url: "https://example.com", search: "api" }),
      "https://example.com · api"
   );
});

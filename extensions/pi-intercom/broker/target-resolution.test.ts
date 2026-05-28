import test from "node:test";
import assert from "node:assert/strict";
import { formatTargetCandidates, publicSessionTarget, resolveTarget, type TargetCandidate } from "./target-resolution.ts";

const sessions: TargetCandidate[] = [
   { id: "c84258fb-4ae6-45e0-81d3-9f6972b242dc", name: "subagent-chat-019e69d0" },
   { id: "209f7944-1111-4222-8333-aaaaaaaaaaaa", name: "subagent-chat-019e69d0" },
   { id: "1c5fd8fd-2222-4333-8444-bbbbbbbbbbbb", name: "worker" },
];

test("public session targets use chat handles for real session IDs", () => {
   assert.equal(publicSessionTarget(sessions[0]!), "chat-c84258fb");
});

test("public session targets retain synthetic sender names", () => {
   assert.equal(publicSessionTarget({ id: "subagent-control", name: "subagent-control" }), "subagent-control");
});

test("resolves public chat handles", () => {
   const resolution = resolveTarget(sessions, "chat-c84258fb");

   assert.equal(resolution.kind, "found");
   assert.equal(resolution.kind === "found" ? resolution.session.id : undefined, sessions[0]!.id);
});

test("resolves unique short ID prefixes", () => {
   const resolution = resolveTarget(sessions, "c84258fb");

   assert.equal(resolution.kind, "found");
   assert.equal(resolution.kind === "found" ? resolution.session.id : undefined, sessions[0]!.id);
});

test("resolves natural target forms copied from session displays", () => {
   for (const target of [
      "session:c84258fb",
      "@c84258fb",
      "subagent-chat-019e69d0 (c84258fb)",
      "subagent-chat-019e69d0#c84258fb",
   ]) {
      const resolution = resolveTarget(sessions, target);
      assert.equal(resolution.kind, "found", target);
      assert.equal(resolution.kind === "found" ? resolution.session.id : undefined, sessions[0]!.id, target);
   }
});

test("reports ambiguity with public chat handles", () => {
   const duplicateName = resolveTarget(sessions, "subagent-chat-019e69d0");
   assert.equal(duplicateName.kind, "ambiguous");
   assert.deepEqual(
      duplicateName.kind === "ambiguous" ? duplicateName.candidates.map((session) => session.id) : [],
      [sessions[0]!.id, sessions[1]!.id]
   );

   const ambiguousPrefix = resolveTarget(
      [
         { id: "c8420000-1111-4222-8333-aaaaaaaaaaaa", name: "alpha" },
         { id: "c8429999-2222-4333-8444-bbbbbbbbbbbb", name: "beta" },
      ],
      "c842"
   );
   assert.equal(ambiguousPrefix.kind, "ambiguous");

   const candidates = duplicateName.kind === "ambiguous" ? formatTargetCandidates(duplicateName.candidates) : "";
   assert.equal(candidates, "chat-c84258fb, chat-209f7944");
});

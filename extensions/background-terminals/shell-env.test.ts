import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import { buildChildEnv } from "./src/shell-env.ts";

test("Git sh.exe prepends usr\\bin and Git\\bin before existing PATH", () => {
   const env = { PATH: ["C:\\Windows\\System32", "C:\\bin"].join(path.delimiter) };
   const result = buildChildEnv(env, "C:\\Program Files\\Git\\usr\\bin\\sh.exe");
   const parts = result.PATH!.split(path.delimiter);
   assert.equal(parts[0], "C:\\Program Files\\Git\\usr\\bin");
   assert.equal(parts[1], "C:\\Program Files\\Git\\bin");
   assert.equal(parts[2], "C:\\Windows\\System32");
   assert.equal(parts[3], "C:\\bin");
});

test("cmd.exe leaves PATH order intact (no Git prepend)", () => {
   const env = { PATH: "C:\\Windows\\System32;C:\\Program Files\\Git\\usr\\bin" };
   const result = buildChildEnv(env, "C:\\Windows\\System32\\cmd.exe");
   assert.equal(result.PATH, env.PATH);
});

test("does not duplicate if already first", () => {
   const env = {
      PATH: ["C:\\Program Files\\Git\\usr\\bin", "C:\\Program Files\\Git\\bin", "C:\\Windows"].join(path.delimiter)
   };
   const result = buildChildEnv(env, "C:\\Program Files\\Git\\usr\\bin\\sh.exe");
   assert.equal(result.PATH, env.PATH);
});

test("missing PATH still produces usable PATH with Git dirs", () => {
   const env = {};
   const result = buildChildEnv(env, "C:\\Program Files\\Git\\usr\\bin\\sh.exe");
   assert.ok(result.PATH);
   const parts = result.PATH!.split(path.delimiter);
   assert.ok(parts.includes("C:\\Program Files\\Git\\usr\\bin"));
   assert.ok(parts.includes("C:\\Program Files\\Git\\bin"));
});

test("pure function does not mutate input env object", () => {
   const env = { PATH: "C:\\Windows" };
   const result = buildChildEnv(env, "C:\\Program Files\\Git\\usr\\bin\\sh.exe");
   assert.notEqual(result, env);
   assert.equal(env.PATH, "C:\\Windows");
});

test("matches Git bash.exe and forward-slash paths", () => {
   const env = { PATH: "C:\\Windows" };
   const result = buildChildEnv(env, "C:/Program Files/Git/usr/bin/bash.exe");
   const parts = result.PATH!.split(path.delimiter);
   assert.equal(parts[0], "C:\\Program Files\\Git\\usr\\bin");
   assert.equal(parts[1], "C:\\Program Files\\Git\\bin");
});

test("matches bare sh/bash basename at usr/bin", () => {
   const env = { PATH: "C:\\Windows" };
   const sh = buildChildEnv(env, "C:\\Program Files\\Git\\usr\\bin\\sh");
   assert.match(sh.PATH!, /C:\\Program Files\\Git\\usr\\bin/);
   const bash = buildChildEnv(env, "C:\\Program Files\\Git\\usr\\bin\\bash");
   assert.match(bash.PATH!, /C:\\Program Files\\Git\\usr\\bin/);
});

test("dirname ending with usr/bin triggers prepend even for nonstandard basename", () => {
   const env = { PATH: "C:\\Windows" };
   const result = buildChildEnv(env, "C:\\Program Files\\Git\\usr\\bin\\posix-sh.exe");
   const parts = result.PATH!.split(path.delimiter);
   assert.equal(parts[0], "C:\\Program Files\\Git\\usr\\bin");
   assert.equal(parts[1], "C:\\Program Files\\Git\\bin");
});

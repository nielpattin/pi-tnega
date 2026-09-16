import { describe, expect, it } from "vitest";
import { raftExecTitleHint } from "../src/ui/raft-code-parser.js";
import { raftExecTitleHintCached } from "../src/ui/raft-title-hint.js";

const cases: [name: string, code: string, expected: string | undefined][] = [
  [
    "single read",
    "return await pi.read({ path: 'src/ui/raft-code-parser.ts', offset: 1, limit: 80 });",
    "Read raft-code-parser.ts",
  ],
  [
    "grep lexeme plus read",
    "const [h, c] = await Promise.all([pi.grep({ pattern: 'fallback', path: 'src', limit: 20 }), pi.read({ path: 'src/config.ts', offset: 520, limit: 60 })]); return { h, c };",
    'Search "fallback" in src + Read config.ts',
  ],
  [
    "coalesced edit",
    "await pi.edit({ path: 'src/config.ts', edits: [{ old: \"a\", new: \"b\" }] }); return 'ok';",
    "Edit config.ts",
  ],
  [
    "write via named string",
    "const r = await pi.write({ path: 'src/ui/title.ts', text: π.title }); return r.output;",
    "Write title.ts",
  ],
  [
    "bash command",
    "return await pi.bash({ cmd: 'pnpm run check', timeout: 180 });",
    "Shell pnpm run check",
  ],
  [
    "long bash command clipped",
    "return await pi.bash({ cmd: 'pnpm vitest run src/ui/title.test.ts', settle: true });",
    "Shell pnpm vitest run src/ui/title.…",
  ],
  [
    "mcp call",
    "return await mcp.github.get_issue({ owner: 'x', repo: 'y', issue_number: 12 });",
    "Mcp github.get_issue",
  ],
  [
    "memory calls collapse under one label",
    "await memory.recall({ query: 'plan' }); return await memory.expand({ session: 'plan' });",
    "Memory ×2",
  ],
  [
    "distinct same-verb targets collapse to a count",
    "const [a, b, c] = await Promise.all([pi.read('/x/a.ts'), pi.read('/x/b.ts'), pi.read('/x/c.ts')]); return [a, b, c];",
    "Read a.ts +2",
  ],
  [
    "segment assembly stops at the char budget",
    `const g = await pi.grep({ pattern: 'renderCall', path: 'src/raft-exec-tool.ts' });
const r = await pi.read({ path: 'src/raft-exec-tool.ts', offset: 240, limit: 30 });
await pi.edit({ path: 'src/raft-exec-tool.ts', edits: [{ old: 'x', new: 'y' }] });
const b = await pi.bash({ cmd: 'pnpm run build', timeout: 120 });
return { g, r, b };`,
    'Search "renderCall" in raft-exec-tool.ts + Read raft-exec-tool.ts +…',
  ],
  [
    "search sweep keeps first-occurrence order under one verb",
    "return await Promise.all([pi.grep({pattern:'TODO',path:'src'}), pi.find({pattern:'*.ts',path:'src'}), pi.ls('src')]);",
    'Search "TODO" in src +2',
  ],
  [
    "bare directory qualifies a grep",
    "return await pi.grep({ pattern: 'TODO', path: 'src', ignoreCase: true });",
    'Search "TODO" in src',
  ],
  [
    "agent task clipped as target",
    "return await agents({ task: 'fix the lint errors in src/ui' });",
    "Agent fix the lint errors in src/ui",
  ],
  [
    "tools discovery counted",
    "const d = await tools.search({ query: 'github issues' }); return await tools.call({ ref: d[0].ref, args: {} });",
    "Tools ×2",
  ],
  [
    "regex pattern never quoted, path wins",
    "return await pi.grep({ pattern: '\\\\.name\\\\?\\\\.trim', path: 'src/raft-exec-tool.ts', limit: 5 });",
    "Search raft-exec-tool.ts",
  ],
  [
    "glob head with directory qualifier",
    "return await pi.find({ pattern: '*.test.ts', path: 'src/ui', limit: 10 });",
    "Search *.test.ts in src/ui",
  ],
  [
    "no raft calls stays neutral",
    "const xs = [1, 2, 3]; return xs.reduce((a, b) => a + b, 0);",
    undefined,
  ],
  [
    "aliased calls are statically invisible",
    "const t = { r: pi.read }; return await t.r('src/config.ts');",
    undefined,
  ],
  [
    "dynamic template yields no target",
    "return await pi.bash({ cmd: `pnpm vitest run ${name}.test.ts` });",
    "Shell",
  ],
  [
    "comments are never counted",
    "// pi.write({ path: 'nope.ts' })\n/* pi.bash({ cmd: 'rm -rf /' }) */\nreturn await pi.read({ path: 'src/real.ts' });",
    "Read real.ts",
  ],
  [
    "unknown tool verb is humanized",
    "return await extensions.forgeWorkspace({ path: 'src/x.ts' });",
    "Forge Workspace x.ts",
  ],
  [
    "named-string payload never surfaces",
    "const md = π['docs/secret.md']; return await pi.bash({ cmd: 'ls' });",
    "Shell ls",
  ],
];

describe("raftExecTitleHint", () => {
  for (const [name, code, expected] of cases) {
    it(name, () => {
      expect(raftExecTitleHint(code)).toBe(expected);
    });
  }
});

describe("raftExecTitleHintCached", () => {
  for (const [name, code, expected] of cases) {
    it(`mirrors the pure hint: ${name}`, () => {
      expect(raftExecTitleHintCached(code)).toBe(expected);
      expect(raftExecTitleHintCached(code)).toBe(expected);
    });
  }
});

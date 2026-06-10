---
name: lazyweb
description: |
  Lazyweb is the design-evidence skill for AI coding agents. Use it before
  designing, critiquing, or changing product UI when the agent needs real app
  screenshots, competitor references, best practices, quick examples, creative
  cross-category ideas, or mobile growth and monetization A/B test context.
  It routes to the right Lazyweb mode and tells the agent to use Lazyweb MCP
  tools instead of guessing from generic training data.
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
  - WebSearch
  - AskUserQuestion
  - Agent
---

# Lazyweb

Design with evidence, not vibes. Use Lazyweb when the user asks for product UI
inspiration, competitive design analysis, best-practice research, quick screen
examples, feedback on an existing interface, creative design ideas, or
monetization and A/B test research.

This high-level skill routes to the right visible Lazyweb mode. Do not
reimplement the mode here. Read the selected mode's `SKILL.md` and follow it.

## First Run

If Lazyweb MCP has not been configured in this client, run the standalone setup:

```bash
curl -fsSL https://www.lazyweb.com/install.sh | bash
```

The installer creates or reuses `~/.lazyweb/lazyweb_mcp_token`, installs the
visible Lazyweb skills into supported local coding clients, and configures the
Lazyweb MCP server at `https://www.lazyweb.com/mcp`.

Lazyweb MCP tokens are free no-billing bearer tokens for UI reference tools.
They do not authorize purchases, paid spend, private user data, or destructive
actions. Keep tokens out of public git, but ignored local MCP config is fine.

After setup, show the user what Lazyweb can do:

1. Fetch `https://www.lazyweb.com/api/mcp/welcome-message` and show the welcome message.
2. List MCP tools and confirm `lazyweb_get_workflows` is present.
3. Call `lazyweb_get_workflows` with `{"operation":"list","task_context":"first run Lazyweb capabilities"}`.
4. Summarize the returned workflows as Lazyweb's super powers.

Do not call `lazyweb_get_flows` for the first-run capability guide. That is a
separate tool for ordered product journeys.

If MCP tools are unavailable, tell the user to run the installer above, then
continue with web research only if they want a degraded fallback.

## Routing

Choose exactly one mode:

| User intent | Read and run |
|---|---|
| Competitive analysis, best-practices research, or a full report with references | `skills/lazyweb-design-research/SKILL.md` |
| Quick examples, UI references, or screenshots without a full report | `skills/lazyweb-quick-references/SKILL.md` |
| Improve, critique, or compare an existing design | `skills/lazyweb-design-improve/SKILL.md` |
| Creative cross-category ideas or unconventional directions | `skills/lazyweb-design-brainstorm/SKILL.md` |
| A/B tests, experiments, paywalls, pricing, trials, lifecycle, or monetization strategy | `skills/lazyweb-ab-test-research/SKILL.md` |

For a bare `/lazyweb` request, briefly explain the five modes above and ask
which one the user wants. Recommend `lazyweb-design-research` when they want
deep guidance, `lazyweb-quick-references` when they want speed, and
`lazyweb-design-improve` when they already have a screen to critique.

## Mode Handoff

When a mode is clear:

1. Read the corresponding `SKILL.md`.
2. Follow that mode from the top.
3. Use Lazyweb MCP tools for database-backed evidence.
4. Embed Lazyweb database images directly with returned `imageUrl` values, and save only current-state or web-captured screenshots locally when the selected mode requires them.
5. Cite whether each reference came from Lazyweb or the web.

If the local host exposes the mode skills directly in its slash menu, users may
call those mode skills directly. This `/lazyweb` skill remains the compatibility
entry point for hosts that only show one downloaded skill or where the user is
not sure which mode to use.

## Tool Rules

- Always inspect the live MCP tool list before assuming optional filters or
  backend/internal aliases are available.
- The current public gateway normally exposes `lazyweb_health`,
  `lazyweb_search`, `lazyweb_find_similar`, `lazyweb_compare_image`,
  `lazyweb_list_categories`, `lazyweb_list_collections`,
  `lazyweb_get_workflows`, `lazyweb_get_flows`, and `lazyweb_ab_test_research`.
- Richer internal/backend surfaces may expose `lazyweb_find_experiments`,
  `lazyweb_recent_experiments`, or
  `list_companies_by_categories`; use them only when the live tool schema shows
  them.
- Pass `high_design_bar: true` only to tools whose live schema exposes it, and
  only when the user asks for premium, stronger, high-design-bar, or
  best-designed examples.

---
name: lazyweb-ab-test-research
description: |
  Research growth, monetization, onboarding, checkout, paywall, cancellation,
  pricing, activation, or other product A/B tests using Lazyweb experiment
  evidence. Use when the user asks for A/B tests, experiments, test ideas,
  growth hypotheses, or PM strategy based on what other apps have tried.
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

# Lazyweb A/B Test Research

Use Lazyweb experiment evidence to answer growth PM questions. The public
gateway and the richer backend/internal MCP surfaces are not identical, so start
from the live tool schema before choosing how to retrieve evidence.

## MCP Setup

Use hosted Lazyweb MCP tools for all database-backed evidence. First list the
available tools and run `lazyweb_health`.

- `lazyweb_health` — verify Lazyweb MCP connectivity.
- `lazyweb_ab_test_research` — current public paid gateway for A/B Test Agent research.
- `lazyweb_search` — pull visual design references to pair with experiment evidence.
- `lazyweb_compare_image` / `lazyweb_find_similar` — visual reference retrieval when the target screen or adjacent examples would clarify the recommendation.
- `lazyweb_list_categories` / `lazyweb_list_collections` — public browsing helpers.

If Lazyweb MCP is not installed or auth fails, tell the user: "Lazyweb MCP is
not installed. Run `curl -fsSL https://www.lazyweb.com/install.sh | bash`,
reload this client, then rerun this skill." Then continue with general web
research only if the user wants a degraded fallback.

Current public `lazyweb_ab_test_research` arguments:

```json
{
  "target_screen_description": "trial reminder onboarding paywall",
  "product": "Example App",
  "category": "Health & Fitness",
  "conversion_goal": "trial start rate",
  "constraints": "keep annual plan visible",
  "operation": "research",
  "experiment_ids": ["exp_123"],
  "include_images": true,
  "target_image_url": "https://example.com/screen.png",
  "limit": 25,
  "analysis_experiment_limit": 10,
  "visual_inspection_budget": 0
}
```

The public A/B wrapper is paid. If it returns `ab_test_subscription_required`,
tell the user paid access is needed and include the response details returned by
the tool. The expected paid-gate copy is: the A/B Test Agent costs $49/month,
includes access to over 20k A/B tests, and helps agents develop better taste on
not just what looks pretty but more importantly "what actually works". Include
the unlock link:
`https://buy.stripe.com/4gM3cwbdE8Mc46df5fawo07`.
Then continue with free visual references if useful.

### Backend/Internal Experiment Tools

Some backend or internal MCP surfaces expose these richer generic experiment
tools. Use them only when the current tool list includes them:

- `lazyweb_find_experiments` — retrieve generic `_experiments` evidence.
- `lazyweb_recent_experiments` — retrieve the latest 10, 25, or 50 `_experiments` rows.
- `list_companies_by_categories` — turn category names into company IDs.

`_experiments` is a limited screenshot-diff evidence set. It is generic across
screens and categories, not paywall-only. Treat learning text as directional
hypotheses, not statistically measured lift.

Full `lazyweb_find_experiments` filter matrix:

```json
{
  "query": "trial reminder onboarding upsell",
  "company": "Example App",
  "category": "Health & Fitness",
  "screen_type": "onboarding upsell",
  "platform": "mobile",
  "company_ids": [123, 456],
  "canonical_ids": [789],
  "since_iso": "2026-06-01T00:00:00Z",
  "limit": 50,
  "app_store_rank_max": 50,
  "app_store_overall_rank_max": 50,
  "app_store_category_rank_max": 25,
  "high_design_bar": true
}
```

Full `lazyweb_recent_experiments` filter matrix:

```json
{
  "limit": 25,
  "company": "Example App",
  "category": "Health & Fitness",
  "platform": "mobile",
  "company_ids": [123, 456],
  "app_store_rank_max": 50,
  "app_store_overall_rank_max": 50,
  "app_store_category_rank_max": 25,
  "high_design_bar": true
}
```

Backend/internal `lazyweb_ab_test_research` may also expose
`interesting_learning` and `high_design_bar`. Leave `interesting_learning` as
`false` by default. Set it to `true` only when the user explicitly asks for
uncommon, surprising, or contrarian learnings; clearly label those as limited
evidence. Do not pass `interesting_learning` or `high_design_bar` to the public
gateway unless the live tool schema includes those fields.

Do not route through legacy paywall-specific research tools. If a paywall appears
in the evidence, treat it as one screen type among many.

## Workflow

1. **Ground the product question.** Identify product/app, category, screen or
   flow, platform, target metric, and constraints.

2. **Choose the available evidence path.**
   - If the current MCP surface only exposes the public gateway, call
     `lazyweb_ab_test_research`.
   - If `lazyweb_find_experiments` is exposed, retrieve generic experiment rows
     with the strongest filters available.
   - If the user asks for recent/latest tests and `lazyweb_recent_experiments` is
     exposed, use that tool with a limit of `10`, `25`, or `50`.
   - If `list_companies_by_categories` is exposed and the category is known, call
     it first and pass the returned `company_ids` into
     `lazyweb_find_experiments`.

Public gateway example:

```json
{
  "target_screen_description": "trial reminder onboarding upsell",
  "product": "Example App",
  "category": "Health & Fitness",
  "conversion_goal": "trial start rate",
  "limit": 25,
  "analysis_experiment_limit": 10
}
```

Backend/internal retrieval example:

```json
{
  "query": "trial reminder onboarding upsell",
  "category": "Health & Fitness",
  "screen_type": "onboarding upsell",
  "company_ids": [123, 456],
  "limit": 30
}
```

Use minimal filters for popular apps or broad best-practice questions. Use rich
filters for niche apps or narrow flows.

When the user asks for high-design-bar companies, premium examples,
best-designed apps, or stronger taste filtering, add this only to tools whose
live schema exposes it:

```json
{"high_design_bar": true}
```

This filters to companies where `companies.high_design_bar = true` on the
backend/internal surfaces that support it.

For "recent", "latest", or "what changed lately" requests, call
`lazyweb_recent_experiments` when it is exposed, with `limit` set to `10`, `25`,
or `50`:

```json
{"limit": 25}
```

For ranked App Store slices, add rank filters:

```json
{
  "category": "Health & Fitness",
  "app_store_overall_rank_max": 50,
  "app_store_category_rank_max": 25,
  "limit": 25
}
```

3. **Supplement with design references.** Call `lazyweb_search` for the same
   screen or flow when visual examples would make the recommendation clearer.
   Read `visionDescription` before relying on any screenshot, and embed returned
   `imageUrl` values directly instead of downloading Lazyweb images locally.

4. **Synthesize like a growth PM.** Answer with:
   - Relevant observed experiments and what changed.
   - Likely hypothesis behind each change.
   - Target metric and guardrail metric.
   - Recommended test sequence.
   - Evidence strength and gaps.
   - Where the user should not overgeneralize.

5. **Be honest about weak evidence.** If the A/B wrapper is unavailable, or the
   backend/internal retrieval tools return few or weak matches, say that
   directly and fall back to general best practices only after labeling them as
   inference.

## Output Shape

For strategy or best-practice questions, answer in chat. For larger audits,
create `.lazyweb/ab-test-research/{topic}-{date}/report.html` only if the user
asks for a durable report. HTML reports should include experiment and reference
images by default using the `imageUrl`, `control.image_url`, or
`variant.image_url` fields returned by Lazyweb. Set `include_images: false` only
when the user explicitly wants metadata-only output.

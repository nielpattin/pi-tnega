---
name: quality
description: Evaluate interface quality from both technical and design perspectives. Run technical audits (accessibility, performance, theming, responsive, anti-patterns) or design critiques (visual hierarchy, information architecture, emotional resonance, cognitive load). Use when the user wants to review, evaluate, audit, or critique an interface.
---

## MANDATORY PREPARATION

Invoke /frontend-design — it contains design principles, anti-patterns, and the **Context Gathering Protocol**. Follow the protocol before proceeding — if no design context exists yet, you MUST run /teach-impeccable first. Additionally gather: what the interface is trying to accomplish.

---

# Technical Audit

Run systematic **technical** quality checks and generate a comprehensive report. Don't fix issues — document them.

This is a code-level audit, not a design critique. Check what's measurable and verifiable in the implementation.

## Diagnostic Scan

Run checks across 5 dimensions. Score each 0-4.

### 1. Accessibility (A11y)
- **Contrast issues**: Text contrast ratios < 4.5:1 (or 7:1 for AAA)
- **Missing ARIA**: Interactive elements without proper roles, labels, or states
- **Keyboard navigation**: Missing focus indicators, illogical tab order, keyboard traps
- **Semantic HTML**: Improper heading hierarchy, missing landmarks, divs instead of buttons
- **Alt text**: Missing or poor image descriptions
- **Form issues**: Inputs without labels, poor error messaging, missing required indicators

**Score**: 0=Inaccessible (fails WCAG A) → 4=Excellent (WCAG AA fully met, approaches AAA)

### 2. Performance
- **Layout thrashing**: Reading/writing layout properties in loops
- **Expensive animations**: Animating layout properties (width, height, top, left) instead of transform/opacity
- **Missing optimization**: Images without lazy loading, unoptimized assets, missing will-change
- **Bundle size**: Unnecessary imports, unused dependencies
- **Render performance**: Unnecessary re-renders, missing memoization

**Score**: 0=Severe issues → 4=Excellent (fast, lean, well-optimized)

### 3. Theming
- **Hard-coded colors**: Colors not using design tokens
- **Broken dark mode**: Missing dark mode variants, poor contrast in dark theme
- **Inconsistent tokens**: Using wrong tokens, mixing token types
- **Theme switching issues**: Values that don't update on theme change

**Score**: 0=No theming (hard-coded everything) → 4=Excellent (full token system, dark mode works perfectly)

### 4. Responsive Design
- **Fixed widths**: Hard-coded widths that break on mobile
- **Touch targets**: Interactive elements < 44x44px
- **Horizontal scroll**: Content overflow on narrow viewports
- **Text scaling**: Layouts that break when text size increases
- **Missing breakpoints**: No mobile/tablet variants

**Score**: 0=Desktop-only → 4=Excellent (fluid, all viewports, proper touch targets)

### 5. Anti-Patterns (CRITICAL)
Check against ALL the **DON'T** guidelines in the frontend-design skill. AI slop tells (AI color palette, gradient text, glassmorphism, hero metrics, card grids, generic fonts).

**Score**: 0=AI slop gallery (5+ tells) → 4=No AI tells (distinctive, intentional design)

## Generate Report

### Audit Health Score Table
| # | Dimension | Score | Key Finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | ? | [most critical issue or "--"] |
| 2 | Performance | ? | |
| 3 | Responsive Design | ? | |
| 4 | Theming | ? | |
| 5 | Anti-Patterns | ? | |
| **Total** | | **??/20** | **[Rating band]** |

**Rating bands**: 18-20 Excellent, 14-17 Good, 10-13 Acceptable, 6-9 Poor, 0-5 Critical

### Anti-Patterns Verdict
Pass/fail: Does this look AI-generated? List specific tells.

### Executive Summary
- Score, rating band, total issues by severity (P0/P1/P2/P3)
- Top 3-5 critical issues, recommended next steps

### Detailed Findings
Tag every issue **P0-P3** severity. For each: issue name, location, category, impact, recommendation, suggested command.

### Patterns & Systemic Issues
Recurring problems indicating systemic gaps.

### Positive Findings
What's working well.

### Recommended Actions
Commands in priority order. End with `/polish` if any fixes recommended. Only recommend from: /polish, /harden, /distill, /typeset, /adapt, /bolder, /optimize, /quieter, /extract, /clarify, /normalize, /arrange, /onboard, /delight, /colorize, /overdrive, /audit, /animate, /critique.

---

# Design Critique

Conduct a holistic design critique — evaluating whether the interface works as a designed experience.

## Phase 1: Design Critique

### 1. AI Slop Detection (CRITICAL)
Check against ALL **DON'T** guidelines in frontend-design skill. AI color palette, gradient text, glassmorphism, hero metrics, card grids, generic fonts.

**The test**: If you showed this and said "AI made this," would they believe you?

### 2. Visual Hierarchy
- Eye flows to most important element first?
- Clear primary action in 2 seconds?
- Size, color, position communicate importance?
- Visual competition between elements?

### 3. Information Architecture & Cognitive Load
> Consult [reference/cognitive-load.md](reference/cognitive-load.md) for the working memory rule and 8-item checklist
- Structure intuitive for new users?
- Related content grouped logically?
- Count visible options at each decision point — if >4, flag it
- Navigation clear and predictable?
- Progressive disclosure or information dump?
- Run 8-item cognitive load checklist from reference

### 4. Emotional Journey
- What emotion does this evoke? Intentional?
- Peak-end rule: Positive peak and ending?
- Emotional valleys: onboarding frustration, error cliffs, anxiety spikes
- Interventions at negative moments?

### 5. Discoverability & Affordance
- Interactive elements obviously interactive?
- Users know what to do without instructions?
- Hover/focus states provide feedback?

### 6. Composition & Balance
- Layout balanced or weighted?
- Whitespace intentional or leftover?
- Visual rhythm, symmetry/asymmetry intentional?

### 7. Typography
- Hierarchy signals reading order?
- Body text comfortable (line length, spacing, size)?
- Fonts reinforce brand/tone?
- Enough contrast between heading levels?

### 8. Color with Purpose
- Color communicates or just decorates?
- Palette cohesive?
- Accents draw attention to right things?
- Works for colorblind users?

### 9. States & Edge Cases
- Empty states guide toward action?
- Loading states reduce perceived wait?
- Error states helpful and non-blaming?
- Success states confirm and guide next steps?

### 10. Microcopy & Voice
- Writing clear and concise?
- Sounds like right human for this brand?
- Labels and buttons unambiguous?
- Error copy helps fix the problem?

## Phase 2: Present Findings

### Design Health Score
> Consult [reference/heuristics-scoring.md](reference/heuristics-scoring.md)

Score each of Nielsen's 10 heuristics 0-4. Report as table. Most real interfaces score 20-32/40.

### Anti-Patterns Verdict
Pass/fail: Does this look AI-generated? List specific tells.

### Overall Impression
Gut reaction — what works, what doesn't, biggest opportunity.

### What's Working
2-3 things done well. Be specific.

### Priority Issues
3-5 most impactful problems. Tag P0-P3. For each: name, why it matters, fix, suggested command.

### Persona Red Flags
> Consult [reference/personas.md](reference/personas.md)

Auto-select 2-3 personas relevant to this interface. Walk through primary action and list specific red flags. Be specific — name exact elements that fail each persona.

### Minor Observations
Quick notes on smaller issues.

## Phase 3: Ask the User
Ask targeted questions based on findings. 2-4 questions max. Offer concrete options, not open-ended prompts.

## Phase 4: Recommended Actions
Commands in priority order reflecting user's priorities. Only recommend from: /polish, /harden, /distill, /typeset, /adapt, /bolder, /optimize, /quieter, /extract, /clarify, /normalize, /arrange, /onboard, /delight, /colorize, /overdrive, /audit, /animate, /critique.

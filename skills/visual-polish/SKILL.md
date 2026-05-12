---
name: visual-polish
description: Perfect the visual details — layout, spacing, design system alignment, typography, micro-detail principles, and final quality passes. Use when the user mentions layout feels off, spacing issues, visual hierarchy, consistency, design drift, alignment, typography, or wants a final polish pass before shipping.
---

## MANDATORY PREPARATION

Invoke /frontend-design — it contains design principles, anti-patterns, and the **Context Gathering Protocol**. Follow the protocol before proceeding — if no design context exists yet, you MUST run /teach-impeccable first. Additionally gather: quality bar (MVP vs flagship).

---

# Layout & Spacing (Arrange)

Improve layout and spacing that feels monotonous, crowded, or structurally weak.

## Assess Current Layout

1. **Spacing**: Consistent or arbitrary? All same (no rhythm)? Related elements grouped tightly with generous space between groups?
2. **Visual hierarchy**: Squint test — can you identify most important, second, and clear groupings? Does whitespace guide the eye?
3. **Grid & structure**: Clear underlying structure or random? Identical card grids everywhere? Everything centered?
4. **Rhythm & variety**: Alternating tight/generous spacing? Every section same structure? Intentional moments of emphasis?
5. **Density**: Too cramped or too sparse? Match content type (data-dense vs marketing).

**CRITICAL**: Space is a design material — use it with intention. Layout problems are often root cause of interfaces feeling "off."

## Improve Layout

### Establish Spacing System
- Consistent spacing scale (Tailwind, rem-based tokens, or custom)
- Semantic token names (`--space-xs` to `--space-xl`, not `--spacing-8`)
- Use `gap` for sibling spacing, `clamp()` for fluid spacing

### Create Visual Rhythm
- Tight grouping: 8-12px between related siblings
- Generous separation: 48-96px between sections
- Varied spacing within sections
- Asymmetric compositions

### Choose Right Layout Tool
- **Flexbox for 1D**: Rows, nav bars, button groups, card contents, most component internals
- **Grid for 2D**: Page-level structure, dashboards, data-dense interfaces
- Don't default to Grid when Flexbox with `flex-wrap` is simpler
- `repeat(auto-fit, minmax(280px, 1fr))` for responsive grids without breakpoints
- Named grid areas for complex page layouts

### Break Card Grid Monotony
- Don't default to card grids for everything — spacing creates grouping
- Cards only when content is truly distinct and actionable
- Never nest cards inside cards
- Vary sizes, span columns, mix cards with non-card content

### Strengthen Visual Hierarchy
- Fewest dimensions needed — space alone can be enough
- Create clear content groupings through proximity and separation

### Manage Depth
- Semantic z-index scale (dropdown → sticky → modal → toast → tooltip)
- Consistent shadow scale (sm → md → lg → xl), subtle shadows
- Elevation reinforces hierarchy, not decoration

**NEVER**: Arbitrary spacing, equal spacing everywhere, wrap everything in cards, nest cards, identical card grids everywhere, center everything, default to hero metric layouts, default to Grid when Flexbox is simpler, arbitrary z-index values.

---

# Design System Alignment (Normalize)

Audit and redesign to perfectly match design system standards.

## Plan

1. **Discover the design system**: Search for docs, component libraries, style guides. Study until you understand: core design principles, target audience, component patterns, design tokens.
2. **Analyze current feature**: Where does it deviate? Which inconsistencies are cosmetic vs functional? Root cause?
3. **Create normalization plan**: Which components replaced? Which styles use tokens? UX patterns match?

## Execute

Systematically address across these dimensions:

- **Typography**: Design system fonts, sizes, weights, line heights. Replace hard-coded values with tokens.
- **Color & Theme**: Apply design system color tokens. Remove one-off color choices.
- **Spacing & Layout**: Spacing tokens (margins, padding, gaps). Align with grid systems.
- **Components**: Replace custom implementations with design system equivalents.
- **Motion & Interaction**: Match animation timing, easing, patterns.
- **Responsive Behavior**: Align breakpoints and patterns with system standards.
- **Accessibility**: Verify contrast ratios, focus states, ARIA labels.
- **Progressive Disclosure**: Match information hierarchy to established patterns.

## Clean Up
- Consolidate reusable components into design system
- Remove orphaned code (unused implementations, styles, files)
- Lint, type-check, test

**NEVER**: Create new one-off components when equivalents exist, hard-code values that should be tokens, introduce diverging patterns, compromise accessibility.

---

# Final Polish Pass (Polish)

Meticulous final pass catching small details that separate good from great.

## Pre-Polish Assessment
- Functionally complete? Known issues to preserve? Quality bar (MVP vs flagship)?
- Polish areas: Visual inconsistencies, spacing/alignment, interaction states, copy, edge cases, transitions

## Polish Systematically

### Visual Alignment & Spacing
- Pixel-perfect to grid, consistent spacing tokens, optical alignment
- Responsive consistency at all breakpoints

### Typography Refinement
- Hierarchy consistent, line length 45-75 chars, line height appropriate
- No widows/orphans, no FOUT/FOIT flashes

### Color & Contrast
- All text meets WCAG, consistent token usage, works in all themes
- Focus indicators visible, tinted neutrals (no pure gray), no gray on color

### Interaction States
Every interactive element needs: default, hover, focus, active, disabled, loading, error, success.

### Micro-interactions & Transitions
- Smooth (150-300ms), consistent easing (ease-out-quart/quint/expo, never bounce)
- 60fps, only transform/opacity, respects reduced motion

### Content & Copy
- Consistent terminology and capitalization, no typos
- Appropriate length, punctuation consistency

### Icons & Images
- Consistent style, proper sizing, optical alignment with text
- Alt text, no layout shift, retina support

### Forms & Inputs
- Labels on all inputs, required indicators clear, helpful error messages
- Logical tab order, consistent validation timing

### Edge Cases & Error States
- All states covered: loading, empty, error, success, long content, offline

### Responsiveness
- All breakpoints, touch targets 44x44px, no text < 14px on mobile, no horizontal scroll

### Performance
- Fast load, no layout shift (CLS), smooth interactions, optimized images, lazy loading

### Code Quality
- No console logs, no commented code, no unused imports, no `any`

## Polish Checklist
- [ ] Visual alignment perfect at all breakpoints
- [ ] Spacing uses design tokens consistently
- [ ] Typography hierarchy consistent
- [ ] All interactive states implemented
- [ ] All transitions smooth (60fps)
- [ ] Copy consistent and polished
- [ ] Icons consistent and properly sized
- [ ] Forms properly labeled and validated
- [ ] Error states helpful
- [ ] Loading states clear
- [ ] Empty states welcoming
- [ ] Touch targets 44x44px
- [ ] Contrast meets WCAG AA
- [ ] Keyboard navigation works
- [ ] No console errors/warnings
- [ ] No layout shift on load
- [ ] Works in supported browsers
- [ ] Respects reduced motion
- [ ] Code clean (no TODOs, console.logs, commented code)

**NEVER**: Polish before functionally complete, spend hours on polish if ships in 30 minutes, introduce bugs while polishing, ignore systematic issues, perfect one thing while leaving others rough.

---

# Typography (Typeset)

Improve typography that feels generic, inconsistent, or poorly structured.

## Assess Current Typography

1. **Font choices**: Are we using invisible defaults (Inter, Roboto, Arial, Open Sans)? Does font match brand personality? Too many families (more than 2-3)?
2. **Hierarchy**: Can you tell headings from body from captions at a glance? Sizes too close together (14px, 15px, 16px)? Weight contrasts strong enough?
3. **Sizing & scale**: Consistent type scale or arbitrary? Body text >= 16px?
4. **Readability**: Line lengths 45-75 chars? Line-height appropriate? Contrast sufficient?
5. **Consistency**: Same elements styled same way throughout?

## Improve Typography

### Font Selection
- Choose fonts reflecting brand personality
- Pair with genuine contrast (serif + sans, geometric + humanist) or single family in multiple weights
- No layout shift: `font-display: swap`, metric-matched fallbacks

### Establish Hierarchy
- 5 sizes cover most needs: caption, secondary, body, subheading, heading
- Consistent ratio (1.25, 1.333, or 1.5)
- Combine size + weight + color + space for strong hierarchy
- App UIs: fixed `rem`-based scale; Marketing: fluid `clamp()` for headings

### Fix Readability
- `max-width: 65ch` on text containers
- Tighter line-height for headings (1.1-1.2), looser for body (1.5-1.7)
- Body text at least 16px / 1rem

### Refine Details
- `tabular-nums` for data tables and dynamic numbers
- Semantic token names (`--text-body`, `--text-heading`), not value names
- Load only weights you actually use

**NEVER**: More than 2-3 font families, arbitrary sizes, body below 16px, decorative fonts for body, disable zoom (`user-scalable=no`), `px` for font sizes, default to Inter/Roboto/Open Sans when personality matters, pair similar fonts.

---

# Detail Principles (Make Interfaces Feel Better)

Small details that compound into great experiences. Apply when building or reviewing UI code.

## Quick Reference

| Category | When to Use |
| --- | --- |
| [Typography](typography.md) | Text wrapping, font smoothing, tabular numbers |
| [Surfaces](surfaces.md) | Border radius, optical alignment, shadows, image outlines, hit areas |
| [Animations](animations.md) | Interruptible animations, enter/exit transitions, icon animations, scale on press |
| [Performance](performance.md) | Transition specificity, `will-change` usage |

## Core Principles

### 1. Concentric Border Radius
`outerRadius = innerRadius + padding`. Mismatched radii is the most common "feels off" cause.

### 2. Optical Over Geometric Alignment
When geometric centering looks off, align optically. Buttons with icons, play triangles, asymmetric icons.

### 3. Shadows Over Borders
Layer transparent `box-shadow` values for natural depth. Shadows adapt to any background.

### 4. Interruptible Animations
CSS transitions for interactive state changes (interruptible). Keyframes for staged sequences (once).

### 5. Split and Stagger Enter Animations
Break content into semantic chunks, stagger each with ~100ms delay.

### 6. Subtle Exit Animations
Small fixed `translateY` instead of full height. Exits softer than enters.

### 7. Contextual Icon Animations
`opacity`, `scale`, and `blur` instead of toggle: scale from `0.25` to `1`, opacity `0` to `1`, blur `4px` to `0px`. Spring: `{ type: "spring", duration: 0.3, bounce: 0 }`.

### 8. Font Smoothing
`-webkit-font-smoothing: antialiased` on root layout on macOS.

### 9. Tabular Numbers
`font-variant-numeric: tabular-nums` for dynamically updating numbers.

### 10. Text Wrapping
`text-wrap: balance` on headings. `text-wrap: pretty` for body text.

### 11. Image Outlines
Subtle `1px` outline with low opacity. Light: `rgba(0, 0, 0, 0.1)`, Dark: `rgba(255, 255, 255, 0.1)`. Never tinted neutrals — reads as dirt.

### 12. Scale on Press
Subtle `scale(0.96)` on click. Never below `0.95`. Add `static` prop to disable.

### 13. Skip Animation on Page Load
`initial={false}` on `AnimatePresence`. Verify it doesn't break intentional entrance animations.

### 14. Never Use `transition: all`
Specify exact properties: `transition-property: scale, opacity`.

### 15. Use `will-change` Sparingly
Only for `transform`, `opacity`, `filter`. Never `will-change: all`.

### 16. Minimum Hit Area
At least 40x40px. Extend with pseudo-element if visible element is smaller.

## Common Mistakes

| Mistake | Fix |
| --- | --- |
| Same border radius on parent and child | `outerRadius = innerRadius + padding` |
| Icons look off-center | Adjust optically with padding or SVG |
| Hard borders between sections | Layered box-shadow with transparency |
| Jarring enter/exit animations | Split, stagger, keep exits subtle |
| Numbers cause layout shift | `tabular-nums` |
| Heavy text on macOS | `antialiased` on root |
| Animation plays on page load | `initial={false}` on AnimatePresence |
| `transition: all` | Specify exact properties |
| First-frame animation stutter | `will-change: transform` (sparingly) |
| Tiny hit areas | Pseudo-element to 40x40px |

## Review Checklist
- [ ] Nested rounded elements use concentric border radius
- [ ] Icons optically centered
- [ ] Shadows over borders where appropriate
- [ ] Enter animations split and staggered
- [ ] Exit animations subtle
- [ ] Dynamic numbers use tabular-nums
- [ ] Font smoothing applied
- [ ] Headings use text-wrap: balance
- [ ] Images have subtle outlines
- [ ] Buttons use scale on press
- [ ] AnimatePresence uses `initial={false}` for default-state elements
- [ ] No `transition: all`
- [ ] `will-change` only on transform/opacity/filter
- [ ] Interactive elements at least 40x40px hit area

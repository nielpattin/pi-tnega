---
name: visual-character
description: Adjust visual personality and intensity — amplify, tone down, add color, or simplify. Use when the user says design looks bland/generic/too safe, too bold/loud/overwhelming, too gray/dull, or too complex/cluttered. Covers visual impact, color strategy, and simplification.
---

## MANDATORY PREPARATION

Invoke /frontend-design — it contains design principles, anti-patterns, and the **Context Gathering Protocol**. Follow the protocol before proceeding — if no design context exists yet, you MUST run /teach-impeccable first.

---

# Amplify (Bolder)

Increase visual impact and personality in designs that are too safe, generic, or visually underwhelming.

## Assess Current State

1. **Identify weakness sources**:
   - Generic choices: System fonts, basic colors, standard layouts
   - Timid scale: Everything medium-sized, no drama
   - Low contrast: Everything similar visual weight
   - Static: No motion, no energy
   - Predictable: Standard patterns, no surprises
   - Flat hierarchy: Nothing commands attention

2. **Understand context**: Brand personality, purpose, audience, constraints

**CRITICAL**: "Bolder" doesn't mean chaotic or garish. It means distinctive, memorable, confident.

**AI SLOP TRAP**: AI defaults to cyan/purple gradients, glassmorphism, neon on dark, gradient text. Bold means distinctive, not "more effects."

## Plan Amplification

- **Focal point**: ONE hero moment, make it amazing
- **Personality direction**: Choose a lane (maximalist, elegant drama, playful energy, dark moody)
- **Risk budget**: How experimental?
- **Hierarchy**: Make big BIGGER, small smaller

## Amplify Across Dimensions

### Typography
- Replace generic fonts with distinctive choices
- Extreme scale jumps (3x-5x, not 1.5x)
- Weight contrast: Pair 900 with 200
- Variable fonts, display fonts, intentional monospace

### Color
- Increase saturation (not neon)
- Bold palette: Unexpected combos, avoid purple-blue AI slop
- Dominant color owns 60%
- Sharp accents, high contrast
- Tinted neutrals, rich gradients

### Spatial Drama
- Extreme scale jumps, break the grid
- Asymmetric layouts, generous space (100-200px gaps)
- Overlap elements for depth

### Visual Effects
- Dramatic shadows (large, soft), background treatments (mesh, noise, grain)
- Texture: Halftone, duotone — NOT glassmorphism (overused AI slop)
- Custom elements: Illustrative, decorative reinforcing brand

### Motion
- Entrance choreography with stagger (50-100ms delays)
- Scroll effects, micro-interactions, ease-out-quart/quint/expo transitions

**NEVER**: Add effects without purpose, sacrifice readability, make everything bold (nothing is), ignore accessibility, overwhelm with motion, copy trendy aesthetics blindly.

---

# Tone Down (Quieter)

Reduce visual intensity in designs that are too bold, aggressive, or overstimulating.

## Assess Current State

1. **Identify intensity sources**:
   - Color saturation, contrast extremes, visual weight
   - Animation excess, complexity, scale
   - Too many bold elements competing

2. **Understand context**: Purpose, audience, what's working, core message

**CRITICAL**: "Quieter" doesn't mean boring. It means refined, sophisticated, easier on the eyes.

## Plan Refinement

- **Color approach**: Desaturate or shift to sophisticated tones
- **Hierarchy**: Which elements stay bold (few), which recede
- **Simplification**: What can be removed
- **Sophistication**: Signal quality through restraint

## Refine Across Dimensions

### Color
- Reduce saturation (70-85% instead of full)
- Muted, sophisticated palette
- Fewer colors, neutral dominance (10% color rule)
- Gentler contrasts, tinted grays (not pure gray)
- Never gray on color — use darker shade or transparency

### Visual Weight
- Reduce font weights (900→600, 700→500)
- Hierarchy through subtlety (weight, size, space), not boldness
- Increase white space, reduce border thickness/opacity

### Simplification
- Remove decorative elements without purpose (gradients, shadows, patterns)
- Simplify shapes, reduce layering, clean up effects

### Motion
- Reduce animation intensity: shorter distances (10-20px instead of 40px), gentler easing
- Remove decorative animations, keep functional
- Subtle micro-interactions, refined easing (ease-out-quart, never bounce)

### Composition
- Reduce scale jumps, align to grid, even out spacing

**NEVER**: Make everything same size (hierarchy matters), remove all color (quiet ≠ grayscale), eliminate personality, sacrifice usability, make everything small and light.

---

# Add Color (Colorize)

Strategically introduce color to designs that are too monochromatic, gray, or lacking warmth.

## Assess Color Opportunity

1. **Understand current state**: Color absence, missed opportunities, context, brand colors
2. **Identify where color adds value**: Semantic meaning (success/error/warning/info), hierarchy, categorization, emotional tone, wayfinding, delight

**CRITICAL**: More color ≠ better. Strategic color beats rainbow vomit.

## Plan Color Strategy

- **Palette**: 2-4 colors max beyond neutrals
- **Dominant** (60%), **Accent** (30%), **Highlight** (10%)
- Each color has a purpose

## Introduce Color Strategically

### Semantic Color
- Success: Green tones (emerald, forest)
- Error: Red/pink (rose, crimson)
- Warning: Orange/amber
- Info: Blue (sky, ocean)

### Accent Application
- Primary actions, links, icons, headers, hover states

### Background & Surfaces
- Replace pure gray with warm neutrals `oklch(97% 0.01 60)` or cool tints `oklch(97% 0.01 250)`
- Subtle gradients (not generic purple-blue)

**Use OKLCH**: Perceptually uniform, great for generating harmonious scales.

### Typography Color
- Brand colors for headings (maintain contrast)
- Highlight text for emphasis

### Balance & Refinement
- **Maintain hierarchy**: 60/30/10 rule for colored elements
- **Accessibility**: WCAG 4.5:1 for text, don't rely on color alone, test for color blindness
- **Cohesion**: Consistent palette, same meanings throughout, temperature consistency

**NEVER**: Use every color, apply without semantic meaning, gray text on colored backgrounds, pure gray or pure black, violate WCAG, make everything colorful, default to purple-blue gradients.

---

# Simplify (Distill)

Remove unnecessary complexity, revealing the essential and creating clarity through ruthless simplification.

## Assess Current State

1. **Identify complexity sources**:
   - Too many elements, excessive variation, information overload
   - Visual noise (unnecessary borders, shadows, backgrounds)
   - Confusing hierarchy, feature creep

2. **Find the essence**: Primary user goal, necessary vs nice-to-have, 20% delivering 80% value

**CRITICAL**: Simplicity is removing obstacles between users and goals. Every element justifies its existence.

## Plan Simplification

- **Core purpose**: ONE thing this should accomplish
- **Essential elements**: Truly necessary
- **Progressive disclosure**: Hide until needed
- **Consolidation**: Combine where possible

## Simplify Across Dimensions

### Information Architecture
- Reduce scope, progressive disclosure, combine related actions
- ONE primary action, few secondary, rest hidden
- Remove redundancy

### Visual Simplification
- 1-2 colors plus neutrals (not 5-7)
- One font family, 3-4 sizes, 2-3 weights
- Remove decorations not serving hierarchy
- Flatten structure — never nest cards inside cards
- Remove unnecessary cards (use spacing/alignment instead)
- Consistent spacing scale

### Layout
- Linear flow over complex grids, remove sidebars
- Full-width, consistent alignment, generous white space

### Interaction
- Reduce choices, smart defaults, inline actions
- Remove steps, clear CTAs

### Content
- Cut copy in half, active voice, remove jargon
- Scannable structure, essential info only, remove redundant copy

### Code
- Remove unused code, flatten component trees, consolidate styles
- Reduce variants (3 covering 90% of cases)

**NEVER**: Remove necessary functionality, sacrifice accessibility, make things so simple they're unclear, remove decision-making info, eliminate hierarchy completely, oversimplify complex domains.

## Document Removed Complexity

If features were removed, document why. Note alternative access paths if needed.

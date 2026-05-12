---
name: motion
description: Add purposeful animations, micro-interactions, motion effects, joyful touches, and technically ambitious visual impact. Use when the user mentions animations, transitions, micro-interactions, motion design, hover effects, delight, polish, personality, or wants to make the UI feel more alive, memorable, or extraordinary.
---

## MANDATORY PREPARATION

Invoke /frontend-design — it contains design principles, anti-patterns, and the **Context Gathering Protocol**. Follow the protocol before proceeding — if no design context exists yet, you MUST run /teach-impeccable first. Additionally gather: performance constraints, what's appropriate for the domain (playful vs professional vs quirky vs elegant).

---

# Purposeful Animation

Analyze where motion would improve the experience:

## Assess Animation Opportunities

1. **Identify static areas**:
   - **Missing feedback**: Actions without visual acknowledgment (button clicks, form submission, etc.)
   - **Jarring transitions**: Instant state changes that feel abrupt (show/hide, page loads, route changes)
   - **Unclear relationships**: Spatial or hierarchical relationships that aren't obvious
   - **Lack of delight**: Functional but joyless interactions
   - **Missed guidance**: Opportunities to direct attention or explain behavior

2. **Understand the context**:
   - What's the personality? (Playful vs serious, energetic vs calm)
   - What's the performance budget? (Mobile-first? Complex page?)
   - Who's the audience? (Motion-sensitive users? Power users who want speed?)
   - What matters most? (One hero animation vs many micro-interactions?)

**CRITICAL**: Respect `prefers-reduced-motion`. Always provide non-animated alternatives.

## Plan Animation Strategy

- **Hero moment**: What's the ONE signature animation?
- **Feedback layer**: Which interactions need acknowledgment?
- **Transition layer**: Which state changes need smoothing?
- **Delight layer**: Where can we surprise and delight?

## Implement Animations

### Entrance Animations
- Page load choreography: Stagger element reveals (100-150ms delays), fade + slide
- Hero section: Dramatic entrance (scale, parallax, or creative effects)
- Content reveals: Scroll-triggered animations via intersection observer
- Modal/drawer entry: Smooth slide + fade, backdrop fade

### Micro-interactions
- **Button feedback**: Hover (scale 1.02-1.05, color shift, shadow), Click (scale 0.95→1, ripple), Loading (spinner/pulse)
- **Form interactions**: Focus (border transition, slight glow), Validation (shake on error, check on success)
- **Toggle switches**: Smooth slide + color transition (200-300ms)
- **Checkboxes/radio**: Check mark animation, ripple
- **Like/favorite**: Scale + rotation, particles, color transition

### State Transitions
- Show/hide: Fade + slide (200-300ms)
- Expand/collapse: Height transition, icon rotation
- Loading: Skeleton screens, spinner animations, progress bars
- Success/error: Color transitions, icon animations, gentle scale pulse

### Navigation & Flow
- Page transitions: Crossfade, shared element transitions
- Tab switching: Slide indicator, content fade/slide
- Scroll effects: Parallax, sticky header state changes, scroll progress

### Feedback & Guidance
- Hover hints: Tooltip fade-ins, cursor changes, element highlights
- Drag & drop: Lift effect (shadow + scale), drop zone highlights
- Copy/paste: Brief highlight flash, "copied" confirmation

## Technical Implementation

### Timing & Easing

**Durations**: 100-150ms (instant feedback), 200-300ms (state changes), 300-500ms (layout changes), 500-800ms (entrance animations)

**Easing (use these, not CSS defaults)**:
```css
--ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1);
--ease-out-quint: cubic-bezier(0.22, 1, 0.36, 1);
--ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
```

Exit animations are faster than entrances (~75% of enter duration).

### CSS Animations
- Transitions for state changes, `@keyframes` for complex sequences
- `transform` + `opacity` only (GPU-accelerated)

### JavaScript Animation
- Web Animations API for programmatic control
- Framer Motion for React
- GSAP for complex sequences

### Performance
- GPU acceleration: Use `transform` and `opacity`, avoid layout properties
- `will-change`: Add sparingly for known expensive animations
- Minimize repaints, use `contain` where appropriate

### Accessibility
```css
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

**NEVER**: Use bounce/elastic easing, animate layout properties, durations >500ms for feedback, animate without purpose, ignore `prefers-reduced-motion`, animate everything, block interaction during animations.

---

# Delight (Joyful Touches)

Add moments of joy, personality, and unexpected polish that transform functional interfaces into delightful experiences.

## Assess Delight Opportunities

1. **Find natural delight moments**:
   - Success states: Completed actions (save, send, publish)
   - Empty states: First-time experiences, onboarding
   - Loading states: Waiting periods that could be entertaining
   - Achievements: Milestones, streaks, completions
   - Interactions: Hover states, clicks, drags
   - Errors: Softening frustrating moments
   - Easter eggs: Hidden discoveries

2. **Understand the context**:
   - Brand personality (Playful? Professional? Quirky? Elegant?)
   - Audience (Tech-savvy? Creative? Corporate?)
   - Emotional context (Accomplishment? Exploration? Frustration?)
   - Appropriateness (Banking app ≠ gaming app)

3. **Define delight strategy**:
   - Subtle sophistication: Refined micro-interactions (luxury brands)
   - Playful personality: Whimsical illustrations and copy (consumer apps)
   - Helpful surprises: Anticipating needs (productivity tools)
   - Sensory richness: Smooth animations, sounds (creative tools)

**CRITICAL**: Delight should enhance usability, never obscure it. If users notice the delight more than their goal, too far.

## Delight Principles

- **Delight amplifies, never blocks**: Quick (< 1 second), skippable, never delays core functionality
- **Surprise and discovery**: Hidden details for users to discover, don't announce every moment
- **Appropriate to context**: Match emotional moment, respect user's state, match brand
- **Compound over time**: Vary responses, reveal deeper layers with continued use

## Delight Techniques

### Micro-interactions & Animation
```css
/* Satisfying button press */
.button { transition: transform 0.1s, box-shadow 0.1s; }
.button:active { transform: translateY(2px); box-shadow: 0 2px 4px rgba(0,0,0,0.2); }
.button:hover { transform: translateY(-2px); transition: transform 0.2s cubic-bezier(0.25, 1, 0.5, 1); }
```

- **Loading**: Playful animations (not just spinners), product-specific messages (not generic AI filler)
- **Success**: Checkmark draw, confetti for major achievements, gentle scale + fade
- **Hover surprises**: Icons that animate, color shifts, tooltips with personality

### Personality in Copy
- Playful error messages ("This page is playing hide and seek")
- Encouraging empty states ("Create something amazing")
- Playful labels ("Send to void" for delete on playful brand)

**AI slop warning**: Avoid cliched loading messages like "Herding pixels", "Consulting the magic 8-ball". Write product-specific copy.

### Illustrations & Visual Personality
- Custom illustrations for empty/error/success states (not stock)
- Animated icons matching brand
- Background effects: particles, gradient mesh, patterns, parallax, time-of-day themes

### Satisfying Interactions
- Drag & drop: Lift effect (shadow, scale), snap animation, undo toast
- Toggle switches: Smooth slide with spring physics, color transition
- Progress: Streak counters, celebratory bars at 100%, badge unlocks with animation

### Sound Design (when appropriate)
- Respect system sound settings, provide mute option, keep volumes subtle
- Never play on every interaction (sound fatigue)

### Easter Eggs & Hidden Delights
- Konami code, hidden keyboard shortcuts, hover reveals, console messages
- Seasonal themes, time-based changes, randomized variations

### Loading & Waiting States
- Interesting messages that rotate, progress with personality
- Fun facts or tips while waiting

## Implementation Patterns
- Animation: Framer Motion (React), GSAP (universal), Lottie (After Effects)
- Sound: Howler.js, use-sound (React)
- Physics: React Spring, Popmotion

**NEVER**: Delay core functionality for delight, force delightful moments, hide poor UX with delight, overdo it, ignore accessibility, sacrifice performance, be inappropriate for context.

---

# Overdrive (Advanced Effects)

Push an interface past conventional limits — using the full power of the browser to make any part of an interface feel extraordinary.

Start your response with:

```
──────────── ⚡ OVERDRIVE ─────────────
》》》 Entering overdrive mode...
```

**EXTRA IMPORTANT**: Context determines what "extraordinary" means. Understand the project's personality before deciding what's appropriate.

### Propose Before Building

Do NOT jump into implementation. MUST:
1. Think through 2-3 different directions with trade-offs
2. Present to user for pick before writing code
3. Only proceed with confirmed direction

### Iterate with Browser Automation

Technically ambitious effects rarely work on first try. MUST use browser automation to preview, verify, iterate.

## Assess What "Extraordinary" Means Here

### For visual/marketing surfaces
Hero sections, landing pages, portfolios — sensory wow: scroll-driven reveals, shader backgrounds, cinematic page transitions, generative art.

### For functional UI
Tables, forms, dialogs, navigation — wow in how it FEELS: dialog morphs from trigger (View Transitions), 100k row tables at 60fps (virtual scrolling), streaming validation, drag-and-drop with spring physics.

### For performance-critical UI
Invisible wow: search filters 50k items without flicker, complex form never blocks main thread, image editor processes in near-real-time.

### For data-heavy interfaces
Charts and dashboards — GPU-accelerated rendering via Canvas/WebGL for massive datasets, animated data transitions, force-directed graphs.

## The Toolkit

### Make transitions feel cinematic
- **View Transitions API** (same-document: all browsers; cross-document: no Firefox) — shared element morphing
- **`@starting-style`** (all browsers) — animate from `display: none` to visible
- **Spring physics** — natural motion with mass, tension, damping. Libraries: motion (Framer Motion), GSAP

### Tie animation to scroll position
- **Scroll-driven animations** (`animation-timeline: scroll()`) — CSS-only parallax, progress bars, reveals (Chrome/Edge/Safari; Firefox: flag — always provide static fallback)

### Render beyond CSS
- **WebGL** (all browsers) — shaders, particles, post-processing. Libraries: Three.js, OGL, regl
- **WebGPU** (Chrome/Edge; Safari partial; Firefox: flag) — always fall back to WebGL2
- **Canvas 2D / OffscreenCanvas** — custom rendering, Web Workers
- **SVG filter chains** — displacement maps, turbulence, morphology

### Make data feel alive
- **Virtual scrolling** — render only visible rows. TanStack Virtual for complex
- **GPU-accelerated charts** — Canvas/WebGL. Libraries: deck.gl, regl
- **Animated data transitions** — morph between chart states. D3 transitions or View Transitions

### Animate complex properties
- **`@property`** (all browsers) — register custom CSS properties, enabling gradient/color animation
- **Web Animations API** (all browsers) — JS-driven animations with CSS performance

### Push performance boundaries
- **Web Workers** — offload computation from main thread
- **OffscreenCanvas** — render in Worker thread
- **WASM** — near-native performance for computation-heavy features

### Interact with the device
- **Web Audio API** — spatial audio, reactive visualizations (requires user gesture)
- **Device APIs** — orientation, ambient light, geolocation (user permission required)

**NOTE**: Enhance how interface FEELS, not what product DOES. Focus on making existing features feel extraordinary.

## Implement with Discipline

### Progressive enhancement (non-negotiable)
Every technique must degrade gracefully. The experience without enhancement must still be good.

```css
@supports (animation-timeline: scroll()) {
  .hero { animation-timeline: scroll(); }
}
```

### Performance rules
- Target 60fps. If dropping below 50, simplify.
- Respect `prefers-reduced-motion`. Provide beautiful static alternative.
- Lazy-initialize heavy resources (WebGL contexts, WASM) only when near viewport.
- Pause off-screen rendering. Test on real mid-range devices.

**NEVER**: Ignore `prefers-reduced-motion`, ship effects causing jank on mid-range, use bleeding-edge APIs without fallback, add sound without opt-in, use ambition to mask weak fundamentals, layer multiple competing extraordinary moments.

## Verify the Result
- **Wow test**: Show someone who hasn't seen it. Do they react?
- **Removal test**: Take it away. Does the experience feel diminished?
- **Device test**: Run on phone, tablet, Chromebook. Still smooth?
- **Accessibility test**: Enable reduced motion. Still beautiful?
- **Context test**: Does this make sense for THIS brand/audience?

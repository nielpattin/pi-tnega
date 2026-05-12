---
name: performance
description: Diagnose and fix UI performance — loading speed, rendering, animations, images, bundle size, Core Web Vitals. Includes React/Next.js best practices from Vercel Engineering. Use when the user mentions slow, laggy, janky, bundle size, load time, Core Web Vitals, or wants a faster, smoother experience.
---

# UI Performance Optimization

## Assess Performance Issues

1. **Measure current state**:
   - **Core Web Vitals**: LCP, FID/INP, CLS
   - **Load time**: Time to interactive, first contentful paint
   - **Bundle size**: JavaScript, CSS, images
   - **Runtime**: Frame rate, memory, CPU
   - **Network**: Request count, payload sizes

2. **Identify bottlenecks**: What's slow? What's causing it? How bad? Who's affected?

**CRITICAL**: Measure before and after. Optimize what actually matters.

## Optimization Strategy

### Loading Performance

**Optimize Images**: WebP/AVIF, proper sizing, lazy loading, `srcset`, compression (80-85% quality), CDN.

**Reduce JavaScript Bundle**: Code splitting, tree shaking, remove unused deps, lazy load with dynamic imports.

**Optimize CSS**: Remove unused CSS, critical CSS inline, minimized files, `content-visibility`.

**Optimize Fonts**: `font-display: swap`, subset fonts, preload critical, limit weights loaded.

**Loading Strategy**: Critical resources first, preload key assets, prefetch next pages, service worker caching.

### Rendering Performance

**Avoid Layout Thrashing**: Batch reads then writes (don't alternate).

**Optimize Rendering**: CSS `contain`, minimize DOM depth, `content-visibility: auto`, virtual scrolling for long lists.

**Reduce Paint**: `transform` and `opacity` for animations (GPU), avoid animating layout properties, `will-change` sparingly.

### Animation Performance
Target 60fps (16ms per frame). Use `requestAnimationFrame` for JS animations. Debounce/throttle scroll handlers.

```css
/* ✅ GPU-accelerated */
.animated { transform: translateX(100px); opacity: 0.5; }
/* ❌ CPU-bound */
.animated { left: 100px; width: 300px; }
```

### React/Framework Optimization
- `memo()` for expensive components, `useMemo`/`useCallback` for expensive computations
- Virtualize long lists, code split routes, avoid inline functions in render
- Use React DevTools Profiler

### Network Optimization
- Combine small files, SVG sprites, inline critical assets
- API pagination, GraphQL only needed fields, gzip/brotli, HTTP caching, CDN
- Adaptive loading based on connection, optimistic UI

## Core Web Vitals

### LCP < 2.5s
Optimize hero images, inline critical CSS, preload key resources, CDN, SSR.

### FID < 100ms / INP < 200ms
Break up long tasks, defer non-critical JS, web workers, reduce JS execution.

### CLS < 0.1
Set image/video dimensions, `aspect-ratio`, reserve space for ads/embeds, avoid layout-shifting animations.

```css
.image-container { aspect-ratio: 16 / 9; }
```

## Performance Monitoring
- Chrome DevTools (Lighthouse, Performance panel), WebPageTest
- Core Web Vitals (Chrome UX Report), bundle analyzers
- Perf monitoring: Sentry, DataDog, New Relic

**NEVER**: Optimize without measuring, sacrifice accessibility for performance, break functionality, use `will-change` everywhere, lazy load above-fold content, micro-optimize while ignoring major bottlenecks, forget mobile performance.

---

# Vercel React Best Practices

Comprehensive performance optimization guide for React and Next.js applications (70 rules across 8 categories).

## When to Apply
- Writing new React components or Next.js pages
- Implementing data fetching (client or server-side)
- Reviewing code for performance issues
- Refactoring existing React/Next.js code
- Optimizing bundle size or load times

## Quick Reference

### 1. Eliminating Waterfalls (CRITICAL)
- `async-cheap-condition-before-await` — Check cheap sync conditions before awaiting
- `async-defer-await` — Move await into branches where used
- `async-parallel` — Use Promise.all() for independent operations
- `async-dependencies` — Use better-all for partial dependencies
- `async-api-routes` — Start promises early, await late
- `async-suspense-boundaries` — Use Suspense to stream content

### 2. Bundle Size Optimization (CRITICAL)
- `bundle-barrel-imports` — Import directly, avoid barrel files
- `bundle-analyzable-paths` — Prefer statically analyzable paths
- `bundle-dynamic-imports` — Use next/dynamic for heavy components
- `bundle-defer-third-party` — Load analytics after hydration
- `bundle-conditional` — Load only when feature activated
- `bundle-preload` — Preload on hover/focus

### 3. Server-Side Performance (HIGH)
- `server-auth-actions` — Authenticate server actions
- `server-cache-react` — Use React.cache() for per-request dedup
- `server-cache-lru` — LRU cache for cross-request caching
- `server-dedup-props` — Avoid duplicate serialization in RSC props
- `server-hoist-static-io` — Hoist static I/O to module level
- `server-no-shared-module-state` — Avoid module-level mutable state in RSC/SSR
- `server-serialization` — Minimize data passed to client components
- `server-parallel-fetching` — Restructure for parallel fetches
- `server-parallel-nested-fetching` — Chain nested fetches per item
- `server-after-nonblocking` — Use after() for non-blocking ops

### 4. Client-Side Data Fetching (MEDIUM-HIGH)
- `client-swr-dedup` — SWR for automatic request dedup
- `client-event-listeners` — Deduplicate global event listeners
- `client-passive-event-listeners` — Use passive listeners for scroll
- `client-localstorage-schema` — Version and minimize localStorage data

### 5. Re-render Optimization (MEDIUM)
- `rerender-defer-reads` — Don't subscribe to state only used in callbacks
- `rerender-memo` — Extract expensive work into memoized components
- `rerender-memo-with-default-value` — Hoist default non-primitive props
- `rerender-dependencies` — Use primitive deps in effects
- `rerender-derived-state` — Subscribe to derived booleans, not raw values
- `rerender-derived-state-no-effect` — Derive during render, not effects
- `rerender-functional-setstate` — Functional setState for stable callbacks
- `rerender-lazy-state-init` — Pass function to useState for expensive values
- `rerender-simple-expression-in-memo` — Avoid memo for simple primitives
- `rerender-split-combined-hooks` — Split hooks with independent deps
- `rerender-move-effect-to-event` — Interaction logic in event handlers
- `rerender-transitions` — startTransition for non-urgent updates
- `rerender-use-deferred-value` — Defer expensive renders
- `rerender-use-ref-transient-values` — Refs for transient frequent values
- `rerender-no-inline-components` — Don't define components inside components

### 6. Rendering Performance (MEDIUM)
- `rendering-animate-svg-wrapper` — Animate div wrapper, not SVG
- `rendering-content-visibility` — For long lists
- `rendering-hoist-jsx` — Extract static JSX outside components
- `rendering-svg-precision` — Reduce SVG coordinate precision
- `rendering-hydration-no-flicker` — Inline script for client-only data
- `rendering-hydration-suppress-warning` — Suppress expected mismatches
- `rendering-activity` — Activity component for show/hide
- `rendering-conditional-render` — Use ternary, not &&
- `rendering-usetransition-loading` — Prefer useTransition for loading state
- `rendering-resource-hints` — React DOM resource hints for preloading
- `rendering-script-defer-async` — Defer or async on script tags

### 7. JavaScript Performance (LOW-MEDIUM)
- `js-batch-dom-css` — Group CSS changes via classes or cssText
- `js-index-maps` — Build Map for repeated lookups
- `js-cache-property-access` — Cache object properties in loops
- `js-cache-function-results` — Cache in module-level Map
- `js-cache-storage` — Cache localStorage reads
- `js-combine-iterations` — Combine filter/map into one loop
- `js-length-check-first` — Check array length before expensive comparison
- `js-early-exit` — Return early
- `js-hoist-regexp` — Hoist RegExp creation outside loops
- `js-min-max-loop` — Loop for min/max instead of sort
- `js-set-map-lookups` — Set/Map for O(1) lookups
- `js-tosorted-immutable` — Use toSorted() for immutability
- `js-flatmap-filter` — Use flatMap to map and filter in one pass
- `js-request-idle-callback` — Defer non-critical work to browser idle time

### 8. Advanced Patterns (LOW)
- `advanced-effect-event-deps` — Don't put useEffectEvent results in deps
- `advanced-event-handler-refs` — Store event handlers in refs
- `advanced-init-once` — Initialize app once per load
- `advanced-use-latest` — useLatest for stable callback refs

## Reference Files

**Full expanded guide** (all rules with explanations and code examples): [AGENTS.md](AGENTS.md)

**Repository overview** (structure, usage, conventions): [README.md](README.md)

**Individual rule files** (70 files in `rules/`):

**Eliminating Waterfalls (CRITICAL):** `rules/async-cheap-condition-before-await.md`, `rules/async-defer-await.md`, `rules/async-parallel.md`, `rules/async-dependencies.md`, `rules/async-api-routes.md`, `rules/async-suspense-boundaries.md`

**Bundle Size (CRITICAL):** `rules/bundle-barrel-imports.md`, `rules/bundle-analyzable-paths.md`, `rules/bundle-dynamic-imports.md`, `rules/bundle-defer-third-party.md`, `rules/bundle-conditional.md`, `rules/bundle-preload.md`

**Server-Side (HIGH):** `rules/server-auth-actions.md`, `rules/server-cache-react.md`, `rules/server-cache-lru.md`, `rules/server-dedup-props.md`, `rules/server-hoist-static-io.md`, `rules/server-no-shared-module-state.md`, `rules/server-serialization.md`, `rules/server-parallel-fetching.md`, `rules/server-parallel-nested-fetching.md`, `rules/server-after-nonblocking.md`

**Client-Side Data Fetching (MEDIUM-HIGH):** `rules/client-swr-dedup.md`, `rules/client-event-listeners.md`, `rules/client-passive-event-listeners.md`, `rules/client-localstorage-schema.md`

**Re-render Optimization (MEDIUM):** `rules/rerender-defer-reads.md`, `rules/rerender-memo.md`, `rules/rerender-memo-with-default-value.md`, `rules/rerender-dependencies.md`, `rules/rerender-derived-state.md`, `rules/rerender-derived-state-no-effect.md`, `rules/rerender-functional-setstate.md`, `rules/rerender-lazy-state-init.md`, `rules/rerender-simple-expression-in-memo.md`, `rules/rerender-split-combined-hooks.md`, `rules/rerender-move-effect-to-event.md`, `rules/rerender-transitions.md`, `rules/rerender-use-deferred-value.md`, `rules/rerender-use-ref-transient-values.md`, `rules/rerender-no-inline-components.md`

**Rendering Performance (MEDIUM):** `rules/rendering-animate-svg-wrapper.md`, `rules/rendering-content-visibility.md`, `rules/rendering-hoist-jsx.md`, `rules/rendering-svg-precision.md`, `rules/rendering-hydration-no-flicker.md`, `rules/rendering-hydration-suppress-warning.md`, `rules/rendering-activity.md`, `rules/rendering-conditional-render.md`, `rules/rendering-usetransition-loading.md`, `rules/rendering-resource-hints.md`, `rules/rendering-script-defer-async.md`

**JavaScript Performance (LOW-MEDIUM):** `rules/js-batch-dom-css.md`, `rules/js-index-maps.md`, `rules/js-cache-property-access.md`, `rules/js-cache-function-results.md`, `rules/js-cache-storage.md`, `rules/js-combine-iterations.md`, `rules/js-length-check-first.md`, `rules/js-early-exit.md`, `rules/js-hoist-regexp.md`, `rules/js-min-max-loop.md`, `rules/js-set-map-lookups.md`, `rules/js-tosorted-immutable.md`, `rules/js-flatmap-filter.md`, `rules/js-request-idle-callback.md`

**Advanced Patterns (LOW):** `rules/advanced-effect-event-deps.md`, `rules/advanced-event-handler-refs.md`, `rules/advanced-init-once.md`, `rules/advanced-use-latest.md`

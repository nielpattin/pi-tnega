---
name: robustness
description: Strengthen interfaces against edge cases, errors, internationalization issues, and unclear copy. Makes interfaces production-ready with resilient error handling and clear communication. Use when the user wants to harden, handle edge cases, fix overflow/i18n issues, improve error messages, or clarify confusing text.
---

## MANDATORY PREPARATION

Invoke /frontend-design — it contains design principles, anti-patterns, and the **Context Gathering Protocol**. Follow the protocol before proceeding — if no design context exists yet, you MUST run /teach-impeccable first. Additionally gather: audience technical level and users' mental state in context.

---

# Hardening (Edge Cases & Errors)

Strengthen interfaces against edge cases, errors, i18n, and real-world usage that breaks idealized designs.

## Assess Hardening Needs

**Test with extreme inputs**: Very long text (names, descriptions), very short (empty), special characters (emoji, RTL, accents), large numbers, many items (1000+), no data (empty states).

**Test error scenarios**: Network failures (offline, slow, timeout), API errors (400/401/403/404/429/500), validation errors, permission errors, rate limiting, concurrent operations.

**Test internationalization**: Long translations (German: +30%), RTL (Arabic, Hebrew), CJK characters, date/time formats, number formats, currency symbols.

## Hardening Dimensions

### Text Overflow & Wrapping
```css
.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.line-clamp { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.wrap { word-wrap: break-word; overflow-wrap: break-word; hyphens: auto; }

/* Prevent flex/grid overflow */
.flex-item { min-width: 0; overflow: hidden; }
.grid-item { min-width: 0; min-height: 0; }
```

### Internationalization
- Add 30-40% space budget for translations
- Use flexbox/grid that adapts to content
- Avoid fixed widths on text containers
- Use logical properties (`margin-inline-start`, `padding-inline`) for RTL
- Use `Intl` API for date/time/number formatting
- Use proper i18n library for pluralization

### Error Handling
- Network errors: Clear message + retry button
- API errors: Handle each status code appropriately (401→login, 403→permission, 404→not found, 500→generic)
- Form validation: Inline errors, clear specific messages, preserve input on error
- Graceful degradation: Core works without JS, images have alt text

### Edge Cases & Boundary Conditions
- **Empty states**: No items, no search results, no notifications — provide clear next action
- **Loading states**: Initial load, pagination, refresh — show what's loading
- **Large datasets**: Pagination or virtual scrolling, search/filter
- **Concurrent operations**: Prevent double-submission, handle race conditions, optimistic updates with rollback
- **Permission states**: No permission to view/edit, read-only mode, clear explanation
- **Browser compatibility**: Polyfills, CSS fallbacks, feature detection

### Input Validation
- Client-side: Required fields, format validation (email, phone, URL), length limits
- Server-side (always): Never trust client-side only, validate and sanitize all inputs

### Accessibility Resilience
- Keyboard navigation, logical tab order, focus management in modals
- Screen reader support: ARIA labels, live regions, descriptive alt text, semantic HTML
- Motion sensitivity: `prefers-reduced-motion` media query
- High contrast mode: Don't rely only on color

### Performance Resilience
- Slow connections: Progressive loading, skeleton screens, optimistic UI
- Memory leaks: Clean up event listeners, cancel subscriptions, clear timers
- Throttling/debouncing for scroll and search handlers

## Testing Strategies
- Manual: Extreme data, different languages, offline, slow connection (3G throttle), screen reader, keyboard-only
- Automated: Unit tests for edge cases, integration for error scenarios, E2E for critical paths, a11y tests (axe/WAVE)

**NEVER**: Assume perfect input, ignore i18n, leave generic error messages ("Error occurred"), forget offline, trust client-side alone, use fixed widths for text, assume English-length text, block entire interface when one component errors.

---

# Clarity (UX Copy)

Improve unclear, confusing, or poorly written interface text.

## Assess Current Copy

1. **Find clarity problems**: Jargon, ambiguity, passive voice, wordiness, assumptions, missing context, tone mismatch
2. **Understand context**: Audience, user's mental state (stressed? confident?), desired action, constraints

## Plan Copy Improvements
- **Primary message**: ONE thing users need to know
- **Action needed**: What to do next
- **Tone**: Helpful? Apologetic? Encouraging?
- **Constraints**: Length limits, brand voice, localization

## Improve Copy Systematically

### Error Messages
Bad: "Error 403: Forbidden" → Good: "You don't have permission. Contact your admin."
Bad: "Invalid input" → Good: "Email needs an @ symbol. Try: name@example.com"

**Principles**: Plain language, suggest fix, don't blame, include examples, link to help.

### Form Labels & Instructions
Bad: "DOB (MM/DD/YYYY)" → Good: "Date of birth" (with format placeholder)
Bad: "Enter value here" → Good: "Your email address"

**Principles**: Clear specific labels, show format with examples, instructions before field, explain why you ask.

### Button & CTA Text
Bad: "Click here" / "Submit" / "OK" → Good: "Create account" / "Save changes" / "Got it, thanks"

**Principles**: Describe action specifically, active voice (verb + noun), match user's mental model.

### Empty States
Bad: "No items" → Good: "No projects yet. Create your first project to get started."

**Principles**: Explain why empty, show next action, welcoming not dead-end.

### Success Messages
Bad: "Success" → Good: "Settings saved! Your changes will take effect immediately."

**Principles**: Confirm what happened, explain next, brief but complete.

### Loading States
Bad: "Loading..." (30+ seconds) → Good: "Analyzing your data... this usually takes 30-60 seconds"

**Principles**: Set expectations, explain what's happening, show progress, offer escape hatch.

### Confirmation Dialogs
Bad: "Are you sure?" → Good: "Delete 'Project Alpha'? This can't be undone."

**Principles**: State specific action, explain consequences, clear button labels ("Delete" not "Yes"), don't overuse.

## Clarity Principles
1. **Be specific**: "Enter email" not "Enter value"
2. **Be concise**: Cut unnecessary words
3. **Be active**: "Save changes" not "Changes will be saved"
4. **Be human**: "Oops, something went wrong" not "System error encountered"
5. **Be helpful**: Tell what to do, not just what happened
6. **Be consistent**: Same terms throughout

**NEVER**: Use jargon, blame users ("You made an error"), be vague, use passive voice, write overly long explanations, use humor for errors, assume technical knowledge, vary terminology, use placeholders as only labels, repeat information.

# Storybook fidelity convention

Applies to every `Product/*` story in `apps/desktop/stories` and `packages/ui/stories`. `Primitives/*` and `Design System/*` are exempt: they demonstrate a component's states, not a product surface, and there is no user path to a StatTile emphasis.

## Every product story maps to a state a real user can reach

Storybook is where pixel work happens, so its stories get treated as ground truth for what the product looks like. That only holds if every story is a state the app actually renders.

Two findings in #1433 — a 135px hero offset and a broken vertical centring — were measured against a story that composed a state the app never renders. Neither reproduced in the built app. The story was not wrong about the component; it was wrong about the product, and every measurement taken against it was wasted.

So each story carries a `// Real path:` comment directly above it, naming how a user gets there:

```tsx
// Real path: sidebar → 扩展 → 技能, with skills installed.
export const Populated: Story = { … }
```

The annotation is prose on purpose. Its value is that someone traced the path and wrote it down; a machine-checkable schema would be satisfied by a plausible-looking lie just as easily. So the convention splits along what a machine can decide. `scripts/check-story-annotations.mjs` checks that the sentence *exists*, and fails on any export it cannot classify rather than skipping it — write stories as `export const Name: Story = …` and nothing else. **It cannot tell you the sentence is true.** Only a reviewer following the call chain can, and reviewing that sentence is the point of writing it. The script's header explains why it stops there.

Two of the first batch of annotations were wrong, and both were caught by reading rather than by running anything: one named a path through a builder that cannot produce the state (`CommandPaletteDisabledCommand`), and one named two hosts for a frame that is only one of them. Write the sentence narrow enough to be falsifiable — the host, the builder, the gate — because a sentence vague enough to always be true buys nothing.

## One story per state, not per variant

A story earns its place by rendering pixels no other story renders. A second level of a page — a route level that replaces the list, a form that shares no content with the screen behind it — is its own state, and gets its own story even though a click reaches it. A narrower version of a state already on screen is not.

Two facts decide it, and both were guessed wrong once:

- **Where a story renders.** `scripts/storybook-visual-smoke.mjs` renders each `product-smoke-manifest.json` surface at the viewports and colour schemes that surface declares — several are wide-only or light-only, and every skipped viewport carries a written opt-out reason — and every *other* story exactly once, at 1280 wide in light (`catalogJobs`). A story is not a width matrix; a surface that needs one belongs in the manifest, with its reasons. And `parameters.viewport.defaultViewport` does nothing in Storybook 10, so a story claiming a viewport that way has been rendering at the default width all along.
- **Whether `play` reaches the state.** `play` runs in the browser, so a story that clicks into a level renders that level — for a reviewer and for the smoke pass, which also fails if the click never lands (see below).

Extra stories still cost: a reviewer scanning the sidebar cannot tell which entry is the page, and duplicates re-render the same pixels every run while claiming coverage they do not add. Where a state matters but renders nothing new, pin it somewhere that runs — a `packages/ui` test or an e2e journey.

## The frame matters, not just the component

A story that mounts the right component inside the wrong wrapper is still unreachable. If the app wraps a surface in a class that owns its height, padding or alignment, the story has to use that wrapper too — otherwise every geometry comparison against the story is measuring the story's own scaffolding.

Import the wrapper rather than retyping its classes. A hand-copied chain drifts the same way a hand-copied convention block does, and it drifts invisibly: `onboarding.stories.tsx` was rewritten once to "the app's chain, class for class", and the rewrite inverted two levels of nesting and dropped a 32px header. Write out only what genuinely cannot be imported, and say in the comment which part that is.

When a component has two hosts, one frame is not both. `capability-audit-strip.stories.tsx` named 技能 and 计划提醒 as paths to a single story built in the skills frame; the plan-reminder page mounts the same strip inside a 1024px clamp with no `.maka-module-main` ancestor, so a `:has(> …)` grid rule that page never gets was part of every measurement taken there. Either build the second frame or say in the annotation which host the story is and what the other one changes. Naming the divergence is cheap; a story that silently averages two frames is worse than no story.

## Derive the fixture, do not assert it

If the runtime computes a field, ask the runtime for it. A story that hardcodes what a classifier would have returned is asserting a fact rather than showing one, and nothing fails when the classifier moves.

## A `play` function is a step, not a test report

A `play` that throws — including from an assertion — fails the smoke run and CI: `scripts/storybook-visual-smoke.mjs` subscribes to `playFunctionThrewException` and `unhandledErrorsWhilePlaying`, and the throw also surfaces as a console error it collects. What `play` cannot do is *report*: there is no test addon, so a run tells you the story broke, not which assertion, in what state, or against what expectation. It is also the slowest place to put a check, because reaching it means building and serving Storybook.

So put behavioural and computed-style contracts where they can name what they check — a `packages/ui` test, an e2e journey, or the smoke script's `checks` — and use `play` for what it is good at: driving a story into the state it claims to render.

## A story that renders nothing is not a story

Components that report by exception return `null` in their healthy state. Three `capability-audit-strip` stories passed all-zero counts and rendered blank panels under confident annotations. "This element is absent from the page" needs no story; delete it and say so where the remaining story explains when the element appears.

## When the app and a story disagree, one of them is wrong

Fix the story or delete it. Never keep both "the app" and "the story version" of a surface alive; the second one rots silently and takes reviewers with it.

## Side-by-side stories are scaffolds

Where a story deliberately puts several states next to each other for review, say so in the annotation. The arrangement is a review aid; each panel is the reachable state, and the row itself is not a screen anyone sees.

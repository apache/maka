<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Storybook fidelity convention

Applies to every `Product/*` story in `apps/desktop/stories` and `packages/ui/stories`. `Primitives/*` and `Design System/*` are exempt: they demonstrate a component's states, not a product surface.

## Every product story maps to a state a real user can reach

Storybook is where pixel work happens, so its stories get treated as ground truth for what the product looks like. That only holds if every story is a state the app actually renders.

Two findings in #1433 — a 135px hero offset and a broken vertical centring — were measured against a story that composed a state the app never renders. Neither reproduced in the built app. The story was not wrong about the component; it was wrong about the product, and every measurement taken against it was wasted.

So each story carries a `// Real path:` comment directly above it, naming how a user gets there:

```tsx
// Real path: sidebar → 扩展 → 技能, with skills installed.
export const Populated: Story = { … }
```

The annotation is prose on purpose. Its value is that someone traced the path and wrote it down; a mechanical presence check would be satisfied by a plausible-looking lie just as easily. Only a reviewer following the call chain can determine whether it is true.

Two of the first batch of annotations were wrong, and both were caught by reading rather than by running anything: one named a path through a builder that cannot produce the state (`CommandPaletteDisabledCommand`), and one named two hosts for a frame that is only one of them. Write the sentence narrow enough to be falsifiable — the host, the builder, the gate — because a sentence vague enough to always be true buys nothing.

## One story per state, not per variant

A story earns its place by rendering pixels no other story renders. A second level of a page — a route level that replaces the list, a form that shares no content with the screen behind it — is its own state, and gets its own story even though a click reaches it. A narrower version of a state already on screen is not.

Two facts decide it, and both were guessed wrong once:

- **Where a story renders.** CI mounts every story exactly once at 1280 wide in light. It does not maintain a viewport, theme or screenshot matrix. Responsive and theme behaviour belongs in a focused component contract or the real desktop E2E harness.
- **Whether `play` reaches the state.** `play` drives a story into the state a reviewer needs to see, and CI runs it — so the state it lands on is the state the smoke reads, and a story that only differs by a `play` step is a second state, not a variant.

Extra stories still cost: a reviewer scanning the sidebar cannot tell which entry is the page, and duplicates re-render the same pixels every run while claiming coverage they do not add. Where a state matters but renders nothing new, pin it somewhere that runs — a `packages/ui` test or an e2e journey.

## The frame matters, not just the component

A story that mounts the right component inside the wrong wrapper is still unreachable. If the app wraps a surface in a class that owns its height, padding or alignment, the story has to use that wrapper too — otherwise every geometry comparison against the story is measuring the story's own scaffolding.

Import the wrapper rather than retyping its classes. A hand-copied chain drifts the same way a hand-copied convention block does, and it drifts invisibly: `onboarding.stories.tsx` was rewritten once to "the app's chain, class for class", and the rewrite inverted two levels of nesting and dropped a 32px header. Write out only what genuinely cannot be imported, and say in the comment which part that is.

When a component has two hosts, one frame is not both. `capability-audit-strip.stories.tsx` named 技能 and 定时任务 as paths to a single story built in the skills frame; the scheduled-task page mounts the same strip inside a 1024px clamp with no `.maka-module-main` ancestor, so a `:has(> …)` grid rule that page never gets was part of every measurement taken there. Either build the second frame or say in the annotation which host the story is and what the other one changes. Naming the divergence is cheap; a story that silently averages two frames is worse than no story.

## Derive the fixture, do not assert it

If the runtime computes a field, ask the runtime for it. A story that hardcodes what a classifier would have returned is asserting a fact rather than showing one, and nothing fails when the classifier moves.

## A `play` function runs in CI, and its assertions are real

The render smoke waits for Storybook's `storyFinished` event before it reads the accessibility tree, so every `play` function executes and a failed assertion inside one fails the lane. This paragraph used to say the opposite — that the smoke mounts with autoplay disabled — and it was wrong: nothing passes `embed`, and #4766 landed 18 stories whose assertions are the coverage.

That makes `play` the right home for a behavioural contract whose subject is the browser: a live Selection, a caret between text nodes, an undo transaction, a portal's identity across a re-render. None of those exist in a `packages/ui` DOM shim, and none of them need Electron.

It is still not a place for geometry or theme matrices. CI mounts every story once, at 1280 wide, in light; a contract that depends on any other viewport or scheme belongs in a `packages/ui` test or the desktop E2E harness. And a rule that is pure state — which commands a Session offers, what a query parses to — belongs in a unit test, where it costs milliseconds instead of a browser.

Write the assertion so it can only pass for the reason it names. A story that mounts the surface and then observes it cannot see anything that happened during the mount, so a probe that must be installed first (a constructor count, an event before the first paint) belongs in a test that owns the global.

## A story that renders nothing is not a story

Components that report by exception return `null` in their healthy state. Three `capability-audit-strip` stories passed all-zero counts and rendered blank panels under confident annotations. "This element is absent from the page" needs no story; delete it and say so where the remaining story explains when the element appears.

## When the app and a story disagree, one of them is wrong

Fix the story or delete it. Never keep both "the app" and "the story version" of a surface alive; the second one rots silently and takes reviewers with it.

## Side-by-side stories are scaffolds

Where a story deliberately puts several states next to each other for review, say so in the annotation. The arrangement is a review aid; each panel is the reachable state, and the row itself is not a screen anyone sees.

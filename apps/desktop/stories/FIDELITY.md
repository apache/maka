# Storybook fidelity convention

Applies to every `Product/*` story in `apps/desktop/stories` and `packages/ui/stories`. `Primitives/*` and `Design System/*` are exempt: they demonstrate a component's states, not a product surface, and there is no user path to a Button variant.

## Every product story maps to a state a real user can reach

Storybook is where pixel work happens, so its stories get treated as ground truth for what the product looks like. That only holds if every story is a state the app actually renders.

Two findings in #1433 — a 135px hero offset and a broken vertical centring — were measured against a story that composed a state the app never renders. Neither reproduced in the built app. The story was not wrong about the component; it was wrong about the product, and every measurement taken against it was wasted.

So each story carries a `// Real path:` comment directly above it, naming how a user gets there:

```tsx
// Real path: sidebar → 扩展 → 技能, with skills installed.
export const Populated: Story = { … }
```

The annotation is prose on purpose. Its value is that someone traced the path and wrote it down; a machine-checkable schema would be satisfied by a plausible-looking lie just as easily. `story-annotation-contract.test.ts` checks that the sentence exists — nothing more. **It cannot tell you the sentence is true.** Only a reviewer following the call chain can, and reviewing that sentence is the point of writing it.

## The frame matters, not just the component

A story that mounts the right component inside the wrong wrapper is still unreachable. If the app wraps a surface in a class that owns its height, padding or alignment, the story has to use that wrapper too — otherwise every geometry comparison against the story is measuring the story's own scaffolding.

Import the wrapper rather than retyping its classes. A hand-copied chain drifts the same way a hand-copied convention block does, and it drifts invisibly: `onboarding.stories.tsx` was rewritten once to "the app's chain, class for class", and the rewrite inverted two levels of nesting and dropped a 32px header. Write out only what genuinely cannot be imported, and say in the comment which part that is.

## Derive the fixture, do not assert it

If the runtime computes a field, ask the runtime for it. A story that hardcodes what a classifier would have returned is asserting a fact rather than showing one, and nothing fails when the classifier moves.

`permission-dialog.stories.tsx` spelled out `category` and `reason` for each request. Four of the combinations could not occur: `rm -rf …` classifies as `fs_destructive`, not `shell_unsafe`; `git clean -fdx` is the reverse; WebFetch's reason falls through to `custom`. The stories rendered fine the whole time. They now call `preToolUse`, which also throws when the mode does not prompt at all — an impossible fixture fails where you can see it instead of quietly showing you a screen that does not exist.

## A story that renders nothing is not a story

Components that report by exception return `null` in their healthy state. Three `capability-audit-strip` stories passed all-zero counts and rendered blank panels under confident annotations. "This element is absent from the page" needs no story; delete it and say so where the remaining story explains when the element appears.

## When the app and a story disagree, one of them is wrong

Fix the story or delete it. Never keep both "the app" and "the story version" of a surface alive; the second one rots silently and takes reviewers with it.

## Side-by-side stories are scaffolds

Where a story deliberately puts several states next to each other for review, say so in the annotation. The arrangement is a review aid; each panel is the reachable state, and the row itself is not a screen anyone sees.

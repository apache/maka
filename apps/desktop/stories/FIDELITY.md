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

What it does guarantee is that nothing slips past it unseen. It derives the files it scans from `.storybook/main.ts` rather than restating them, and it fails on any top-level export it cannot classify instead of skipping it. A contract that quietly ignores what it does not parse passes *because* it did not understand — which is the same failure as a story that quietly shows a screen the app does not render. So stories use `export const Name: Story = …` and nothing else; a new form is a deliberate widening of the contract, not a silent exemption.

Two of the first batch of annotations were wrong, and both were caught by reading rather than by running anything: one named a path through a builder that cannot produce the state (`CommandPaletteDisabledCommand`), and one named two hosts for a frame that is only one of them. Write the sentence narrow enough to be falsifiable — the host, the builder, the gate — because a sentence vague enough to always be true buys nothing.

## The frame matters, not just the component

A story that mounts the right component inside the wrong wrapper is still unreachable. If the app wraps a surface in a class that owns its height, padding or alignment, the story has to use that wrapper too — otherwise every geometry comparison against the story is measuring the story's own scaffolding.

Import the wrapper rather than retyping its classes. A hand-copied chain drifts the same way a hand-copied convention block does, and it drifts invisibly: `onboarding.stories.tsx` was rewritten once to "the app's chain, class for class", and the rewrite inverted two levels of nesting and dropped a 32px header. Write out only what genuinely cannot be imported, and say in the comment which part that is.

When a component has two hosts, one frame is not both. `capability-audit-strip.stories.tsx` named 技能 and 计划提醒 as paths to a single story built in the skills frame; the plan-reminder page mounts the same strip inside a 1024px clamp with no `.maka-module-main` ancestor, so a `:has(> …)` grid rule that page never gets was part of every measurement taken there. Either build the second frame or say in the annotation which host the story is and what the other one changes. Naming the divergence is cheap; a story that silently averages two frames is worse than no story.

## Derive the fixture, do not assert it

If the runtime computes a field, ask the runtime for it. A story that hardcodes what a classifier would have returned is asserting a fact rather than showing one, and nothing fails when the classifier moves.

`permission-dialog.stories.tsx` spelled out `category` and `reason` for each request. Four of the combinations could not occur: `rm -rf …` classifies as `fs_destructive`, not `shell_unsafe`; `git clean -fdx` is the reverse; WebFetch's reason falls through to `custom`. The stories rendered fine the whole time. They now call `preToolUse`, which also throws when the mode does not prompt at all — an impossible fixture fails where you can see it instead of quietly showing you a screen that does not exist.

Running the classifier does not clear the arguments, and one round of review missed exactly that gap. `OfficeDocumentEdit` went on shipping `operation: 'replaceText'` after the derivation landed — the tool takes `create | add | set | remove`, its Zod schema rejects the call before the permission engine is ever asked, and the dialog renders the operation verbatim. `preToolUse` had nothing to say about it because classification is not validation. So the rule covers both halves: derive what the runtime computes, and check the args against the schema that would have received them. Naming the authority in the annotation — the enum, the file — is what makes the next person able to check it.

## A story that renders nothing is not a story

Components that report by exception return `null` in their healthy state. Three `capability-audit-strip` stories passed all-zero counts and rendered blank panels under confident annotations. "This element is absent from the page" needs no story; delete it and say so where the remaining story explains when the element appears.

## When the app and a story disagree, one of them is wrong

Fix the story or delete it. Never keep both "the app" and "the story version" of a surface alive; the second one rots silently and takes reviewers with it.

## Side-by-side stories are scaffolds

Where a story deliberately puts several states next to each other for review, say so in the annotation. The arrangement is a review aid; each panel is the reachable state, and the row itself is not a screen anyone sees.

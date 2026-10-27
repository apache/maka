Closes #[issue number]

## Description

Describe in English the changes made in this pull request and the problem it solves.
Please keep **1 PR to solve 1 problem**, and keep **small improvements small** to make the PR easier to review and to merge.

## Screenshot

| Platform | Before                       | After                       |
| -------- | ---------------------------- | --------------------------- |
| iOS      | [Put Before Screenshot here] | [Put After Screenshot here] |
| Android  | [Put Before Screenshot here] | [Put After Screenshot here] |

## Public API

List every public item this pull request adds, changes or removes, grouped by crate or module, with its signature and one line on what it is for: Rust items, JS exports, elements, props, style keys, Tailwind utilities, `nsh.json` keys, CLI commands and SDK APIs. If none, remove this section.

- `nsh`: `List` prop `example?: boolean` — what it does.

## Breaking Changes

Describe any breaking changes introduced by this pull request. If none, remove this section. What apps use (JS exports, elements, props, style keys, Tailwind utilities, their types and behavior) is never broken: see [compatibility](../docs/dev/compatibility.md).

```diff
- Old code snippet
+ New code snippet
```

## Performance

For changes to a hot path: before / after `nsh test --trace` timings and mount item counts. If none, remove this section.

## How to Test

Please describe the tests that you ran to verify your changes. Provide instructions so we can reproduce.

## Checklist

- [ ] I have read the [CONTRIBUTING](../CONTRIBUTING.md) document and followed the guidelines.
- [ ] Reviewed the changes in this PR and confirmed AI generated code (if any) is accurate.
- [ ] Passed `cargo test --workspace`, `cargo +nightly fmt --all` and clippy (including the Catalyst and Android runs for platform code).
- [ ] Changes to what apps use keep what released versions shipped and come with a case in `tests/compat/` (`cargo xtask compat`).
- [ ] Ran the related `examples/gallery` demos on iOS and Android (if the change is visible or platform-specific).

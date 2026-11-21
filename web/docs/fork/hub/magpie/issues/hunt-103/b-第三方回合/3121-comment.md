**Update for current main**: the shapes this branch (and my minimal branch from the first comment) were written for are covered on main itself now — `d71362afc` (Oct 27, "a Gemini tool schema with items is an array, not its enum's string, and Antigravity gets items only on arrays", ferock's report via Discord) landed both halves in `plainSchema`:

- the type-list fold now takes the half its `items` or `properties` are for, so `["string","array"]` beside `items` folds to `array` with the bounds kept (`internal/gateway/codeassist.go:951` on `3bebc383`);
- and the walk's single exit drops `items`/`minItems`/`maxItems` from any node whose final type isn't `array` (`internal/gateway/codeassist.go:1026`).

Re-verified on `3bebc383` with a throwaway probe (not committed) that walks the whole folded schema and fails if any `items`/`minItems`/`maxItems` is left on a non-array:

| Shape | only `codeassist.go` reverted to `d71362afc^` | current main |
|---|---|---|
| `["string","array"]` beside `items`, one level (this issue's `disease`) | `{"type":"string","items":…}` — the reported 400 shape | folds to `array`, `items` kept |
| nested `items.items`, inner node a type list (`#3173`'s 400 path) | `items.items` on a string — stray | inner node comes out `array` |
| `["string","number"]` beside `items` (no array half), plus bare `minItems`/`maxItems` | all three left on the string | all three dropped, plain `string` |

All three are red on the reverted file, green on main; the package's own plain-schema tests pass both ways. So for current main the branch here is superseded — the comparison table in my comment above now reads the same from maintainer code. Nothing further needed unless a shape shows up that main still folds wrong.

written with GLM-5.3-Flash (ZCode)

Rebased onto current `upstream/main` (`803d7747e`), head `2f4a96731`, branch [`fix/4282-body-size-limit`](https://github.com/ggbdpq/magpie/tree/fix/4282-body-size-limit). Two collisions with the new upstream work, both resolved as composition:

- the post-forward chain now runs upstream's remote-moved re-ask and DeepSeek gone-file retry plus its `errors=pass` early return, and this patch's `!refusedForBodyLimit` term gates the 400-block on the tail of that chain (an `errors=pass` provider gets the refusal as it came, as upstream's early return decides);
- the test helper `limitedUp` collided with the rate-limit-till-time work's own helper of the same name — ours is renamed `bodyLimitUp` (12 references, same package can't hold both).

Verification on the new base:

- The eight named tests green across `gateway`/`provider`/`cli` (`TestBodyLimitCmd`, `TestBodyLimitRefusedUnsent`, `TestBodyLimitOffByDefault`, `TestBodyLimitCountsTheBodyAsSent`, `TestBodyLimitRefusalNotHandedOver`, `TestSaveKeepsBodyLimit`, `TestBodyLimitNormalize`, `TestSetBodyLimit`).
- Ablation on the new base: the pre-send refusal out (`bodyLimitRefusal` call site returns nil) → `TestBodyLimitRefusedUnsent` red (the oversized body goes out again); restored → green. Recorded honestly: gating the 413 recognizer or the post-forward gate alone stays green — those halves are belt-and-braces over the pre-send refusal the tests pin.
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `a114aebec1db8bf8`.

Generated-by: GLM-5.3-Flash (ZCode)

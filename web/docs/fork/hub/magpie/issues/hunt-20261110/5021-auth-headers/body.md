@Jasonpetrelli your 11-04 note is exactly the manual equivalent — the Advanced › Key header switch to `Authorization: Bearer` is what this patch learns automatically from the vendor's answers; the patch just saves everyone the detour through the editor (and covers the 404 case that switch can't, from your retest).

Rebased onto current `upstream/main` (`0d99261dc`): the branch carries its two commits (the first patch and the rework that supersedes it), rebased as a series — zero conflicts. Branch: [`fix/5021-both-auth-headers`](https://github.com/ggbdpq/magpie/tree/fix/5021-both-auth-headers), head `4fd4c2560`. The series `git am`s clean onto a tree at `0d99261dc` (both patches, in order); per-patch sha256[:16]: `a581dd1167fc7924` (0001), `dc892e63772d1bce` (0002).

Verification on the new base:

- `TestRetryOneAuth404NotLearned`, `TestList404NotLearned`, `TestRetryOneAuthOnKeyRefused403` green.
- Ablation on the new base: the 403 trigger out (retry only on explicit 401 again) → `TestRetryOneAuthOnKeyRefused403` red; restored → green.
- Sibling scan: `BothAuthRefused`/`AuthKeyRefused` word-classifier pair unchanged on this range; no other reader of `AuthHeader` changed upstream.

Generated-by: GLM-5.3-Flash (ZCode)

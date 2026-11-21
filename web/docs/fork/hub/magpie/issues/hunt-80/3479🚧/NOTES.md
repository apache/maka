# hunt80-b / #3479 notes

## 占坑
- take: https://github.com/yetone/magpie/issues/3479#issuecomment-6387624625 (0 comments before, no assignee, no open PR referencing it)
- baseline: 7b1faf99f2a36732a836fd135a7a2f937b4ed3e9 (upstream/main fetched 2026-10-25, matches task brief)
- worktree: /tmp/magpie-hunt80-b @ 7b1faf99, branch hunt80-b-3479

## 先例（拍板依据）
- #1542: routing page, same WebKit "ResizeObserver loop" page-error class. **No comments at all, still OPEN** — no maintainer follow-up ruling there.
- Precedent commit 75aa03e1a (yetone, 2026-10-07): purpose-filter — test-side exemption of exactly this message, rationale in comment beside the handler: "WebKit reports it as a page error, Chromium doesn't... Nothing is lost or painted wrong: the round is delivered on the next frame."
- 7 specs already carry the identical regex exemption: purpose-filter x2, group-template x3, group-share, group-duplicate, update-release-page, view-scrollbar-drag.

## 定性（实测）
- RED on baseline: BROWSER=webkit solo 1/1 red — 6/6 geometry subtests green, outer `assert.deepEqual(errors, [])` red with `['ResizeObserver loop completed with undelivered notifications.']` (matches #3479 verbatim). Log: /tmp/hunt80-b-red-run1.log
- Probe v1 (wrapped RO) + v2 (native RO, per-frame geometry snapshots), /tmp/hunt80-b-probe.cjs / probe2.cjs:
  - class ladder converges: top -> tight (f3) -> cramped (f16) -> inrow (f33) -> crowded (f48) -> packed (f60); topH constant 46, actW constant 82.
  - **en@1.25: last 182 frames geometry identical** (top 448x46, nav 300, act 82). zh@1.25 and en@1.1 likewise settle. No thrash, no drift.
  - v1 probe additionally shows every sweep stop gets 2 RO deliveries in the same frame (viewport change + fitTop's class change); occasionally a third round (nav) — at one stop that lands past the loop depth and WebKit reports it.
- Verdict: benign (hypothesis B) — finite re-layout rounds crossing RO notification rounds; WebKit reports undelivered round, Chromium doesn't; nothing painted wrong. Same class as 75aa03e1a. Product-side "fix" would be rAF-deferring fitTop's class writes — behavior change on all engines to silence one benign notice; precedent chose the test-side exemption.

## 修复（先例形态）
- header-centre.test.cjs line 66: handler now filters `/^ResizeObserver loop completed with undelivered notifications/`, 6-line comment beside it. All layout assertions untouched.

## 验证矩阵
- GREEN webkit run1/run2: 7/7 pass both (logs /tmp/hunt80-b-green-wk1.log, wk2)
- GREEN chromium: 7/7 pass (/tmp/hunt80-b-green-cr1.log)
- Ablation: file restored to 7b1faf99 version, webkit -> red again exit=1, pass 6 fail 1, same message (/tmp/hunt80-b-ablate.log); fix restored after, `git status` shows only header-centre.test.cjs modified.
- Sibling matrix: header-zoom-fit webkit+chromium 5/5 green both; header-relang webkit+chromium 6/6 green both (theory-sibling specs that sweep fitTop and assert errors==[] — baseline green, left alone).
- 失败读取语义: N/A — no file/network read semantics touched; GUI test pageerror handler only.

## 待发布
- commit subject: `gui tests: header-centre doesn't count WebKit's ResizeObserver loop notice as a page error (#3479)`
- 尾注 Generated-by: GLM-5.3-Flash (ZCode) 恰一次
- push origin hunt80-b-3479 -> ls-remote 比对 -> fetch upstream 零触及 -> 评论查重 -> POST -> GET 回读

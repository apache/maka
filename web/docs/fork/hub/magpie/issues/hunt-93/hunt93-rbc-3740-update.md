# hunt93-rbC：#3740 head 更新评论稿（未发布，等授权）

- 单：#3740（hunt91-l1-3740-overlap400，在审中；原交付评论 6417911317 指向旧 head 83bf1de6）
- 2026-10-27 rebase onto upstream/main `9ae79122`（冲突：docs/subsystems/gateway-routing.md，机械解=上游两条新 bullet（`notAnAPIReply` 改短 + 新 `provider.Unsaid`）与我方 `openCodeBareRefusal` bullet 共存，删旧版 2xx 重复段）
- 新 head：`26949ef7`（83bf1de6 → 26949ef7，已 force-with-lease 推 fork）
- 验证：internal/ patch 与旧 head 逐字节同内容（仅 index 哈希与 hunk 行号偏移），docs 仅新增行上下文变化——代码 patch 零变化，docs-only 冲突不影响 patch。

## 拟发评论（一行，英文，未发）

> Rebasing this onto current main (docs-only conflict in `docs/subsystems/gateway-routing.md`; the code patch is unchanged): branch head is now `26949ef7` ([hunt91-l1-3740-overlap400](https://github.com/ggbdpq/magpie/tree/hunt91-l1-3740-overlap400)).

## 状态

- **未发**，等用户授权后再发到 #3740。

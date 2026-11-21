# issues：每单原件

猎手的产出目录：patch、issue/评论草稿、红绿日志、复现脚本。这里只放原件；结论和结局写进 [journal](../journal/README.md)，可复用的教训交给复盘晋升到 [handbook/10](../handbook/10-避坑清单与模式家族.md)。

## 命名（2026-11-01 用户定版）

- **第一层只允许 `hunt-<NN>/`（连字符）+ 本 README**，不允许散文件、散车道夹或非 hunt 目录。
- **单件子目录=`hunt-<NN>/<单号>-<slug>/`**：slug 2–4 个 kebab 词说明改的是哪块（如 `4732-glm-webp-refusal`）；同一单再交付加 `-v2`（如 `4574-desktop-context-v2`）。诊断/分析单 slug 直接表意（如 `4748-codex-compaction-concurrent`），不带形态词。
- **fork 分支=`fix/<单号>-<slug>`**（同 slug 复用）；**老分支一律不改名**。
- **提交信息 subject=`fix(<scope>): <summary> (#N)`**。
- 非 hunt 的委托类产物按所属轮次归入对应 `hunt-<NN>/`（先例：`3682-followup`→`hunt-92/`，台账 hunt92 D 行明载）。
- 2026-11-01 重组已执行：63 个 `hunt-<NN>` 全量落位（含从错误位置 `fork/docs/issues/` 迁回的 hunt101 两 patch 与 hunt115 七夹），hunt115 内 11 夹已按新规改名（hunt115-* → <单号>-<slug>）；历史路径引用以当日编年条目为映射依据。

| 形态 | 用途 | 例子 |
| --- | --- | --- |
| `hunt-<NN>/` | 第 NN 轮狩猎/维护/委托的唯一第一层目录 | `hunt-115/`、`hunt-79/` |
| `hunt-<NN>/<单号>-<slug>/` | 轮内单 issue 产物目录 | `hunt-115/4732-glm-webp-refusal✅/` |
| ~~`legacy/`~~ | 早期原件归档已于 2026-10-23 删除（614 文件均在 git 历史，`git log --follow -- docs/issues/legacy` 可溯）；原帖 patch 均在 GitHub issue 内 | — |

## 约定

- 新单一律建目录，不在 `issues/` 顶层放散文件；**正典路径=`docs/hub/magpie/issues/hunt-<轮次>/`，不再使用 `fork/docs/issues/`（2026-11-01 已清空删除）**。
- 每个目录建议放一份 `RESULT.md`：做了什么、交付链接、没跑什么。
- 临时 HOME、缓存、账号文件、exe 不进本目录（见 [08 §4](../handbook/08-Windows工作区与沙盒规范.md)）。
> **2026-11-06 规约修订（用户定版）**：第一层目录命名从递增轮号 `hunt-<NN>` 改为**日期式 `hunt-YYYYMMDD`**（同日产物统一入当日目录，如 `hunt-20261106/`）。既有 `hunt-<NN>` 目录不回改。新狩猎轮产物一律落日期目录。

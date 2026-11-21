# Lane B / hunt-123 / #5024 — supported_reasoning_levels 缺 description（Codex 0.166 整文件解析失败）

日期：2026-11-04　结局：完成（patch 附 issue）

## 根因
magpie 写 magpie-models.json 时，vendor 条目路径（codexcat.listedEntry）按"vendor 怎么写就怎么带"保留 levels——vendor 没给 description 时字段就缺；用户设了 vendor 未列的 effort 时合成 `{"effort":…}` 同样缺字段。Codex 0.166 的 serde 要求每个 level 都有 description，缺一个整个文件解析失败（"missing field `description`"）。手补后 magpie 下次 sync 重写文件又缺——与报告者"修好又坏"循环吻合。

struct 路径（entriesAt 的 `level{Effort:…}`）tag 无 omitempty，恒写 `"description":""`，合法，非根因。ownEntry 路径（Codex 自有条目）原样保留，不改。

## 修法
internal/codexcat/codexcat.go listedEntry：levels 定型后逐条补缺失的 description（effortLabel：Low/Medium/High/Extra High/Max/…，t3EffortLabels 同款映射；vendor 自带的保留）。新测试 internal/codexcat/description_test.go TestCodexListedLevelsSayDescription。

## 验证
- RED（修前红）→ GREEN；消融回父提交 d8b3749ef 复红；stash 恢复。
- codexcat 全包 ok；codexcat -race ok；gateway nogui 全包 ok（653s）。
- agent nogui 全包：仅 TestMothX 红（预存清单内，plugin-field 面，与改动无关），其余全过。
- gofmt / vet / go build ./... 干净。
- Watched 三查：levels 写出面 rg 全 repo 仅 codexcat 两处+struct；gateway modelObject（/v1/models，Catwalk 消费方）不属本面，不改；失败语义（断言 nil 安全、非 map 条目跳过、vendor 自带不覆盖）；热路径 O(levels) 可忽略，CacheEntries/Remember 未触碰。

## 发布
- 分支 fix/5024-reasoning-description（基于 upstream/main tip d8b3749ef），head ecfd02e32c6549dd62b22980f14977f9e67a81e7，已推 fork origin 并 ls-remote 核对。
- patch：0001-codexcat-catalog-level-description.patch，SHA-256 前 16 = 7f9e317333182f44
- take：comment 6616837469；交付帖：comment 6617211588（GET 回读八要素全过，作者 ggbdpq，全英文）。

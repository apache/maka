# #3098 侦察报告：ZCode 3.14+ model picker 显示名 —— 放弃 patch（诊断评论交付）

- 日期：2026-10-20
- 分支：`hunt55-e-zcode-display`（/tmp/magpie-h63，HEAD=0f044e94，未提交任何改动——放弃路线无 patch）
- 判定：**放弃**。ZCode 3.14+ 的 `provider_config.json` schema 在 entry 与 config 全链 `.strict()` 且不含任何显示名字段，model picker 行文本硬编码为 `label: modelId`；magpie 无字段可写，写入 `name` 反而会被 strict 校验拒收导致配置加载失败。
- 产物：`comment.md`（英文诊断评论草稿，零中文、无 patch、无尾部模板）。

## 证据清单

| # | 来源 | 版本/位置 | 关键内容 |
|---|------|-----------|----------|
| 1 | issue #3098 全文（gh，yetone/magpie） | 2026-10-20，0 评论 | legacy config.json 带 `"name": "OFM-DS-V4.1-Flash"` 但 picker 仍显示 raw id；建议在 `providerModelRules[].config` 加 `name`（报告者自认需验证 schema）；引用「`buc` in the bundled CLI」与「selection settings use `label`」 |
| 2 | 本机 `~/.zcode/v2/provider_config.json` | ZCode 3.15.3（macOS，/Applications/ZCode.app，Info.plist CFBundleShortVersionString=3.15.3） | 37 条 `providerModelRules` 全部 providerId=magpie，entry 键形状唯一：`(config, modelId, providerId)`；config 键形状唯一：`(optionSpecs, properties)`；properties 键形状唯一：`(contextWindow, inputFormat)`——无任何 name 类字段 |
| 3 | 本机 `~/.zcode/v2/config.json` | 同上 | 仅 magpie 一个 provider、37 个模型，全部带友好 `name`（如 `auto/GLM-5.3-Flash -> 'GLM-5.3-Flash · routing group'`）——与 issue 描述一致：legacy 有名字、picker 仍显示 raw id |
| 4 | ZCode app bundle `out/host/index.js`（app.asar 提取，/tmp/zcode-asar-extract） | 3.15.3 | model-rule entry schema：`tF=E.object({templateId,modelId,config:ui}).strict()`，`ep=tF.omit({templateId:!0}).extend({providerId})`（strict 继承，entry 仅容 `{modelId,providerId,config}`）；文件级 schema `gh=E.object({providerModelRules:E.array(ep),manualProviderModelRules:E.array(oC)}).strict().superRefine(...)` |
| 5 | 同上 `out/host/index.js` | 3.15.3 | config 内层：`yi=Os.pick({enabled:!0}).extend({enabled:ui.shape.enabled,properties:lh.properties.pick({contextWindow,supportsJsonSchemaOutput,supportsNativeWebSearch,supportsMidConversationSystem}).extend({inputFormat:…pick({supportsImage,supportsVideo,supportsPdf})}),optionSpecs:…pick({reasoningLevel}).extend({maxOutputTokens:…pick({max})})})`——manual 规则的 config 只白名单这几个键 |
| 6 | `out/main/chunk-OW6EUS2G.js`（zod+模型 config schema 源头，经导入链 `Ua as Le`/`bX`） | 3.15.3 | `bX=e.object({...Dt(vz.shape),properties:bz.nullable().optional(),optionSpecs:Sz.nullable().optional()}).strict()`；`gs`（properties 全集）=`{requiresMfjsToolSchema,contextWindow,inputFormat,outputFormat,supportsToolCall,supportsJsonSchemaOutput,supportsNativeWebSearch,supportsMidConversationSystem}.strict()`；`V_`（optionSpecs 全集）=`{reasoningLevel,maxOutputTokens}.strict()`；`Dt`=「全字段 nullable+optional 的稀疏化」助手。**无 name** |
| 7 | `out/main/chunk-ZCWQ2IP2.js` 与 `out/scheduler/index.js` | 3.15.3 | 同一 schema 的独立副本：`Kn=Xa.omit({templateId:!0}).extend({providerId})`（`Xa…strict()`）/ `_l=lE.omit({templateId:!0}).extend({providerId})`（`lE…strict()`）——三 bundle 一致，模型级均无 name |
| 8 | `out/host/index.js` 读写路径 | 3.15.3 | 读：`models:lF(YQ(r.config.modelConfigRules))`，`lF(e){let t=gh.parse(e);…}`；写：`toPersonalJSON(){return gh.parse({providerModelRules:…})}`——文件读写都过 strict zod，注入 `name` 会在 parse 处抛错（进入 personal config recovery）或至多存活到 ZCode 下次重写被剥离 |
| 9 | `out/host/index.js` picker 构造（**决定性**） | 3.15.3 | `function vo(f){return{id:f.providerId,label:f.providerName?.trim()||f.providerId,models:f.models.map(S=>({id:mP(f.providerId,S.modelId),label:S.modelId}))}}i(vo,"createModelSelectionProviderOption")`——模型行的 `label` **硬编码为 raw `S.modelId`**，不存在按模型查显示名的路径；`Gi`=`listModelSelectionProviderOptions`；状态行拼接 `${providerLabel}/${modelName}` 同理 |
| 10 | `out/scheduler/index.js`、`out/host/index.js` provider 级 schema | 3.15.3 | provider 规则（provider 级）**有** `providerName`：`Go=l.object({providerId,templateId?,providerName?,enabled?,config}).strict()`（ZCWQ2IP2），`GS=…providerName:Wo.nullable().optional()…strict()`（scheduler），`ProviderConfigMap.overlay` 显式合并 `providerName`——唯一的可写显示面在 provider 级（picker 前缀），magpie 已写且已保留用户自定义（zcode.go:478,495-497，#2030） |
| 11 | legacy config 的 model schema（对照报告者引用） | 3.15.3，`out/host/index.js` | OpenCode 风格 legacy model schema **有** `name:E.string().optional()`（`EK`；provider 级 `whe={id,name:min(1),endpoints,models:[EK]}`）——报告者「entries 有 name」很可能来自这里，但它是 legacy 文件的 schema，且 picker 不读它 |
| 12 | magpie 侧 `/tmp/magpie-h63/internal/agent/zcode.go`（HEAD 0f044e94） | upstream/main | :63-64 两路径；:142 legacy 写 `"name": m.Name`；:466 新文件 model rule 仅 `{providerId,modelId,config}`（无 name 可写）；:478 写 `providerName:"magpie"` 并保留用户名；:491-493 注释引 ZCode 源码路径 `packages/provider/src/config/provider-data-schema.ts`（「ZCode checks the file strictly」与本次 strict 证据互证） |
| 13 | magpie 侧 git log | 0f044e94 | `1de4bbc7`「agent(zcode): magpie's models reach ZCode 3.14 … Checked against ZCode's own schemas」——provider_config 支持的引入提交；`git log --grep '#3098'` 空（主线程已核） |
| 14 | `internal/agent/zcode_test.go` | 0f044e94 | 既有断言确认 model rule 无 name、`providerName` 用户值保留（:582 `r["providerName"]="My GW"`） |

## 放弃依据（一段话）

ZCode 3.14+ 的 `provider_config.json` 由 strict zod schema 校验（host 读写均过 `gh.parse`）：model rule entry 只容 `{modelId, providerId, config}`，config 只容 `{enabled?, properties?, optionSpecs?}`，properties/optionSpecs 各自也只有白名单键，**全链不存在任何 name/label/displayName 字段**（证据 4-8，三 bundle 一致）；即便 schema 有字段，picker 行文本也是硬编码 `label: S.modelId`，不查任何按模型的名字（证据 9）；报告者自己的 legacy `config.json` 已带 `name` 而 3.14.1 picker 仍显示 raw id，与代码结论互证（证据 1、3）。因此「在 provider_config.json 写 name」不可实现且有害（strict 拒收→recovery），按 #2984 先例放弃 patch，产出英文诊断评论（comment.md）：写明证据源、结论（schema 无字段 + picker 不读）、报告者 schema 引用的可能出处（legacy `name` / provider 级 `providerName` / option 类型的 `label` 字段）、可行建议（per-model 友好名需 ZCode 上游改 schema+picker；magpie 侧唯一可写面 `providerName` 已就位；改可读 modelId 属命名重设计不建议）。

## 版本注意

本机为 ZCode 3.15.3（非报告者 3.14.1），结论注明版本；3.14.1 的 entry 形状（报告者贴出的 JSON）与该 strict schema 逐键吻合，且 magpie 的 3.14 支持（1de4bbc7「Checked against ZCode's own schemas」）产出同一形状，跨版本一致性有旁证但未装 3.14.1 实测（comment.md 中已如实标注此 caveat）。

## 过程产物

- `/tmp/zcode-asar-extract/`（app.asar 提取的 host/main/scheduler bundle，供复查证据 4-11 的原文；保留未删）
- 工作树 /tmp/magpie-h63 无任何改动（`git status` clean）；未 push、未发帖、主 clone 未动

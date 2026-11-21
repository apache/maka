# hunt32/C — #2602 交付草稿（ZCode Global Build 额度）

## 结论

这不是 magpie 内建代码的缺陷：ZCode 是插件化订阅（movers 表），报错用户的卡片读取链路在
`@magpie-community/opencode-zcode-auth`（npm latest 0.1.19 = plugins 仓 main = mover min，三方一致）。
「当前用户不存在coding plan」这句中文文案 magpie 与插件都不生成（两边仓内都搜不到），
它是 Z.ai 后端 `/api/monitor/usage/quota/limit` 的 msg，经插件 `call()` 原样透传到卡片。

## 根因链路（插件 0.1.19，packages/zcode/index.mjs）

- `stateOf`（L1153-1156）：`auth.type === "api"`（"GLM Coding Plan API key" 方式添加）的账号只有
  `key/device/site/base`，**没有 `jwt`**。
- `plansOf`（L207）：`if (isTeam(s) || !s.jwt) return { start: false, gift: null }` →
  usage 分支（L1719）`gift ? dualUsage : codingUsage` → `codingUsage`（L432-434）请求
  `/api/monitor/usage/quota/limit`（Coding Plan 的端点）。
- 该账号没有 GLM Coding Plan 订阅 → Z.ai 返回 `{code:…, msg:"当前用户不存在coding plan"}` → 透传为卡片错误。
- 而领取的赠送额度（ZCode Global Build / Trust Build，即"鸡蛋"）在
  `/api/v1/zcode-plan/billing/balance`，**只能用 ZCode 的会话 token（jwt，Bearer）读**
  （`giftOf` L463-466）。api-key 方式的账号没有 jwt，永远读不到它。

内建侧同形状（parity，仅迁移前的几小时窗口有效）：`zcodeOnStart`（zcode_start.go:130）
`k.JWT == "" → false` → `zcodeQuota`（zcode.go:428）读同一端点 → `zcodeCall`（zcode.go:687）透传 msg。
10-16 起 MoveRetiring 每小时把内建账号强迁到插件（migrate.go:908-930，"no way back"），所以
magpie 仓内修内建对该用户无效——AGENTS.md「A fix here alone doesn't reach those users」。

## 用户立即可用的路径

用 **"ZCode app's sign-in"**（或 Z.ai OAuth）方式重新添加该账号：这两种方式带 jwt
（source:"zcode" 的条目每次读取都跟随 ZCode app 的凭据，stateOf L1138-1148），
`plansOf` 走 `start=true` → `giftOf` 读 balance → Global Build 的 buckets 显示
（插件 0.1.11+ 还会对待领取的赠送额度给提示行）。api-key 方式的条目删掉即可。

## 修复建议（落在 magpie-community/plugins packages/zcode）

api-key 方式的账号在 `codingUsage` 收到「当前用户不存在coding plan」时，给出可操作的错误，
例如：该账号没有 GLM Coding Plan；它领取的赠送额度要用 "ZCode app's sign-in" 方式添加才能显示。
（balance 需要 jwt，api-key 账号读不了，所以只能是把话说清楚，不是换端点。）
插件发新版后 magpie 侧 raise mover min。

## 没跑什么

- 没有真实「无订阅 + 已领 Global Build」账号，无法实测 Z.ai 两个端点的回复；
  文案归属由「两边仓内均无此文案 + envelope 透传路径唯一」推断，标注为推断而非实测。
- 未跑 magpie 测试套件（本单无 magpie 仓内代码改动）。

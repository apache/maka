收到,这个观察我们认真核对了一圈,结论和 reasoning 那一半不同:**image 这一侧不是标签 bug,而是声明过的设计**(Image recognition 描述功能的使能机制),直接"统一以注册表真实能力导出 image"会把描述功能废掉。下面是完整的证据链、你那条 502 的逐环拆解、以及链路里真正的残余缺口。

## 为什么不是 reasoning 同款

reasoning 侧是两套判定兄弟路径不一致(gateway `e.Reasoning || len(levels) > 0` vs 导出 `len(efforts) > 0`),没有补偿机制,所以统一口径是对的(已在 `9f8fe81a` 合入)。

image 侧则是一个**有意的反向声明**:只要 magpie 配有图片识别模型(下称 describer),导出给所有 agent 的清单就**故意**把每个模型都标成能看图,让图片能到达 magpie,由 describer 把图片描述成文字再喂给纯文字模型。三处铁证:

| 证据 | 位置 |
| --- | --- |
| 引入该行为的提交(正文自述"agents are told every model takes them while a model that sees describes images") | `19e239c7` |
| 扩展提交(models.dev 未声明的也描述) | `6cab1167` |
| 代码注释明文 | `internal/provider/visible.go:48-53`("Agents are then told every model takes images; told a model is text-only, they turn the user's image away before magpie is asked")、`internal/gateway/vision.go:27-34` |
| 导出侧实现 | `internal/agent/route.go:153-171`(`Images: e.Images \|\| seen`,`seen := provider.Described()`;Codex 的清单同款在 `internal/provider/codex_models.go:610,617`) |

而且有**两个测试守护着这个行为**,其中 `TestDescribedModelTakesImages`(`internal/agent/vision_test.go:26`)直接断言"ImageInput 明确 false 的纯文字模型,在有 describer 时必须被告知能看图,Vision off 后才恢复真话"——按注册表真实能力导出 image,这个测试会红。`#1569` 先例(有意豁免的兄弟面补丁被拒)就是这条路的教训,所以我们不发 patch。

反过来说:**你想导出真话的那个形态是存在的**——Settings → Models → Image recognition 设为 off(或没有任何模型能看图)时,`provider.Described()` 为 false,导出就逐字反映注册表真实能力;代价是纯文字模型的图片会在客户端就被拒(400 "does not support image input")。

## 你那条 502 的逐环拆解

1. Pi 侧:models.json 标了 image(设计使能,如上),所以 Pi 放行图片——设计预期内。
2. magpie 请求时闸门(gateway.go:1854-1866):读的才是注册表真话(`ImageInput` = false),进入"找 describer 描述图片"分支。
3. describer 是 `codex/gpt-6.1-sol`,描述请求失败 → 502 "model can't see images, and … couldn't describe the image for it"(gateway.go:1885-1893)。你看到的 "model can't see images" 就是这条 502 的一部分,不是独立的拒绝。

所以这单的病根不在导出标签,在 **describer 选了一个该账号实际不可用的模型**。

## 真正的残余缺口(观察+假设,未动手)

自动挑选(AutoVision)在"用户启用的模型"里选一个"能看图"的小模型,已有两道防护:只挑启用的(`d5cae267`)、跳过额度用尽的(`b5d7f057`,#1801)。但它把"在账号列表里"当"可服务",而 ChatGPT 账号的列表恰恰**声明过会混入跑不了的模型**:

- `internal/provider/chatgpt_api.go:508-528`(`siwcWithCodex`):给 ChatGPT token 的列表并入 Codex 计划的模型,注释自己写着 "a model it can't run is 'not supported when using Codex with a ChatGPT account'"(#933 的取舍);
- codex 账号没有 copilot 那样的拒绝记忆(`copilotRefuses`,`internal/provider/account.go:1428`;codex 无对应物),所以被拒过一次还会再选它;
- 失败的降级就是现状:502 + 提示语(autoSeerNote 会说 "magpie picked codex/gpt-6.1-sol of the models you enabled: pick another in Settings → Models → Image recognition")。

设计兼容的修法方向有两条,都不小(要么给 codex 加拒绝记忆并在挑选时跳过——#1801 同形;要么 describe 失败后换下一个候选 describer 重试),超出评论能代定的范围,留给维护者裁决。

## 你现在就能做的

- Settings → Models → Image recognition 换成一个该 ChatGPT 账号实际可用的模型(502 文本尾部通常会点名 magpie 自动挑的是谁);
- 或者干脆 off:导出恢复注册表真话,Pi 会自己拦图片,不再有 502,代价是纯文字模型收不到图片描述。

## 两个小征询

1. 你那条 502 的完整文本(尾部会点名 describer 和缺失说明)——想确认是"自动挑选撞上不可用模型"还是"Settings 里手动挑的模型后来失效了"(后者 `pickedMissing` 只查解析,不查可服务);
2. 复现时 Settings → Models → Image recognition 是不是空着(自动)。

确认后如果维护者愿意接"拒绝记忆/失败换手"任一方向,我们再按 #1801 的先例出 patch。

Generated-by: GLM-5.3-Flash (ZCode)

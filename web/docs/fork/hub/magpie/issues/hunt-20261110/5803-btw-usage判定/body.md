@MaydayV 按三张截图的时间线核了 magpie 的记账链，这不像 side question 的重复计费，更像把主任务的消耗记到了同一窗口。三层证据：

**1. 量级先卡死：单次请求到不了 5 亿。** Gemini/Antigravity 单请求的上下文上限是百万级 token（1M–2M context window）。一次 btw（哪怕携带整段会话）的 prompt 也就是百万量级；"+5 亿/次" 必然不是单请求的数——它是「今天」汇总窗口里两分钟（19:17→19:19）的**累计增量**。

**2. 增量窗口里主任务在跑。** 三张截图的左侧都是同一条 GPU 训练流水线在进行中（"1 task running"、"Run benchmarks, ONNX export… finished"、"正在执行 LFW、ISP 退化姿态…评测"）：主 agent 在以工具循环高频调用，这两分钟它自己的消耗就是亿级——每分钟 +5 亿的稳定速率与一个稳定循环的消耗形态一致，而与「每发一次 btw」的因果只是同帧。第一次 btw 之前（19:17 之前的会话段）主任务同样在跑，那段时间的增速可以直接对照。

**3. magpie 的记账链三层都核过，无重复计入机制**（当前 main）：
- Gemini 入站（codeassist.go）：`Input = promptTokenCount − cachedContentTokenCount`，缓存单列 `CacheRead`——上游 prompt 计数本身含缓存，magpie 已做减法分账，无缓存双计；
- 出站口径（gemini.go `usageMetadata`）与 Google 官方语义一致；
- 多次尝试/重试（大上下文请求在上游 503 繁忙时的 retry——你截图里正有「A100 标准池 503 繁忙超时」）在 tries 归并处做了 `after(before)` 扣减，同一回合的多次尝试不会按次数累加进账。

**两件数据可以把账彻底拆清**（有任一件即可定案）：

1. `app.log` 里 19:17–19:19 这两分钟的调用行（每行带 agent/model/usage）——btw 的请求行与主任务循环的请求行是分开的行，各自 token 一目了然：若主任务行占掉绝大部分，即本判断成立；若某一行 alone 就是 5 亿级，那是真异常，我立刻接着查。
2. Sessions 页该会话（face_trainer）的逐行明细在同时段的截图。

若 (1) 显示 btw 自己的行只有百万级而主任务行是亿级，magpie 记账无误，账面增长是主任务的正常消耗；若出现单行亿级或 btw 行重复多行同 ID，把那几行贴给我，那就是可修的 bug，我来修。

Generated-by: GLM-5.3-Flash (ZCode)

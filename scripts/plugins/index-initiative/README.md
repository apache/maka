# Index Initiative / 主动观察

基于 Maka Agent runtime 的独立 Host 插件。一个后台 Agent 持有持续的用户指示，可以发现多个 memory-network index，按需要读取条目、引用原文、反向关联及尚未覆盖的增量，再判断是否有值得推进的事情。没有固定 index 类型，也不要求每次产生任务。

## 使用

先安装当前工作树的 `memory-network` 插件，再安装本插件。两者通过模型可调用的公开工具配合；本插件不读取记忆数据库，不修改 index 覆盖位置。

在普通对话中明确要求开启，例如：

> 开启主动观察。结合我已有的多个 index，关注当前项目有没有新的阻碍或可推进的事情。可以检索、核对和准备本地草稿；联系别人前先问我。没有有用变化就安静，每半小时左右检查一次。

前台 Agent 调用 `InitiativeEnable` 保存用户指示并立即启动第一次后台检查。调用立即返回。后续沿用同一个后台 Session，普通会话仍可继续。该 profile 第一版只配置一个主动观察 Agent，由发起会话管理。

| 工具 | 用途 |
| --- | --- |
| `InitiativeEnable` | 设置自然语言目标/行动范围和建议检查间隔，首次创建后台 Agent |
| `InitiativeStatus` | 查看当前执行、记录、最近更新、下次时间及异常 |
| `InitiativeControl` | 发起会话请求 `pause / resume / check` |
| `InitiativeRead` | 后台 Agent 领取本次唤醒，读取最新指示、记事本、观察位置和近期记录 |
| `InitiativeHistory` | 分页读取历史决策，可按 Agent 自己定义的记录 key 查找 |
| `InitiativeCheckpoint` | 保存本轮判断、记事本、观察位置、处理记录、可选汇报及下次检查时间 |

`intervalMinutes` 默认 30，仅作为建议；下一次检查由 Agent 提交带时区的未来绝对时间及原因。`update` 为空表示本轮没有值得汇报的变化。当前汇报保存在状态、历史记录和后台会话，**尚未接入前台消息推送、通知或专用 UI**。

## 运行结构

```text
用户开启 → 独立后台 Session
定时到期 → 同一 Session 收到唤醒 → InitiativeRead
  → 发现并选择多个 index → 核对原文及相关增量
  → 普通 Agent loop：继续查 / 在授权内行动 / 有价值的汇报 / 安静
  → InitiativeCheckpoint → 自然结束 → 等待下次时间
```

决策和执行仍是一个普通 Agent loop；调度器不替 Agent 拆任务。自然结束钩子只要求保存检查结果及后续时间，不要求制造行动。记事本是参考，当前指示和新证据可以推翻过去的判断。

SQLite 保存当前快照和 append-only 运行/决策记录。`bookmarks` 是主动观察自己的阅读位置，允许按 source、index 保存任意结构，**不代表 index 已整理的覆盖位置**。原文和 index 的游标继续由 memory-network 管理。

代码保证一次只有一个本插件调度的检查、租约隔离、activation/turn/revision 校验、同一提交幂等、未来时间验证。Agent 自己判断语义重复；journal key 不是外部系统的 exactly-once 保证。普通工具权限仍由 Maka runtime 执行；自然语言行动范围不是新增的全工具安全沙箱。

等待中的调度可跨重启恢复。执行中崩溃、运行超时或强制退出未 checkpoint 时保留错误并停止自动重放，避免重复未知副作用；检查状态后可显式 resume。工具参数错误或被结束钩子拦住不导致暂停，Agent 可以修改后重交。

## 开发与验证

在仓库依赖已安装后：

```sh
cd scripts/plugins/index-initiative
npm install
npm run verify
```

`prepare:test` 构建同工作树的 memory-network 和实际 Host API 测试入口。产物为 `release/index-initiative.maka-extension`，可从 Maka 插件安装入口导入。配置 `tickMs` 控制时间扫描频率，`runTimeoutMs` 控制一次检查的运行保护；默认分别 5 秒、10 分钟。

Host 进程必须保持运行；本插件不是独立操作系统守护进程。目前只有时间驱动，没有外部事件订阅。测试使用实际 Host 插件平台和实际记忆插件，模型决策由受控驱动替代；真实模型效果另测，见 TEST-REPORT.md。


## 主动推进试跑（2026-09-30）

默认任务改为：结合历史与当前情况，选择现在值得主动告诉用户的信息，并按重要性、时效性和相关程度排序取舍。调查及前置准备服务于告知判断，不以寻找可执行任务为主目标。没有值得告知的信息时保持安静。Index 的整理标准不作为主动 Agent 的待办清单。完整文本是 `src/prompt.ts` 中的 `PROACTIVE_TASK`，`InitiativeEnable` 仍可传入用户自己的指示。

根据用户的实验选择，普通后台 Session 继续继承 Maka 工具/权限，**不新增强制只读工具沙箱**。真实模型试跑使用 `buildBuiltinTools` 提供的普通终端和文件操作工具，只在任务提示里要求以只读核查及前置准备为主。请勿将它描述为代码保证的只读模式。

`scripts/live-ten.ts` 使用同一组本地 `sources.json`、`seeds.json` 测试真实模型。设置 `INITIATIVE_SCENARIO_DIR` 可以保留不同试验结果；凭据通过 `MAKA_SCENARIO_API_KEY` 或该目录的临时 `credential` 传入，退出时移除临时文件。网页查询由 `research-tools.ts` 的 request/response 文件桥接到测试操作者的浏览服务；它不是插件生产环境自带的搜索引擎，后台实际运行仍使用 Maka 已配置的网络工具。此次普通工具试跑没有选择调用网络工具，不能据此声称联网路径已完成真实验证。

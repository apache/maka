# 主动助手：普通对话 + 主机心跳

InitiativeEnable 在调用它的普通聊天 Session 上开启心跳，不再创建专用后台助手。用户消息、心跳调查和助手回复使用该 Session 原本的历史与上下文管理。

- InitiativeEnable：保存探索指示及用户要求的检查周期，默认 30 分钟。首次检查在一个周期后；需要立即检查可由用户调用 InitiativeControl check。
- InitiativeStatus：读取主机调度状态。
- InitiativeControl：用户请求 pause / resume / check。暂停只停止后续心跳，不中止聊天。

模型不选择下次心跳时间。没有 InitiativeRead、InitiativeCheckpoint、独立记事本或退出 hook；一次调查可以正常结束，不必制造任务或消息。心跳遇到忙碌会话时推迟；每次结束后等待配置周期再检查，不补发积压心跳。中断或不确定的执行停止自动重放，保留错误供检查。

开启会话获得一条简短角色指示：正常与用户交流，具体执行任务委派给独立 Matter，按需查询进展并传达用户对事项的修改。具体任务不与主聊天共享工作状态。

## 配套插件

安装当前 memory-network 以检索索引和原文，安装 proactive-matters 以使用：

- MatterDelegate：按稳定 taskKey 转交具体授权任务，重试复用同一事项和子 Session。
- MatterTasks：查询本会话委派的事项及最近报告。读取不等于已通知用户。
- MatterTaskMessage：把明确的新用户要求写入对应事项。
- MatterTaskControl：按用户要求暂停、继续、检查或取消事项。

任务结果目前通过主助手在用户询问或下一次心跳时查询后反馈；没有另做即时推送链。实际回复直接出现在原聊天 Session，是否安静由普通 Agent 决定，没有新增空消息渲染协议。授权边界仍由 Maka runtime 执行，提示中的只读要求不是额外工具沙箱。

## 升级与验证

旧版 SQLite 的 worker / notebook / decisions 原样保留在历史归档，升级后默认暂停，需在原发起对话明确启用。旧后台 Session 历史不自动复制到聊天 Session。不会恢复旧的模型自选唤醒时间。

npm run verify 完成构建、打包、平台受控测试和类型检查。产物为 release/index-initiative.maka-extension。Host 需保持运行；tickMs 默认 5 秒，runTimeoutMs 默认 10 分钟。超时停止后续心跳，但不会强制取消共享聊天中的用户请求。

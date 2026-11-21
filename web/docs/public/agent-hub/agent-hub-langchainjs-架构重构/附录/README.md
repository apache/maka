# 附录 · 可运行代码骨架与技术验证

验证环境：Node 24.14，langchain 1.5.18、@langchain/core 1.2.18、@langchain/langgraph 1.5.1、@langchain/openai 1.6.2、zod 4.6.7。

## 代码骨架（`代码骨架/`）

这是 `apps/agent/src` 的最小可运行版本，各工作包可以直接借鉴（WP1–WP4 的"参考实现"）。

| 文件 | 对应工作包 | 说明 |
|---|---|---|
| `contracts.ts` | — | 从 `packages/shared/src/contracts.ts` 原样复制，仓库里应直接 import `@agent-hub/shared` |
| `data.ts`、`tools.ts` | WP1 | 证据库、商品目录、三个工具与因果校验 |
| `translate.ts` | WP2 | 事件翻译层（映射表、开场白扣留、错误收口） |
| `scripted-model.ts`、`scripts.ts`、`agent.ts`、`llm.ts` | WP3 | 离线策略模型、三场景剧本、createAgent 装配、ChatOpenAI 工厂 |
| `server.ts` | WP4 | node:http + SSE |
| `run-demo.ts` | WP2/WP3 测试 | 6 组场景 + 序列约束断言（`checkSequence`） |
| `run-demo-output.txt` | — | 实际运行输出 |

运行方法：

```bash
mkdir ah-skeleton && cd ah-skeleton && npm init -y
npm i langchain@1.5.18 @langchain/core@1.2.18 @langchain/langgraph@1.5.1 @langchain/openai@1.6.2 zod@4
cp -r <本目录>/代码骨架 skeleton          # 含 package.json {"type":"module"}
node skeleton/run-demo.ts                 # 结尾输出"全部断言通过 ✅"
node skeleton/server.ts                   # 另开终端：
curl -N -X POST localhost:8809/api/agent/chat -H 'content-type: application/json' -d '{"message":"想给妈妈送生日礼物"}'
```

`run-demo.ts` 覆盖的场景：

1. 三场景离线剧本：卡片、证据、正文与旧 `agent.py` 一致；
2. 同 thread 第二轮能看到上一轮（`getState` 断言），跨 thread 隔离；
3. 模型先引用不存在的证据 → 工具报错回灌 → 自我修正，开场白进思考区而不进正文；
4. 死循环模型 → `error{server}`"步数超出上限"；
5. 上游 500 → 只有一个 error，原始报错（含 `sk-xxx`）不外泄；
6. 中止 → `error{aborted}`。

骨架开发过程中踩到、已写进设计的坑：

- 自定义模型 `handleLLMNewToken` 必须带 `{ chunk }`；
- 默认 `recursionLimit: 25` 会先于业务限额触发；
- `toolCallLimitMiddleware` 的 `continue` 在一步内全部被拦截时，会结束本轮且没有正文；
- 每次模型调用的 reasoning 要开新段，否则会追加到上一个"校验未通过"的段里。

## 技术验证（`技术验证/`）

| 脚本 | 验证了什么 |
|---|---|
| `spike1-createAgent流式与证据校验.mts` | messages/updates/custom 三路流的顺序；工具抛错回灌与自我修正；custom 事件早于 ToolMessage；MemorySaver 多轮；工具调用前的文本会作为 token 流出（→ 开场白扣留的由来） |
| `spike2-中止与异常.mts` | abort → AbortError；模型抛带 status 的错误原样上抛 |
| `spike3-ChatOpenAI假上游.mts` | ChatOpenAI 对接本地假 OpenAI SSE：空 choices 不崩、reasoning_content 进 additional_kwargs（不在 contentBlocks）、tool_call 分片拼装、usage_metadata、HTTP 500 → status 500 |

每个脚本都附有 `*-output.txt` 实际输出。

## 其他

- `agent-hub-restore.py` / `.txt`：评审时用于复现 `tasks.py` 重启后任务卡在 running 的脚本及其输出（WP6 的红灯依据）。

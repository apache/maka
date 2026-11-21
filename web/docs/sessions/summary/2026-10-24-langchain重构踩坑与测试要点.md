# langchain 重构踩坑与测试要点

**一句话总结**：把一个手写 Python 智能体服务迁到 langchain.js（Node 24 直跑 TS）的完整重构里，沉淀出 Node 测试、.env 优先级、本地代理绕行、langchain 集成四类可复用经验。

## 背景

个人项目 agent-hub 做智能体层重构：新增 TS 服务（createAgent + 工具 + SSE），按工作包串行开发，每个包先写红灯测试再实现。过程中在测试命令、环境变量、本地代理和 langchain 类型/流式细节上踩了一串坑，均已定位根因并验证修复。

## 核心命令

```bash
node --test                          # Node 24 跑 .ts 测试，无参数自动发现 **/*.test.ts
pnpm --filter @agent-hub/agent typecheck   # 单包 typecheck（tsc --noEmit）
OPENAI_API_KEY= pnpm test:e2e        # 空值环境变量压过 .env 文件，强制测试走离线模式
curl -s --noproxy '*' http://localhost:<端口>/healthz   # 本机挂着代理时，curl 必须绕行
env -u http_proxy -u https_proxy -u all_proxy NO_PROXY=localhost,127.0.0.1 pnpm test:e2e
                                     # Playwright 的 webServer 轮询同样要先清代理
~/.local/share/uv/python/cpython-3.12-*/bin/python3.12 -m venv apps/api/.venv
apps/api/.venv/bin/python -m pip install -e "apps/api[dev]"   # 系统 Python 过旧时用 uv 管理的版本建 venv
```

重启恢复冒烟（验证服务端重启后续跑，⚠️ kill -9 只对准自己起的测试进程）：

```bash
(cd apps/api && exec apps/api/.venv/bin/python -m uvicorn app.main:app --port 8808) >/tmp/u1.log 2>&1 & U1=$!
sleep 2; kill -9 $U1        # ⚠️ 强杀模拟崩溃；PID 必须是上面记录的 $U1，误杀别的进程后果自负
# 用同样命令重启后，轮询任务接口，断言进度从断点继续而不是归零
```

## 关键结论

1. **Node 24 的 `node --test` 位置参数按 glob 处理，不是路径**：`node --test src/ test/` 会把目录当模块入口执行，报 MODULE_NOT_FOUND。直接 `node --test` 无参数自动发现最稳，测试文件放 `**/*.test.ts` 即可。
2. **Node `process.loadEnvFile()` 不覆盖已存在的环境变量**：`.env` 只在进程启动时读一次，改完必须重启；反过来 `OPENAI_API_KEY= cmd` 用空值可强制压过 `.env` 文件——配了真实 key 后跑 e2e 会因输出不确定挂掉固定断言，就用这招强制离线。
3. **本地代理会拦截 localhost**：shell 里挂着 `http_proxy` 时 curl 返回 502（代理没转发本机端口），Playwright 的 webServer 健康检查也会超时。curl 用 `--noproxy '*'`，命令行测试用 `env -u` 清掉代理变量。
4. **langchain.js 三个坑**：① `tool()` 回调的 `runtime` 参数必须显式标注 `ToolRuntime`，否则 TS 选中错误重载报 TS2339；② middleware 数组混入多种中间件后联合类型会让 `createAgent` 重载解析跑偏，收窄成 `AnyAgentMiddleware[]` 即可；③ 自己写假 OpenAI SSE 上游/录制回放时，每次补全要唯一 id、首个 delta 必须带 `role`——否则翻译层把多次调用误判为同一次、消息被聚合失败。
5. **两个服务端加固模式**：同一会话并发请求会互相覆盖 checkpointer 记忆（实测丢一轮）——用 busy 集合拒绝第二个请求返回 409，finally 里保证释放；请求体上限要边读边累计字节数、超限立即断，不要整体读完再判断。
6. **macOS/zsh 小坑**：没有 `timeout` 命令；zsh 不做单词拆分，`C="curl -s"` 再 `$C url` 会报 command not found，要封装成函数。

## 下次怎么用

- Node/TS 项目跑测试：直接 `node --test`，别给目录参数；测试文件命名跟 `*.test.ts` 约定即可。
- 项目里加了 `.env` 之后：所有自动化测试前想清楚"key 会不会被读到"，用空环境变量覆盖是零成本开关。
- 本机挂代理做开发：localhost 联调统一带 `--noproxy` 或清代理变量，省掉大量"服务明明起了却连不上"的排查时间。
- 给 ChatOpenAI 写假上游做契约测试：按第 4 条三个坑自查，能少走半天弯路。
- 验证服务重启恢复语义：起进程 → 干活到一半 → kill -9 → 重启 → 轮询断言状态延续，这个模式适用于任何带快照/恢复逻辑的服务。

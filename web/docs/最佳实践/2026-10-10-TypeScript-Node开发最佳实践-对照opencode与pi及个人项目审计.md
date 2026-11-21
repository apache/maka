# TypeScript / Node 开发最佳实践（对照 opencode、pi 与个人项目审计）

> 用途：新项目直接套用；老项目按“待修项”逐条处理。每条规则都写了理由和证据，没有证据的不写。

## 依据

| 来源 | 版本 | 角色 |
|---|---|---|
| fork/opencode | `3ffea8ff` | 主参考：Bun + turbo、zod、测试隔离 |
| fork/pi | `7b19cf19` | 副参考：npm + Biome、严格 tsconfig、依赖钉死 |
| tcode（coding-agent/impls/typescript） | 工作区 | 审计：tsc 通过，269/269 测试通过 |
| lang-ts（lang/language/impls/typescript） | 工作区 | 审计：tsc 通过，vitest 31 个测试通过 |
| agent-hub web/shared | 工作区 | 审计：依赖未安装，只做了静态审查和 oxlint（0 个问题） |
| agents/console（cli、diffmap/prism/register-core） | 工作区 | 审计：tsc 通过，vitest 161 个测试通过 |

本地工具链：node v24.21.0、pnpm 10.30.3。

## 0. 环境先能跑

- 仓库里必须有能一键安装的锁文件（`pnpm-lock.yaml`、`package-lock.json` 或 `bun.lock`），CI 用 `npm ci` 或 `pnpm i --frozen-lockfile` 安装。
  - 理由：agent-hub 本地没有 `node_modules`，typecheck 和测试都跑不了，“通过”无从谈起。
- 不要把编译产物放进 `src/`。
  - 理由：tcode 的 `src/` 里有 23 个未跟踪的 `.js`，和 `.ts` 源码已经不一致（`session.js` 缺 realpath 逻辑），很容易被误加载。

## 1. tsconfig

新项目的基线：

```jsonc
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "noEmit": true
  }
}
```

- `noUncheckedIndexedAccess` 要开。opencode（`packages/opencode/tsconfig.json:9`）和 pi 都没开，这一点不照抄。lang-ts 开了，照样零错误，说明成本不高。
- `verbatimModuleSyntax` 加 `erasableSyntaxOnly` 来自 pi（`tsconfig.base.json:7-8`）。这样源码能直接用 Node 原生的类型剥离运行，tcode 的 `node --test *.ts` 就靠这个。
- 禁用 `as any`。审计中只有 register-core 的 `PuppeteerRealAdapter.ts:87` 出现过一次，保持这个水平。

## 2. 路径与边界（安全类）

- 判断路径是否越界时，两边都先 `fs.realpathSync`（目标不存在时，对最近一个存在的父目录做 realpath，再拼回剩余部分），然后用 `path.relative` 得到 `rel`。
  - 越界的判定是：`rel === '..'`、`rel.startsWith('..' + path.sep)`，或 `path.isAbsolute(rel)`。
  - 理由：tcode `pathguard.ts:39` 用的是 `rel.startsWith('..')`，复现显示 `ws/..foo/a` 被误判为越界。`path.resolve` 不解析符号链接，复现显示 `ws/link → /tmp/out` 被判为在工作目录内，越界警告没有出现。这和 Go、Python 版的缺陷是同一个。
- 服务只给本机用时，绑定 `127.0.0.1`，并加随机 token 和 Host 校验。tcode 的 `web.ts` 已经这样做了，照着做就行。

## 3. 子进程

- 能用参数数组就不用 `shell: true`。opencode 的 `util/process.ts:59-60` 还会拒绝空命令。
- 需要超时的子进程：用 `spawn(..., { detached: true })` 启动，超时后执行 `process.kill(-child.pid, 'SIGTERM')`，等一段宽限时间再发 `SIGKILL`。Windows 上改用 `taskkill /T /F`。
  - 理由：tcode `bash.ts:59-75` 只杀了 shell 本身，又在 `close` 事件里收尾（`close` 要等所有持有管道的进程都退出）。复现结果是 `timeout_sec:1` 实际阻塞了 8014ms，孙进程也没被杀。
  - opencode 的 `shell/shell.ts:16-45` 是先 TERM、等待、再 KILL 的写法。pi 直接发 KILL，子进程没有机会清理，不照抄。
  - tcode 自己的 `web.ts:376-378` hook runner 已经用了 `detached` 加进程组 kill，bash 工具照着改即可。
- 用绝对路径调用系统工具，例如 pi 用 System32 下的 `taskkill.exe`，不依赖 PATH。还要给子进程挂一个 `error` 监听，防止 spawn 失败把 Node 进程带崩。

## 4. 网络请求与取消

- 所有 `fetch` 都要带 signal：`AbortSignal.any([callerSignal, AbortSignal.timeout(ms)])`（opencode `util/abort.ts:28-35`，pi `oauth/anthropic.ts:84`）。
  - 审计中缺 signal 的有：lang-ts `jsprelude.ts:436` 的 `http.get`（客户程序可以卡死它）、console `apps/cli/src/index.ts:24`、prism-core `browser-context.ts:131,168`，以及 tcode `mcp.ts:242,248` 的通知请求。
- 实现 sleep 或 retry 时，先检查 `signal.aborted`，并监听 `abort` 事件（pi `utils/retry.ts:149-160`）。
- 用 `process.on` 挂监听器时要成对 `off`（opencode `cli/cmd/tui/thread.ts:160-169`）。

## 5. 错误处理

- 自定义错误类要带 `code` 和 `{ cause }`（pi `utils/models-error.ts:5-21`）。如果调用方只展示 `message`，就把 cause 的摘要拼进 message。
- 不要写空的 `catch {}` 或 `.catch(() => {})`。确实是尽力而为（unlink、kill）时，写一行注释说明原因，或者记一条 debug 日志。
  - opencode 有约 80 处这种写法，不照抄。
  - tcode 有 11 处 `catch {}` 和 10 处 `.catch(() => {})`，大多数有理由。需要改的是 `web.ts:156`：`JSON.parse` 失败时退回 `{}`，模型给的畸形参数会被当成“没有参数”执行，应该返回错误让模型重试。
- 全局 `unhandledRejection`、`uncaughtException` 处理里记完日志就退出，退出码非零。opencode `src/index.ts:41-50` 记完日志继续运行，不照抄。

## 6. 运行时校验

- 外部输入（HTTP body、配置文件、LLM 工具参数）要用 schema 校验。用 zod（opencode 和 agent-hub 在用）还是 TypeBox（pi 在用）都可以，一个项目只用一种。
- 用 `safeParse` 返回结构化的错误信息，不要让 `parse` 抛异常直接冒到顶层（opencode `config/config.ts:189`）。

## 7. 文件完整性

- 写文件时先写临时文件，再 `rename`。tcode 的 `config.ts:271` 和 `session.ts:75` 已经这样做了。
- 替换整个目录时，先把旧目录改名为备份，失败就回滚（pi `chord/src/node/bundle.ts:176-192`）。

## 8. 测试

- 小项目首选 `node --test`（tcode 在用，零依赖）。需要 mock 或 watch 时再用 vitest。
- 测试启动前把 `HOME`、`XDG_*` 指向临时目录，避免读到真实配置（opencode `test/preload.ts`）。
- 临时目录用 `await using` 配合 `Symbol.asyncDispose` 自动清理（opencode `test/fixture/fixture.ts:46-71`）。
- 需要真实 API 的测试用 `describe.skipIf(!process.env.X_API_KEY)` 跳过（pi `ai/test/abort.test.ts:101`）。跳过就如实写成跳过。
- 修 bug 时先写一个在旧代码上会失败的测试。

## 9. lint、格式与 CI

- 一个工具同时负责 lint 和格式化：Biome（pi）或 oxlint 加 prettier（agent-hub 用 oxlint）。不关 `noExplicitAny`、`noNonNullAssertion`，pi 关了这两项，不照抄。
- CI 的最小形态：`npm ci --ignore-scripts`，然后 typecheck，然后 lint，然后 test。action 按 commit SHA 钉死，开 `concurrency` 并设置 `cancel-in-progress`（pi `ci.yml`）。
  - 目前 tcode 和 console 都没有 CI，也没有 lint 脚本。
- 依赖版本精确钉死：在 `.npmrc` 里写 `save-exact=true`，Bun 用 `bunfig.toml` 的 `[install] exact = true`。

## 10. 不采纳或暂缓

- 预览版或 beta 工具链：`tsgo` 7.0-dev、`effect` 4.0-beta、从 `pkg.pr.new` 装的依赖。对个人项目来说太不稳定。
- turbo 缓存、Blacksmith runner、JUnit 报告发布、Windows CI 矩阵：只有在多包并且确实有跨平台用户时才需要。
- pi 的 GritQL 插件、成堆的 `check:*` 脚本和入口图检查：维护成本高于收益。
- 手写的 `cd && npm run build` 链式构建：改用 `tsc -b` 或工作区的拓扑排序。

## 11. 采纳清单（新项目开工时逐项勾选）

- [ ] 锁文件已提交，`npm ci` 能一键装好
- [ ] tsconfig 开了 strict、noUncheckedIndexedAccess、verbatimModuleSyntax
- [ ] 每个 `fetch` 都带 `AbortSignal.any([..., AbortSignal.timeout()])`
- [ ] 子进程用 detached 启动，超时时 TERM、宽限、再 KILL 整个进程组
- [ ] 路径越界判断：两边 realpath，按分隔符精确比较 `..`
- [ ] 外部输入用 zod 或 TypeBox 做 safeParse
- [ ] 没有无注释的空 catch
- [ ] 写文件用临时文件加 rename
- [ ] 测试隔离 HOME，需要网络的测试用 skipIf
- [ ] CI 跑 typecheck、lint、test，action 钉 SHA

## 12. 本次审计发现的待修项（2026-10-10 已处理，状态见末尾）

| 等级 | 位置 | 问题 | 证据 |
|---|---|---|---|
| 中 | tcode `src/plugins/tools/bash.ts:59-111` | 超时只杀 shell，孙进程存活，工具调用要等孙进程结束才返回 | 复现：1s 超时实际 8014ms |
| 低 | tcode `src/plugins/tools/pathguard.ts:35-41` | `..foo` 被误判越界；符号链接越界时没有警告（`isWriteTrusted` 有 realpath，审批不会被绕过） | 两项都已复现 |
| 低 | tcode `web.ts:156` | 工具参数 JSON 解析失败时静默退回 `{}` | 读源码确认 |
| 低 | lang-ts `jsprelude.ts:436` | `http.get` 没有超时 | 读源码确认 |
| 低 | console cli `index.ts:24`、prism-core `browser-context.ts:131,168` | fetch 没有超时，错误原因被吞掉 | 读源码确认 |
| 工程 | tcode `src/*.js` | 23 个过期的编译产物，未跟踪 | `git status` |
| 工程 | agent-hub | 依赖未安装，typecheck 和测试都跑不了 | 本地运行 |
| 工程 | tcode、console | 没有 CI，也没有 lint 脚本 | 目录检查 |

处理状态：
- tcode pathguard：已修，`83902be`，新增 `test/pathguard.test.ts`（旧代码 2 条断言失败）。
- tcode bash：已改 `bash.ts`（detached + 进程组 SIGKILL），新增 `test/bash-timeout.test.ts`（旧代码耗时 5013ms）。`bash.ts` 和 `package.json` 都是未跟踪文件，所以没有提交。
- tcode `web.ts:156`：复核后确认这里只用于回放历史消息，不影响工具执行，不修。
- console：已修，`d08ab8c`。
- lang-ts `http.get`：暂缓。加超时会让 JS 后端和其他后端的行为不一致，要先在规范里定下超时语义。

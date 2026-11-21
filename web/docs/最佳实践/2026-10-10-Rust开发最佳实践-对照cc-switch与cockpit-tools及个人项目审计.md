# Rust 开发最佳实践（对照 cc-switch、cockpit-tools 与个人项目审计）

> 用途：新项目直接套用；老项目按“待修项”逐条处理。每条规则都写了理由和证据。

## 依据

| 来源 | 版本 | 角色 |
|---|---|---|
| fork/cc-switch（`src-tauri/`） | `49a68559` | 主参考：工具链固定、CI 门禁、错误类型、原子写 |
| fork/cockpit-tools | `e41864d0` | 反面参考较多：没有 clippy/fmt 门禁，错误类型退化成 String |
| lang workspace（19 个 crate） | 工作区 | 审计：fmt 通过；clippy `-D warnings` 失败（2 个 warning、1 个 error）；测试 513/513 通过 |
| coding-agent/impls/rust | 工作区 | 审计：33 个文件未格式化，clippy 报 28 个风格错误；测试 63 个，需要换一个干净的 target 目录才全部通过 |
| syntax-party 3 个 axum lab | 工作区 | 审计：`rust-version = 1.97.1` 导致 1.92 无法构建；加 `--ignore-rust-version` 后 clippy 干净，但没有测试 |
| design-archive | 工作区 | 审计：拉取 registry 失败，clippy 和测试都没跑 |

本地工具链：rustc/cargo 1.92.0，带 clippy 和 rustfmt。

## 0. 工具链与 Cargo 配置

- 用 `rust-toolchain.toml` 固定工具链，并在 Cargo.toml 写 `rust-version`（cc-switch `rust-toolchain.toml:1-4`、`Cargo.toml:9`）。
  - `rust-version` 必须不高于实际能装到的版本。理由：syntax-party 写的 1.97.1 比当前稳定版还新，没人能构建。
  - CI 用 `dtolnay/rust-toolchain@stable` 加 `-D warnings` 时，新版 clippy 的新 lint 会让 CI 无故变红。lang workspace 就是这种情况，需要固定版本。
- lint 策略写进 Cargo.toml，不要只写在 CI 命令行上：

```toml
[lints.clippy]
unwrap_used = "warn"
```

  - 理由：两份参考仓库和四个个人项目都没有 `[lints]` 表，lint 策略只存在于 CI 命令里，本地跑不到同样的检查。
- workspace 的依赖统一写在 `[workspace.dependencies]`，成员用 `.workspace = true` 引用。cockpit-tools 声明了但没用上，成员又各自钉了一遍版本，还有两份重复的 Cargo.lock，不照抄。
- 二进制 crate 提交 Cargo.lock，构建用 `--locked`。

## 1. 路径与边界（安全类）

- 判断路径是否越界时，两边都要 `canonicalize`（目标不存在时，对最近一个存在的父目录做 canonicalize，再拼回剩余部分），然后用 `Path::starts_with` 比较。这个方法按路径分量比较，天然排除 `/a/bc` 冒充 `/a/b` 的情况。
  - 理由：coding-agent `pathguard.rs:14-38` 只做词法归一，不解析符号链接，所以 `cwd/link → /etc` 下的 `link/passwd` 被判为在工作目录内。
  - 更严重的是，`in_allow_write_dirs`（`:44-54`）也基于同一个词法结果。允许目录里的一个符号链接就能把写操作引到别处，并且跳过确认。Python 和 TS 版的白名单两边都做了 realpath，Rust 版没有，所以只有 Rust 版是真正的绕过。
  - `..foo` 误判在 Rust 版不存在，因为 `components()` 会把它解析成普通分量。
- 把远程或外部输入拼进本地路径时（例如 `out.join(rel)`），拒绝绝对路径和 `ParentDir` 分量。design-archive `mirror.rs:61` 有这个风险，`rel` 的来源还没追。

## 2. 子进程

- 需要超时的子进程：Unix 上用 `CommandExt::process_group(0)` 启动，超时后对整个进程组发信号，即 `libc::kill(-pgid, SIGTERM)`，宽限一段时间再发 `SIGKILL`。Windows 上用 `taskkill /T /F`（cc-switch `commands/misc.rs:3627-3633`）。
  - 理由：coding-agent `bash.rs:156-168` 在非 Windows 平台只调了 `child.kill()`。随后 `out_h.join()`（`:117-118`）要等管道 EOF，而孙进程（例如 `sleep 999 &`）一直占着管道，工具调用会挂到孙进程结束。这是读源码得出的结论，没有跑运行时复现。和 TS、Go、Python 版的问题同源。
- tokio 的子进程加 `.kill_on_drop(true)`（cockpit-tools `commands/grok.rs:161`）。Windows 上加 `CREATE_NO_WINDOW`。

## 3. 错误处理

- 每个 crate 只定义一个 `thiserror` 错误枚举。到边界（Tauri command、HTTP）再统一转换：
  - Tauri command：`impl Serialize`（cc-switch `error.rs:111-124`）。
  - HTTP：`impl IntoResponse`。
  - cockpit-tools 有两个 `AppError`，另外还有约 926 个 `Result<_, String>`，错误类型全丢了，不照抄。
- IO 错误要带上路径，例如 `AppError::io(&path, e)`（cc-switch `database/backup.rs:1149`）。
- 锁中毒要转成错误，不要 `lock().unwrap()`（cc-switch 的 `lock_conn!` 宏，`database/mod.rs:61-68`）。
  - cockpit-tools 在 Tauri command 里有 43 处 `lock().unwrap()`。
  - axum lab 也全是 `lock().unwrap()`。目前没有在持锁期间 panic 的路径，问题只停留在理论上，但新代码不要这样写。
- 字符串截断按字符边界：`s.char_indices().nth(n).map_or(s, |(i, _)| &s[..i])`，或者用 `floor_char_boundary`（MSRV 允许时）。
  - 理由：design-archive `figma.rs:68` 写的是 `&body[..body.len().min(160)]`，中文错误体会 panic。
- `expect` 只用在启动期的配置错误上，并且写明原因。请求路径上不出现 `unwrap`、`expect`。

## 4. async 与并发

- tokio 只开需要的 feature（cc-switch `Cargo.toml:47`）。不要直接 `full`。
- CPU 密集或阻塞的工作放进 `tokio::task::spawn_blocking`：bcrypt、`std::fs`、`reqwest::blocking`。
  - 理由：auth-todo-api `main.rs:163` 在 async handler 里同步跑 bcrypt（约 250ms），会占住一个 runtime worker。
  - cockpit-tools 有 16 个 async command 文件直接调 `std::fs`。
- 短的同步临界区用 `std::sync::Mutex`。只有需要跨 `.await` 持锁时才用 `tokio::sync::Mutex`。
- 后台循环用 `tokio::spawn` 加 `select!` 监听 shutdown，并保留 JoinHandle（cc-switch `proxy/server.rs:148-160`）。

## 5. HTTP 客户端

- 所有 reqwest Client 都要设 `timeout` 和 `connect_timeout`。构建失败时返回错误，不要静默退回 `Client::new()`（cockpit-tools `utils/http.rs:4-8` 就是这样退回的）。
  - design-archive `figma.rs:39` 没有设超时，连接卡住时会永远等下去。
- 流式请求用空闲或读超时，不要给一个 24 小时的总超时（cc-switch `forwarder.rs:2693`，等于没有超时）。

## 6. 文件完整性

- 写文件用同目录临时文件，写完 `sync_all`，再 `rename`。cc-switch 的 `config.rs:462-672` 是完整范本，Windows 的替换语义也处理了。小项目可以直接用 `tempfile::NamedTempFile::persist`。
  - design-archive 在 async 任务里直接 `std::fs::write`（`figma.rs:337,427,441`），既不是原子写，也会阻塞 runtime。`:427` 的错误还被 `.ok()` 吞掉了。

## 7. 安全（Web 服务）

- 登录时，用户名不存在也要跑一次 dummy hash 校验，让两种情况耗时接近，防止通过响应时间枚举用户名。auth-todo-api `main.rs:162` 在用户名不存在时提前返回了。
- JWT 密钥从环境变量读取。`Validation::new(HS256)` 要明确指定算法（auth-todo-api 这一点做对了）。
- 不要照抄 lab 的写法：绑定 `0.0.0.0`、CORS 设为 `*`、密钥写成常量。

## 8. 测试

- 单元测试写在 `#[cfg(test)] mod tests` 里，集成测试放在 `tests/`。临时目录用 `tempfile`。
- 需要网络或私有数据的测试写成 `#[ignore = "原因"]`（cc-switch、cockpit-tools 都这样做）。
- 断言不要写恒真式。lang `crates/lang-cli/tests/e2e.rs:428` 的 `... || true` 恒为真，clippy 的 `overly_complex_bool_expr` 已经报出来了。
- 项目目录搬家后要 `cargo clean`，或者换一个 `CARGO_TARGET_DIR`。coding-agent 的 smoke 测试 7 个失败，原因是旧的测试二进制里写死了旧路径。
- 修 bug 时先写一个在旧代码上会失败的测试。

## 9. lint、格式与 CI

- CI 最小形态，每个 crate 或 workspace 一份：

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

  加上 `Swatinem/rust-cache`，并按 SHA 钉死。工具链从 `rust-toolchain.toml` 读取（cc-switch `ci.yml:127-179`）。
- 目前只有 lang workspace 有 CI。coding-agent 本地 fmt 和 clippy 都没过，要先清零，再接入门禁。

## 10. 不采纳或暂缓

- cargo-nextest 和 WSL2 专用 job：小项目用 `cargo test` 就够了。
- 为合并 feature 并存两个 reqwest 版本、vendor 一份打过补丁的 tao（cockpit-tools）：维护负担大，除非被迫，否则不要这样做。
- cc-switch 的 release profile（`codegen-units=16` 加 thin LTO）是为大 crate 调的。小项目用默认配置，或者 `lto = true, codegen-units = 1`。
- 自定义 panic hook：只有需要收集崩溃报告时才加。
- `tracing` 加按天滚动的日志文件：CLI 和 lab 用 `eprintln!` 或 `log` 加 `env_logger` 就够了。

## 11. 采纳清单

- [ ] `rust-toolchain.toml` 和 `rust-version` 都已写，并且版本能装到
- [ ] Cargo.toml 里有 `[lints.clippy] unwrap_used = "warn"`
- [ ] 每个 crate 只有一个 thiserror 错误枚举，边界处统一转换；IO 错误带路径
- [ ] 没有 `lock().unwrap()`；字符串按字符边界截断
- [ ] 阻塞的工作放进 spawn_blocking；tokio 只开需要的 feature
- [ ] reqwest 设了 timeout，构建失败时报错
- [ ] 路径越界判断：两边 canonicalize，再按分量 starts_with
- [ ] 子进程按进程组超时清理，先 TERM、宽限、再 KILL
- [ ] 写文件用临时文件、sync、再 rename
- [ ] CI 跑 fmt、clippy `-D warnings`、test，带 `--locked`

## 12. 本次审计发现的待修项（2026-10-10 已处理，状态见末尾）

| 等级 | 位置 | 问题 | 证据 |
|---|---|---|---|
| 高 | coding-agent `src/plugins/tools/pathguard.rs:30-54` | 不解析符号链接。白名单可被符号链接绕过，写操作跳过确认 | 读源码确认，没有运行时复现 |
| 中 | coding-agent `src/plugins/tools/bash.rs:117-118,156-168` | Unix 上超时只杀 sh，孙进程占着管道，工具调用会一直挂住 | 读源码确认，没有运行时复现 |
| 中 | design-archive `src/figma.rs:68` | 按字节截断字符串，遇到中文会 panic | 读源码确认 |
| 中 | auth-todo-api `src/main.rs:162-163` | bcrypt 阻塞 runtime；登录耗时可用来枚举用户名 | 读源码确认 |
| 低 | lang `crates/lang-cli/tests/e2e.rs:428` | 断言恒真，测试实际没有检查任何东西 | clippy 报出 |
| 低 | lang `lang-backend-{go,js}/src/json.rs` | `manual_range_contains`，CI 的 clippy 步骤很可能是红的（待验证） | 本地 clippy |
| 低 | design-archive `figma.rs:39,337,427,441` | Client 没有超时；写文件非原子且阻塞 runtime；有错误被 `.ok()` 吞掉 | 读源码确认 |
| 待验证 | design-archive `mirror.rs:61` | `out.join(rel)` 可能把文件写到输出目录之外 | 没追 `rel` 的来源 |
| 工程 | syntax-party labs | `rust-version = 1.97.1` 无法构建；没有测试 | 本地构建 |
| 工程 | coding-agent | 33 个文件未格式化，clippy 有 28 个风格错误；旧 target 导致 smoke 测试失败 | 本地运行 |

处理状态：
- coding-agent pathguard：已修，`acdf21d`（旧代码新测试失败）。
- coding-agent bash：已修，`bbac303`（旧代码耗时 5.0s，修后约 1s）。
- design-archive `figma.rs`：按字符截断，并加 connect/read 超时，已修，`c0e03993ab`。非原子写和 `.ok()` 未处理。
- auth-todo-api 登录：已修，`6f39b8a`。实测用户不存在与密码错误的耗时都约 0.69s。
- lang clippy 与 e2e 恒真断言：已修，`bb00541`。clippy `-D warnings` 通过，测试全部通过。
- 未处理：`mirror.rs:61` 待追 `rel` 来源；syntax-party 的 rust-version；coding-agent 的 fmt 和 clippy 风格问题；design-archive 的 pnpm 源目录缺失（本次在 /tmp 副本中离线构建验证）。

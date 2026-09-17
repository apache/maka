# Gitoxide 文件执行与接受链路：交付合同

## 范围

基线为 PR1 `0de112e99`，其 main 基线为 `cd93f13da`。
本切片把 Runtime 的纯转换接到 Gitoxide candidate 和 Storage atomic acceptance，
不接 Desktop、session catalog、Host election/startup、continuation 或自动重试。

主要不变量：一次 managed T1 绑定的 exact base/path/args，只有在对应结果内容、candidate、
durable response 被同一个 owner 重验后才能接受；candidate 本身不是 accepted truth。

## Owner 和线性化点

- Gitoxide helper 拥有 SHA-1 object graph 与候选 ref；保持 main 的 policy v3，不引入新 policy epoch。
- Runtime 拥有参数和纯转换结果。适配器只接收 Runtime 生成的 response，不再委托可泄漏的执行 callback。
- Host 的 baseline owner 在 WeakMap 中唯一绑定 execution stores；baseline/successor/no-effect
  proof 只能由该 owner 签发。裸对象不能经过 Storage verifier。
- SQLite 已有事务是接受的线性化点：T2、successor、head、reservation 原子提交。
- accepted Git ref 是派生投影。reopen 先验证 immutable accepted version 与 parent，
  只允许从 exact predecessor CAS 到 accepted commit；其他 ref 值拒绝，不强制覆盖。
- PR2 才增加 group-bound `readVersion`，实际消费者为上述 parent 校验。
  它不是写权限，并且同样参与 close/revocation。

## 操作与失败状态

| 操作 | 校验和边界 | 失败/回滚 |
| --- | --- | --- |
| import + acceptImport | authentic import capability；SQLite baseline acceptance | destination import residue 由既有 import protocol 重验；不伪造 baseline |
| reopen | SQLite epoch/head/profile/repository identity，helper 验证 accepted objects，最后重读 head | 异步期间 head 漂移则拒绝 capability |
| pre-T1 prepare | 原始参数快照、canonical path、accepted file/absence、无 active reservation | 失败不写 T1；不存在与对象缺损明确区分 |
| successful mutation | 重算纯转换，验证 candidate tree/blob 与 durable call/response | 错误 content/path/result 拒绝；不回落 generic T2 |
| no-op | verified unchanged candidate + successful no-effect terminal | 不推进 head，事务释放 reservation |
| deterministic Edit rejection | accepted base 上重算匹配失败 + exact error response | failed-no-effect terminal，不推进 head |
| accepted ref repair | exact accepted successor + predecessor CAS | 无法证明时拒绝，不重新执行 Write/Edit |

在 candidate 发布后、SQLite 接受前退出，只证明 candidate 可重新验证，**本切片不会在启动时自动结算**。
SQLite 已接受后退出，可由新 owner reopen 幂等修复 accepted ref；不能把这称为完整会话 Resume。
没有 checkout 文件写入、目录 projection rotation、quarantine GC、Bash 或 npm。

## 提取方式

- settlement、mutation admission、Runtime adapter 与最终来源 `87a9c7765` 一致。
- baseline owner 采用 `9cca39e27` 的功能边界；最终来源的新增部分仅为
  candidate recovery 与 continuation inspection，留给 PR4。
- helper/invocation/repository capability 使用 `7f534eeff` 的边界，包含 Windows 长 ref 修复；
  之后的 existing-candidate-only verification API 留给 PR4。
- 文件执行 child fixture 从 `9cca39e27` 提取，重命名为
  `gitoxide-file-execution-child.ts`，636 行；不带最终来源的 backend/catalog/continuation 分支。
- Runtime export 只增加纯转换入口；不覆盖 main 的依赖版本或 lockfile。
- 三平台现有 helper workflow 增补新 owner、fixture、Runtime 与 Storage 的触发路径；
  workflow policy test 验证新边界会被 PR/push 两种事件选择。

## 平台和证据

| 平台 | 合同 | 本轮证据 |
| --- | --- | --- |
| Windows | SHA-1 accepted object/ref；有界 helper；真实进程退出后新 owner reopen | 4 workspace build；Rust 14 unit + 62 integration；Host 45 pass / 6 platform skip；Runtime/Storage 121 pass |
| Linux | 同一 object/ref/SQLite 合同 | workflow 已配置，本轮未执行 |
| macOS | 同一 object/ref/SQLite 合同 | workflow 已配置，本轮未执行 |

测试使用真实 Gitoxide、SQLite、root lease、ToolRuntime；Git CLI 仅建立测试源仓库。
不把同进程 mock 当成跨进程证据，也不把 process exit 当成断电证明。
本机 gnullvm helper 必须静态 CRT 链接，以便空 PATH 子进程运行；普通动态链接首轮失败属于
本机构建方式，不是通过扩大运行权限绕过。

Node 24.18.1 的定向 Host 命令为：

```sh
node --test packages/runtime-host/dist/__tests__/gitoxide-helper-artifact-authority-internal.test.js packages/runtime-host/dist/__tests__/gitoxide-helper-invocation-internal.test.js packages/runtime-host/dist/__tests__/gitoxide-repository-admission-authority-internal.test.js
```

设置 MAKA_GITOXIDE_HELPER_PATH 为本切片构建出的 helper；51 tests = 45 pass + 6
显式 Windows skip，0 fail。真实 Runtime/owner crash/reopen 六种模式均执行，未跳过。
本机 gnullvm 以 `cargo rustc --bin maka-gitoxide-helper -- -C target-feature=+crt-static`
构建 helper，再运行已编译的 repository_admission integration runner：62/62。
Rust unit 14/14；没有修改 Cargo.lock 或测试隔离环境。

Gitoxide workflow path/filter 两项验证通过。完整 workflow policy suite 为 45/46，
未改动的 shared-comparison Bash fixture 在 Windows 报错；PR1 对照运行该项也非绿
（清理阶段 EPERM）。本切片未修无关 CI harness，不能宣称全量 CI 已通过。

## 后续

PR3 加入真实 session 创建与 Desktop 入口；PR4 再加入 existing-candidate recovery、
source-bound continuation 和 Electron crash proof。
本切片仍按基础执行能力审查，不宣称完整 Desktop 产品已可用。

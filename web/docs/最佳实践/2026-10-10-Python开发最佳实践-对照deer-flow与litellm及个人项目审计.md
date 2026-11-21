# Python 开发最佳实践（对照 deer-flow、litellm 与个人项目审计）

日期：2026-10-10

## 依据

**参考项目（只读）**

- 主参考：`~/cc/github/other/deer-flow/backend`，commit `c58d04b6`。
- 次参考：`fork/litellm`，commit `533ee1dc`。

**审计对象（只读，未改代码）**

| 项目 | 测试运行情况 |
|---|---|
| `lang/language/impls/python` | 未运行：没有可用的 pytest |
| `interview/code/coding-agent/impls/python`（pcode） | 已运行：58 个 unittest 加 smoke，结果 OK |
| `reverse/code/reverse-engineering-assistant` | 未运行：没有 `.venv` |
| `interview/code/agent-hub/apps/api` | 未运行：没有 `.venv` |
| `tools/design/design-archive` | 未运行：没有 `.venv` |
| `tools/workflow/tapd-task-creator` | 未运行：没有 `.venv` |

本机环境：`python3` 是 3.9.6，低于各项目要求的 `requires-python`；ruff、pytest、mypy、pyright 都没装。所以本文的 Python 证据大多来自**源码确认**，标“已复现”的才是实际跑过的。不要把它当作“测试已通过”。

**适用范围**

GuaHub 下的个人 Python 项目。子项目自己的 AGENTS.md 优先。每条规则都写明“规则、原因、证据”。和 Go 篇（同目录 `2026-10-10-Go开发最佳实践-*.md`）相同的原则不再重复。

---

## 0. 先修环境，再谈规范（目前最大的缺口）

这次审计中，6 个项目只有 1 个能在本机跑起来。最佳实践的第一条不是代码风格，而是**项目要能一条命令跑通**：

```sh
uv sync --locked          # 按 uv.lock 建 .venv，不手工 pip install
uv run pytest -q          # 或项目约定的测试命令
uv run ruff check . && uv run ruff format --check .
```

- **`pyproject.toml` 是唯一的配置入口。** 里面写清 `requires-python`、`[dependency-groups].dev`（放 pytest、ruff，可选 pyright），并提交 `uv.lock`。参考 deer-flow `backend/pyproject.toml:6,55-81`、`Makefile:6`。
- **dev 依赖用 `>=` 下限，靠 lock 文件锁定版本。** 不要像 litellm 那样在 dev 组里全部写死 `==`（`pyproject.toml:197-215`），有了 lock 文件再这样写只会制造无谓的版本变动。
- **CI 要覆盖声明的最低版本。** lang 的 Python 实现声明支持 `>=3.12`，CI 却只测 3.14（`lang/language/.github/workflows/ci.yml:134-153`）。litellm 声明 `>=3.10`，却只测 3.12。个人项目至少把最低版本测一遍。
- **本机统一用 uv 管理解释器**（`uv python install 3.12`），不要依赖系统自带的 3.9。

## 1. 路径与边界（安全类）

| 规则 | 原因 | 证据 |
|---|---|---|
| 越界判断前，两侧都先 `os.path.realpath` / `Path.resolve()`。目标文件还不存在时，解析最近的已存在祖先；悬空链接按越界处理 | `os.path.abspath` 只做字面归一化，不解析符号链接 | **已复现**：pcode `pathguard.py:23` 中，`resolve_path('link/x.txt')` 返回 `outside=False`，但 `link` 实际指向工作目录外。Go 版的同一问题已在 `c478138` 修复，Python 版还没有修 |
| 比较时写 `rel == '..' or rel.startswith('..' + os.sep)`，不要只写 `startswith('..')` | `..foo/` 是合法的目录名 | **已复现**：pcode `pathguard.py:29` 中，`resolve_path('..foo/a')` 返回 `outside=True` |
| 白名单判定用 `Path.resolve()` 加 `is_relative_to` | 字符串前缀匹配会把 `/a/bc` 误判为在 `/a/b` 之内 | 正面例子：pcode `inside_allow_dirs` 的两侧都做了 `resolve()`，所以白名单本身没有被绕过 |

## 2. 子进程

- **参数用列表传，不用 `shell=True`，并且一定带 `timeout=`。** 所有审计项目都做到了这一点，例如 `tapd_automation.py:566`、`axhub.py:96`、lang 的 `conformance/runner.py:103-118`。反例是 deer-flow `extensions/manager.py:966-971`，没有设置 timeout。
- **超时或取消时要杀掉整个进程组，而不只是 shell。**

```python
proc = subprocess.Popen(argv, stdout=PIPE, stderr=PIPE, start_new_session=True)
try:
    out, err = proc.communicate(timeout=timeout)
except subprocess.TimeoutExpired:
    os.killpg(proc.pid, signal.SIGKILL)   # Windows 用 taskkill /T /F
    out, err = proc.communicate()
```

  证据（**已复现**）：pcode `bash.py:79,105` 只调用了 `proc.kill()`。命令 `sleep 7; echo hi` 设置 1 秒超时，结果 5 秒后才返回，而且 `sleep 7` 还在运行。原因是孙进程一直占着管道，读线程要各等满 `join(timeout=2)` 才退出。

## 3. HTTP 与外部调用

- **每个外部调用都显式设置超时。** `requests` 默认**没有**超时；httpx 默认 5 秒，也要显式写出来。参考 litellm `http_handler.py:167-170`：`httpx.Timeout(timeout=..., connect=...)`。正面例子：agent-hub `llm.py`（connect 10 秒、read 120 秒），lang 的 `urlopen(..., timeout=30)`。
- **复用 client，并负责关闭。** 不要每次请求都 `async with httpx.AsyncClient()`（deer-flow `github/app_auth.py:164` 就是这样，而且没设超时）。如果函数内部替调用方创建了兜底 client，必须保证它会被关闭；agent-hub `llm.py:128` 是否关闭还待验证。
- **不要用模块级全局变量缓存 client**，例如 litellm 用 `setattr(litellm, ...)` 的做法（`http_handler.py:1761-1766`）。这样难以测试，还会在测试之间泄漏状态。应改为依赖注入，或者在 FastAPI 的 lifespan 里创建。

## 4. 异常处理

- **转换异常时保留原因：** `raise DomainError(...) from e`。deer-flow 有大约 458 处这样写，例如 `routers/skills.py:186`。
- **领域异常保持小而局部**，例如 `OIDCError` 及其子类（deer-flow `auth/oidc.py:53-61`）。不要套一层厂商 SDK 的异常类（litellm `exceptions.py:132`），除非确实需要兼容。
- **`except Exception` 只能用在边界上**（CLI 顶层、请求处理入口、尽力而为的清理），并且要做到以下之一：
  - 用 `logger.exception(...)` 记录堆栈；
  - 把错误转成明确的输出；
  - 恢复状态后重新抛出。正面例子：lang `go_backend.py:984` 先恢复状态再 `raise`。

  如果是有意为之，标注 `# noqa: BLE001 原因`（lang 的 `cli/main.py` 就是这么做的）。反例：deer-flow 大约有 1090 处 `except Exception`，但只有约 270 处 `logger.exception`；litellm 大约有 4065 处，只有约 310 处。
- **静默吞掉的异常会变成数据丢失：**
  - agent-hub `tasks.py:66` 中，`except Exception: continue` 遇到损坏的快照就直接跳过，不留日志。再加上 `tasks.py:52` 写快照不是原子的，进程崩溃后任务会无声消失。
  - pcode `session.py:63` 吞掉了所有追加写入的错误。这是有意设计，但磁盘写满之类的故障永远不会被发现，至少应该记录一条 warning。
- **库代码不要用 `print`**，用 `logger = logging.getLogger(__name__)`（deer-flow 有 294 个模块这样写）。`print` 只留给 CLI 的输出。

## 5. 文件与数据完整性

- **文本 IO 一律写 `encoding="utf-8"`。** macOS 默认就是 UTF-8，但 Windows 不是。审计项目基本都做到了。
- **状态或快照文件要原子写入：**

```python
tmp = path.with_suffix(path.suffix + ".tmp")
tmp.write_text(data, encoding="utf-8")
os.replace(tmp, path)          # 同一文件系统内是原子操作
```

  证据：agent-hub `tasks.py:52` 直接调用 `write_text`。
- **持久化的数据不要放在系统临时目录。** agent-hub `tasks.py:22` 默认把快照写到 `/tmp`，可能被系统清理。

## 6. 配置与密钥

- **缺少必需的密钥时，启动直接失败。** 不要回退到写死的默认值。agent-hub `orders.py:18` 在 `AGENT_HUB_PAY_SECRET` 缺失时，会回退成一个公开的字符串继续运行。
- **集中读取配置。** 小项目用一个 `Settings` 类（pydantic-settings，或者一个 dataclass 加 `os.environ`）。不要像 deer-flow（约 147 处）和 litellm（约 1318 处）那样到处 `os.getenv`。
- **读取配置不要改写进程环境。** agent-hub `llm.py:46` 的 `.env` 加载器用了 `os.environ.setdefault`，这会让测试之间互相串环境。应该把配置读进对象。

## 7. 并发与 asyncio

- **超时用 `async with asyncio.timeout(n)`**（3.11 起可用；deer-flow `routers/plugins.py:139`）。
- **阻塞调用放进 `asyncio.to_thread`**（deer-flow 约 413 处）。Selenium、同步文件 IO、同步 SDK 都不能直接在 async 的 handler 里调用；tapd-task-creator 是否有这个问题待验证。
- **`gather(..., return_exceptions=True)` 之后要逐个检查结果**，否则等于吞掉了异常。
- **共享状态的检查和写入，要用正确的 key 一次完成。** 证据（源码确认）：agent-hub `tasks.py:67` 写的是 `if task.status not in _TASKS:`，但 `_TASKS` 的键是 `taskId`，所以去重判断永远不起作用，恢复的快照会覆盖内存中正在运行的任务。这类笔误需要一个测试来锁住行为：先放一个运行中的任务，再恢复同 ID 的快照，断言原任务没有被覆盖。

## 8. 测试

- **框架：** 默认用 pytest。项目已经在用 unittest 的（pcode 只依赖标准库）就保持现状，不为统一而迁移。
- **隔离：**
  - 用 `tmp_path`、`monkeypatch`（包括 `monkeypatch.setenv`、`monkeypatch.chdir`），不要手写 `mkdtemp` 又不清理。lang 的 `tests/conformance_test.py:72-76` 在 `.tmp-build/` 里留下了 600 个目录。
  - 用 autouse fixture 重置单例和全局状态（deer-flow `tests/conftest.py:81-158`）。
- **外部依赖要打标记**：例如 `@pytest.mark.integration`、`@pytest.mark.live`，默认运行 `-m "not live"`，通过环境变量显式开启（deer-flow `pyproject.toml:84-89`、`Makefile:32-33`）。缺少依赖时用 `pytest.skip("原因")`，并在交付说明里写明是跳过，不算通过。
- **async 测试：** 用 pytest-asyncio 的 strict 或 auto 模式都可以。不要把整个会话共用一个事件循环（litellm `pyproject.toml:383`），以免状态泄漏。
- **修 bug 先写测试**，确认它在旧代码上会失败，并把旧代码的失败输出写进提交说明。规则和 Go 篇相同。

## 9. lint 与类型检查

- **ruff 起步配置**（个人项目，宁少勿多，再按棘轮方式逐步加规则）：

```toml
[tool.ruff]
line-length = 120            # deer-flow 用 240，E501 基本形同虚设
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B", "BLE", "S", "ASYNC", "SIM"]
```

- **棘轮做法：** 某条规则在代码库里已经是 0 处违规，就把它加进 `extend-select`，此后一律硬失败（litellm `ruff.toml:5-13`）。存量问题不批量清零，CI 只检查改动的文件（参考 litellm `test-linting.yml:111-119`，用 `git diff --name-only $BASE` 挑出改动文件）。
- **测试代码也要过 lint**，不要像 litellm 那样把整个 `tests/*` 排除掉（`ruff.toml:35`）。
- **类型检查：** 先用 pyright 的 basic 模式或 mypy 的默认配置，只要求新代码没有错误。strict 模式加按规则计数的门禁（litellm）对个人项目太重。
- **`make lint` 是 CI 和 pre-commit 的同一个入口**，做法是 `ruff check` 加 `ruff format --check`，再加 uv lock 校验钩子（deer-flow `.pre-commit-config.yaml:5-17`）。

## 10. 不采纳或暂缓

| 做法 | 来源 | 理由 |
|---|---|---|
| pytest-split 时长文件加 4 分片、xdist 矩阵 | deer-flow `Makefile:22-58`、litellm `test-unit.yml:494-499` | 测试规模到不了这个量级 |
| mutmut、按规则计数的 basedpyright 门禁、`lint.external` 的 noqa 记账 | litellm | 维护成本远大于收益 |
| Blockbuster 阻塞 IO 门禁 | deer-flow `tests/blocking_io/conftest.py:27` | 理念好，但只有大量使用 async 的项目才值得 |
| 全局 `filterwarnings` 静默警告 | litellm `pyproject.toml:390-397` | 会掩盖真正的弃用警告 |
| uv `override-dependencies` 绕行 | deer-flow `pyproject.toml:94-109` | 只在遇到具体冲突时才用，并写清原因 |

## 11. 采纳清单

- [ ] `uv sync --locked && uv run pytest` 一条命令能跑通；`uv.lock` 已提交；CI 覆盖 `requires-python` 声明的最低版本
- [ ] ruff 检查和格式检查进入 CI 和 pre-commit；新增规则走棘轮方式
- [ ] 路径边界判断做了 `realpath`，并按路径分量比较
- [ ] 子进程用参数列表，带 timeout，超时时杀掉整个进程组
- [ ] 所有 HTTP 调用都显式设置超时，client 复用并会被关闭
- [ ] `except Exception` 只出现在边界上，并且记录堆栈、转换成输出或重新抛出
- [ ] 状态文件原子写入；文本 IO 写明 `utf-8`
- [ ] 缺少必需密钥时启动失败；配置集中在一个对象里，不改写 `os.environ`
- [ ] 测试用 `tmp_path`、`monkeypatch`；外部依赖打标记，缺失时 skip 并如实报告

## 12. 本次审计发现的待修项（未实施，需要你确认后再修）

| 优先级 | 项目 | 位置 | 问题 | 状态 |
|---|---|---|---|---|
| 1 | pcode | `pathguard.py:23,29` | 越界提示可以通过符号链接绕过；`..foo` 被误判为越界 | 已复现 |
| 2 | pcode | `bash.py:79,105` | 超时后孙进程残留，工具要 5 秒才返回 | 已复现 |
| 3 | agent-hub | `tasks.py:67` | 用 `status` 当键查重，恢复快照会覆盖运行中的任务 | 源码确认（文件里有你未提交的改动） |
| 4 | agent-hub | `tasks.py:52,66`、`orders.py:18` | 快照写入不是原子的、损坏的快照静默跳过；缺少密钥时回退到公开默认值 | 源码确认 |
| 5 | lang（Python 版） | `tests/conformance_test.py:72-76`、`ci.yml` | 临时目录不清理；CI 不测最低版本 3.12 | 源码确认 |

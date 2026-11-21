# Cursor 沙盒执行生存手册（长期资产）

> 适用范围：Cursor IDE（截至 2026-01）
> 不适用：Claude Desktop / Windsurf / Copilot / 终端直连环境
> 性质：工程实践总结，不是理论文档

---

## 0. 为什么需要这份文档

在 Cursor 中，Agent 并不是在你的真实终端里执行命令，而是在一个：

- 非 login shell
- 非 interactive shell
- PTY/TTY 行为不完整
- 文件系统/权限被限制

的**沙盒环境**中执行。

结果就是：
**"命令看起来没问题，但就是失败，而且没有输出。"**

本手册的目标是：

> 当你在 Cursor 中遇到异常行为时，
> **用最短路径判断是不是沙盒问题，并给出稳定解法。**

---

## 1. Cursor 沙盒的核心特征（必须先记住）

- 不会自动 source `~/.zshrc`
- `TERM=dumb`，大量工具会自动降级或静默
- stdout / stderr 可能被吞
- `cd && command` 可能失败
- `/tmp` 不可靠
- 后台命令（is_background）极容易静默失败

---

## 2. 高频问题速查表（直接对照）

### 2.1 node / pnpm / fnm 对不上

**症状**

- `node -v` 不是你本机版本
- pnpm 找不到 / 行为异常

**根因**

- 非 login shell，fnm 初始化未执行

**标准解法**

```bash
/bin/zsh -c "source ~/.zshrc && <command>"
```

---

### 2.2 cd 失败 / 工作目录漂移

**症状**

- cd xxx && pwd 没输出
- 后续命令在错误目录执行

**根因**

- Cursor 沙盒 + gvm 覆盖了 cd

**标准解法**

```
builtin cd /abs/path && command
```

---

### 2.3 输出被吞（最坑）

**症状**

- Exit code = 1
- stdout / stderr 完全为空

**高风险命令**

- pnpm install
- turbo run
- tsc
- docker compose up

**应对原则**

- 不依赖重定向
- 不写 /tmp
- 尽量直接前台执行

---

### 2.4 /tmp 写入失败

**症状**

```
cat /tmp/xxx.log
# No such file
```

**根因**

- 沙盒不保证 /tmp 可写

**标准解法**

```
mkdir -p .ggbdpq/tmp
command > .ggbdpq/tmp/out.log 2>&1
```

---

### 2.5 pnpm store 报错

**症状**

```
ERR_PNPM_UNEXPECTED_STORE
```

**解法（一次性）**

```
pnpm config set store-dir ~/Library/pnpm/store/v3
```

---

### 2.6 pnpm script 不存在，但 Cursor 没有任何输出

**症状**

- `pnpm typecheck` / `pnpm lint` 等命令直接退出
- Exit code = 1
- stdout / stderr 为空
- 看起来像“沙盒吞输出”

**真实原因**

- 项目根本没有定义该 script
- Cursor 沙盒未正确显示 pnpm 的 “Missing script” 报错

**快速自检（必做）**

```bash
cat package.json | grep "\"typecheck\""
```

或：

```
pnpm run
```

**标准处理方式**

- 明确约定：PRD / EXECUTION.md 中使用的 script，必须在根 package.json 中存在
- 对 Monorepo，必须统一在根定义聚合脚本（如 typecheck / lint / build）

**经验法则**

> 在 Cursor 中看到“无输出失败”，

> **先检查 script 是否真实存在，再怀疑沙盒。**

---

## 3. 我在 Cursor 中的"安全命令写法规范"

### ✅ 推荐

```

/bin/zsh -c "source ~/.zshrc && builtin cd /abs/path && command"

```

### ❌ 避免

```

cd xxx && command
command > /tmp/file
command & # 后台

```

---

## 4. 诊断顺序（不要乱猜）

1. pwd
2. which node && node -v
3. which pnpm && pnpm -v
4. echo $TERM
5. 是否涉及 cd / 重定向 / 后台

**80% 的问题在第 2 步就能确认。**

---

## 5. 已验证的真实案例来源

- PromptFlow 项目（2026-01）
- 多轮 PRD 执行
- Tailwind v4 / Vite / Turbo / Prisma / Docker

详细记录见：

- sandbox-diagnosis.md
- sandbox-diagnosis-20260114-214509.md

---

## 6. 本手册的适用边界

- ✔ 适用于 Cursor Agent
- ❌ 不保证其他 AI IDE 行为一致
- ❌ 不保证未来 Cursor 版本不变

当 Cursor 行为发生变化时，应新增"轮次诊断"，而不是修改本手册历史结论。

---

## 7. 使用原则（一句话）

> **在 Cursor 中遇到奇怪问题，**
>
> **先假设是沙盒，再考虑代码。**

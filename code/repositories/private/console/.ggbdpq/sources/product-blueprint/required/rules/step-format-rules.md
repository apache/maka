# Step Format Rules

> 三行强制 steps 规范（母本硬规则）

---

## 三行格式

每条 step 必须包含且仅包含以下三行，顺序固定：

```
第 1 行：操作：<动词开头，只做一件事>
第 2 行：产物：<明确路径或可观察结果>
第 3 行：验收命令：<可复制运行的命令>
```

---

## 硬约束

1. **每条 step 只能三行，不能多也不能少**
2. **三行顺序固定**：操作 → 产物 → 验收命令
3. **三行前缀固定且必须精确匹配**：`操作：` / `产物：` / `验收命令：`
4. **操作行必须动词开头，只做一件事**
5. **产物行必须给出明确路径或可观察结果**
6. **验收命令行必须给出可复制运行的命令**
7. **若无法用命令验收，仍必须给出替代可执行检查方式**（test -f / grep / node -c 等）
8. **允许人工验收时，验收命令必须能定位验收清单文件路径**

---

## 验收门禁等级

### L0：文档与结构门禁

- **适用**：仅检查文件存在性、内容匹配，不执行运行时验证
- **允许命令**：`test -f`, `test -d`, `grep`, `jq`, `ls`, `wc`

### L1：工程门禁

- **适用**：必须通过静态类型检查，确保代码可编译
- **必须命令**：`pnpm typecheck`

### L2：行为门禁

- **适用**：必须通过运行时测试，确保代码行为正确
- **必须命令**：`pnpm test`, `npx playwright test`, `curl`

---

## 优先级门禁要求

| 优先级 | 最后一步验收命令要求                                             |
| ------ | ---------------------------------------------------------------- |
| P0     | 必须达到 L2（pnpm test 或 npx playwright test）                  |
| P1     | 必须达到 L2（pnpm test 或 npx playwright test）                  |
| P2     | 允许 L1（pnpm typecheck）或 L0（test -f/grep），视 item 类型裁决 |

---

## 示例

```
操作：创建 pnpm-workspace.yaml 配置 apps/* 和 packages/*
产物：pnpm-workspace.yaml 文件存在
验收命令：test -f pnpm-workspace.yaml && echo 'PASS'
```

```
操作：运行 pnpm typecheck 验证类型无报错
产物：pnpm typecheck 输出 exit code 为 0
验收命令：pnpm typecheck
```

```
操作：运行 pnpm test 验证单测通过
产物：pnpm test 输出包含 PASS 且 exit code 为 0
验收命令：pnpm test
```

---

## 防污染条款

1. **规则正文存放位置**：只允许出现在 `.ggbdpq/required/rules` 与 `.ggbdpq/required/toolchain`
2. **progress.txt 内容限制**：仅记录动作事实与路径裁决，不写目录树，不写表格，不写规则解释
3. **prd.json 职责单一**：仅负责业务需求排布，环境与规则通过 `optional_refs` 索引引用

---

> 本文件为母本硬规则，所有 prd.json 中的 steps 必须遵循此格式。

---
name: Hooks 面试稿与用法索引
overview: 从零编写 useState 和 useEffect 的面试 30 秒回答稿，并扫描 bcp-front / domp-front / ssap-front 全部 780+ 处 Hook 调用，按固定结构生成两份完整索引文档。
todos:
  - id: scan-bcp-useState
    content: 扫描 bcp-front 全部 useState 调用（~327 处），提取 7 字段结构化数据
    status: pending
  - id: scan-bcp-useEffect
    content: 扫描 bcp-front 全部 useEffect 调用（~190 处），提取 7 字段结构化数据
    status: pending
  - id: scan-domp
    content: 扫描 domp-front 全部 useState + useEffect 调用（~215 处），提取 7 字段结构化数据
    status: pending
  - id: scan-ssap
    content: 扫描 ssap-front 全部 useState + useEffect 调用（~51 处），提取 7 字段结构化数据
    status: pending
  - id: write-interview-useState
    content: 编写 useState 面试 30 秒回答稿（定义、边界、常见坑、追问、最小示例）
    status: pending
  - id: write-interview-useEffect
    content: 编写 useEffect 面试 30 秒回答稿（定义、边界、常见坑、追问、最小示例）
    status: pending
  - id: assemble-useState-md
    content: 合并 useState 扫描数据 + 回答稿，按排序规则输出 docs/react-hooks/useState.md
    status: pending
  - id: assemble-useEffect-md
    content: 合并 useEffect 扫描数据 + 回答稿，按排序规则输出 docs/react-hooks/useEffect.md
    status: pending
  - id: verify
    content: 验收：字段完整性、编号正确性、排序正确性、总条目数一致性
    status: pending
isProject: false
---

# Hooks 面试回答稿 + 项目用法全量索引

## 产物

- `docs/react-hooks/useState.md`
- `docs/react-hooks/useEffect.md`

两个文件均包含：

1. **面试 30 秒回答稿**（从零创建）
2. **项目真实用法索引**（全量收录，不裁剪）

---

## 第一阶段：扫描与数据采集

### 步骤 1 - 使用 ripgrep 全量提取匹配行及上下文

对三个仓库依次执行 `rg`，排除无关目录，输出匹配行 + 上下文 8 行：

```bash
# useState 扫描（三个仓库分别执行）
rg -n -C 8 --type-add 'frontend:*.{js,jsx,ts,tsx}' -t frontend \
  --glob '!node_modules' --glob '!dist' --glob '!build' \
  --glob '!coverage' --glob '!.next' --glob '!.turbo' \
  --glob '!.git' --glob '!storybook-static' \
  'useState\s*\(' \
  bcp-front/src

# useEffect 扫描（同参数，模式换为 useEffect\s*\(）
rg -n -C 8 --type-add 'frontend:*.{js,jsx,ts,tsx}' -t frontend \
  --glob '!node_modules' ... \
  'useEffect\s*\(' \
  bcp-front/src
```

四个模式覆盖：

- `useState\s*\(`
- `useEffect\s*\(`
- `React\.useState\s*\(`
- `React\.useEffect\s*\(`

实际执行时可合并为 `(React\.)?useState\s*\(` 减少扫描次数。

### 步骤 2 - 提取每个匹配的元数据

对每个匹配项，通过读取文件提取：

- **Path**：相对仓库根目录路径
- **Module**：`src/` 下一级目录名（如 `component`、`pages`、`hooks`）
- **Export**：从文件中查找 `export (default|named)` 获取组件/函数名
- **Hook**：useState 或 useEffect
- **Purpose**：根据变量名、上下文推断一句话用途
- **Snippet**：Hook 调用上下各 8 行
- **Notes**：面试追问点（依赖数组、闭包、竞态等）

### 步骤 3 - 同文件多处 Hook 编号

同一文件内多处 useState/useEffect 按出现行号顺序编号为 `#1`、`#2`、`#3`...

---

## 第二阶段：面试回答稿编写

### useState 回答稿核心点

- 定义：函数组件中声明可触发 re-render 的局部状态
- 边界：初始值只在首次渲染时生效；set 是异步批处理；对象/数组需浅拷贝
- 常见坑：直接 mutate 不触发更新、闭包陈旧值、初始化昂贵计算未用惰性初始化
- 追问：函数式更新 `setState(prev => ...)` vs 直接赋值；与 useReducer 的取舍

### useEffect 回答稿核心点

- 定义：在 commit 阶段后执行副作用，同步 React 外部系统
- 边界：依赖数组语义（空 = mount、省略 = 每次、指定 = 变化时）；cleanup 时机
- 常见坑：依赖遗漏导致闭包陈旧、竞态条件未用 cleanup 或 AbortController、无限循环
- 追问：useEffect vs useLayoutEffect；Strict Mode 双重执行；如何避免 "effect 作为数据获取" 的反模式

---

## 第三阶段：文档组装与输出

### 排序规则

1. 仓库顺序：bcp-front -> domp-front -> ssap-front
2. 仓库内按 Path 字典序（`src/component/a.tsx` < `src/component/b.tsx`）

### 文档结构（固定）

```markdown
# useState（或 useEffect）

## 1. 面试 30 秒回答稿

### 定义

### 解决的问题

### 边界

### 常见坑

### 追问与加分点

### 最小正确示例

## 2. 我项目中的真实用法索引

### bcp-front

#### component

- **Path:** ...
- **Module:** ...
- **Export:** ...
- **Hook:** ...
- **Purpose:** ...
- **Snippet:** ...
- **Notes:** ...

#### hooks

...

### domp-front

...

### ssap-front

...
```

---

## 执行策略

由于总量约 780+ 处，将使用 **并行子代理** 策略：

| 子代理  | 负责范围                                 | 预估匹配数 |
| ------- | ---------------------------------------- | ---------- |
| Agent A | bcp-front useState (327 处)              | 最大       |
| Agent B | bcp-front useEffect (190 处)             | 大         |
| Agent C | domp-front useState + useEffect (215 处) | 中         |
| Agent D | ssap-front useState + useEffect (51 处)  | 小         |

每个子代理输出结构化中间数据后，由主代理合并、排序、去重编号，最终写入两份 Markdown。

面试回答稿由主代理直接编写，不依赖扫描结果。

---

## 验收方式

1. 两份文档均存在于 `docs/react-hooks/` 目录下
2. 面试回答稿部分：定义、边界、常见坑、追问、最小示例齐全，示例不超过 25 行
3. 索引部分：每条记录 7 个字段完整，Snippet 包含上下各 8 行
4. 同文件多处 Hook 有 #N 编号
5. 排序正确：仓库固定顺序，仓库内 Path 字典序
6. 总条目数与 rg count 一致（useState ~434，useEffect ~349）

---

## 需要你确认的点

1. 产物路径 `docs/react-hooks/useState.md` 和 `docs/react-hooks/useEffect.md` 放在 LearnReact 根目录下，确认？
2. 全量 780+ 条索引生成的文档会非常长（预估 useState.md 约 3000-5000 行、useEffect.md 约 2500-4000 行），确认全部收录不裁剪？
3. 面试回答稿从零编写，以 React 18 为基准，确认？
4. Snippet 上下文各 8 行（你原始要求），如果文件开头/结尾不足 8 行则取到边界，确认？
5. Notes 字段面试追问点我会基于代码实际情况判断，可能涉及：闭包、依赖数组、竞态、清理函数、函数式更新、批处理、惰性初始化等，确认这些维度覆盖面足够？
6. 自定义 Hook 内的 useState/useEffect 也一并收录到对应文档中（标注 Export 为 hook 名），确认？
7. 执行阶段我会使用并行子代理加速，单次执行可能需要 5-10 分钟，确认可以等待？

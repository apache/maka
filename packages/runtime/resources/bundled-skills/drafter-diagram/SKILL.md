---
name: 技术示意图
description: 需要把流程、架构、时序、数据模型或状态机画成图时使用。用户会说"画个流程图""画一下系统架构""这个调用时序图""ER 图""帮我把这段逻辑可视化""生成一张架构示意图"。
category: 设计与UI
allowed-tools:
  - Read
  - Write
  - Bash
---

# 技术示意图

## 目标

把文字描述的逻辑关系变成清晰的**文本源码图**：优先用 Mermaid（流程 / 时序 / 架构 / ER / 状态 / 甘特），复杂精细排版用 Graphviz DOT。产物是可版本管理的 `.mmd` 或 `.dot` 源文件，加一张渲染好的 SVG/PNG。核心原则：**源码可读、结构正确、渲染无报错**，图服务于理解而非炫技。

选型速判：

- 有明确"步骤 / 判断分支 / 参与方消息 / 实体关系 / 状态迁移" → **Mermaid**（语法短、渲染快、GitHub 原生支持）
- 需要精细控制布局、分层子图、大规模节点、精确连线走向 → **Graphviz DOT**
- 蓝图 / 极简线框风格 → Mermaid 加自定义 theme 变量，或 DOT 配 `rankdir` + 素色节点

## 工作流步骤

### 第 1 步：厘清要表达什么

先判定图的**类型**，类型错了后面全白费：

| 表达对象 | 图类型 | 语法 |
|---------|--------|------|
| 步骤与分支 | 流程图 | Mermaid `flowchart` |
| 多方按时间交互 | 时序图 | Mermaid `sequenceDiagram` |
| 模块/服务依赖 | 架构图 | Mermaid `flowchart` + `subgraph` |
| 数据表与关系 | ER 图 | Mermaid `erDiagram` |
| 对象生命周期 | 状态图 | Mermaid `stateDiagram-v2` |
| 复杂大图/精排 | 有向图 | Graphviz `digraph` |

### 第 2 步：抽取节点与关系

从需求里列出：**节点**（框里写什么）、**边**（谁指向谁、连线标签）、**分组**（哪些节点属于同一子系统）。节点文字力求短，超过 6–8 字的说明放边标签或注释，别塞进框里。

### 第 3 步：写源码（用下面的模板起手）

**Mermaid 流程图**（含判断、子图、样式）：

```
flowchart TD
    A[用户请求] --> B{已登录?}
    B -->|否| C[跳转登录]
    B -->|是| D[校验权限]
    D --> E[(数据库)]
    subgraph 服务层
        D --> F[业务处理]
    end
    F --> G[返回结果]
    classDef db fill:#eef2ff,stroke:#4f46e5,color:#1a1a2e;
    class E db;
```

**Mermaid 时序图**：

```
sequenceDiagram
    autonumber
    participant C as 客户端
    participant A as API 网关
    participant S as 服务
    C->>A: POST /order
    A->>S: 转发请求
    S-->>A: 201 Created
    A-->>C: 返回订单号
    Note over S: 写入订单表
```

**Mermaid ER 图**：

```
erDiagram
    USER ||--o{ ORDER : places
    ORDER ||--|{ ITEM : contains
    USER {
        int id PK
        string email
    }
    ORDER {
        int id PK
        int user_id FK
    }
```

**Mermaid 状态图**：

```
stateDiagram-v2
    [*] --> 待支付
    待支付 --> 已支付: 支付成功
    待支付 --> 已取消: 超时
    已支付 --> 已发货: 出库
    已发货 --> [*]
```

**Graphviz DOT**（分层架构 / 蓝图风格）：

```
digraph arch {
    rankdir=TB;
    node [shape=box, style="rounded,filled", fillcolor="#f9fafb",
          color="#4f46e5", fontname="Inter", fontsize=12];
    edge [color="#9ca3af", fontname="Inter", fontsize=10];
    subgraph cluster_fe { label="前端"; color="#e5e7eb"; Web; Mobile; }
    subgraph cluster_be { label="后端"; color="#e5e7eb"; API; Worker; }
    Web -> API; Mobile -> API; API -> Worker;
    API -> DB [label="读写"]; DB [shape=cylinder];
}
```

用 Write 把源码存成 `diagram.mmd` 或 `diagram.dot`。

### 第 4 步：渲染成图片（Bash，按需安装工具）

**Mermaid** —— 用 `@mermaid-js/mermaid-cli` 的 `mmdc`，无需全局装：

```bash
# 渲染 SVG（矢量、推荐）
npx -y @mermaid-js/mermaid-cli -i diagram.mmd -o diagram.svg
# 渲染高清 PNG（用于粘贴/分享）
npx -y @mermaid-js/mermaid-cli -i diagram.mmd -o diagram.png -s 2 -b transparent
# 指定主题（default/neutral/dark/forest）
npx -y @mermaid-js/mermaid-cli -i diagram.mmd -o diagram.svg -t neutral
```

**Graphviz** —— 需 `dot`，先探测再按需装：

```bash
if ! command -v dot >/dev/null 2>&1; then
  echo "安装 graphviz..."; brew install graphviz   # macOS
fi
dot -Tsvg diagram.dot -o diagram.svg
dot -Tpng -Gdpi=200 diagram.dot -o diagram.png
```

### 第 5 步：自检渲染结果

渲染命令**必须成功退出且生成非空文件**。若报语法错，读错误行号定位（常见：中文括号、节点 id 含空格、箭头拼写）。确认后向用户交付源文件与图片路径。

## 规范 / 质量清单

- [ ] 图类型与表达对象匹配（流程/时序/ER/状态选对）
- [ ] 节点文字精简，长说明移到边标签或 Note
- [ ] 方向一致（流程图统一 TD 或 LR，不混）
- [ ] 判断节点分支标注了条件（是/否、成功/失败）
- [ ] 相关节点用 subgraph/cluster 分组
- [ ] 数据库/外部系统用区分形状（圆柱/异形）
- [ ] 渲染命令零报错，输出文件非空
- [ ] 中文节点未触发语法冲突（避免裸露的 `()[]{}` 特殊字符）
- [ ] SVG 优先（矢量可缩放），需要位图时 PNG 至少 2x

## 输出格式

交付两类文件，写在用户指定或当前目录：

1. **源文件** `*.mmd` / `*.dot` —— 可版本管理、可二次编辑
2. **渲染图** `*.svg`（默认）或 `*.png`（分享用）

Markdown 场景可直接内嵌 Mermaid 源码块（GitHub、多数文档站原生渲染），此时可省略图片：

````
```mermaid
flowchart LR
    A --> B
```
````

交付说明包含：图类型、选用 Mermaid/DOT 的理由、源文件路径、图片路径、渲染命令。

## 边界

- 只画结构性技术示意图，不做数据统计图表（柱状/折线/饼图属于图表类，不在此范围）。
- 不臆造需求里没有的节点或关系；信息不足时先问清参与方与流向，别脑补。
- 一张图聚焦一个视角；系统过大时拆成多张（总览图 + 分模块细节图），不堆在一张里挤成蛛网。
- 渲染依赖（node/npx、graphviz）缺失时先按需安装并提示用户，不假设环境已就绪。
- 不引用外部图片或字体资源，源文件自包含。

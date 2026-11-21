# UI UX Pro Max 架构与实现分析

本文面向个人深度学习，目标是从资深架构师视角拆解 `ui-ux-pro-max` 的源码设计。分析重点放在架构机制和设计取舍，说明它如何把大量 UI/UX 知识组织成可检索、可组合、可扩展、可复用的 Skill 工程。

## 结论摘要

`ui-ux-pro-max` 的核心价值在于分层清晰。`SKILL.md` 负责使用协议，`search.py` 负责 CLI 控制，`core.py` 负责统一检索，`design_system.py` 负责组合推理与文件输出，`data` 目录负责承载结构化知识。

这套设计优秀的地方有四点。

1. 规则和知识分离，`SKILL.md` 不承担海量知识存储。
2. 检索和组合分离，普通查询与设计系统生成各司其职。
3. 配置和算法分离，新增 domain 或 stack 多数时候只需要补 CSV 和配置。
4. 运行输出和长期沉淀分离，终端输出适合即时使用，Master 加页面覆盖适合跨会话复用。

## 问题定义

一个大型 UI/UX Skill 会遇到四类矛盾。

| 矛盾                   | 具体表现                         | 当前架构的处理方式                                  |
| ---------------------- | -------------------------------- | --------------------------------------------------- |
| 文档可读性与知识规模   | 知识越多，`SKILL.md` 越容易膨胀  | 把知识主体放入 CSV，`SKILL.md` 只写工作流和关键规则 |
| 搜索相关性与字段复杂度 | 每张表字段不同，统一检索容易失真 | 用 `CSV_CONFIG` 声明搜索列和输出列                  |
| 单条建议与完整方案     | 普通搜索只能回答局部问题         | `design_system.py` 聚合多个 domain 生成设计系统     |
| 一次性结果与长期复用   | 终端输出难以成为项目事实源       | 持久化为 `MASTER.md` 与页面覆盖文件                 |

所以，这个 Skill 的架构目标可以概括为一句话。用薄协议调度厚知识，用轻量检索连接多表数据，用组合层把局部知识变成可执行设计建议。

## 当前源码事实

当前本地路径如下。

`~\.agents\categories\04-设计系统与前端应用\01-UIUX与前端审美\ui-ux-pro-max`

关键文件规模如下。

| 文件                       | 行数 | 架构角色                                                      |
| -------------------------- | ---: | ------------------------------------------------------------- |
| `SKILL.md`                 |  659 | 协议层，说明何时用、怎么用、怎么验收                          |
| `scripts\search.py`        |  114 | 控制层，负责 CLI 参数和分支路由                               |
| `scripts\core.py`          |  262 | 检索层，负责 CSV 配置、BM25、domain 和 stack 查询             |
| `scripts\design_system.py` | 1148 | 组合层和持久化层，负责设计系统生成、格式化、Master 与页面覆盖 |

配置内数据量如下。

| 数据范围           |  数量 |    行数 |
| ------------------ | ----: | ------: |
| 普通 domain        | 11 个 | 2739 行 |
| 技术栈 stack       | 16 个 |  841 行 |
| 合计可配置检索数据 | 27 组 | 3580 行 |

`data\design.csv` 和 `data\draft.csv` 也在数据目录中，分别约 1601 行与 1602 行。它们当前没有进入 `core.py` 的 `CSV_CONFIG` 或 `STACK_CONFIG`，更适合作为参考或备份类资料看待，不能把它们算入 CLI 直接检索口径。

## 总体架构

```text
用户请求
  |
  v
SKILL.md
  |  触发条件、规则优先级、工作流、验收清单
  v
search.py
  |  CLI 参数解析、输出格式选择、分支路由
  +-------------------------+
  |                         |
  v                         v
core.py                  design_system.py
  |                         |
  |  BM25 搜索              |  多 domain 聚合
  |  domain 查询             |  reasoning rule 应用
  |  stack 查询              |  设计系统字典生成
  |                         |  ASCII / Markdown 输出
  |                         |  Master / page override 持久化
  v                         v
data/*.csv              design-system/<project>/
```

这个结构最值得学习的点是每层只解决一个主要问题。

| 层级     | 解决的问题                  | 代表文件           |
| -------- | --------------------------- | ------------------ |
| 协议层   | 什么时候用、按什么规则用    | `SKILL.md`         |
| 控制层   | CLI 如何接收参数并分发      | `search.py`        |
| 检索层   | 如何从不同 CSV 中找相关内容 | `core.py`          |
| 组合层   | 如何把多域结果合成设计系统  | `design_system.py` |
| 持久化层 | 如何把结果变成项目级事实源  | `design_system.py` |
| 数据层   | 如何承载可扩展知识卡片      | `data\*.csv`       |

## 文件职责

```text
ui-ux-pro-max/
├── SKILL.md
├── scripts/
│   ├── search.py
│   ├── core.py
│   └── design_system.py
└── data/
    ├── styles.csv
    ├── colors.csv
    ├── products.csv
    ├── typography.csv
    ├── landing.csv
    ├── charts.csv
    ├── icons.csv
    ├── ux-guidelines.csv
    ├── react-performance.csv
    ├── app-interface.csv
    ├── google-fonts.csv
    ├── ui-reasoning.csv
    ├── design.csv
    ├── draft.csv
    └── stacks/
        ├── react.csv
        ├── nextjs.csv
        ├── vue.csv
        ├── svelte.csv
        ├── astro.csv
        ├── swiftui.csv
        ├── react-native.csv
        ├── flutter.csv
        ├── nuxtjs.csv
        ├── nuxt-ui.csv
        ├── html-tailwind.csv
        ├── shadcn.csv
        ├── jetpack-compose.csv
        ├── threejs.csv
        ├── angular.csv
        └── laravel.csv
```

职责表如下。

| 文件                | 核心职责                                                            | 学习重点                     |
| ------------------- | ------------------------------------------------------------------- | ---------------------------- |
| `SKILL.md`          | 定义触发条件、优先级规则、CLI 使用方式、交付检查清单                | 如何把使用协议写得清楚       |
| `search.py`         | 统一 CLI 入口，处理 `--design-system`、`--domain`、`--stack` 等分支 | 如何让调用入口保持薄         |
| `core.py`           | 定义 `CSV_CONFIG`、`STACK_CONFIG`、`BM25` 和搜索函数                | 如何用配置适配异构数据       |
| `design_system.py`  | 聚合检索、应用 reasoning、格式化输出、持久化文件                    | 如何把知识检索升级为方案生成 |
| `data\*.csv`        | 承载产品、风格、配色、字体、图表、UX 等知识                         | 如何把知识卡片化             |
| `data\stacks\*.csv` | 承载栈级实现规则                                                    | 如何统一多技术栈规则结构     |

## 数据事实

### 配置内普通 domain

这些数据文件由 `core.py` 的 `CSV_CONFIG` 直接声明，普通查询和设计系统生成会使用其中一部分。

| Domain         | 文件                    | 行数 | 主要用途                        |
| -------------- | ----------------------- | ---: | ------------------------------- |
| `style`        | `styles.csv`            |   84 | UI 风格、效果、兼容性、实现检查 |
| `color`        | `colors.csv`            |  161 | 产品类型到语义色板              |
| `chart`        | `charts.csv`            |   25 | 图表选择、可访问替代、库建议    |
| `landing`      | `landing.csv`           |   34 | 页面结构、CTA 和转化策略        |
| `product`      | `products.csv`          |  161 | 产品类型、推荐风格、关键考虑    |
| `ux`           | `ux-guidelines.csv`     |   99 | UX 规则、反模式、严重级别       |
| `typography`   | `typography.csv`        |   73 | 字体搭配、情绪、导入方式        |
| `icons`        | `icons.csv`             |  105 | 图标库、导入代码、使用场景      |
| `react`        | `react-performance.csv` |   44 | React 与 Next.js 性能建议       |
| `web`          | `app-interface.csv`     |   30 | App 接口、触控、无障碍规范      |
| `google-fonts` | `google-fonts.csv`      | 1923 | Google Fonts 字体检索           |

### 配置内技术栈 stack

这些文件由 `STACK_CONFIG` 管理，查询时走 `search_stack()`。

| Stack             | 文件                         | 行数 |
| ----------------- | ---------------------------- | ---: |
| `react`           | `stacks\react.csv`           |   53 |
| `nextjs`          | `stacks\nextjs.csv`          |   52 |
| `vue`             | `stacks\vue.csv`             |   49 |
| `svelte`          | `stacks\svelte.csv`          |   53 |
| `astro`           | `stacks\astro.csv`           |   53 |
| `swiftui`         | `stacks\swiftui.csv`         |   50 |
| `react-native`    | `stacks\react-native.csv`    |   51 |
| `flutter`         | `stacks\flutter.csv`         |   52 |
| `nuxtjs`          | `stacks\nuxtjs.csv`          |   58 |
| `nuxt-ui`         | `stacks\nuxt-ui.csv`         |   50 |
| `html-tailwind`   | `stacks\html-tailwind.csv`   |   55 |
| `shadcn`          | `stacks\shadcn.csv`          |   60 |
| `jetpack-compose` | `stacks\jetpack-compose.csv` |   52 |
| `threejs`         | `stacks\threejs.csv`         |   53 |
| `angular`         | `stacks\angular.csv`         |   50 |
| `laravel`         | `stacks\laravel.csv`         |   50 |

### 参考类数据

`design.csv` 和 `draft.csv` 体量很大，但当前 CLI 配置没有读取它们。分析架构时要区分两件事。

1. 文件夹中存在的资料。
2. 当前运行路径真正读取的资料。

这个区分很关键。架构判断要以配置入口为准，不能只看目录文件数量。

## 检索链路

普通 domain 查询的链路如下。

```text
search.py 接收 query 与 domain
  |
  v
core.search(query, domain, max_results)
  |
  v
读取 CSV_CONFIG 中的 file、search_cols、output_cols
  |
  v
_load_csv() 读取 CSV
  |
  v
_search_csv() 拼接 search_cols 成文档
  |
  v
BM25.fit() 建索引
  |
  v
BM25.score() 排序
  |
  v
只返回 score 大于 0 的 top N
  |
  v
format_output() 输出 Markdown
```

这个链路里有三个好设计。

### 1. 搜索列与输出列分离

`CSV_CONFIG` 对每个 domain 声明两组列。

| 配置          | 作用                             |
| ------------- | -------------------------------- |
| `search_cols` | 参与 BM25 匹配，强调关键词相关性 |
| `output_cols` | 返回给用户，强调可读性和可执行性 |

这避免了一个常见问题。把所有字段都塞进搜索文本，会引入噪声。只输出搜索字段，又会丢掉执行所需细节。当前设计把两个目标拆开，检索稳定性和输出质量都更好。

### 2. 同一内核处理多种 domain

`_search_csv()` 不关心自己在搜风格、配色、字体还是 UX。它只读取配置、拼接文档、排序、返回指定字段。新增 domain 的主要成本变成三步。

1. 新增 CSV。
2. 在 `CSV_CONFIG` 增加文件和列映射。
3. 必要时扩展 `detect_domain()` 的关键词。

### 3. BM25 足够贴合本地 Skill

BM25 的价值在于轻量、离线、可解释。对于几千行结构化知识，它能用很低的复杂度解决“哪几条最相关”的问题。这个选择保持了 Skill 的本地可复制性，也降低了部署门槛。

## Stack 查询链路

技术栈查询由 `search_stack()` 负责。它和普通 domain 共用 `_search_csv()`，区别在于 stack 文件使用统一列结构。

```text
search.py 接收 --stack react-native
  |
  v
core.search_stack(query, stack, max_results)
  |
  v
STACK_CONFIG 找到 stacks/react-native.csv
  |
  v
使用 _STACK_COLS 的 search_cols 和 output_cols
  |
  v
走同一个 BM25 检索内核
```

统一列结构让 16 个 stack 能共享一套查询逻辑。它体现的是工程上的克制，数据结构先统一，代码层就不用为每个技术栈写特殊分支。

## 设计系统链路

设计系统生成是这套 Skill 最有价值的部分。它把局部检索升级成组合建议。

```text
query
  |
  v
先查 product，得到产品类别
  |
  v
用产品类别匹配 ui-reasoning.csv
  |
  v
得到 pattern、style_priority、color_mood、typography_mood、anti_patterns
  |
  v
跨 product、style、color、landing、typography 多域检索
  |
  v
按风格优先级选择候选
  |
  v
生成 design_system 字典
  |
  v
输出 ASCII 或 Markdown
```

### 组合层的关键对象

| 对象或函数                         | 作用                                                  |
| ---------------------------------- | ----------------------------------------------------- |
| `SEARCH_CONFIG`                    | 规定设计系统要查哪些 domain，以及每个 domain 返回几条 |
| `DesignSystemGenerator.generate()` | 主流程，负责产品识别、推理规则、跨域搜索和结果组装    |
| `_find_reasoning_rule()`           | 从 `ui-reasoning.csv` 中找产品类别对应规则            |
| `_apply_reasoning()`               | 把 CSV 规则转成可执行字段                             |
| `_multi_domain_search()`           | 组合多域检索                                          |
| `_select_best_match()`             | 根据 `style_priority` 选择更匹配的风格                |
| `format_ascii_box()`               | 适合终端阅读的输出                                    |
| `format_markdown()`                | 适合保存到文档的输出                                  |

### 设计系统字典

`generate()` 最终返回一个结构化字典，核心字段包括这些内容。

| 字段             | 含义                                                        |
| ---------------- | ----------------------------------------------------------- |
| `project_name`   | 项目名称                                                    |
| `category`       | 产品类别                                                    |
| `pattern`        | 页面结构、章节顺序、CTA 位置、转化策略                      |
| `style`          | 风格名称、关键词、性能、无障碍、明暗模式支持                |
| `colors`         | primary、secondary、accent、background、foreground 等语义色 |
| `typography`     | heading font、body font、mood、Google Fonts URL             |
| `key_effects`    | 推荐动效与视觉效果                                          |
| `anti_patterns`  | 需要避免的设计反模式                                        |
| `decision_rules` | 从 `ui-reasoning.csv` 解析出的规则 JSON                     |

这一步的关键价值在于输出已经不只是搜索结果列表，而是一份可直接进入设计与实现阶段的方案骨架。

## 持久化链路

持久化由 `persist_design_system()` 负责。它会把设计系统写入项目目录下的设计系统文件。

```text
generate_design_system(..., persist=True)
  |
  v
persist_design_system(design_system, page, output_dir, query)
  |
  v
创建 design-system/<project>/
  |
  v
写入 MASTER.md
  |
  +-- 如果传入 page
      |
      v
      写入 pages/<page>.md
```

持久化层有两个重要设计。

### 1. Master 加页面覆盖

`MASTER.md` 是全局设计规则。页面级文件用于记录具体页面的偏离规则。读取时应先查页面文件，再回退到 Master。

这种设计适合长期项目。它允许项目保持统一设计语言，同时允许 dashboard、checkout、profile 等页面有局部调整。

### 2. 页面覆盖智能生成

`format_page_override_md()` 会调用 `_generate_intelligent_overrides()`，结合页面名、页面查询词、当前设计系统结果，再查 `style`、`ux`、`landing` 等 domain，生成页面级建议。

这说明持久化层不只是把当前结果写入文件，还会根据页面上下文做一次轻量再推理。

## 输出格式设计

`ui-ux-pro-max` 有三类输出。

| 输出                | 场景                          | 特点                                               |
| ------------------- | ----------------------------- | -------------------------------------------------- |
| 普通检索 Markdown   | `--domain` 或自动 domain 查询 | 简短、结果列表化、适合模型消费                     |
| Stack 检索 Markdown | `--stack` 查询                | 面向技术栈实现规则                                 |
| 设计系统输出        | `--design-system` 查询        | 聚合 Pattern、Style、Colors、Typography 和检查清单 |

`format_output()` 会把普通查询结果截断到较短文本，避免输出过长。`format_markdown()` 更适合写入文档，`format_ascii_box()` 更适合终端快速阅读。

## 为什么这套设计优秀

### 1. 对模型友好

模型需要的是清晰入口、稳定命令、结构化返回。这个 Skill 没有要求模型在几千行散文中自己找规则，而是把检索工作交给脚本，把使用顺序写进 `SKILL.md`。

### 2. 对维护者友好

维护者可以分层修改。

| 修改目标             | 主要改哪里                                                   |
| -------------------- | ------------------------------------------------------------ |
| 调整使用规则         | `SKILL.md`                                                   |
| 新增知识             | `data\*.csv`                                                 |
| 新增 domain          | `CSV_CONFIG` 和 CSV                                          |
| 新增 stack           | `STACK_CONFIG` 和 `data\stacks\*.csv`                        |
| 调整搜索算法         | `core.py`                                                    |
| 调整设计系统组合策略 | `design_system.py` 与 `ui-reasoning.csv`                     |
| 调整输出格式         | `format_output()`、`format_markdown()`、`format_master_md()` |

### 3. 对扩展友好

它可以迁移到其他知识密集型 Skill。例如品牌规范、法务条款、产品方法论、组件库规范、可访问性审计、性能规则库。迁移时不需要照搬 UI/UX 内容，只要保留分层思想。

### 4. 对本地环境友好

所有核心能力基于本地 Python 和 CSV，不依赖外部向量库、数据库或网络服务。它的部署成本低，审计成本也低。

## 工程取舍

任何架构都有代价。这里的取舍值得学习。

| 取舍               | 好处                    | 代价                                |
| ------------------ | ----------------------- | ----------------------------------- |
| 使用 CSV           | 易编辑、易扩容、易 diff | 缺少强 schema，需要额外校验         |
| 使用 BM25          | 本地、轻量、可解释      | 对同义词和深层语义不敏感            |
| 使用配置路由       | 新增 domain 成本低      | 配置和 CSV 字段需要保持一致         |
| 使用薄推理层       | 输出足够稳定            | `decision_rules` 的潜力尚未完全释放 |
| 使用 Markdown 输出 | 模型和人都容易读        | 结构化消费能力弱于 JSON schema      |
| 使用 Master 加覆盖 | 适合跨会话设计系统      | 需要约束团队读取顺序                |

## 当前局限

1. `detect_domain()` 依赖关键词匹配，复杂自然语言可能误判 domain。
2. BM25 关键词检索对同义表达支持有限，比如同一设计意图换词后可能召回下降。
3. CSV 缺少统一 schema 校验，字段名漂移会直接影响检索或输出。
4. `decision_rules` 已经解析成 JSON，但当前执行深度还比较轻。
5. `SKILL.md` 顶部描述和数据目录仍可能继续漂移，需要自动化统计辅助维护。
6. `design.csv`、`draft.csv` 这类参考文件和运行时数据的边界需要在维护文档中持续标注。

## 优先升级路线

如果继续优化，建议按下面顺序推进。

1. 增加数据校验脚本，检查 CSV 必需列、空值、重复 key 和非法 JSON。
2. 增加统计生成脚本，把 domain 数、stack 数、数据行数写入一份可审计报告。
3. 让 `SKILL.md` 顶部能力数字从统计脚本生成，减少人工漂移。
4. 扩展 `decision_rules` 执行层，把 JSON 规则纳入明确分支。
5. 给 `detect_domain()` 增加测试样例，覆盖边界 query。
6. 为设计系统输出增加 JSON 选项，服务更严格的自动化消费场景。
7. 明确 `design.csv` 和 `draft.csv` 的生命周期，是删除、归档，还是纳入配置。

## 复刻路径

如果你要把这套架构复刻到新 Skill，可以按下面顺序做。

### Step 1 定义协议层

先写一个薄 `SKILL.md`，只回答这些问题。

| 问题     | 内容                   |
| -------- | ---------------------- |
| 何时使用 | 明确触发条件和跳过条件 |
| 如何执行 | 给出 3 到 5 步工作流   |
| 如何检索 | 给出 CLI 入口和示例    |
| 如何验收 | 给出质量检查清单       |

### Step 2 设计知识卡片

先准备 3 到 5 张 CSV。每张表对应一个 domain，字段要分成检索字段和输出字段。

示例字段设计如下。

| 类型     | 字段示例                                         |
| -------- | ------------------------------------------------ |
| 搜索字段 | Name、Keywords、Category、Description            |
| 输出字段 | Do、Do not、Example、Severity、Source、Checklist |

### Step 3 写通用检索内核

复刻 `core.py` 的关键结构。

1. `DATA_DIR` 指向数据目录。
2. `CSV_CONFIG` 声明 domain 到文件和列的映射。
3. `_search_csv()` 只处理通用检索。
4. `search()` 负责 domain 路由。
5. 需要多栈时再加入 `STACK_CONFIG`。

### Step 4 写控制入口

复刻 `search.py` 的薄入口思想。

1. 解析 `query`。
2. 支持 domain 查询。
3. 支持 stack 查询。
4. 支持 JSON 或 Markdown 输出。
5. 复杂组合逻辑交给单独模块。

### Step 5 增加组合层

当单条检索无法满足任务时，再加入类似 `design_system.py` 的组合层。

组合层应完成这些工作。

1. 先识别任务类型。
2. 读取 reasoning 表。
3. 跨 domain 检索。
4. 按优先级挑选候选。
5. 生成结构化方案。
6. 按需要输出为 Markdown 或持久化文件。

### Step 6 增加治理机制

成熟后补三类治理能力。

1. CSV schema 校验。
2. 数据统计报告。
3. 示例命令和输出快照测试。

## 验收方式

这类文档和 Skill 的验收，不应只看能不能运行。建议分三层验收。

| 层级     | 验收点                                   | 命令或方式          |
| -------- | ---------------------------------------- | ------------------- |
| 文档事实 | 路径、行数、domain、stack、数据量一致    | `rg` 检查旧口径残留 |
| CLI 行为 | 普通查询、stack 查询、设计系统查询可运行 | 执行只读示例命令    |
| 架构表达 | 分层、链路、取舍、复刻步骤清楚           | 人工审阅标题和表格  |

只读示例命令如下。

```powershell
python "~\.agents\categories\04-设计系统与前端应用\01-UIUX与前端审美\ui-ux-pro-max\scripts\search.py" "beauty spa wellness service" --design-system -p "Serenity Spa" -f markdown
```

```powershell
python "~\.agents\categories\04-设计系统与前端应用\01-UIUX与前端审美\ui-ux-pro-max\scripts\search.py" "animation accessibility" --domain ux --max-results 2
```

```powershell
python "~\.agents\categories\04-设计系统与前端应用\01-UIUX与前端审美\ui-ux-pro-max\scripts\search.py" "navigation list performance" --stack react-native --max-results 2
```

## 总结

`ui-ux-pro-max` 值得学习的核心，不在于它收集了多少 UI/UX 条目，而在于它把知识、检索、推理、输出和持久化拆成了可维护的层次。

这套设计给其他 Skill 的启发很直接。

1. 用 `SKILL.md` 写协议，不堆知识。
2. 用 CSV 写知识，不堆提示词。
3. 用配置适配异构数据，不写重复检索逻辑。
4. 用组合层生成方案，不停留在搜索结果。
5. 用持久化文件沉淀规则，不让设计结论停留在一次性输出里。

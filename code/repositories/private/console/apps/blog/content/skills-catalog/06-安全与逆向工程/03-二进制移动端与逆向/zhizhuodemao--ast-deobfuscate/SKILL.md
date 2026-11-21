---
name: ast-deobfuscate
description: 用 Babel AST 还原混淆的 JS 代码（字符串解密、控制流还原、死代码删除）。
  TRIGGER when: 用户要求解混淆、还原代码、反混淆、deobfuscate，或遇到 _0x 前缀变量、大型字符串数组、switch-case 控制流平坦化、sojson/OB 混淆等需要 AST 处理的代码。也包括"这段代码看不懂"、"代码全是乱码"、"还原一下这个 JS"。
  DO NOT TRIGGER when: 代码只是 minified（压缩但未混淆），或用户只想格式化/美化代码。
argument-hint: [混淆代码文件路径或 URL]
---

# ast-deobfuscate

对 **$ARGUMENTS** 执行 AST 解混淆，最大化还原可读代码。

**工具链**: `@babel/parser` + `@babel/traverse` + `@babel/generator` + `@babel/types`

---

## 工作目录约定

```
project/
├── source/
│   └── original/          # 原始混淆文件（只读，不修改）
│       └── target.js
├── scripts/               # 解混淆脚本（每步一个，一次性，针对目标定制）
│   ├── step1_string_decrypt.js
│   ├── step2_expr_simplify.js
│   └── ...
├── intermediate/          # 中间产物（每步输出，可回退）
│   ├── target_step0.js    # 格式化 + 去反调试
│   ├── target_step1.js    # 字符串解密后
│   ├── target_step2.js    # 表达式简化后
│   └── ...
└── source/
    └── deobfuscated/      # 最终输出
        └── target_deobf.js
```

**原则**: 每个步骤读取上一步的中间文件，输出新的中间文件。出错时可从任意中间文件重新开始。

### 环境初始化

解混淆脚本基于 Babel 工具链运行在 Node.js 中。首次执行前检查并安装依赖：

```bash
# 在项目根目录检查 package.json，没有则初始化
npm init -y
npm install @babel/parser @babel/traverse @babel/generator @babel/types
# 如需格式化
npm install prettier
```

---

## 执行策略

### 整体原则

本 skill 是**百科全书**，不是固定流水线。执行者根据实际代码灵活选择步骤：

1. **进入计划模式**: 先完成 Step 0 分析，然后进入计划模式，向用户展示分析结果和建议的步骤组合，获得确认后再执行
2. **按需跳步**: 没有字符串数组就跳过 Step 1，没有控制流平坦化就跳过 Step 4
3. **随时调整**: 任何步骤执行后发现新情况，都可以回退或插入额外步骤
4. **MCP 用于分析和验证**: js-reverse MCP 用于获取源码、搜索特征、小规模验证方案可行性；大批量转换和验证通过 Node.js 脚本执行

### MCP 使用时机

MCP 的定位是**分析工具和验证探针**，不是批量执行引擎。

| 阶段 | MCP 用法 |
|------|---------|
| **分析阶段** | `search_in_sources` 搜索混淆特征；`get_script_source` 获取目标脚本 |
| **方案验证** | `evaluate_script` 执行几个解密调用，确认方案可行后再写批量脚本 |
| **中间验证** | `evaluate_script` 抽样对比解混淆前后的函数输出 |
| **控制流分析** | `set_breakpoint` + `step_over` 动态跟踪 switch-case 执行顺序 |
| **最终验证** | 在浏览器中用解混淆后的代码替换原始代码，验证功能正常 |

大批量字符串解密、表达式简化、死代码移除等转换工作，全部通过 Node.js 脚本 + Babel AST 完成。

### Subagent 并行策略

可并行的任务组合：
- Step 0 中：特征识别 + 反调试代码搜索
- Step 2 中：Proxy 函数识别 + 对象字典识别（互不依赖）
- 验证阶段：多组测试数据可并行验证

---

## 技术手册

以下是各类解混淆技术的详细参考。**根据 Step 0 的分析结果，选择需要的章节执行。**

---

### Step 0: 预分析与特征识别

**目标**: 了解混淆类型和程度，为后续步骤提供参考（非硬性路由）。

**0.1 获取源码**

```
本地文件: 直接读取 $ARGUMENTS
URL: 下载后保存到 source/original/
浏览器中（代码尚未下载到本地）:
  - 用 MCP list_scripts → get_script_source 获取
  - 可用 search_in_sources 做关键词快速扫描:
    "_0x" → 确认混淆前缀    "debugger" → 定位反调试
    "push" + "shift" → 旋转 IIFE    "split('|')" → 控制流平坦化
```

**0.2 格式化**: 用 prettier 或 babel generator 统一缩进，保存为 `intermediate/target_step0.js`

**0.3 AST 体检报告**（可选）

文件较小时直接全文阅读是最快最全面的方式。但即使能读全文，统计脚本的价值在于**把非结构化代码转化为结构化数据** — "callee 频次 Top 5"这类信息，人肉读代码很难准确统计。写一个脚本对 AST 做全局扫描：

```
统计项:
  基础指标:
    - 文件大小、总行数、AST 总节点数
    - FunctionDeclaration / FunctionExpression 数量
    - VariableDeclaration 数量

  字符串数组特征:
    - 最大的 ArrayExpression 及其元素数量（>50 个元素大概率是字符串数组）
    - 该数组所在的行号范围

  访问器函数特征:
    - CallExpression 中 callee 名称频次 Top 5（高频调用的大概率是访问器函数）
    - 这些函数的参数模式（单参数数字？双参数？）

  控制流特征:
    - WhileStatement 内嵌 SwitchStatement 的数量（>0 说明有控制流平坦化）
    - SwitchCase 总数量

  命名模式:
    - 标识符前缀分布统计（如 _0x、_0X、a0_、_$、__x 等，取 Top 3 前缀及占比）
    - 单字符变量占比
    - 平均标识符长度

  混淆强度:
    - StringLiteral 数量 vs CallExpression 取字符串的数量（比值越低，字符串混淆越重）
    - UnaryExpression 中 ! 运算符数量（大量 ![] !![] 说明布尔值混淆）
```

**0.4 特征指纹（仅供参考）**

| 特征 | 混淆类型 | 常见处理 |
|------|---------|---------|
| 高频前缀（如 `_0x`/`a0_`）+ 大字符串数组 + 旋转 IIFE | Obfuscator.io 及变种 | Step 1→2→3→4→5→6 |
| 高频前缀但无字符串数组 | 轻度混淆 | Step 2→3→5→6 |
| `while(true){switch}` + 顺序数组 | 控制流平坦化 | Step 2→4→5→6 |
| `jsjiami.com` 标记 | sojson | 先去壳，再按实际情况选步骤 |
| Webpack/Parcel 模块包裹 | 打包工具 | 先 unpack 提取模块，再对单模块解混淆 |
| 大量 `eval` / `Function()` | 代码加密 | 沙箱执行解密层，再按实际情况选步骤 |

**0.5 移除反调试**（如存在）

搜索并删除：
- `debugger` 语句（尤其在定时器/循环中）
- `setInterval(() => { debugger }, ...)`
- `constructor("debu")` 反格式化检测
- `console` 重写/禁用代码

**0.6 进入计划模式**

向用户展示：
1. 识别到的混淆特征
2. 建议执行的步骤组合
3. 预估的复杂度

用户确认后开始执行。执行过程中发现新情况随时可调整计划。

**产出**: `intermediate/target_step0.js` + 分析报告

---

### Step 0.5: Webpack/打包工具 Unpack（可选）

**适用条件**: 代码是 Webpack/Browserify/Parcel 打包的 bundle。识别特征：

```
Webpack 特征:
  - 外层 IIFE 接收一个模块数组或对象作为参数
  - 内部有 __webpack_require__ 或类似的模块加载函数:
    function(modules) {
      function __webpack_require__(moduleId) {
        if(installedModules[moduleId]) return installedModules[moduleId].exports;
        var module = installedModules[moduleId] = { exports: {} };
        modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);
        ...
      }
    }
  - 每个模块是 function(module, exports, __webpack_require__) { ... }
```

**处理方向**

```
1. 识别模块数组/对象（IIFE 的参数）
2. 提取每个模块函数，保存为独立文件:
   intermediate/modules/module_0.js
   intermediate/modules/module_1.js
   ...
3. 对 __webpack_require__(N) 调用，添加注释标注引用了哪个模块
4. 识别入口模块（通常是 __webpack_require__(0)）
5. 对每个模块独立执行后续解混淆步骤

Webpack 固定参数重命名（确定性的，不需要猜测）:
  - 第 1 个参数 → module
  - 第 2 个参数 → exports
  - 第 3 个参数 → __webpack_require__
  - __webpack_require__.p → __webpack_public_path__
  - __webpack_require__.m → __webpack_modules__
  - __webpack_require__.c → __webpack_module_cache__
```

**产出**: `intermediate/modules/module_N.js`（每个模块独立文件）

⚠️ unpack 后，后续步骤对每个模块文件独立执行，而非对整个 bundle。

---

### Step 1: 字符串解密与大数组回填

**适用条件**: 代码中存在字符串数组 + 访问器函数模式。若无此模式则跳过。

**目标**: 将所有加密/编码的字符串还原为明文。这是后续步骤的基础。

**1.1 识别字符串数组结构**

典型模式包含三部分（函数名前缀不固定，可能是 `_0x`、`a0_`、`_$` 或任意混淆名）：
- **字符串数组函数**: 返回包含所有字符串的数组
- **旋转 IIFE**: 对数组执行 push/shift 旋转，打乱原始顺序
- **访问器函数**: 接受索引参数，返回数组中对应字符串（通常有偏移量计算）

识别方法: 通过 AST 体检报告中的"最大 ArrayExpression"和"CallExpression callee 频次 Top 5"定位

**1.2 处理方向**

```
流程: 先用 MCP 小规模验证方案，再写 Node.js 脚本批量执行

第一步: 用 MCP 验证方案
  1. 用 MCP evaluate_script 调用几个访问器函数，确认能正确返回明文
  2. 确认参数模式（单参数？双参数？偏移量？）
  3. 方案验证通过后，再写批量脚本

第二步: 批量执行（二选一）

方案 A（推荐）: Node.js vm 沙箱
  1. 从 AST 中提取字符串数组 + 旋转 IIFE + 访问器函数的源码
  2. 在 vm.createContext() 沙箱中执行
  3. 遍历 CallExpression，用沙箱函数计算返回值并替换
  4. 删除已无用的数组函数、旋转 IIFE、访问器函数

方案 B: 纯静态分析（旋转逻辑简单时）
  1. 解析数组元素，静态计算旋转次数
  2. 手动应用旋转得到最终数组
  3. 直接用索引查表替换
```

**1.3 转义字符串还原**

```
遍历所有 StringLiteral: 删除 node.extra（强制用已解析的 value）
  \x48\x65\x6c\x6c\x6f → "Hello"
  \u0048\u0065 → "He"
```

**1.4 数值还原**

```
遍历所有 NumericLiteral: 删除 node.extra
  0x12 → 18, 0b1010 → 10
```

**验证**: 用 MCP `evaluate_script` 抽样对比几个解密结果是否正确

**产出**: `intermediate/target_step1.js`

---

### Step 2: 表达式简化

**适用条件**: 几乎所有混淆代码都需要此步骤。与 Step 5 循环执行效果最佳。

**2.1 常量折叠 (Constant Folding)**

```
遍历 BinaryExpression / UnaryExpression / LogicalExpression / ConditionalExpression:
  1. 调用 path.evaluate()
  2. 若 confident === true:
     - 用 t.valueToNode(value) 生成新节点
     - 验证结果是 Literal 类型（排除 Infinity/undefined 等边界值）
     - 所有类型都要处理: string, number, boolean（不要只处理部分类型）
     - 替换原节点
  3. 若 confident === false:
     - 检查是否为连续字符串拼接（左子树右叶 + 右叶都是 StringLiteral）
     - 若是，合并相邻字面量
```

**2.2 布尔值还原**

```
遍历 UnaryExpression:
  ![]  → false    !![] → true
  !0   → true     !1   → false
  !""  → true     !"x" → false
  void 0 → undefined
```

**2.3 Proxy 函数内联**

```
识别条件: 函数体只有一条 return 语句，且 return 的是:
  - 二元运算: function(a,b){ return a + b }
  - 函数调用: function(a,b){ return a(b) }
  - 属性访问: function(a,b){ return a[b] }
  - 逻辑运算: function(a,b){ return a && b }

处理:
  1. 找到所有符合条件的 FunctionDeclaration
  2. 确认 binding.constant === true（未被重新赋值）
  3. 找到所有 CallExpression 引用
  4. 将实参代入函数体表达式，替换调用处
  5. 引用归零后删除函数声明
```

**2.4 对象属性字典内联**

```
识别条件: 对象仅作为属性字典使用
  var map = { 'a': function(x,y){return x+y}, 'b': 'hello' }
  map['a'](1, 2)  →  1 + 2
  map['b']        →  'hello'

处理:
  1. 找到对象声明，确认所有属性值为 Literal 或简单函数
  2. 确认 binding.constant === true
  3. 将所有 MemberExpression 访问替换为对应属性值
  4. 对函数类属性，同时执行 Proxy 函数内联逻辑
  5. 引用归零后删除对象声明
```

**产出**: `intermediate/target_step2.js`

---

### Step 3: 引用与属性访问标准化

**适用条件**: 代码中大量使用 `obj['prop']` 方括号访问。需在字符串解密（Step 1）之后执行。

**3.1 方括号转点号**

```
遍历 MemberExpression:
  条件: computed === true 且 property 是 StringLiteral
  且属性名是合法标识符（匹配 /^[a-zA-Z_$][a-zA-Z0-9_$]*$/）
  obj['prop']     → obj.prop
  obj['forEach']  → obj.forEach
  保留: obj['class']（保留字）, obj['data-id']（含连字符）, obj[variable]（变量）
```

**3.2 逗号表达式拆分**

```
逗号表达式不只出现在 ExpressionStatement 中，需覆盖所有位置:

1. ExpressionStatement:
   (a = 1, b = 2, c())  →  a = 1; b = 2; c();

2. ReturnStatement:
   return (a = 1, b = 2, result)  →  a = 1; b = 2; return result;

3. IfStatement test / for init / for update 中的逗号表达式也需拆分

4. 赋值右侧:
   x = (a(), b(), c)  →  a(); b(); x = c;
```

**产出**: `intermediate/target_step3.js`

---

### Step 4: 控制流平坦化还原

**适用条件**: 代码中存在 `while(true){ switch(...) { case... } }` 结构。强依赖 Step 2 的常量折叠。

**4.1 分析实际结构**

不预设固定模式，根据实际代码分析控制流结构：

```
常见特征（仅供参考，实际变种很多）:
  - WhileStatement，test 恒为 true
  - 循环体内是 SwitchStatement
  - 存在某种顺序控制机制（数组索引、状态变量等）
  - 每个 case 以 continue/break 结尾

分析方法:
  1. 阅读具体的 while-switch 代码，理解其控制流逻辑
  2. 用 MCP set_breakpoint + step_over 动态跟踪实际执行顺序
  3. 判断顺序控制机制是静态可解的还是依赖运行时值
```

**4.2 还原方向**

```
根据分析结果制定还原策略。核心思路:
  1. 确定代码块的执行顺序
  2. 按顺序提取各 case 的代码块
  3. 移除控制流包裹（while/switch/continue）
  4. 用 path.replaceWithMultiple() 替换整个结构

⚠️ 复杂情况（状态变量动态计算、嵌套多层等）:
  - 向用户展示分析结果，请求辅助判断
  - 可用 MCP 动态跟踪辅助理解执行流程
  - 宁可保留未还原的结构，也不要错误还原
```

**验证**: 用 MCP `evaluate_script` 执行还原后的函数，对比原始输出

**产出**: `intermediate/target_step4.js`

---

### Step 5: 死代码移除

**适用条件**: 几乎所有混淆代码都需要。与 Step 2 循环执行效果最佳。

**5.1 不可达分支清理**

```
遍历 IfStatement / ConditionalExpression:
  1. 用 path.get("test").evaluateTruthy() 求值条件
  2. 若结果 === true:  用 consequent 替换整个节点
  3. 若结果 === false: 用 alternate 替换（无 alternate 则删除）
  4. 注意: BlockStatement 需展开为语句数组再替换
```

**5.2 无用变量/函数剔除**

```
遍历 VariableDeclarator / FunctionDeclaration:
  1. 获取 binding = scope.getBinding(name)
  2. 若 binding.constant === true 且 binding.referenced === false:
     - 确认 init 无副作用后删除
  3. 若 init 有副作用（函数调用等）: 保留
```

**5.3 空语句清理**

```
遍历 EmptyStatement: 直接删除
遍历 BlockStatement: 若 body 为空且不是函数体，删除
```

**5.4 循环策略（Step 2 + Step 5）— 必须实现，不可跳过**

单次执行 Step 2 和 Step 5 会遗漏大量可简化代码。原因：死代码移除后暴露新的常量表达式，常量折叠后又暴露新的死代码。

```
实现方式: 在脚本中用循环包裹 Step 2 和 Step 5 的 visitor

let round = 0;
do {
  changed = false
  执行 Step 2 全部 visitor（常量折叠 + 布尔值 + Proxy + 对象字典）
  执行 Step 5 全部 visitor（不可达分支 + 无用变量 + 空语句）
  若本轮有任何节点被替换或删除 → changed = true
  round++
  保存中间文件: intermediate/target_step5_round{round}.js
} while (changed && round < 50)
```

每轮循环保存中间文件: `intermediate/target_step5_round{N}.js`

**产出**: `intermediate/target_step5.js`

---

### Step 6: 变量重命名与最终整形

**适用条件**: 代码中存在无意义的混淆变量名时执行。仅执行确定性的模式化重命名，不做语义推导。

**6.1 模式化重命名（确定性的）**

```
某些变量名可以根据代码模式确定性地重命名，不需要猜测:

Webpack 模块参数（不管原始名是什么前缀）:
  function(xx1, xx2, xx3) { xx3(69) }
  → function(module, exports, __webpack_require__) { __webpack_require__(69) }
  判断依据: 三参数函数，第三个参数被当作函数调用且参数是数字

常见回调模式:
  .then(function(xx) { ... })  → .then(function(response) { ... })
  .catch(function(xx) { ... }) → .catch(function(error) { ... })

事件处理:
  .addEventListener("click", function(xx) { ... })
  → .addEventListener("click", function(event) { ... })
```

不确定语义的变量保留原始混淆名，不做规则编号（如 var_1）或语义推导，避免引入错误。

**6.2 代码整形**

```
1. var 声明拆分: 将单行多声明拆为每行一个
2. return 简化: if(x) return a; else return b; → return x ? a : b
3. 用 babel generator 输出，配置 compact: false, concise: false
```

**6.3 最终验证**

```
用 MCP evaluate_script:
  1. 选取关键函数，用相同输入对比原始代码和解混淆代码的输出
  2. 若有差异，定位出错的步骤，从对应中间文件回退修复
```

**产出**: `source/deobfuscated/target_deobf.js` + `scripts/deobfuscate_target.js`

---

## 安全边界

1. **沙箱隔离**: 执行混淆代码必须在 `vm` 模块、`isolated-vm` 或浏览器（MCP）中，禁止直接 `eval`
2. **迭代上限**: Step 2↔5 循环设硬上限（50 次），防止无限循环
3. **副作用保护**: 删除代码前检查是否有副作用（网络请求、DOM 操作、赋值）
4. **作用域安全**: 重命名必须通过 `path.scope.rename()`，不能直接修改 `node.name`
5. **验证**: 每步完成后用 `@babel/parser` 重新解析，确认语法合法

---

## Babel 关键 API 速查

| 用途 | API |
|------|-----|
| 静态求值 | `path.evaluate()` → `{ confident, value }` |
| 布尔求值 | `path.get("test").evaluateTruthy()` → `true/false/undefined` |
| 替换节点 | `path.replaceWith(node)` / `path.replaceWithMultiple([nodes])` |
| 删除节点 | `path.remove()` |
| 获取绑定 | `path.scope.getBinding(name)` → `{ constant, referenced, references, referencePaths }` |
| 安全重命名 | `path.scope.rename(oldName, newName)` |
| 刷新作用域 | `path.scope.crawl()` — 删除/替换节点后必须调用 |
| 值转节点 | `t.valueToNode(value)` — 注意 Infinity/undefined 返回非 Literal |

---

## 注意事项

1. **Step 2↔5 循环不可省略** — 这是最容易被跳过但影响最大的环节，单次执行会遗漏大量可简化代码
2. **Webpack bundle 必须先 unpack** — 不拆模块直接解混淆，9000 行混在一起对 LLM 和调试都不友好
3. **逗号表达式不只在 ExpressionStatement 中** — return、if、for 里都有，必须全部覆盖
4. **常量折叠要覆盖所有类型** — string、number、boolean 都要处理，不要只处理部分
5. **模式化重命名优先** — Webpack 参数等确定性模式先处理，不确定的保留原始名
6. **混淆前缀不只是 `_0x`** — 也可能是 `a0_`、`_$`、`__x` 等，用 AST 统计高频前缀来判断
7. **每步写独立 visitor** — 不要在一个 traverse 中混合多种转换，容易产生节点失效
8. **scope 变更后刷新** — 删除/替换节点后，后续 traverse 需调用 `scope.crawl()`
9. **保留不确定的代码** — 宁可保留看不懂的代码，也不要错误删除有用逻辑
10. **中间文件是安全网** — 任何步骤出错都可以从上一步的中间文件重来
11. **灵活调整步骤** — 实际混淆千变万化，本手册是参考而非教条

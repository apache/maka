---
name: env-patch
description: >-
  在 Node.js 中运行浏览器加密 JS（补环境）。env_core.js 提供函数伪装/原型链/Proxy 引擎，Claude 按诊断报告在 run.js 中按需编写存根。
  TRIGGER when: 用户说"补环境"、"提取模块"、"Node里跑"、"webpack模块提取"、"环境模拟"、"把JS搞到Node跑"，或找到加密入口后需要脱离浏览器独立运行。
  DO NOT TRIGGER when: 只是在浏览器调试、做 AST 解混淆、或写普通 Node.js 代码。
argument-hint: "[项目名] [可选：场景说明]"
---

# env-patch

对 **$ARGUMENTS** 执行补环境方案。

**前置条件**：已知加密入口（模块 ID、函数名、所在脚本）。如未定位，先用 `/find-crypto-entry`。

## 核心概念

- **`env_core.js` 是引擎**：提供工具函数（`setFuncNative` / `setObjNative` / `getNativeProto` / `wrapFunc` / `monitor` / `createProxy`）和诊断报告。引擎不含任何环境存根，复制后不再修改。
- **`run.js` 是策略**：所有环境存根、补丁、加载逻辑都写在 run.js 中。每轮诊断后只改 run.js。
- **`browser-stubs.md` 是参考目录**：按诊断报告中出现的 UNDEFINED/ERRORS 按需取用存根代码。

## 铁律

1. **禁止修改原始 JS** — `source/` 下文件只读。`env/` 下的 JS 副本（main.js / sdk.js / bytecode.js）一旦生成即为定稿，不再修改。所有补丁写在 run.js / sign.js 中。
2. **必须 require env_core.js** — 禁止在 run.js 中重写 setFuncNative / setObjNative / createProxy 等工具函数。所有工具通过 `const env = require('./env_core')` 引入，然后调用 `env.setFuncNative()` / `env.createProxy()` 等。env_core.js 复制后不再修改。如果需要额外 helper，写在 run.js 顶部，但不得重复实现 env_core 已有的功能。
3. **先分析 VMP 入口参数** — VMP 入口的依赖数组决定补环境边界。`typeof chrome !== "undefined" ? chrome : undefined` 检查的是 `globalThis`，不是 `window`。必须用 `Object.defineProperty(global, name, ...)` 同步。
4. **加载顺序是致命的** — VMP 在 `require()` 的**瞬间**初始化并读取环境，之后不可更改。run.js 中的代码必须严格按以下顺序：
   1. `const env = require('./env_core')` — 获取工具（第一行）
   2. 构建存根对象（document / navigator / location 等）
   3. `env.init({ window, document, navigator, location })` — 阻断 Node 泄露 + 挂载全局
   4. 额外环境补齐 — performance、chrome 等全局同步
   5. `require('./main.js')` — 加载目标 JS
   6. 测试签名
5. **格式验证优先于请求验证** — 签名长度/前缀与浏览器不一致 = 降级，即使 HTTP 200 也是假阳性。

## 模板

| 文件 | 用途 |
|------|------|
| `${CLAUDE_SKILL_DIR}/scripts/env_core.js` | 工具集 + Proxy 引擎 + 诊断报告 |
| `${CLAUDE_SKILL_DIR}/scripts/webpack_runtime.js` | 最小 webpack runtime |

复制到项目 `env/` 后，**env_core.js 不再修改**。

## 执行流程

### Step 1: 搭建项目结构

```
<project>/
├── source/     # 原始 JS（下载，不修改）
├── env/        # 运行环境
│   ├── env_core.js      # 从模板复制，不改
│   ├── main.js          # 目标 JS 副本（或 sdk.js + bytecode.js）
│   ├── run.js           # 加载器 + 环境存根 + 测试
│   └── sign.js          # 签名接口（最后封装）
├── python/     # 验证脚本
└── docs/progress.md
```

**判断场景**（按需读取 reference）：

| 场景 | JS 文件 | 参考文档 |
|------|---------|---------|
| 单文件 SDK | 复制到 `env/main.js` | — |
| SDK + 字节码分离 | `env/sdk.js` + `env/bytecode.js` | `references/multi-file.md` |
| webpack bundle | 提取模块到 `env/main.js` | `references/webpack.md` |
| 运行时动态加载 | curl 下载到 `source/`，复制到 `env/` | `references/dynamic-loading.md` |

### Step 2: 首次运行

编写最小 run.js，只包含必要存根：

```javascript
const env = require('./env_core');
const _process = process; // init() 会隐藏 process，提前保留引用

// ① 构建最小存根（从 browser-stubs.md 取用 document/navigator/location）
const fakeDocument = { /* ... */ };
const fakeNavigator = { /* ... */ };
const fakeLocation = { /* ... */ };

// ② 组装 window
const fakeWindow = {
    document: fakeDocument,
    navigator: fakeNavigator,
    location: fakeLocation,
    // ... 按需补充
};
fakeWindow.window = fakeWindow;
fakeWindow.self = fakeWindow;
fakeWindow.top = fakeWindow;
fakeWindow.parent = fakeWindow;
fakeWindow.globalThis = fakeWindow;

// ③ 初始化（Node 泄露阻断 + 全局挂载）
env.init({
    window: env.createProxy(fakeWindow, 'window', 0),
    document: env.createProxy(fakeDocument, 'document', 0),
    navigator: env.createProxy(fakeNavigator, 'navigator', 0),
    location: env.createProxy(fakeLocation, 'location', 0),
});

// ④ 额外全局同步
// global.chrome = window.chrome;  // 如需

// ⑤ 加载目标 JS
require('./main.js');

// ⑥ 测试
console.log('签名函数:', typeof window.签名函数名);
```

运行 `node env/run.js`，读取诊断报告。

### Step 3: 诊断循环（核心）

每轮运行后读取诊断报告，按以下决策树处理：

```
诊断报告
├── [HANG] 进程卡死/无输出 → 参考 references/anti-debug.md
│   ├── setInterval debugger 死循环 → hook setInterval 过滤
│   ├── eval/Function 动态生成 debugger → hook eval + Function 剥离
│   └── 同步 while(true) → 定位源码，run.js 中 patch 全局
│
├── [ERRORS] → 必须立即修复
│   ├── TypeError: xxx is not a function → 补对应方法
│   ├── xxx is not defined → 补全局变量/构造函数
│   └── Cannot read property of undefined → 补中间对象
│
├── [UNDEFINED] → 逐项处理
│   ├── 先用 evaluate_script 从浏览器获取真实值
│   ├── 浏览器也是 undefined → 跳过（标记为已确认）
│   └── 浏览器有值 → 补到 run.js（从 browser-stubs.md 取用规范写法）
│
└── ERRORS = 0 && UNDEFINED 全部已确认 → 进入签名格式校验
    ├── 签名长度/前缀与浏览器一致 → Step 4
    └── 签名不一致 → 深度排查
        ├── monitor() 包装关键对象，追踪属性访问
        ├── 全局错误拦截：process.on('uncaughtException')
        ├── 对照 references/node-detection.md 逐项检查
        └── 所有外部 hook 均无异常 → references/limitations.md
```

**每轮操作**：
1. 读诊断报告
2. 从 `browser-stubs.md` 取用对应存根代码，用 `env_core.js` 的工具编写
3. 只修改 run.js
4. 重新运行，回到第 1 步

### Step 4: 封装验证

**sign.js**：

```javascript
const env = require('./env_core');
// ... 环境构建（与 run.js 相同）...
require('./main.js');

module.exports = function sign(url, data) {
    // 调用签名函数，返回结果
    return window.签名函数名(url, data);
};
```

**验证顺序**：
1. **格式验证** — 签名长度、前缀与浏览器一致
2. **请求验证** — HTTP 200 + 业务数据返回

## References

遇到具体场景时按需读取：

| 文件 | 何时读取 |
|------|---------|
| `references/anti-debug.md` | 进程卡死/极慢，或已知目标有 debugger 反调试 |
| `references/browser-stubs.md` | 需要补存根时，查找规范写法 |
| `references/node-detection.md` | 签名降级（长度/前缀与浏览器不一致） |
| `references/multi-file.md` | SDK + 字节码分离、多解释器场景 |
| `references/dynamic-loading.md` | 加密代码从 API 动态加载 |
| `references/webpack.md` | webpack bundle 模块提取 |
| `references/storage-tracing.md` | 怀疑 localStorage 有控制流开关 |
| `references/limitations.md` | 所有外部 hook 无效时，了解方案天花板 |

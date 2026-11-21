# Redux DevTools v3.2.10 — 逆向工程报告 (dsv4)

> 逆向日期: 2026-07-06 | 模型: DeepSeek V4 Pro | 平台: Chrome Extension MV3

## 产出物清单

| 文件 | 说明 |
|------|------|
| `dist/` | 可加载的 Chrome 扩展 (29 文件，原样复制) |
| `src/types/index.ts` | TypeScript 类型定义 (290+ 行) |
| `src/docs/ARCHITECTURE.md` | 架构文档 (含模块图、职责表、技术决策) |
| `src/docs/DATA_FLOW.md` | 数据流文档 (6 个 Mermaid 序列图) |
| `src/docs/SECURITY_AUDIT.md` | 安全审计报告 (9 维度评估) |
| `package.json` | npm 包配置 (TypeScript + @types/chrome) |
| `tsconfig.json` | TypeScript 编译配置 |

## 模块清单

| 模块 | 文件 | 大小 | 上下文 |
|------|------|------|--------|
| Service Worker | `background.bundle.js` | 23KB | Extension SW |
| Content Script (Bridge) | `content.bundle.js` | 3.8KB | Isolated World |
| Page Script (API) | `page.bundle.js` | 34KB | MAIN World |
| DevTools Page | `devtools.bundle.js` | 111B | DevTools Page |
| DevTools Panel | `devpanel.bundle.js` | 1633KB | DevTools Panel |
| Remote DevTools | `remote.bundle.js` | 1634KB | Tab/Window |
| Options Page | `options.bundle.js` | 153KB | Extension Page |

## 代码可读性评估

- **打包方式**: Webpack 5，单 bundle 输出，变量名已压缩
- **可读性**: 低。所有模块为 webpack-bundled 产物，变量名被压缩为单字母 (e, t, n, r)，但函数逻辑仍可从控制流推断
- **Source Map**: 无
- **混淆**: 无故意混淆，仅 webpack 默认压缩

## Bundler 特征

- Webpack `( () => { ... } )()` IIFE 包装
- `R = (e, t) => () => (t || e((t = { exports: {} }).exports, t), t.exports)` 模块定义模式
- `"use strict"` 前缀

## 安全评级

**总体: 中低风险**。详见 `src/docs/SECURITY_AUDIT.md`。

## 使用方法

```bash
# 类型检查
npx tsc --noEmit

# 加载到 Chrome
# 1. 打开 chrome://extensions/
# 2. 启用 "开发者模式"
# 3. 点击 "加载已解压的扩展"
# 4. 选择 dist/ 目录
```

# Chrome Font Super Enhancer — 逆向工程文档

## 概述

本仓库是对 Chrome Web Store 上 **Chrome Font Super Enhancer** (v2.25) 扩展的完整逆向工程分析产物。

扩展通过动态注入 CSS `text-shadow` 和 `-webkit-text-stroke` 样式来增强 Chrome 浏览器的字体渲染效果，改善文字在低分辨率屏幕上的显示质量。

## 仓库结构

```
chrome-font-super-enhancer-dsv4/
├── README.md                     # 本文件
├── package.json                  # TS 类型定义项目配置
├── dist/                         # 原始扩展文件（可加载到 Chrome）
│   ├── manifest.json
│   ├── service-worker.js
│   ├── content.js
│   ├── popup.html / popup.js / popup.css
│   ├── options.html / options.js / options.css
│   ├── manage.html / manage.js
│   ├── images/                   # 图标与资源
│   └── _metadata/                # Chrome Web Store 签名
└── src/
    ├── types/
    │   └── index.ts              # TypeScript 类型定义
    └── docs/
        ├── ARCHITECTURE.md       # 架构文档
        ├── DATA_FLOW.md          # 数据流文档（含 Mermaid 图）
        └── SECURITY_AUDIT.md     # 安全审计报告
```

## 核心功能

| 功能 | 说明 |
|------|------|
| 字体增强 | 通过 text-shadow + text-stroke 改善文字渲染清晰度 |
| 厚度调节 | 0-9 级，控制 -webkit-text-stroke 宽度 |
| 深色模式支持 | 浅色文字同样加粗 |
| 字间距调整 | 0-20 级（捐赠解锁功能） |
| 站点排除 | 按域名排除特定网站，含批量管理界面 |
| 捐赠系统 | 输入解锁码隐藏捐赠横幅，解锁高级功能 |

## 技术要点

- **平台**: Chrome 浏览器扩展
- **清单版本**: Manifest V3
- **权限**: `storage` + `activeTab`（最小权限集）
- **字体增强原理**: 基于文本颜色亮度动态计算 text-shadow rgba 不透明度
- **DOM 处理**: MutationObserver 增量处理 + WeakMap/WeakSet 内存管理
- **Shadow DOM**: 支持穿透 open shadow roots
- **存储**: chrome.storage.sync 跨设备同步配置
- **无网络通信**: 完全离线运行，无数据外传

## 解锁码算法

```javascript
// getuc() = "Apz4m1-s"
"Contexts binary-o Stage100 parameter 80040000 unzipped Append Async"
  .split(' ')
  .reduceRight((acc, word, idx) => acc + word[7 - idx], '')
```

## 快速使用

在 Chrome 中加载扩展：

1. 打开 `chrome://extensions/`
2. 启用"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择 `dist/` 目录

## 类型定义使用

```bash
npm install    # 安装 TypeScript
npm run typecheck  # 类型检查
```

```typescript
import type { ExtensionOptions, ParsedColor } from './src/types';
```

## 文档导航

- [架构文档](./src/docs/ARCHITECTURE.md) — 组件层级、文件结构、技术原理
- [数据流文档](./src/docs/DATA_FLOW.md) — Mermaid 流程图、跨组件通信
- [安全审计报告](./src/docs/SECURITY_AUDIT.md) — 权限分析、代码安全、隐私合规

## 声明

本仓库仅用于学习和研究目的。原始扩展版权归原作者 ("ME") 所有。未重新分发修改版本。

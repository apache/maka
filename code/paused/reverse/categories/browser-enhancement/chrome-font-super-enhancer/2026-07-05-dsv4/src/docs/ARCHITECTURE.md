# Chrome Font Super Enhancer — 架构文档

## 一、概述

Chrome Font Super Enhancer 是一款 Manifest V3 浏览器扩展，通过在页面上动态注入 CSS `text-shadow` 和 `-webkit-text-stroke` 样式来改善 Chrome 中字体的渲染效果。扩展支持按域名排除、深色模式适配、字间距调整，并通过捐赠解锁机制提供高级功能。

- **版本**: 2.25
- **清单版本**: Manifest V3
- **作者**: "ME"
- **文件总数**: 18（含图片资源和元数据）

---

## 二、文件结构

```
chrome-font-super-enhancer/
├── manifest.json          # 扩展清单 (MV3)
├── service-worker.js      # Service Worker (后台)
├── content.js             # 内容脚本 (注入所有页面)
├── popup.html             # 弹出窗口 UI
├── popup.js               # 弹出窗口逻辑
├── popup.css              # 弹出窗口样式
├── options.html           # 选项页面 UI
├── options.js             # 选项页面逻辑
├── options.css            # 选项页面样式
├── manage.html            # 排除域名管理页面
├── manage.js              # 排除域名管理逻辑
├── images/
│   ├── fixfonts16.png     # 图标 16x16
│   ├── fixfonts32.png     # 图标 32x32
│   ├── fixfonts48.png     # 图标 48x48
│   └── fixfonts128.png    # 图标 128x128
├── paypal.png             # PayPal 捐赠按钮图片
├── options.png            # Web Store 截图/素材
└── _metadata/
    └── verified_contents.json  # Chrome Web Store 签名
```

---

## 三、架构层级

```
┌──────────────────────────────────────────────────────┐
│                    Browser Chrome                     │
├──────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │   popup.html  │  │ options.html │  │ manage.html│ │
│  │   popup.js    │  │ options.js   │  │ manage.js  │ │
│  │   popup.css   │  │ options.css  │  │            │ │
│  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘ │
│         │                 │                 │        │
│         ▼                 ▼                 ▼        │
│  ┌──────────────────────────────────────────────┐    │
│  │         chrome.storage.sync / local           │    │
│  └──────────────────────┬───────────────────────┘    │
│                         │                            │
│  ┌──────────────────────┴───────────────────────┐    │
│  │            service-worker.js                  │    │
│  │  - onInstalled (NEW badge)                    │    │
│  │  - onMessage (badge clear)                    │    │
│  │  - windows.onRemoved (manage window cleanup)  │    │
│  └──────────────────────────────────────────────┘    │
│                                                     │
│  ┌──────────────────────────────────────────────┐    │
│  │            content.js (每个页面)              │    │
│  │  - 文本阴影注入 (text-shadow)                 │    │
│  │  - 笔画宽度 (-webkit-text-stroke)             │    │
│  │  - 字间距调整 (letter-spacing)                │    │
│  │  - MutationObserver 增量处理                  │    │
│  │  - Shadow DOM 穿透                            │    │
│  └──────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────┘
```

---

## 四、组件职责

### 4.1 manifest.json
- 声明 Manifest V3 扩展
- 配置 content_scripts 注入规则（`<all_urls>`, `document_end`, `all_frames`）
- 声明权限：`storage`（读写配置）、`activeTab`（获取当前标签页 URL）
- 注册 Service Worker 和弹出窗口

### 4.2 service-worker.js（后台脚本）
- **"NEW" 徽章**: 扩展更新时在图标上显示红色 "NEW" 文字
- **徽章清除**: 监听来自 popup.js 的 `popupOpened` 消息，打开弹出窗口时清除徽章
- **窗口追踪**: 监听 `windows.onRemoved` 事件，当用户手动关闭管理窗口时清理 `manageWindowId`

### 4.3 content.js（核心引擎）
- **初始化**: 从 `chrome.storage.sync` 读取配置，检查当前域名是否在排除列表中
- **字体增强**: 遍历 DOM 树中所有可见元素，根据文本颜色计算合适的 text-shadow + text-stroke
- **增量处理**: 使用 `MutationObserver` 监听 DOM 变化（childList + attributes），仅处理新增/变更节点
- **Shadow DOM**: 递归穿透 `shadowRoot`，处理 Web Component 内部文本
- **防抖批处理**: 100ms 延迟批量处理突变，减少重绘开销
- **内存管理**: 使用 `WeakMap` / `WeakSet` 跟踪已处理元素，避免 DOM 属性污染和内存泄漏

### 4.4 popup.js + popup.html（弹出窗口）
- **总开关**: 启用/禁用扩展，保存后刷新所有标签页
- **厚度滑块**: 0-9 级别，控制 `-webkit-text-stroke` 宽度
- **深色模式**: 切换后白色文字也加粗
- **字间距滑块**: 0-20 级别（捐赠解锁功能）
- **站点排除**: 一键添加/移除当前域名到排除列表
- **排除管理**: 打开 `manage.html` 管理窗口（单例模式）
- **捐赠解锁**: 输入解锁码激活高级功能，隐藏 PayPal 横幅

### 4.5 options.js + options.html（选项页面）
- 功能与 popup 基本一致，额外提供独立的设置入口
- 不包含当前站点排除功能（无语境）
- 解锁码输入和保存

### 4.6 manage.js + manage.html（排除域名管理）
- 表格展示所有排除域名（按字母排序）
- 添加新域名（含格式验证正则）
- 删除域名（确认对话框）
- 接收 URL 参数 `tabId` 和 `host`，变更后自动刷新来源标签页

---

## 五、核心技术原理

### 5.1 text-shadow 字体增强

扩展不走系统级字体渲染，而是利用 CSS `text-shadow` 创建与文本颜色相同的模糊阴影：

```
text-shadow: 0 0 0px rgba(R, G, B, opacity)
```

- 阴影颜色与文字颜色相同
- 模糊半径 0（硬边阴影），偏移量 0
- 不透明度根据亮度动态计算：`opacity = (255 * (255 - L) / 65025)`
- 暗色文字 (L < 128) 不透明度设为 1（完全覆盖）
- 深色模式支持开启时所有文字不透明度均为 1

### 5.2 亮度计算 (Luminosity)

```
L = 0.2126 * R + 0.7152 * G + 0.0722 * B
```

使用 ITU-R BT.709 亮度系数（感知加权）。

### 5.3 text-stroke 加粗

```
-webkit-text-stroke: (Thickness/10)px
```

厚度值 0-9，实际 stroke 宽度为 0~0.9px，以 0.1px 为步长。

### 5.4 解锁码算法

```
getuc() = "Contexts binary-o Stage100 parameter 80040000 unzipped Append Async"
  .split(' ')
  .reduceRight((acc, word, idx) => acc + word[7 - idx], '')
```

计算结果: `"Apz4m1-s"`

---

## 六、数据存储

| 存储类型 | Key | 类型 | 说明 |
|---------|-----|------|------|
| sync | `Thickness` | string | 厚度 0-9 |
| sync | `Enab` | boolean | 总开关 |
| sync | `Darkmodesupport` | boolean | 深色模式 |
| sync | `LetterSpacing` | string | 字间距 0-20 |
| sync | `excludedDomains` | string[] | 排除域名列表 |
| sync | `unlockCode` | string | 捐赠解锁码 |
| local | `manageWindowId` | number | 管理窗口 ID（单例） |

所有用户配置存储在 `chrome.storage.sync`，运行时状态存储在 `chrome.storage.local`。

---

## 七、安全边界

- 扩展仅需 `storage` + `activeTab` 权限，无需 host 权限
- content script 注入 `all_urls`，但通过 `activeTab` 限制交互
- 解锁码比较采用混淆字符串算法，非密码学安全但增加了逆向难度
- 排除域名通过格式化正则验证，阻止无效输入

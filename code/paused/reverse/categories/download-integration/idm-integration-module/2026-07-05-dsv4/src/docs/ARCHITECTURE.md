# IDM Integration Module — 架构分析文档

> 版本: v6.43.1 | Manifest V3 | Tonec FZE
> 逆向工程日期: 2026-07-05

---

## 一、项目概述

IDM Integration Module 是 Internet Download Manager (IDM) 桌面应用的 Chrome 浏览器扩展程序。其核心功能是拦截浏览器中的下载请求和媒体资源，通过 **Native Messaging** 或 **WebSocket** 桥接协议将下载任务转发给 IDM 桌面应用处理。

该扩展在 Chrome Web Store 拥有数千万用户，因具备 `proxy`、`nativeMessaging`、`downloads`、`cookies` 等高危权限，是一个安全审计价值极高的逆向工程目标。

---

## 二、文件结构与职责

```
dist/
├── manifest.json          # MV3 清单文件 (v6.43.1)
├── background.js          # Service Worker — 核心逻辑 (56KB, 混淆)
│                          #   协议解析、IPC、下载拦截、代理检测
├── content.js             # 内容脚本 — 页面内媒体嗅探 (29KB, 混淆)
│                          #   DOM 监控、媒体元素发现、链接提取
├── document.js            # Web可访问脚本 — XHR/fetch API Hook (5KB)
│                          #   拦截页面 JS 的网络请求调用
├── debug.js               # 调试辅助 — 抑制 console 输出 (0.7KB)
├── captured.js            # 捕获页面逻辑 (1KB)
├── captured.html          # IDM 下载中转页面
├── welcome.html           # 安装/更新欢迎页面
├── welcome.js             # 欢迎页面逻辑 (3.2KB)
├── images/                # 图标资源 (logo 16/32/48/128, etc.)
├── _locales/              # 16 种语言本地化 (ar/de/en/es/fa/fr/he/it/nl/pl/pt/ru/th/tr/vn/zh_cn/zh_tw)
└── _metadata/             # Chrome Web Store 签名验证元数据
```

---

## 三、核心架构

### 3.1 进程模型

```
┌─────────────────────────────────────────────────────────┐
│                    Chrome Browser                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │          Service Worker (background.js)           │   │
│  │  ┌──────────────┐  ┌──────────────────────────┐ │   │
│  │  │ Protocol Parser│  │ Download Interceptor      │ │   │
│  │  │ (binary/text)  │  │ (webRequest + downloads) │ │   │
│  │  └──────┬───────┘  └──────────┬───────────────┘ │   │
│  │         │                     │                   │   │
│  │  ┌──────┴─────────────────────┴──────────────┐  │   │
│  │  │         Port Registry & State Machine       │  │   │
│  │  └──────┬──────────────────────┬──────────────┘  │   │
│  └─────────┼──────────────────────┼─────────────────┘   │
│            │ chrome.runtime       │ webRequest           │
│            │ .connect()           │ API                  │
│  ┌─────────┴──────────┐           │                     │
│  │  Content Scripts    │           │                     │
│  │  (content.js)       │           │                     │
│  │  ┌───────────────┐ │           │                     │
│  │  │ DOM Observer   │ │           │                     │
│  │  │ Media Detector │ │           │                     │
│  │  │ Link Extractor │ │           │                     │
│  │  └───────────────┘ │           │                     │
│  └────────────────────┘           │                     │
│                                    │                     │
│  ┌────────────────────────────────┴─────────────────┐   │
│  │  Web-Accessible Script (document.js)              │   │
│  │  ┌──────────────────────────────────────────┐    │   │
│  │  │ XHR/fetch Response Interception          │    │   │
│  │  │ (ROT13 API names, ReadableStream hooks) │       │   │
│  │  └──────────────────────────────────────────┘    │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                         │
          ┌──────────────┴──────────────┐
          │   Native Messaging Bridge    │
          │   ┌──────────────────────┐  │
          │   │ Primary:              │  │
          │   │ com.tonec.idm        │  │
          │   │ (Native Messaging)    │  │
          │   ├──────────────────────┤  │
          │   │ Fallback:             │  │
          │   │ ws://127.0.0.1:1001   │  │
          │   │ (WebSocket, plugin.v3)│  │
          │   └──────────────────────┘  │
          └──────────────┬──────────────┘
                         │
          ┌──────────────┴──────────────┐
          │    IDM Desktop Application  │
          │    (Internet Download Mgr)  │
          └─────────────────────────────┘
```

### 3.2 关键组件

| 组件 | 文件 | 职责 |
|------|------|------|
| **协议解析器** | background.js (`qb` 类) | 解析 IDM 二进制应用层协议 (MSG# 标记前缀) |
| **端口注册表** | background.js (`Q` 类) | 维护所有 content-script 端口、窗口/标签页状态 |
| **下载拦截器** | background.js (`cb`/`Rb`/`Ub`/`Hc`) | 通过 webRequest API 拦截 HTTP 请求 |
| **媒体嗅探器** | content.js (`R` 类) | DOM 监控、视频/音频元素发现、YouTube/Vimeo 适配 |
| **API Hook** | document.js | 拦截 `XMLHttpRequest` 和 `fetch` 返回值 |
| **代理检测** | background.js (`bb`/`Rb`/`Sb`) | 读取浏览器代理设置并同步至 IDM 桌面应用 |
| **站点适配器** | background.js (`aa` 数组) | 28+ 站点特定规则 (YouTube, Vimeo, Facebook, Instagram 等) |

---

## 四、ROT13 混淆说明

该扩展使用 **ROT13 字符替换** 对关键字符串进行混淆处理，以规避 Chrome Web Store 的自动审查机制。

### 4.1 混淆函数

**background.js** (`ua` 函数):
```javascript
function ua(a) {
    return a.replace(/[a-z]/gi, function(b) {
        return oa((b = na(b)) + ((b & 31) > 13 ? -13 : 13));
    });
}
```

**content.js** (`B` 函数):
```javascript
function B(a) {
    return a.replace(/[a-z]/gi, function(b) {
        return aa((b = Z(b)) + ((b & 31) > 13 ? -13 : 13));
    });
}
```

### 4.2 典型解码示例

| 密文 (ROT13) | 明文 | 位置 |
|---|---|---|
| `KZYUggcErdhrfg` | `XMLHttpRequest` | background.js:Ya |
| `bcra` / `fraq` | `open` / `send` | background.js:Ya |
| `srgpu` | `fetch` | background.js:Ya |
| `hcybnq` / `ybnqraq` | `upload` / `loadend` | background.js:Ya |
| `nccyvpngvba/iaq.g1p` | `application/vnd.t1c` | background.js:Ya |
| `lbhghor` | `youtube` | background.js:$a handler |

混淆覆盖范围：
- **background.js**: 12+ 处 ROT13 调用，主要混淆 XMLHttpRequest/fetch API 方法名
- **content.js**: 30+ 处 ROT13 调用，混淆 CSS 选择器、正则表达式和 JavaScript API 名
- **document.js**: 所有 API 钩子目标字符串均经过 ROT13 编码

---

## 五、Native Messaging 桥接

### 5.1 连接策略

```
优先级 1: chrome.runtime.connectNative("com.tonec.idm")
         └── 标准 Native Messaging 协议

优先级 2 (降级): WebSocket ws://127.0.0.1:1001
         └── 二进制帧协议 (MSG# 标记)
```

连接在 Service Worker 启动时建立，断开后自动重连（最多尝试 120 次，指数退避）。

### 5.2 应用层协议

`background.js` 中定义了 IDM 专用的应用层协议。消息使用基于文本的帧格式：

```
MSG#<seq>#<type>#<flags>#<subtype>:<param1>:<param2>...,<key1>=<value1>,...
```

- `MSG#`: 固定前缀
- `seq`: 消息序列号 (自增)
- `type`: 消息类型 (0=keep-alive, 2=handshake, 13=download, 14=link-sniff, etc.)
- `flags`: 控制标志位
- `subtype`: 子类型码
- 参数和字段使用 `:` / `,` / `=` 分隔

协议支持 100+ 种消息类型，涵盖下载管理、窗口同步、媒体捕获、代理配置等全部功能。

---

## 六、关键权限分析

| 权限 | 用途 | 风险等级 |
|------|------|----------|
| `nativeMessaging` | 与 IDM 桌面应用通信 | **高** — 可执行本地应用 |
| `proxy` | 读取/监听代理设置 | **高** — 可监控所有流量 |
| `cookies` | 读取 cookie 获取 session | **高** — 可窃取登录凭据 |
| `downloads` + `downloads.shelf` + `downloads.ui` | 接管浏览器下载 | **中** — 可拦截下载 |
| `webRequest` | 拦截所有网络请求 | **高** — 可读取请求体 |
| `scripting` + `<all_urls>` | 注入脚本至所有页面 | **高** — 全站代码注入 |
| `declarativeNetRequest` | 动态 URL 重定向 | **中** |
| `storage` | 本地配置存储 | **低** |
| `tabs` / `webNavigation` | 页面导航监控 | **中** |
| `contextMenus` | 右键菜单集成 | **低** |
| `management` | 管理扩展状态 | **中** |

---

## 七、数据流向总结

1. **页面加载** -> content.js 注入 (document_start) -> 建立 Port 连接 -> 注册到 Service Worker
2. **用户点击链接** -> webRequest 拦截 -> 分类器判断 -> 发送至 IDM 桌面应用
3. **视频/音频播放** -> content.js DOM MutationObserver -> 发现媒体元素 -> 上报 Service Worker
4. **页面 JS fetch/XHR** -> document.js API Hook -> 拦截响应 -> 通过 postMessage 转发
5. **IDM 桌面响应** -> Native Messaging 返回 -> Service Worker 处理 -> 更新 UI/状态

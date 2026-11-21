# Get CRX — 架构文档

## 概述

**Get CRX** 是一个极简的 Chrome 扩展（MV3），用于从 Chrome Web Store 下载任意扩展的 `.crx` 文件。

- 总文件数：4 个（不含 `_metadata`）
- 唯一 JS 文件：`bg.js`（Service Worker，约 60 行）
- 版本：1.51
- 原始作者：匿名（未在 `manifest.json` 中声明 `author` 字段）

## 技术栈

| 层面 | 技术 |
|------|------|
| 平台 | Chrome Extension Manifest V3 |
| 后台脚本 | Service Worker（无 DOM 访问） |
| 权限 | `contextMenus`, `downloads` |
| 主机权限 | `chrome.google.com`, `chromewebstore.google.com` |
| 外部 API | `clients2.google.com/service/update2/crx`（Google CRX 更新 API） |

## 文件结构

```
get-crx-source-code/
├── manifest.json          # 扩展清单（MV3）
├── bg.js                  # Service Worker（唯一业务逻辑）
├── icon_48.png            # 48px 图标
├── icon_128.png           # 128px 图标
└── _metadata/             # Chrome 自动生成的验证元数据
    └── verified_contents.json
```

## 组件架构

### 1. Service Worker (`bg.js`)

扩展的唯一业务逻辑文件，承担三个职责：

#### a) 上下文菜单注册
- 扩展安装时，在 `runtime.onInstalled` 触发前同步注册
- 菜单 ID: `getCRX`
- 菜单标题: "Get CRX of this extension"
- 触发上下文: `all`（页面、链接、选中文本等均可触发）
- URL 白名单: 仅限两种 Chrome Web Store 域名

#### b) 上下文菜单点击处理 (`getCRX()`)
1. 查询当前活动标签页
2. 判断 Web Store 版本（经典版 vs 新版）
3. 从标签页标题中提取扩展名称
4. 从 URL 中提取扩展 ID
5. 调用 `chrome.runtime.getPlatformInfo()` 获取 NaCl 架构
6. 构造 Google CRX 更新 API 下载 URL
7. 通过 `chrome.downloads.download()` 触发浏览器下载（`saveAs: true`）

#### c) 下载文件名重命名 (`onDeterminingFilename`)
- 监听下载事件，匹配 `clients2.google.com` 的 CRX 请求
- 将系统生成的随机文件名替换为 `{扩展名} {版本号}.crx` 格式
- 版本号格式：从 Google 返回的文件名中提取（例如 `extension_1_5_1_0.crx` → `1.5.1.0.crx`）

### 2. 全局状态

```javascript
var ExtName;  // 存储当前下载对应的扩展名
```

**设计缺陷**：全局可变变量，非线程安全。如果用户在短时间内触发两次下载，第二次下载会覆盖 `ExtName`，导致第一个下载文件命名错误。

### 3. 外部依赖

唯一的外部 API 调用：

```
https://clients2.google.com/service/update2/crx
  ?response=redirect
  &nacl_arch={平台架构}
  &prodversion={Chrome版本}
  &acceptformat=crx2,crx3
  &x=id%3D{扩展ID}%26installsource%3Dondemand%26uc
```

该 API 返回一个 302 重定向到实际 `.crx` 文件的下载地址。

## 数据流

参见 [`DATA_FLOW.md`](./DATA_FLOW.md)。

## 权限分析

| 权限 | 用途 | 风险 |
|------|------|------|
| `contextMenus` | 在 Web Store 页面右键菜单中添加选项 | 低 — 仅限于白名单 URL |
| `downloads` | 触发 CRX 文件下载并自定义文件名 | 中 — 可触发任意 URL 下载 |

`host_permissions` 限定在两个 Web Store 域名下，但 `downloads` API 调用的实际下载 URL 是 `clients2.google.com`，该域名并不在 `host_permissions` 中——这是设计上需要的（否则无法下载），Google 对此 API 的使用没有额外限制。

## 安全审计

详见 [`SECURITY_AUDIT.md`](./SECURITY_AUDIT.md)。

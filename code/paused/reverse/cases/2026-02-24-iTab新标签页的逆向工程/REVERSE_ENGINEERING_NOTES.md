# iTab 新标签页逆向工程笔记

> 版本: 1.6.36 | 分析日期: 2026-02-24

## 目录

- [项目概述](#项目概述)
- [技术栈分析](#技术栈分析)
- [API 端点清单](#api-端点清单)
- [存储系统分析](#存储系统分析)
- [核心模块分析](#核心模块分析)
- [数据流分析](#数据流分析)
- [安全审计](#安全审计)

---

## 项目概述

### 基本信息

| 属性 | 值 |
|------|-----|
| **名称** | iTab 新标签页 |
| **版本** | 1.6.36 |
| **Manifest 版本** | 3 (MV3) |
| **开发者** | codelife.cc |
| **官网** | itab.link |

### 技术架构

```
┌─────────────────────────────────────────────────────────────┐
│                      Chrome Extension (MV3)                  │
├─────────────────────────────────────────────────────────────┤
│  Layer 1: UI Components                                      │
│  ├── Vue 3 Components (Element Plus UI)                      │
│  └── Custom Web Components (itab-wallpaper, itab-date)       │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: State Management                                   │
│  ├── Vue 3 Reactivity System                                │
│  └── Event Bus (eventBus-DoYR1VKS.js)                       │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: Storage Layer                                      │
│  ├── LocalForage (IndexedDB/LocalStorage driver)            │
│  ├── IndexedDB Wrapper (with TTL)                           │
│  └── Chrome Storage (sync)                                  │
├─────────────────────────────────────────────────────────────┤
│  Layer 4: API Layer                                          │
│  ├── Axios HTTP Client                                      │
│  ├── Request Interceptors (auth, signature)                 │
│  └── API Endpoints (api.codelife.cc)                        │
└─────────────────────────────────────────────────────────────┘
```

---

## 技术栈分析

### 前端框架

| 技术 | 版本 | 用途 |
|------|------|------|
| **Vue 3** | 3.x | 核心框架 |
| **Vite** | 最新 | 构建工具 |
| **Tailwind CSS** | 3.x | 样式框架 |
| **Element Plus** | 最新 | UI 组件库 |
| **Day.js** | 最新 | 日期处理 |
| **LocalForage** | 1.10.0 | 本地存储 |

### 构建配置

```javascript
// Vite 打包特征
- 411 个 chunk 文件
- 代码分割 (code splitting)
- 动态导入 (dynamic imports)
- 摇树优化 (tree-shaking)
- 变量名保留 (未混淆)
```

---

## API 端点清单

### 基础配置

```javascript
// baseRequest-cLAYUkE1.js
const baseURL = "https://api.codelife.cc"
const timeout = 15000

// 请求头
headers: {
  signaturekey: string,    // 设备指纹签名
  version: string,         // 扩展版本号
  mode: "itab",            // 固定值
  token?: string,          // 用户 token (可选)
  lang: "cn"               // 语言 (GET 请求)
}
```

### 壁纸 API (wallpaper-tfepPeaw.js)

| 端点 | 方法 | 功能 | 参数 |
|------|------|------|------|
| `/wallpaper/category` | GET | 获取壁纸分类 | category?, page? |
| `/wallpaper/list` | GET | 获取壁纸列表 | category, page, pageSize |
| `/wallpaper/use` | GET | 记录壁纸使用 | id |
| `/wallpaper/random` | GET | 随机壁纸 | - |
| `/wallpaper/unsplash` | GET | Unsplash 壁纸 | page? |
| `/wallpaper/unsplash/category` | GET | Unsplash 分类 | - |
| `/wallpaper/video/list` | GET | 视频壁纸列表 | page? |
| `/wallpaper/like` | GET | 点赞壁纸 | id |
| `/wallhaven/category` | GET | Wallhaven 分类 | - |

### 用户 API (user-DkQrGwhA.js)

| 端点 | 方法 | 功能 | 参数 |
|------|------|------|------|
| `/user/login` | GET | 用户登录 | phone?, password?, email?, openid? |
| `/user/info` | GET | 获取用户信息 | - |
| `/user/send-phone-code` | POST | 发送验证码 | phone |
| `/user/phone-login` | POST | 手机验证码登录 | phone, code |
| `/user/bind-phone` | POST | 绑定手机 | phone, code |
| `/user/verify-password` | POST | 验证密码 | password |
| `/user/verify-email` | POST | 验证邮箱 | email, code |
| `/user/update` | POST | 更新用户 | data |
| `/user/updateinfo` | POST | 更新用户信息 | data |
| `/user/updatePass` | POST | 修改密码 | oldPass, newPass |
| `/user/deleteOne` | DELETE | 删除账号 | - |
| `/user/registry` | POST | 注册 | data |
| `/user/sendVerifyCode` | POST | 发送验证码 | email |
| `/itab/config` | GET | 获取配置 | - |
| `/itab/update` | POST | 更新配置 | config |

### 天气 API

使用和风天气 (QWeather) API，通过代理获取：

```javascript
// weather-DOYsFf4A.js
const weatherApi = {
  // 获取天气信息
  getWeather: async (location, useCache = true) => {
    // location: 城市 ID 或 经纬度
    // 返回: 实时天气、预报、空气质量等
  }
}

// 存储
// - "weather": 10 分钟缓存
// - "weather-default-city": 30 分钟缓存
```

### 其他 API

| 端点 | 方法 | 功能 |
|------|------|------|
| `/analytics/dailyInstall` | GET | 安装统计 |
| `/yiyan` | GET | 获取一言 |
| `/wechat/robot` | POST | 错误上报 |

---

## 存储系统分析

### LocalForage 配置

```javascript
// localforage-BUwrrJyZ.js
const config = {
  name: "localforage",
  storeName: "keyvaluepairs",
  driver: [
    "asyncStorage",      // IndexedDB (优先)
    "webSQLStorage",     // WebSQL
    "localStorageWrapper" // localStorage (降级)
  ]
}
```

### IndexedDB 封装 (indexdb-DBTHFlgI.js)

带 TTL 的键值存储：

```javascript
const indexdb = {
  set(key, value, ttl) {
    // ttl: 过期时间（毫秒）
    const data = {
      exp: Date.now() + ttl,
      data: value
    }
    return localforage.setItem(key, data)
  },

  async get(key, checkExp = true) {
    const item = await localforage.getItem(key)
    if (item && item.exp && checkExp) {
      if (Date.now() > item.exp) {
        localforage.removeItem(key)
        return null
      }
      return item.data
    }
    return item?.data
  }
}
```

### 存储键清单

| 键名 | 类型 | TTL | 说明 |
|------|------|-----|------|
| `token` | string | 永久 | 用户登录 token |
| `weather` | object | 10分钟 | 天气数据 |
| `weather-default-city` | object | 30分钟 | 默认城市天气 |
| `yiyan` | object | 10分钟 | 一言数据 |
| `layoutViewNotice` | number | 永久 | 布局视图提示已显示 |
| `lunarDate` | string | 会话 | 农历日期 |
| `navConfig` | object | 永久 | 导航配置 |
| `baseConfig` | object | 永久 | 基础配置 |

### Chrome Storage

```javascript
// 同步配置
chrome.storage.sync.set({
  navConfig: {...},
  baseConfig: {...}
})
```

---

## 核心模块分析

### 1. 壁纸系统

**壁纸类型**:
```javascript
enum WallpaperType {
  BuiltIn = 0,      // 内置壁纸
  Image = 1,        // 图片壁纸
  Video = 2,        // 视频壁纸
  Color = 3,        // 纯色背景
  Unsplash = 4      // Unsplash 壁纸
}

interface Wallpaper {
  type: WallpaperType
  src: string        // 图片/视频 URL
  thumb?: string     // 缩略图
  mask?: number      // 遮罩透明度 (0-1)
  blur?: number      // 模糊程度
}
```

**自定义元素**:
```javascript
// main-DarYadZA.js
customElements.define("itab-wallpaper", class extends HTMLElement {
  set wallpaper(wallpaper) {
    // 动态更新壁纸
    Ae(this.bgEl, wallpaper)
  }
})
```

### 2. 时间组件

**自定义元素**:
```javascript
customElements.define("itab-date", class extends HTMLElement {
  // 显示：时间、日期、星期、农历
  // 点击切换布局视图 (widget/simple)
})
```

### 3. 图标网格

**拖拽系统**:
```javascript
// 使用 Draggable 库
// 支持拖拽排序、创建文件夹、跨导航组拖拽

interface IconItem {
  id: string
  name: string
  url?: string
  type: "icon" | "folder" | "text" | "component"
  src?: string          // 图标 URL
  iconText?: string     // 文字图标内容
  backgroundColor?: string
  size?: "1x1" | "1x2" | "2x1" | "2x2" | "2x4"
  children?: IconItem[] // 文件夹子项
  component?: string    // 组件名称 (app-xxx)
  config?: any          // 组件配置
}
```

### 4. 搜索引擎

**搜索引擎配置**:
```javascript
interface SearchEngine {
  key: string        // 搜索引擎标识 (baidu, google, etc.)
  title: string      // 显示名称
  href: string       // 搜索 URL
  icon?: string      // 图标 URL
}
```

### 5. 导航组

**布局结构**:
```javascript
interface NavGroup {
  id: string
  name: string
  children: IconItem[]
}
```

---

## 数据流分析

### 壁纸加载流程

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│ 用户切换壁纸 │ ──> │ 显示加载状态 │ ──> │ 加载壁纸图片 │
└─────────────┘     └─────────────┘     └──────────────┘
                                                │
                                                v
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│ 更新显示    │ <── │ 提取主色调  │ <── │ 图片加载完成 │
└─────────────┘     └─────────────┘     └──────────────┘
                            │
                            v
                    ┌──────────────┐
                    │ 更新 CSS 变量 │
                    │ --img-bg     │
                    │ --img-text   │
                    └──────────────┘
```

### 用户登录流程

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│ 用户输入    │ ──> │ API 请求    │ ──> │ 服务器验证   │
│ 手机/验证码 │     │ /user/login │     │ 返回 token   │
└─────────────┘     └─────────────┘     └──────────────┘
                                                │
                                                v
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│ 获取用户配置 │ <── │ 保存 token  │ <── │ 存储到 local │
│ 同步到云端  │     │ 更新状态    │     │ 触发回调     │
└─────────────┘     └─────────────┘     └──────────────┘
```

### 配置同步流程

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│ 配置变更    │ ──> │ 保存到本地  │ ──> │ 已登录?      │
│ SAVE_CONFIG │     │ localforage │     │              │
└─────────────┘     └─────────────┘     └──────────────┘
                                                │
                    ┌───────────────────────────┼─────────────────────┐
                    │                           │                     │
                    v                           v                     v
            ┌──────────────┐           ┌──────────────┐       ┌──────────────┐
            │ 是: 上传配置 │           │ 否: 仅本地   │       │ 更新状态     │
            │ /itab/update│           │ 存储         │       │ 触发事件     │
            └──────────────┘           └──────────────┘       └──────────────┘
```

---

## 安全审计

### 数据外传分析

| 域名 | 用途 | 必要性 | 风险等级 |
|------|------|--------|----------|
| `api.codelife.cc` | API 服务 | 是 | 低 |
| `files.codelife.cc` | 静态资源 (图标、壁纸) | 是 | 低 |
| `images.unsplash.com` | Unsplash 壁纸 | 是 | 低 |
| `wallhaven.cc` | Wallhaven 壁纸代理 | 是 | 低 |

### 权限分析

```json
{
  "permissions": [
    "bookmarks",   // 读取书签 - 必要
    "activeTab"    // 当前标签页 - 必要
  ],
  "optional_permissions": [
    "favicon",       // 获取网站图标 - 必要
    "notifications", // 通知 - 可选
    "offscreen",     // 后台文档 - 可选
    "desktopCapture" // 屏幕录制 - 可选 (视频壁纸)
  ]
}
```

### 代码安全

1. **无恶意代码** - 未发现明显的恶意行为
2. **数据加密** - 使用 AES 加密 (aes-C7jXGMOE.js)
3. **设备指纹** - 使用 fingerprintjs 生成设备签名
4. **错误上报** - 将错误信息上报到服务器

### 隐私建议

1. 配置同步功能会将用户配置上传到服务器
2. 壁纸使用记录会上传（用于推荐）
3. 错误日志可能包含敏感信息

---

## 逆向工程方法

### 代码分析技巧

1. **通过 chunk 命名推断功能**
   - `wallpaper-*.js` → 壁纸相关
   - `user-*.js` → 用户相关
   - `indexdb-*.js` → IndexedDB 封装

2. **搜索关键模式**
   ```bash
   # 搜索 API 端点
   grep -oE '"/[^"]*"' chunks/*.js

   # 搜索存储键
   grep -oE '\.get\("[^"]*"\)' chunks/*.js

   # 搜索自定义元素
   grep -oE 'customElements\.define\("[^"]*"' chunks/*.js
   ```

3. **追踪依赖关系**
   - 查看文件顶部的 import 语句
   - 分析 `__vite__mapDeps` 依赖映射

### 逆向难点

1. **动态导入** - 大量异步 chunk 加载
2. **变量混淆** - 部分变量名被压缩
3. **第三方库** - 需要排除 Vue、Element Plus 等库代码
4. **类型推断** - 需要从 API 响应推断类型定义

---

## 后续工作

- [ ] 完整的 TypeScript 类型定义
- [ ] 核心模块源代码还原
- [ ] 可运行的独立项目
- [ ] 详细的数据流图
- [ ] API Mock 服务

---

## 参考资料

- [Chrome Extension MV3 文档](https://developer.chrome.com/docs/extensions/mv3/)
- [Vue 3 文档](https://vuejs.org/)
- [LocalForage 文档](https://localforage.github.io/localForage/)
- [和风天气 API](https://dev.qweather.com/)

# WebInk v0.4.2 - 架构文档

## 概述

WebInk 基于 Plasmo 框架构建，使用 Parcel 打包，采用 Content Script + Background Service Worker 架构。

## 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐      ┌──────────────┐                   │
│  │   Web Page   │◄─────┤ Content Script│                   │
│  │              │      │  (inject)     │                   │
│  └──────────────┘      └──────┬───────┘                   │
│                                │                            │
│                                │ chrome.runtime            │
│                                │ sendMessage               │
│                                ↓                            │
│  ┌──────────────────────────────────────────┐              │
│  │     Background Service Worker            │              │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  │              │
│  │  │ Storage │  │ Message │  │ History │  │              │
│  │  │ Helper  │  │ Handler │  │ Manager │  │              │
│  │  └─────────┘  └─────────┘  └─────────┘  │              │
│  └──────────────────────────────────────────┘              │
│                          ↑                                  │
│                          │ chrome.storage                  │
│  ┌──────────────────────────────────────────┐              │
│  │         chrome.storage.local             │              │
│  │  ┌────────┐  ┌────────┐  ┌────────┐     │              │
│  │  │ Config │  │ History│  │  Cache │     │              │
│  │  └────────┘  └────────┘  └────────┘     │              │
│  └──────────────────────────────────────────┘              │
│                                                             │
│  ┌──────────────┐      ┌──────────────┐                   │
│  │  Side Panel  │      │  Options     │                   │
│  │  (UI)        │◄─────┤  Page        │                   │
│  └──────────────┘      └──────────────┘                   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## 核心模块

### 1. Content Script

**职责**:
- 页面内容提取
- HTML → Markdown 转换
- 目录生成
- 复制到剪贴板

**核心库**:
- `@mozilla/readability` - 内容提取
- `turndown` - Markdown 转换

### 2. Background Service Worker

**职责**:
- 消息处理
- 数据存储
- 历史记录管理
- 文件下载

**API**:
- `chrome.storage.local` - 本地存储
- `chrome.runtime` - 消息通信
- `chrome.downloads` - 文件下载

### 3. UI 组件

**Side Panel**:
- Markdown 预览
- 目录导航
- Monaco Editor (代码编辑)

**Options Page**:
- 配置设置
- 历史记录管理

## 数据流

```
用户操作 → UI 组件 → Background → Content Script
              ↓             ↓              ↓
           Message      Storage        Readability
                          ↓              ↓
                       chrome        Turndown
                       storage          ↓
                          ↓          Markdown
                         Cache ←──────┘
```

## 新增功能 (v0.4.2)

### Monaco Editor
- 200+ 语言高亮支持
- 代码编辑和预览
- 主题切换

### Mermaid 图表
- 流程图
- 类图
- ER 图
- 甘特图
- 等 10+ 种图表类型

### 多语言翻译
- 内容翻译功能
- 语言检测

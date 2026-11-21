# ChatGPT Degrade Checker v2.4.6 — 架构文档

**逆向日期**: 2026-07-04
**AI 助手**: Claude (DeepSeek-V4-Pro)

---

## 架构概览

```
┌─────────────────────────────────────────────────────┐
│           ChatGPT Degrade Checker v2.4.6             │
│             降级检查 / 模型使用统计                    │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌──────────────────────┐  ┌──────────────────────┐ │
│  │  Page Context         │  │  Content Script      │ │
│  │  (injected)           │  │                      │ │
│  │                       │  │  ┌────────────────┐  │ │
│  │  fetch_script.js ─────┼──┼─►│ 模型统计面板    │  │ │
│  │  ├─ fetch/XHR 拦截    │  │  │ ├─ PoW 风险显示 │  │ │
│  │  ├─ 模型识别          │  │  │ ├─ 使用进度条    │  │ │
│  │  ├─ PoW 检测          │  │  │ ├─ 账号类型标签  │  │ │
│  │  └─ 账号类型检测      │  │  │ └─ 导出/导入按钮 │  │ │
│  │                       │  │  └────────────────┘  │ │
│  └──────────────────────┘  │                       │ │
│                            │  ┌────────────────┐   │ │
│                            │  │ gpt-export.js   │   │ │
│                            │  │ JSZip 聊天导出   │   │ │
│                            │  └────────────────┘   │ │
│                            └──────────────────────┘ │
│                                                     │
│  Storage: localStorage (非 chrome.storage)           │
└─────────────────────────────────────────────────────┘
```

## 技术栈

| 层级 | 技术 |
|------|------|
| Manifest | MV3 |
| Background | 无（纯 Content Script 方案） |
| 页面注入 | inject.js → fetch_script.js |
| 存储 | localStorage |
| UI | 纯 DOM 操作，内联样式 |
| 导出 | JSZip |
| 外部链接 | upchatgpt.cn, ponskey.com |

## 核心机制

### PoW（Proof of Work）降智检测

ChatGPT 通过 PoW 难度值控制访问质量。难度值以十六进制表示（如 `0x0000abc...`），前导零越多表示 PoW 难度越高 → 风险越大。

```
难度值前导零数: 0-2 → 🔴 高风险（已降级）
              3   → 🟡 中风险
              4   → 🟢 低风险
              5+  → 🟢 正常
```

### 模型使用统计

通过拦截 ChatGPT API 的 fetch/XHR 请求，从响应头中提取：
- 模型名称（`x-openai-model` / response body model_slug）
- 账号类型（响应体中的 plan_type / account 信息）
- PoW 难度（`x-pow-difficulty` 响应头）

### 数据存储

使用 `localStorage`（非 `chrome.storage`），存储：
- `gptModelStats` — 模型使用统计
- `gptLastRequestTime` — 最后请求时间
- `gptLastResetTime` — 上次重置时间
- `gptUserPlanType` — 用户账号类型
- `gptModelStatsPanelState` — 面板状态

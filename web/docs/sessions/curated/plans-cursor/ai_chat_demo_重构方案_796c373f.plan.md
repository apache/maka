---
name: AI Chat Demo 重构方案
overview: 将 ai-chat-demo 从 Taro 4.2.0 降级到 Taro 3.6.x，参考主项目 AI Agent 页面重构 UI，新增 KIMI/DeepSeek/GLM 多模型接入支持。
todos:
  - id: taro-downgrade
    content: Taro 4.2.0 降级到 3.6.x，验证编译通过
    status: pending
  - id: multi-model
    content: 新增模型配置层（src/config/models.ts）和后端多模型路由（server.js）
    status: pending
  - id: page-restructure
    content: 重构页面结构：Header + BaseContent + MessageContent + AgentBottom 三段式布局
    status: pending
  - id: new-components
    content: 新增组件：Sidebar 历史侧边栏、ActionList 技能卡片、TopicList 话题列表、ActionMenu 技能菜单
    status: pending
  - id: message-enhance
    content: 消息渲染增强：ScrollView 分组、回到底部按钮、刷新按钮、loading 动画
    status: pending
  - id: style-unify
    content: 样式统一：参考主项目紫色系视觉风格，bg 图 + 渐变背景
    status: pending
  - id: final-verify
    content: 全量验证：build:h5 + build:weapp 编译通过，server 启动正常
    status: pending
isProject: false
---

## 一、Taro 3.6.x 降级

将所有 `@tarojs/*` 包从 4.2.0 降到 3.6.31（3.6 最新稳定版）。

**修改文件**: [ai-chat-demo/package.json](ai-chat-demo/package.json)

依赖变更:
- `@tarojs/cli`, `@tarojs/taro`, `@tarojs/components`, `@tarojs/react`, `@tarojs/runtime`, `@tarojs/shared`, `@tarojs/helper`: → `3.6.31`
- `@tarojs/plugin-framework-react`: → `3.6.31`
- `@tarojs/plugin-platform-h5`, `@tarojs/plugin-platform-weapp`: → `3.6.31`
- `@tarojs/webpack5-runner`: → `3.6.31`
- `babel-preset-taro`: → `3.6.31`
- `react`, `react-dom`: 保持 `^18.3.1`（3.6 兼容 React 18）
- `zustand`: 保持 `^5.0.0`

降级后执行 `rm -rf node_modules && npm install` 重装依赖，验证 `npm run build:h5` 编译通过。

---

## 二、UI 重构 — 参考主项目 AI Agent 页面

参考 [src/aiAgentPackage/aiAgent/](src/aiAgentPackage/aiAgent/) 的页面结构，重构 demo 的聊天页面。

### 2.1 页面架构重构

**修改文件**: [ai-chat-demo/src/pages/chat/index.tsx](ai-chat-demo/src/pages/chat/index.tsx)

参考主项目 `AiAgentInner` 的三段式布局:
```
Header (自定义导航栏 + 返回 + 历史侧边栏)
  ↓
ContentArea (有会话时显示 MessageContent，无会话时显示 BaseContent 欢迎页)
  ↓
BottomArea (ActionMenu 技能菜单 + InputBar 输入栏)
```

将当前简单的 Header + MessageList + InputBar 改为:
- `Header`: 自定义导航栏，含返回按钮 + 标题「AI智能教练」+ 历史会话按钮
- `BaseContent`: 空会话时的欢迎页，含 ActionList（技能卡片网格）+ TopicList（推荐话题列表）
- `MessageContent`: 消息列表，使用 ScrollView + scrollIntoView，支持消息分组（Q&A 对）
- `AgentBottom`: ActionMenu（横向滚动技能图标）+ InputBar

### 2.2 新增组件

创建以下组件（参考主项目对应组件的 UI 结构）:

| 新文件 | 参考来源 | 用途 |
|--------|----------|------|
| `src/components/Header/Sidebar.tsx` | [Header/Sidebar/](src/aiAgentPackage/aiAgent/components/Header/Sidebar/) | 历史会话侧边栏 |
| `src/components/BaseContent/index.tsx` | [BaseContent/](src/aiAgentPackage/aiAgent/components/BaseContent/) | 欢迎页容器 |
| `src/components/BaseContent/ActionList.tsx` | [ActionList/](src/aiAgentPackage/aiAgent/components/BaseContent/ActionList/) | 技能卡片网格 |
| `src/components/BaseContent/TopicList.tsx` | [TopicList/](src/aiAgentPackage/aiAgent/components/BaseContent/TopicList/) | 推荐话题列表 |
| `src/components/ActionMenu/index.tsx` | [ActionMenu/](src/aiAgentPackage/aiAgent/components/AangeBottom/ActionMenu/) | 底部横向技能菜单 |

### 2.3 消息渲染增强

**修改文件**: [ai-chat-demo/src/components/MessageList/index.tsx](ai-chat-demo/src/components/MessageList/index.tsx)

参考主项目 `MessageContent`:
- 使用 `ScrollView` + `scrollIntoView` 替代当前的 div 滚动
- 消息按 Q&A 对分组显示
- 新增「回到底部」浮动按钮（参考主项目 `backToBottomBtn`）
- AI 回答中新增「刷新」按钮（参考 `AnswerContent` 的 refreshWrap）
- 流式输出时的 loading 动画改为三点跳动（参考主项目 loadingBubble）

### 2.4 样式统一

**修改文件**: 所有 `.module.scss` 文件

参考主项目的视觉风格:
- 背景: 渐变 + 背景图（`background-image: url(CDN) + linear-gradient`）
- 色系: 紫色系 `#f3f1fe → #f5f6fb → #f7f8fc`（主项目用的紫色调，与美业品牌一致）
- 导航栏: 透明背景 + 自定义返回箭头 + 汉堡菜单图标
- 气泡: 圆角、阴影、适当的间距

---

## 三、多模型接入

### 3.1 模型配置层

**新建文件**: [ai-chat-demo/src/config/models.ts](ai-chat-demo/src/config/models.ts)

```typescript
export interface ModelConfig {
  id: string;
  name: string;
  provider: string;      // 'openai' | 'kimi' | 'deepseek' | 'glm'
  baseURL: string;
  model: string;          // 模型标识符
  apiKey: string;
}

// 从环境变量读取，默认使用 mock
export const MODELS: ModelConfig[] = [
  { id: 'kimi',     name: 'KIMI',     provider: 'kimi',     baseURL: 'https://api.moonshot.cn/v1',    model: 'moonshot-v1-8k',  apiKey: process.env.KIMI_API_KEY || '' },
  { id: 'deepseek', name: 'DeepSeek', provider: 'deepseek', baseURL: 'https://api.deepseek.com/v1',  model: 'deepseek-chat',   apiKey: process.env.DEEPSEEK_API_KEY || '' },
  { id: 'glm',      name: 'GLM-4',    provider: 'glm',      baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', apiKey: process.env.GLM_API_KEY || '' },
];

export const DEFAULT_MODEL_ID = process.env.DEFAULT_MODEL || 'kimi';
```

### 3.2 后端多模型路由

**修改文件**: [ai-chat-demo/server/server.js](ai-chat-demo/server/server.js)

改造 `server.js`:
- 从 `.env` 读取多个模型的 API Key 和 Base URL
- 请求体中新增 `modelId` 字段
- 根据 `modelId` 选择对应的 OpenAI 客户端实例
- 所有模型统一使用 OpenAI 兼容接口（KIMI/DeepSeek/GLM 都兼容）

```javascript
// 多模型客户端初始化
const modelClients = {};
for (const [id, config] of Object.entries(MODEL_CONFIGS)) {
  if (config.apiKey) {
    modelClients[id] = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  }
}
```

### 3.3 前端模型选择

**新建文件**: [ai-chat-demo/src/store/modelStore.ts](ai-chat-demo/src/store/modelStore.ts)

- 新增 zustand store 管理当前选中的模型
- 配置文件中指定默认模型（env config 方式）
- 在 Header 或设置区域展示当前模型标识

### 3.4 SSE 层适配

**修改文件**: [ai-chat-demo/src/hooks/useSSE.ts](ai-chat-demo/src/hooks/useSSE.ts)

- 请求 body 中传递 `modelId`
- 其余 SSE 协议不变（所有模型的流式输出格式兼容 OpenAI SSE）

**修改文件**: [ai-chat-demo/server/.env.example](ai-chat-demo/server/.env.example)

```env
# KIMI (Moonshot)
KIMI_API_KEY=your-kimi-key
KIMI_BASE_URL=https://api.moonshot.cn/v1
KIMI_MODEL=moonshot-v1-8k

# DeepSeek
DEEPSEEK_API_KEY=your-deepseek-key
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
DEEPSEEK_MODEL=deepseek-chat

# GLM (Zhipu AI)
GLM_API_KEY=your-glm-key
GLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
GLM_MODEL=glm-4-flash

# 默认模型
DEFAULT_MODEL=kimi
```

---

## 四、实施顺序

1. **Step 1**: Taro 降级到 3.6.x，验证编译通过
2. **Step 2**: 新增模型配置层和后端多模型路由
3. **Step 3**: 重构页面结构（Header + BaseContent + MessageContent + AgentBottom）
4. **Step 4**: 新增组件（Sidebar、ActionList、TopicList、ActionMenu）
5. **Step 5**: 消息渲染增强（ScrollView 分组、回到底部、刷新按钮）
6. **Step 6**: 样式统一（参考主项目紫色系视觉风格）
7. **Step 7**: 全量验证 — `build:h5` + `build:weapp` 编译通过 + server 启动正常
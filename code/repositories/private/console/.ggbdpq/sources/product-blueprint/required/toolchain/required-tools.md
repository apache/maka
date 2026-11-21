# 必备技能与插件清单

> 本清单定义 AI Agent 执行任务时必须具备的 skills 与 plugins。  
> 缺失时请先安装，不要在缺失状态下继续跑任务。

## 〇 Skill 查找与安装规则

### 查找顺序

1. 仓库根目录 `skills/`
2. 项目级 `.cursor/skills/`

### 兜底安装

若本地都找不到所需 skill，允许使用 find-skills 进行下载与安装：
- 参考来源：https://github.com/vercel-labs/skills/blob/main/skills/find-skills/SKILL.md
- 安装落点：`.cursor/skills/<skill-name>/`
- 版本锁定：安装后必须创建 `.cursor/skills/<skill-name>/VERSION.lock`，内容包含来源 URL、固定 commit/tag、安装日期

### 安全边界

- 夜间无人值守模式默认禁止安装未知来源 skill
- 必须显式授权后才允许安装

## 一 设计（强制）

### 适用场景

- 所有涉及 UI/UX 的任务
- 前端页面开发
- 组件设计

### 必备项

| 名称                    | 说明           | 强制 |
| ----------------------- | -------------- | ---- |
| `frontend-design`       | 前端设计规范   | ✅   |
| `web-design-guidelines` | Web 设计指南   | ✅   |
| `ui-ux-pro-max`         | UI/UX 专业增强 | ✅   |

### 缺失处理

```
⚠️ 缺失设计类 skill 时，禁止执行 UI 相关任务。
先安装：frontend-design / web-design-guidelines / ui-ux-pro-max
```

## 二 规划（强制）

### 适用场景

- 所有任务的规划阶段
- 任务拆分与步骤设计

### 必备项

| 名称                  | 说明           | 强制 |
| --------------------- | -------------- | ---- |
| `planning-with-files` | 文件级规划能力 | ✅   |

### 缺失处理

```
⚠️ 缺失规划类 skill 时，可能导致任务拆分不合理。
先安装：planning-with-files
```

## 三 大型项目规划（二选一，强制）

### 适用场景

- 多文件、多模块项目
- 复杂功能开发
- 重构与迁移

### 必备项（二选一）

| 名称          | 说明         | 强制                 |
| ------------- | ------------ | -------------------- |
| `superpowers` | 超级能力扩展 | ✅（或 feature-dev） |
| `feature-dev` | 功能开发增强 | ✅（或 superpowers） |

### 缺失处理

```
⚠️ 大型项目缺失规划增强时，任务执行效率下降。
至少安装其一：superpowers 或 feature-dev
```

## 四 重构（强制）

### 适用场景

- 代码重构
- 类型优化
- 代码简化

### 必备项

| 名称              | 说明                | 强制 |
| ----------------- | ------------------- | ---- |
| `code-simplifier` | 代码简化            | ✅   |
| `typescript-lsp`  | TypeScript 语言服务 | ✅   |

### 缺失处理

```
⚠️ 缺失重构类 skill 时，代码质量可能下降。
先安装：code-simplifier / typescript-lsp
```

## 五 安全（全阶段强制）

### 适用场景

- 所有任务的所有阶段
- 涉及用户数据、认证、授权的代码

### 必备项

| 名称                | 说明     | 强制 |
| ------------------- | -------- | ---- |
| `security-guidance` | 安全指导 | ✅   |

### 缺失处理

```
⚠️ 安全类 skill 必须全程启用，禁止在缺失状态下执行任何任务。
先安装：security-guidance
```

## 六 React 必备

### 适用场景

- React 技术栈项目
- 使用 React 19 + Vite 8 的项目

### 必备项

| 名称                          | 说明           | 条件           |
| ----------------------------- | -------------- | -------------- |
| `vercel-react-best-practices` | React 最佳实践 | React 项目必备 |
| `vercel-composition-patterns` | 组合模式       | React 项目必备 |

### 缺失处理

```
⚠️ React 项目缺失 React 专用 skill 时，代码质量无法保证。
先安装：vercel-react-best-practices / vercel-composition-patterns
```

## 七 Next.js 必备

### 适用场景

- Next.js 技术栈项目
- 使用 App Router 的项目

### 必备项

| 名称                    | 说明             | 条件               |
| ----------------------- | ---------------- | ------------------ |
| `next-best-practices`   | Next.js 最佳实践 | Next.js 项目必备   |
| `next-cache-components` | 缓存与组件优化   | Next.js 项目必备   |
| `next-upgrade`          | 版本升级指导     | Next.js 升级时必备 |

### 缺失处理

```
⚠️ Next.js 项目缺失专用 skill 时，SSR/缓存可能配置错误。
先安装：next-best-practices / next-cache-components
```

## 八 Vue 必备

### 适用场景

- Vue 技术栈项目
- 使用 Vue 3.5 + Vite 8 的项目

### 必备项

| 名称                 | 说明         | 条件         |
| -------------------- | ------------ | ------------ |
| `vue-best-practices` | Vue 最佳实践 | Vue 项目必备 |

### 缺失处理

```
⚠️ Vue 项目缺失 Vue 专用 skill 时，响应式逻辑可能有问题。
先安装：vue-best-practices
```

## 九 Vite 与 pnpm 相关必备

### 适用场景

- 使用 Vite 作为构建工具
- 使用 pnpm 作为包管理器

### 必备项

| 名称         | 说明          | 条件          |
| ------------ | ------------- | ------------- |
| `antfu-vite` | Vite 高级用法 | Vite 项目推荐 |
| `antfu-pnpm` | pnpm 最佳实践 | pnpm 项目推荐 |

### 缺失处理

```
⚠️ 缺失 Vite/pnpm 专用 skill 时，构建配置可能不够优化。
推荐安装：antfu-vite / antfu-pnpm
```

## 十 安装检查清单

### 强制项（所有项目）

```
□ frontend-design
□ web-design-guidelines
□ ui-ux-pro-max
□ planning-with-files
□ superpowers 或 feature-dev（二选一）
□ code-simplifier
□ typescript-lsp
□ security-guidance
```

### 条件项（按技术栈）

**React 项目**

```
□ vercel-react-best-practices
□ vercel-composition-patterns
```

**Next.js 项目**

```
□ next-best-practices
□ next-cache-components
□ next-upgrade（升级时）
```

**Vue 项目**

```
□ vue-best-practices
```

**Vite/pnpm 项目**

```
□ antfu-vite
□ antfu-pnpm
```

## 后续手动扩展区

> 以下区域留给后续手动添加的 skill/plugin

### 待评估

| 名称 | 说明 | 状态   |
| ---- | ---- | ------ |
|      |      | 待添加 |

### 已废弃

| 名称 | 废弃原因 | 废弃时间 |
| ---- | -------- | -------- |
|      |          |          |

> 本清单为母本必备项定义，具体项目可根据技术栈裁剪。

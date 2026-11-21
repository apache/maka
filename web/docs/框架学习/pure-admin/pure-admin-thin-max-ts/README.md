# 从入门到精通：吃透一套企业级 Vue3 后台管理系统

本系列基于本仓库 `pure-admin-thin-max-ts` v7.0.0 写作。它是一套 Vue 3.5 + Vite 8 + TypeScript + Element Plus 的后台管理系统"壳子"，麻雀虽小，五脏俱全：无感刷新 token、动态路由、页面/按钮两级权限、多租户入口、mock 后端、完整的工程化链路，全部是生产级写法。

每篇文章都遵守同一条纪律：**所有结论都能在源码里找到出处**。文中的文件路径相对仓库根目录，行号基于当前 `main` 分支。读的时候开着源码对照，效果最好。

## 章节目录

| 章节 | 文件 | 内容 | 难度 |
| --- | --- | --- | --- |
| 01 入门 | [01-getting-started.md](./01-getting-started.md) | 项目定位、跑起来、内置账号、目录地图 | ★☆☆ |
| 02 配置 | [02-config-system.md](./02-config-system.md) | .env / platform-config.json / 用户偏好三层配置体系 | ★★☆ |
| 03 路由 | [03-routing.md](./03-routing.md) | 静态路由自动注册、动态路由生命周期、路由守卫 | ★★★ |
| 04 认证 | [04-auth-token.md](./04-auth-token.md) | 双 Cookie 设计、token 无感刷新、登出链路 | ★★★ |
| 05 权限 | [05-permissions.md](./05-permissions.md) | 页面级 roles、按钮级 Auth/Perms、通配权限 | ★★★ |
| 06 数据层 | [06-http-and-mock.md](./06-http-and-mock.md) | PureHttp 封装、mock 后端、对接真实后端 | ★★☆ |
| 07 业务模块 | [07-business-modules.md](./07-business-modules.md) | 字典管理、日历排班、租户管理逐页精读 | ★★☆ |
| 08 布局与主题 | [08-layout-theme.md](./08-layout-theme.md) | 四种布局、用户偏好存储、popular 菜单风格 | ★★☆ |
| 09 构建与部署 | [09-build-and-deploy.md](./09-build-and-deploy.md) | Vite8/Rolldown、CDN 与压缩、lint 链路、Docker | ★★★ |
| 10 二次开发 | [10-customization.md](./10-customization.md) | 新增一个完整页面的全流程、常见坑清单 | ★★★ |

## 三条学习路径

按你的目标选路线，不必从 01 顺读到 10。

| 目标 | 路线 | 说明 |
| --- | --- | --- |
| 快速用它做项目上线 | 01 → 02 → 06 → 07 → 10 → 09 | 重点看配置、数据层对接和二次开发流程 |
| 学透前端工程能力 | 01 → 03 → 04 → 05 → 08 | 路由、鉴权、权限是这套代码最有教学价值的部分 |
| 架构审查与裁剪 | 01 → 06 → 09 → 10 | 关注 mock 生产开关、构建链路和精简手法 |

## 阅读约定

- 每篇开头先给"本篇你会搞懂"，先结论后展开。
- 概念第一次出现时用朴素的话定义，配一个生活类比。
- 文中命令都标注了用途和预期结果，建议边读边跑。
- "新手容易搞混"小节纠偏最常见的误解，出自真实踩坑点。
- 每篇结尾有自检清单，能答上来再进下一篇。

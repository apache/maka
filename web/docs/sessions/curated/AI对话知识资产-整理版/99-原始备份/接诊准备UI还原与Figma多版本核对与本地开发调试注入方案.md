# 接诊准备 UI 还原与 Figma 多版本核对与本地开发调试注入方案

> 生成于 2026-09-29，基于 homing-miniapp-workbench 仓库 v1.7.2.1 会话完整复盘。

## 一、问题背景与目标

三条任务线：

1. **Figma 归档维护**：`E:\ggbdpq\web\02-UI设计\历史汇总\Figma\` 按 Figma「项目库」（fileKey `7Qgdm9G6EjT6OmxP3e6dPs`）各版本页面归档画板（PNG@2x + 节点树 JSON + `_manifest.json` + README）。本轮完成 v1.7.2 增量同步（09-24 设计更新）、UI还原区 9 板重抓、v1.7.2.1 新页面（`8723:579`）首抓，以及 8 个版本全部 700+ 画板的逐一变动核对。
2. **接诊准备 UI 还原修复**（`src/subPackage/receptionPrep`）：用户本地改了一部分但改错若干处，要求严格对照 Figma 走查图（`8843:1509` 还原问题 9.24 标注块 + `8420:471` 设计图）百分百还原。
3. **本地开发调试工具**：用户在 Win Chrome 直连 dev server 开发，反复遇到「未登录 12001005」和版本门槛（canIUse receptionPrep >= 11）恒 false，要求做一个不进生产的调试注入方案。

## 二、最终结论与关键决策

### Figma 核对

- **核心定性结论：字节对比不可作数，节点树 diff 才是唯一可靠判定**。Figma 渲染服务端噪声可使同内容 PNG 字节差最高 9%（如 S2 首页 +220KB 内容一字未动）；反之树完全一致即零改动。
- 8 版本（S2/S3/S4/v1.6.9/v1.7.0/v1.7.1/v1.7.2/v1.7.2.1）核对结论：全部画板**零真实设计改动**。字节差异均为渲染噪声/浮点抖动；唯一树差异是 S2 一处色值第 4 位小数抖动；v1.7.0 两板仅被挪动位置（canvasPosition 已修正提交 `f0eb06fa`）。
- 结构新增节点（S2 +13、S3 +8 等）均为散素材/标注，非正式画板，未纳入归档。
- S2UI还原页（`1533:2923`，67 节点）从未归档——遗留待用户决策。
- v1.7.2.1 页是 v1.7.2 页 09-24 新增帧的复制副本（字节近乎相同、节点 id 不同），后续设计迭代以新页为准。

### 接诊准备 UI 还原

- **设计事实以 Figma 节点树 `effects` 字段为准，不靠目测**。定稿帧实测：标签两页均无投影；详情页客户信息卡 `8843:1636` 投影 `0 12 28 rgba(64,56,166,8%)`；头像 `8843:1638` 白边 3rpx。
- **用户口径 > 定稿帧**（两次重要纠正）：①「顶部接诊助手去掉」是滚动后随内容滚出视口，不是删除组件；②详情页客户信息最终**无白底卡**（对照 8420:471），阴影 14/28 之争随卡一起消失；详情页标签**有投影**（用户口径与 8420:471 采样一致），首页标签无投影——由 variant 参数区分。
- 标签顺序 `TAG_GROUP_ORDER` 必须保持与后端约定的「价值→需求→活跃→项目」，不以 UI 稿为准。

### 本地调试

- **未登录 12001005 的完整根因链**：localStorage 按 origin 隔离（localhost 与 10.6.33.85 是两个空间）+ `request/index.h5.ts` 响应头 token 回写机制会覆盖注入 token + 手写 localStorage 会被 zustand persist 全量回写冲掉。
- **最终方案**：dev-only 的 `src/utils/localdev.ts`（`loadLocalDev()`）——URL 带 `URLtoken` 时写入专用调试键并**直接 setState 注入内存 store**（zustand persist 自动落盘，绕开 hydrate 时序），请求组装时调试 token 优先；同时每次 dev 加载自动补模拟版本上下文（不依赖 URLtoken）。

## 三、技术方案与关键实现

### Figma 归档脚本（`.debug/figma/`，gitignore 内不入库）

- `v172-refetch.mjs` / `v172-uirestore-refetch.mjs` / `v1721-fetch.mjs`：增量/全量抓取，PNG@2x + 节点树 JSON + manifest 同步。
- `old-versions-byte-check-v2.mjs`：字节对比管线。**关键经验**：Figma `images` API 批量渲染冷缓存会整批超时（曾 5 分钟×5 次重试全灭）——必须 5 个 id 一批 + 批失败降级逐节点 + 渲染 URL 断点缓存到 `render-url-cache/<ver>.json`（Figma 渲染缓存跨请求累积，重跑只补缺）。
- `diff-tree.mjs` / `all-tree-diff.mjs`：节点树深度 diff 定性（数值容差 1e-6 过滤浮点抖动）。
- 令牌：`C:\Users\802165\.agents\skills\clife-homing-figma\.env`（注意 skill 目录已从 `clife-homing-figma-to-urls` 合并到 `clife-homing-figma`），只在单命令变量流转。

### localdev.ts 设计要点

```
src/utils/localdev.ts        # 全部调试常量/逻辑/使用指南收敛于此，整体可删
src/app.h5.tsx               # 仅 loadVconsole() 旁一行 loadLocalDev()（H5 专属入口，小程序无此文件）
src/services/request/index.h5.ts  # dev 下 header.token 优先取 DEV_DEBUG_TOKEN
```

- 函数拆分：`readUrlToken`（hash 参数优先、search 兜底）/ `injectDebugState`（store setState 注入 token + 模拟 outer_context）/ `stripUrlToken`（URL API 重建 search+hash 两段，无残留分隔符）。
- 常量收敛：`DEV_DEBUG_TOKEN = 'homing-dev-debug-token'`、`URL_TOKEN_PARAM`、`GLOBAL_DATA_KEY`、`SIMULATED_APP_VERSION='11'`、`SIMULATED_OS_TYPE='android'`。
- 幂等无循环：patch 为空直接 return；清参 replace 前后比对 URL 必须变化才执行。
- 生产隔离双保险：函数内 `process.env.NODE_ENV !== 'development'` 早退（构建期 DCE 消除）+ `app.h5.tsx` 仅参与 H5 构建。
- 外部调用点注释只写一行「本地开发调试」（用户要求），细节全在 localdev.ts 顶部五节使用指南。

### UI 还原代码结构

- `CustomerTagRow` 公共组件 `variant: 'home' | 'detail' | 'archive'` 三态：home 紧凑无投影（fs18/padding 2 16/间距 8），detail/archive 详情规格带 `.tagShadow`（0 4 8 rgba(29,29,29,6%)，对照 8420:471）。修复了 `tagCompact` 类从未挂载的历史 bug。
- 首页滚动：`.content` 页面级滚动 + `.stickyDeviceBar { position: sticky; top: 0; z-index: 2 }` + 设备条下缘同背景色渐隐（`linear-gradient($rp-home-bg, 透明)` 32rpx）+ `.content::after` 滚动余量（hero 切图 1372:484 → `padding-bottom: calc(35.28% + 10rpx)`，纯比例自适应，不涉固定像素/状态栏高度）。App 注入的 `homing-status-bar-height` 是动态值，勿用固定像素方案。
- 客户信息卡两页样式分写：首页 `.profileHome`（88rpx 头像无描边），详情 `.profileDetail`（无白底卡铺页面背景、头像 100rpx 白边 3rpx + `$rp-shadow-tag` 投影）。

## 四、踩坑经验（可迁移）

1. **Figma 渲染噪声最高 9%**——归档刷新前必须先做树 diff，否则会盲目覆盖大量未变文件。
2. **Figma images 批量 API 冷缓存超时**：整批同步渲染，一个大会板拖死全批；降级逐节点 + 断点缓存是解法。
3. **HEAD 请求对 S3/图床不稳**（并发下 headers timeout），GET 下载算 Content-Length 更可靠。
4. **zustand persist 无 partialize 时禁止手写 localStorage 同名字段**——任何 `set()` 都会全量回写内存态冲掉手写值；要注入就直接 `store.setState()`。
5. **响应头 token 回写**（`header?.token` → `setState({token})`）会覆盖一切外部注入的 token，调试 token 必须在请求组装层抢占优先级。
6. **localStorage 按 origin 隔离**：`localhost:10086` 与 `10.6.33.85:10086` 互不相通；换地址必须重新注入。
7. **dev server（webpack-dev-server）响应无 Cache-Control**，浏览器启发式缓存旧 bundle，改代码「不生效」先查 Disable cache。
8. **sticky 失效的第三种形态**：样式链全通但内容滚动余量不足，滚到底 sticky 到不了激活点——垫等比余量解决，不要急着改定位方案。
9. **CSS Modules 类名未挂载**（`tagCompact` 写了没拼进 className）这类历史 bug，靠守卫测试断言组件源码字符串才暴露。
10. **`git add -A` 在混合工作区会误裹他人文件**——本轮误提交用户 txt 两次，靠 `reset --soft` + 精确 add 修正；分组提交时必须 `git diff --cached --name-status` 逐组核对。
11. **守卫测试锁死中间口径**：本地测试断言若锁定「当时认为对」的实现（如全局头像白边），后续口径修正会红——测试应锁最终设计事实并注明来源帧号。
12. **Figma 用户给的 node-id 可能有误**（8723-5798 不存在，实际 8723:579）——以 `GET /files` 页面列表核对为准。

## 五、已完成事项与提交

web 知识库仓库（`E:\ggbdpq\web`，main）：
- `915e14f1` v1.7.2 设计图同步 09-24 版（36 文件）
- `b62a7b9f` 知识库整理
- `f2438646` UI还原区 1~7 重抓（定性为渲染噪声）
- `ce23c373` v1.7.2.1 页面全量归档（32 文件）
- `f0eb06fa` 全版本核对记录 + v1.7.0 挪位板修正

workbench 仓库（feature/env-v1.7.2.1 分支）：
- `43728da3` feat(receptionPrep): 首页/详情页滚动重构，设备连接条置顶（提交4）
- 提交1 按压态去置灰（10 文件）、提交2 标签 variant 三态化（5 文件）、提交3 详情客户信息卡（2 文件）均已按给定文案暂存并提交
- 本地调试 loadLocalDev 三个文件已暂存（文案已给）

本地测试（`tests/` 只存本机绝不提交，红线）：`customerTags.test.cjs`、`receptionPrepUiRestore.test.cjs` 已更新到最终口径全绿；其余 8 个失败测试为预存问题与本轮无关。

## 六、遗留问题与下一步

1. **提交 5（文档）未提交**：`docs/ui-design/01.UI还原明细.md` 已同步口径，文案已给：`docs(receptionPrep): UI 还原明细同步滚动与阴影口径`。
2. 用户自己的未提交文件：`.gitignore`、`package-lock.json`、`stylelint.config.js`、`AGENTS.md`，由用户处理。
3. `postcss-scss` 项目未安装，stylelint 无法运行（package.json 本无此依赖，勿擅自加），SCSS 一直以人工核对代替。
4. S2UI还原页（1533:2923）是否补归档待用户决策；`图标/` 目录 09-14 后未重扫（v1.7.2 README 已标注缺口）。
5. 详情卡阴影若设计确认走定稿，`$rp-shadow-card`（0 12 28）替换现值即可（现已无卡，此项随去白底失效）。
6. 客户档案页将来接入标签组件时传 `variant="archive"`，档案设计稿分化后再补样式。
7. stylelint 红线中「自检命令」依赖的 postcss-scss 需与用户确认是否补装。

## 七、新会话快速恢复上下文

- **仓库**：workbench 在 `feature/env-v1.7.2.1` 分支；UI 还原五组提交 + loadLocalDev 已全部提交/暂存完毕。工作区剩余：提交5 文档 + 用户自己的 4 个杂项文件。
- **本地开发**：AI美管家 `npm run dev:h5:itest_bma`，宏脉SDK `npm run dev:h5:itest`；Win Chrome 首次/换 token 用 `http://localhost:10086/#/pages/homeTabs/index?URLtoken=<token>` 进入（自动注入+清参+刷新），版本门槛每次加载自动模拟（version 11/android）；DevTools 必须勾 Disable cache。详见 `src/utils/localdev.ts` 顶部指南。
- **Figma 归档**：脚本在 workbench `.debug/figma/`（`v172-refetch.mjs`/`v1721-fetch.mjs` 增量重抓、`render-url-cache/` 断点缓存），令牌在 `~/.agents/skills/clife-homing-figma/.env`；判定改动只信节点树 diff（`diff-tree.mjs`/`all-tree-diff.mjs`），不信字节。
- **设计口径**：标签顺序=后端约定（价值→需求→活跃→项目）；标签投影=详情/档案有、首页无（variant 区分）；详情页客户信息无白底卡；设备条 sticky 置顶 + hero 滚出 + 等比滚动余量；按压态全部 `hoverClass="none"` + `:active` 本色。
- **下一步**：催提交 5；真机回归本轮 UI 还原；按需补 S2UI还原归档与图标重扫。

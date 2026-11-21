# 09 构建与部署：Vite8/Rolldown、插件链与两个真实的 Docker 坑

本篇你会搞懂三件事：

1. 从 `pnpm build` 到 dist 目录，构建链路上每个插件干了什么。
2. CDN 模式、压缩模式、staging 模式这三个发版旋钮怎么用。
3. 本仓库 Dockerfile 里两个按当前状态必然翻车的问题（已逐一验证）。

## 一句话定义

构建配置分两处：`vite.config.ts` 是主配置，`build/` 目录是被主配置引用的四个模块（plugins 插件清单、cdn 替换、compress 压缩、utils 工具与别名）。类比厨房：vite.config 是菜单，build/ 是四个备菜间，出餐流程全部在菜单里编排。

## 命令全景（package.json scripts）

| 命令 | 用途 | 备注 |
| --- | --- | --- |
| `pnpm dev` | 开发服务器，端口 8848 | NODE_OPTIONS 预留 4G 内存 |
| `pnpm build` | 生产构建到 dist | 先 rimraf 清空，预留 8G 内存 |
| `pnpm build:staging` | 预发布构建 | 走 `.env.staging`：`VITE_CDN = true` |
| `pnpm report` | 构建并打开依赖体积分析 report.html | rollup-plugin-visualizer |
| `pnpm preview` | 本地预览构建产物 | |
| `pnpm typecheck` | vue-tsc 全量类型检查 | 不产出文件，CI 用 |
| `pnpm lint` | eslint + prettier + stylelint 三连 | 各自可单独跑 |

注意 `dev`/`build` 脚本用了 `NODE_OPTIONS=xxx vite` 这种 Unix 风格的环境变量前缀，Windows 的 cmd 不认。本机跑不起来时用 Git Bash / PowerShell 7+，或自己改写脚本。

## vite.config.ts 主配置

- **别名**：`@` 指 src，`@build` 指 build 目录（`build/utils.ts` 的 `alias`，路径解析逻辑保证了配置文件在哪都能跑）。
- **server**：`host: "0.0.0.0"`（局域网可访问），`warmup` 预热 index.html 和 views/components，压低冷启动白屏；`proxy: {}` 空着等你填后端代理。
- **build**：目标 es2015；`chunkSizeWarningLimit: 4000`；产物按 `static/js|css|...` 分类加 hash（`rolldownOptions.output`）。这里用的是 `rolldownOptions` 而不是传统 `rollupOptions`——本仓库跑在 Vite 8 + Rolldown 内核上（Rust 版打包器，Vite 未来方向的落地版），大部分 rollup 插件生态仍在过渡期，加新构建插件前先确认兼容性。
- **`__APP_INFO__`**：打包时注入依赖清单和构建时间（`build/utils.ts`），前端控制台能打印出来。
- **define**：关掉 i18n devtools（本版本非国际化，残留 define 属正常）。

## 插件链（build/plugins.ts）

按执行顺序，每个插件的职责：

| 插件 | 职责 | 条件 |
| --- | --- | --- |
| `@tailwindcss/vite` | Tailwind v4 官方 vite 插件（不再走 postcss 配置文件） | 恒开 |
| `vue` + `vueJsx` | SFC 与 tsx 支持（hook 里的 cellRenderer 靠它） | 恒开 |
| `code-inspector-plugin` | 按住 Alt+Shift（Mac 为 Option+Shift）点击页面元素直达 IDE 源码行 | 恒开 |
| `viteBuildInfo` | 控制台打印构建信息 | 恒开 |
| `vite-plugin-router-warn` | 压掉 vue-router 动态路由注册前的 no match 警告 | 仅 dev |
| `vitePluginFakeServer` | mock 后端 | **enableProd: true，第 06 篇已强调** |
| `vite-svg-loader` | svg 以 `?component` 导入成组件（排班页图标） | 恒开 |
| `unplugin-icons` | `~icons/ep/delete` 这类写法按需离线图标 | 恒开 |
| `vite-plugin-cdn-import` | 大依赖替换为 bootcdn 引用 | `VITE_CDN = true` 时 |
| `configCompressPlugin` | gzip/brotli 产物 | `VITE_COMPRESSION` 非 none 时 |
| `vite-plugin-remove-console` | 生产剥离 console（iconfont 除外） | 生产 |
| `visualizer` | 体积分析 | `pnpm report` 时 |

## 三个发版旋钮

**CDN 模式**（`build/cdn.ts`）：把 vue、vue-router、element-plus、axios、dayjs、echarts 替换成 bootcdn 的 `<script>`，版本号自动读 package.json 的 dependencies。适合国内公网站点减体积；内网部署应把 prodUrl 换成自有静态服务器。staging 环境（`.env.staging`）默认开启它做真实验证。

**压缩模式**（`build/compress.ts`）：`gzip`/`brotli`/`both` 生成 `.gz`/`.br` 附件（默认不删原文件，需 nginx 开启对应静态压缩模块才有意义）；加 `-clear` 后缀的变体（如 `gzip-clear`）会删除原文件，产物只保留压缩件。全部关掉是 `none`（当前生产配置）。

**模式与变量**：Vite 的 mode 机制决定读哪个 `.env.[mode]`，`build/utils.ts` 的 `wrapperEnv` 统一做类型转换与默认值（第 02 篇）。

## 工程化链路

- **强制 pnpm**：`preinstall: npx only-allow pnpm`，用 npm/yarn 装依赖直接失败。
- **husky + lint-staged**：`prepare: husky` 装钩子，`.lintstagedrc` 按文件类型分工——`*.{js,jsx,ts,tsx}` 走 prettier + eslint；`*.vue` 三件套全上（prettier、eslint、stylelint）；`*.md` 只过 prettier。提交即自动修复。
- **commitlint**：conventional 提交规范（`chore:`、`fix:`、`feat:`），git log 里清一色的规范提交就是它管的。
- **eslint 10 flat config**：`eslint.config.js`，配套 `eslint-plugin-better-tailwindcss` 检查 class 排序。
- **stylelint**：`stylelint.config.js`，属性排序用 recess-order 规则集。

## 部署：两个按当前仓库状态必然翻车的问题

以下两条都在写本文时实际验证过，接手部署先处理：

**问题一：Dockerfile 引用了不存在的 `.npmrc`。** `Dockerfile` 第 8 行：

```dockerfile
COPY .npmrc package.json pnpm-lock.yaml ./
```

仓库根目录没有 `.npmrc` 文件（已用 `ls` 验证不存在）。`COPY` 的源文件缺失会让 `docker build` 直接报 `failed to compute cache key` 失败。修法二选一：提交一个 `.npmrc`（哪怕只放 registry 配置），或把这行改成 `COPY package.json pnpm-lock.yaml ./`。

**问题二：三处 Node 版本声明互相矛盾。** `package.json` engines 要求 `node >= 22.22.1`，`.nvmrc` 写的是 `v24.18.0`，而 `Dockerfile` 基础镜像是 `node:20-alpine`。即便解决了问题一，20 版镜像跑 `pnpm install` 会触发 engines 校验报错（pnpm 默认strict）。修法：基础镜像换成 `node:22-alpine` 或 `node:24-alpine`，与 engines 对齐。顺带审视 `corepack prepare pnpm@latest --activate`——`latest` 会漂移，建议锁到具体大版本以满足 `pnpm >= 11` 的约束。

**标准部署形态**：两阶段构建——第一阶段 node 环境构建出 dist，第二阶段 nginx:stable-alpine 纯静态托管，暴露 80 端口。路由模式是 hash（`.env.production` 的 `VITE_ROUTER_HISTORY = "hash"`），nginx 不需要 try_files 兜底；若切 h5 模式，记得加 `try_files $uri $uri/ /index.html`。产物里 `platform-config.json` 是运行时文件（第 02 篇），改标题、主题无需重新构建镜像，把它做成 ConfigMap 或卷挂载是最实用的姿势。

## 自检清单

1. 想让生产包体积立减，先动哪个旋钮？代价是什么？
2. `pnpm report` 打开的 report.html 里，体积大头通常是谁？哪个旋钮能把它摘出去？
3. Docker 构建失败在 COPY 这一步，原因是什么？两处要改哪里？

最后一篇 [10 二次开发实战](./10-customization.md)。

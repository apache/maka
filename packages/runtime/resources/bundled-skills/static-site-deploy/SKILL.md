---
name: 静态站点部署
description: 把前端项目或静态站点部署上线并返回可访问 URL；当用户说"部署到 Netlify/Vercel/Cloudflare"、"发布这个网站"、"给我一个预览链接"、"把项目部署上线"时使用。
category: DevOps与部署
allowed-tools:
  - Read
  - Bash
---

# 静态站点部署

把本地的前端项目或纯静态站点（HTML/CSS/JS）通过官方 CLI 部署到主流托管平台，并返回一个可访问的 URL。支持 Netlify、Vercel、Cloudflare Pages 三大平台。

## 目标

用户通常会这样表达需求：

- "帮我把这个项目部署上线，给我一个可以访问的链接"
- "部署到 Netlify / Vercel / Cloudflare Pages"
- "先创建一个预览部署来测试"
- "直接发布到生产环境"

你要做的是：识别项目类型与构建产物 → 构建 → 检查 CLI 与登录状态 → 部署 → 把最终 URL 交给用户。整个过程保持**保守**：只在有明确、标准的构建脚本时才执行构建，绝不臆造或猜测构建命令。

## 适用范围

- 适用：纯前端静态站点（HTML/CSS/JS/assets）、SPA（React/Vue/Svelte 等）、静态站点生成器产物（Vite、Next.js `export`、Nuxt `generate`、Astro、Hugo、Jekyll、11ty、VitePress、Docusaurus 等）。
- 部分适用：需要 SSR、边缘函数或后端 API 的项目——Vercel 对 Next.js SSR 支持最好，Cloudflare Pages 支持 Functions，但这类场景已超出"静态站点"范畴，需要额外配置，遇到时先向用户说明。
- 不适用：需要独立后端服务、数据库、长连接服务器进程的项目。这类项目建议用户改用面向服务的托管平台（如 Render、Fly.io），本技能不覆盖。

## 平台选择决策

如果用户没有指定平台，先按下面的对比帮他选，并说明理由：

| 平台 | 何时优先选它 | CLI | 免费额度特点 |
| --- | --- | --- | --- |
| **Netlify** | 通用静态站点、Jamstack、需要表单/重定向/边缘函数、团队协作 | `netlify`（netlify-cli） | 100GB/月带宽，构建分钟数有限 |
| **Vercel** | Next.js 项目、需要 SSR/ISR、React 生态、预览部署体验最佳 | `vercel` | 对个人项目友好，Next.js 一等公民 |
| **Cloudflare Pages** | 追求全球 CDN 速度、大流量、需要 Workers/边缘计算、免费带宽不限量 | `wrangler` | 带宽无限，构建次数每月 500 |

简明建议：

- 项目是 **Next.js** 且用到 SSR / API Routes → 优先 **Vercel**。
- 追求**免费不限流量**、全球分发速度、或已在用 Cloudflare 生态 → **Cloudflare Pages**。
- 普通静态站点、需要表单处理或重定向规则、想要成熟的 CI 集成 → **Netlify**。
- 用户已登录过其中某个平台的 CLI → 直接用那个，减少摩擦。

选定后，如果用户没表态，就用一句话告诉他你选了哪个、为什么，然后继续。

## 通用工作流

按顺序执行，每一步确认后再进入下一步。

### Step 1 — 识别项目类型与构建产物目录

先读 `package.json`（若存在），判断框架与构建脚本。同时用 `Read` 检查项目根是否已有构建产物目录，只检查这些白名单目录（不要递归全盘扫描）：

- `dist/`（Vite、Vue CLI、Astro）
- `build/`（Create React App）
- `out/`（Next.js `next export`）
- `.output/public/`（Nuxt 3 静态）
- `dist/` 或 `public/`（Hugo、部分 SSG）
- `_site/`（Jekyll、11ty）
- `.vitepress/dist/`、`.docusaurus` 构建产物
- `public/`（通用）

判定规则：候选目录内含 `index.html` 才算有效构建产物。

- 如果用户明确指定了目录，且该目录含 `index.html` → 直接跳到 Step 4。
- 如果恰好找到一个含 `index.html` 的目录 → 记为部署目录。
- 如果找到多个候选 → 让用户选。
- 如果一个都没有 → 进入 Step 2 构建。
- 如果项目根本身就是一堆静态文件（根目录有 `index.html`、没有 `package.json`）→ 直接用项目根作为部署目录，跳到 Step 3。

### Step 2 — 构建（保守策略）

只有在 `package.json` 里存在明确的构建脚本时才构建。按优先级查找脚本名：`build` → `build:prod` → `build:production` → `generate`（Nuxt）→ `export`（Next.js）。

```bash
# 检查依赖是否已安装
[ -d node_modules ] || echo "需要先安装依赖"
```

- 若 `node_modules/` 不存在，先告诉用户需要安装依赖，确认后再根据 lock 文件选择包管理器执行安装：
  - 有 `pnpm-lock.yaml` → `pnpm install`
  - 有 `yarn.lock` → `yarn install`
  - 有 `bun.lockb` → `bun install`
  - 否则 → `npm install`
- 执行构建，例如 `npm run build`。
- 构建完成后重新扫描 Step 1 的白名单目录，确认产物目录里有 `index.html`。
- 构建失败或没有产物 → 把错误报告给用户并停止，**不要猜测替代命令**。

### Step 3 — CLI 检测与登录状态检查

部署前先确认对应平台的 CLI 已安装且已登录。CLI 缺失时给出安装命令，登录态缺失时**引导用户自己完成登录**（登录/授权属于用户操作，见"边界"一节）。

各平台的检测命令见下面的平台小节。核心原则：

- CLI 未安装 → 提示安装命令（如 `npm i -g netlify-cli`），让用户安装或确认用 `npx`。
- 未登录 → 运行登录命令并把浏览器授权交给用户，等用户确认登录成功后再继续。**不要**替用户输入凭据或 token。

### Step 4 — 部署

用对应平台的 CLI 部署识别到的产物目录。区分预览部署与生产部署：

- 默认先做**预览部署**，除非用户明确要求直接上生产。
- 用户说"发布到生产"、"上线"、"--prod" 时才带生产参数。

### Step 5 — 返回可访问 URL

部署命令会输出一个 URL。把这个 URL 清晰地交给用户作为访问链接。只展示访问地址，不要复述内部日志、账号 ID 等细节。若刚部署完访问 404，提示用户等待几秒 CDN 生效后重试。

## 平台具体命令

### Netlify（netlify-cli）

检测与登录：

```bash
# 是否安装
netlify --version || echo "未安装：npm i -g netlify-cli"
# 登录状态
netlify status
# 未登录时（会打开浏览器，由用户授权）
netlify login
```

部署（`--dir` 指向产物目录）：

```bash
# 预览部署（draft URL）
netlify deploy --dir=dist

# 生产部署
netlify deploy --dir=dist --prod
```

首次部署若未关联站点，CLI 会交互式询问是创建新站点还是关联已有站点；可用 `netlify link` 先关联，或加 `--site <site-id>` 指定。部署输出中的 `Website URL`（生产）或 `Website Draft URL`（预览）就是要返回的链接。

### Vercel（vercel CLI）

检测与登录：

```bash
vercel --version || echo "未安装：npm i -g vercel"
# 查看当前登录用户
vercel whoami
# 未登录时（浏览器授权，由用户完成）
vercel login
```

部署：

```bash
# 预览部署（在项目根运行）
vercel

# 生产部署
vercel --prod
```

首次运行会交互式询问关联/创建项目、框架预设、构建命令与输出目录——Vercel 通常能自动识别常见框架（Next.js、Vite 等），静态项目可直接确认默认值。命令结束会打印 `Preview` 或 `Production` URL，即为访问链接。对纯静态目录也可用 `vercel deploy <dir>`。

### Cloudflare Pages（wrangler）

检测与登录：

```bash
wrangler --version || echo "未安装：npm i -g wrangler"
# 登录状态
wrangler whoami
# 未登录时（浏览器 OAuth 授权，由用户完成）
wrangler login
```

部署（`pages deploy` 指向产物目录）：

```bash
# 部署到 Pages 项目（首次会提示创建项目并让你命名）
wrangler pages deploy dist

# 指定项目名与生产分支
wrangler pages deploy dist --project-name=my-site --branch=main
```

输出中的 `https://<hash>.<project>.pages.dev`（预览）或项目主域名（生产分支）即为可访问 URL。非 `main`/生产分支的部署会得到带 hash 前缀的预览域名。

## 常见错误排查

- **命令找不到（command not found）**：CLI 未全局安装。改用 `npx netlify-cli ...` / `npx vercel ...` / `npx wrangler ...`，或让用户全局安装。
- **未登录 / 401 / Not authenticated**：运行对应的 `login` 命令，把浏览器授权交给用户，登录成功后重试部署。
- **部署目录为空或缺少 index.html**：说明构建产物目录识别错了或构建没成功。回到 Step 1/2 重新确认产物目录，检查构建日志。
- **构建失败**：把完整错误贴给用户，常见原因是依赖未安装、Node 版本不符、环境变量缺失。不要盲目重试或换命令。
- **SPA 路由刷新 404**：单页应用需要把所有路径回退到 `index.html`。Netlify 用 `_redirects`（`/* /index.html 200`），Cloudflare Pages 同样支持 `_redirects`，Vercel 可用 `vercel.json` 的 `rewrites`。提示用户按平台补上重定向规则。
- **环境变量未生效**：静态构建时的环境变量需在构建前注入（如 Vite 的 `VITE_` 前缀变量），或在平台 Dashboard/CLI 设置。CLI 无法读到本地 `.env` 时要显式配置。
- **刚部署访问 404 或旧内容**：CDN 尚未同步或缓存，等几秒到一分钟再刷新。

## 边界

- **登录与授权必须由用户本人完成**。你可以运行 `login` 命令触发浏览器授权流程，但绝不代替用户输入密码、API token 或点击授权按钮。等用户确认授权成功后再继续。
- **不代替用户接受任何服务条款或计费协议**。涉及付费计划、超额计费、绑定信用卡时，把选择权交还用户。
- **构建保守**：只在有标准构建脚本时构建；产物目录不明、monorepo 结构复杂或构建配置非常规时，停下来问用户，不要猜测。
- **只返回访问 URL**，不泄露账号 ID、token、内部日志等敏感或无关细节。
- 生产部署具有对外可见性，执行 `--prod` 类命令前确认这确实是用户想要的（预览 vs 生产）。

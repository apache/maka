# 02 把项目跑起来

> 本篇目标：从零启动项目，登录进系统，并完成三处最常见的初始改造。每条命令都说明用途和预期结果。

## 前置条件

| 依赖 | 要求 | 检查命令 |
| --- | --- | --- |
| Node.js | ^20.19.0 或 >=22.13.0 | `node -v` |
| pnpm | >=9 | `pnpm -v` |
| Git | 任意近期版本 | `git --version` |

版本要求来自 `package.json` 的 `engines` 字段。`preinstall` 脚本里有 `npx only-allow pnpm`，用 npm 或 yarn 安装会直接报错退出，这不是 bug，是强制约束。

一个 Windows 下的已知坑：如果用 fnm（Fast Node Manager）管理 Node，在非交互 shell 里 `cd` 进仓库可能报错 `We can't find the necessary environment variables to replace the Node version`。原因是 fnm 的 shell 钩子没在当前会话初始化。解决方式是先执行 `fnm env --use-on-cd | Out-String | Invoke-Expression`（PowerShell）或在 bash 配置里加载 `fnm env`，再进入项目目录。

## 启动三步

在仓库根目录依次执行：

```bash
# 1. 安装依赖。首次安装较慢，pnpm 会按 pnpm-lock.yaml 锁定版本
pnpm install

# 2. 启动开发服务器。预期输出本地地址 http://localhost:8848/
pnpm dev

# 3. 浏览器打开 http://localhost:8848/
```

端口号 8848 来自 `.env` 的 `VITE_PORT`，想换端口改这一处即可。

## 登录

开发模式默认表单已预填（`src/views/login/index.vue` 第 73 行附近的 `ruleForm` 初始值）：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| 租户 | pure-admin | 仅当 `.env` 中 `VITE_ENABLE_TENANT=true` 时显示，mock 不校验 |
| 用户名 | admin | mock 里唯一的超管账号 |
| 密码 | admin123 | `mock/login.ts` 不校验密码，填任意值都能登录 |

登录后有两套视角值得对比：

- `admin` 账号：roles 为 `["admin"]`，按钮权限为通配符 `*:*:*`，能看到全部菜单，包括系统管理、多租户、监控。
- 随便输入一个其他用户名（比如 `test`）：mock 会把它识别为 `common` 角色，只授予 `permission:btn:add` 和 `permission:btn:edit` 两个按钮权限，左侧菜单立刻少一批。这是理解第 05 篇权限机制最直观的实验。

## 验证项目是"活"的

登录成功后做三个小动作，确认核心链路正常：

1. 点击右上角设置齿轮，把布局从"双栏"切成"纵向"，左侧菜单形态立即变化。这验证了布局系统（第 08 篇）。
2. 在系统管理 → 用户管理里搜索任意关键字，列表会刷新（数据来自 `mock/system.ts` 的 `/user` 端点）。这验证了 mock 链路（第 06 篇）。
3. 切换语言到 English，菜单文字变化。这验证了 i18n（词条在 `locales/` 目录）。

## 五分钟改造清单

新项目落地通常先改这三处。

### 改标题

编辑 `public/platform-config.json`：

```json
{
  "Title": "PureAdmin"
}
```

把 `Title` 改成你的产品名。改完刷新浏览器即可，不用重启 dev server，因为这份配置是运行时通过 axios 拉取的（机制见第 03 篇）。同文件里 `Logo`、`Watermark`、`EpThemeColor` 等视觉项都在这里改。

### 改登录页品牌

`src/views/login/index.vue` 里的头像、标题文案、背景图（`src/assets/login` 目录）按需替换。全局搜索 `PureAdmin` 字样确认没有漏改的展示位。

### 改菜单语言或默认主题

同样在 `platform-config.json`：`"Locale": "zh"` 控制默认语言（可选 zh、zh-TW、en、ja、ko），`"ThemeMode": "light"` 控制默认主题模式（light、dark、system）。

## 常用命令速查

下表来自 `package.json` 的 `scripts` 字段。

| 命令 | 用途 | 预期结果 |
| --- | --- | --- |
| `pnpm dev` | 启动开发服务器 | 输出 localhost:8848 |
| `pnpm build` | 生产构建 | 生成 `dist/`，产物按 `static/js`、`static/css` 分类 |
| `pnpm build:staging` | 预发构建 | 读取 `.env.staging` |
| `pnpm preview` | 本地预览构建产物 | 注意先 build 再 preview |
| `pnpm typecheck` | TS 类型检查 | vue-tsc 全量检查，无输出即通过 |
| `pnpm lint` | 三连检查：eslint、prettier、stylelint | 全部通过会依次输出结果 |
| `pnpm report` | 构建并生成依赖体积分析 | 自动打开 `report.html` |

特别说明 `pnpm build`：它是 `rimraf dist && vite build && generate-version-file` 的组合，构建产物里 mock 依然生效（`build/plugins.ts` 中 `enableProd: true`），所以你可以直接 `pnpm preview:build` 一条命令完成"构建加预览"，不需要任何后端。

## 目录规范：提交前会发生什么

仓库配了 husky 加 lint-staged（`.husky/`、`.lintstagedrc`）。`git commit` 时会自动对暂存文件跑 prettier、eslint、stylelint 并执行 commitlint 校验提交信息格式（`commitlint.config.js`，要求 conventional commits 风格，如 `feat: xxx`、`fix: xxx`）。如果提交被拦下，按提示修完再提交即可，不要用 `--no-verify` 绕过。

## 下一步

项目已经跑起来了，接下来两条路任选：

- 想理解"从浏览器输入网址到看到页面之间发生了什么"，读 [03 启动链路](./03-bootstrap.md)。
- 急着写业务页面，可以直接跳 [10 实战：新增一个完整业务模块](./10-crud.md)，遇到不懂的机制再回读 03 到 06。

# 用 wxa-runner 在浏览器里调试微信小程序

> 更新：2026-11-13。康养有两个小程序项目，跑法不同：

| 项目 | 框架 | 跑法 |
| --- | --- | --- |
| `E:\Projects\senior\frontend\mp\mp-c-terminal-wxapp-xiangyang`（襄阳现行，课程/活力恒泰等模块在此） | Taro 4.3.2 + React 18 | wxa-runner ≥0.13.1 直接跑，**不需要任何扩展**（2026-11-13 实测） |
| `E:\Projects\senior\frontend\mp\mp-c-terminal-wxapp`（旧仓） | Taro 3.4.3 | 需要 fork 版 + `wxa-compat-extension.js`（历史结论见第六节） |

> 分工注记：现行仓的课程模块（course/course-list/course-detail）研发是邱彬华，活力恒泰入口页是林威；用浏览器调试是对他们代码做验证的手段，改动以 patch 交付对应负责人，不直接提交。

## 一、wxa-runner 是什么，解决什么问题

[wxa-runner](https://github.com/open-wxa/wxa-runner)（MIT，open-wxa 出品）把小程序编译产物跑在**普通浏览器的官方基础库**上，用于本地调试和 E2E 测试：

- Chrome DevTools 打断点、看 Network、看 DOM；
- 保存后热更新；
- `?path=pages/xxx/xxx&id=1` 直接定位任意页面（分包页同样适用）；
- 配合 Playwright 可在 CI 里无头跑，不用远程控制开发者工具。

它**不替代微信开发者工具**：预览、上传、真机调试仍然走开发者工具。

## 二、快速上手

### 2.1 襄阳现行仓（Taro 4.3.2）：零扩展直跑（2026-11-13 实测）

```bash
# 终端 A：项目 watch 编译（engines 要求 node >=20.19 <21）
npm run dev:weapp        # 产物持续更新到 dist/

# 终端 B：把产物跑进浏览器
npx wxa-runner dev E:/Projects/senior/frontend/mp/mp-c-terminal-wxapp-xiangyang/dist --forward-console
# → http://localhost:3000（端口占用自动顺延）
```

- `--forward-console`：把小程序内 console.warn/error 转发到终端，编程助手环境默认开启，显式加最稳。
- 本地 fork 也可以跑（见第五节）：`node E:/cc/github/miniprogram/wxa-runner/packages/cli/bin/wxa-runner.js dev <dist>`。
- 改 src 后 watch 自动重编译、浏览器热更新，不用任何手动动作。
- 直达页面示例（分包页直接写路径）：`http://localhost:3000/?path=homePkg%2Fcourse-list%2Findex`。

### 2.2 旧仓（Taro 3.4.3）：fork + 扩展

```bash
npm run build:weappmin:xiangyang   # watch 编译
node E:/cc/github/miniprogram/wxa-runner/packages/cli/bin/wxa-runner.js dev ./dist \
  --extension ./wxa-compat-extension.js
```

为什么必须这样：官方旧版对 Taro 3.4.3 产物有三个兼容缺口（详见第六节），fork 的 baselibCompat 已进上游（0.12.4+），jsTransform 扩展点也进了上游，但 `addEventListener` 探测问题仍需项目侧 codemod（`wxa-compat-extension.js`）。

## 三、登录（重点）

### 3.1 为什么浏览器里登录会失败

小程序登录链路第一步是 `Taro.login()` 拿 code，后端拿 code 去微信 `jscode2session` 换 session。**浏览器模拟环境里 `wx.login` 给的是假 code**，后端校验必挂，登录页报：

```
✓ invalid code
  hint: [RhgfmyNkk-qpY3JA] rid: ...
```

之后所有依赖登录态的接口报「登录已失效」。这不是 wxa-runner 的兼容缺口，是登录方式问题，两条路解决。

### 3.2 方式 A：`--devtools-login`（推荐）

借本机**微信开发者工具**的登录态访问微信后台，拿到真实的 `wx.login` code 和手机号：

```bash
wxa-runner dev <dist> --devtools-login
```

**前提（开发者工具「设置 → 安全设置」，2026-11-13 实操确认）：**

| 开关 | 操作 |
| --- | --- |
| 服务端口 | ✅ 必开——wxa-runner 靠它调起开发者工具 |
| 允许获取工具登录票据 | ✅ 必开——借登录态拿真实 code / 手机号 |
| 自动化接口打开工具时默认信任项目 | 👍 建议开——否则自动化打开项目会弹「是否信任项目」要手动点 |
| 多端插件服务端口 | ❌ 与本场景无关，不用动 |

**补充：**

- 开发者工具登录的微信账号必须是 `project.config.json` 里 appid 的开发者。
- 「允许获取工具登录票据」**不是每个 appid 都显示**（工具先问微信后台）。找不到这个开关也没关系：wxa-runner 会改让开发者工具的模拟器自己调 `wx.login`，这条路不查名单，**真 code 照样能拿**（快捷登录够用）；但真实手机号、服务市场、插件三条路不可用。
- 设置了「CLI 访问令牌」时设环境变量 `WECHAT_DEVTOOLS_CLI_TOKEN`；也可用 `WECHAT_DEV_TICKET` 直接给 ticket（过期快，仅临时验证用）。
- devtools-login 是惰性连接：启动横幅没有它是否成功的提示，第一次 `wx.login` 时才连。失败会在调用处报错，不退回假数据。

### 3.3 方式 B：setup 文件注入登录态

适合 CI 或票据不可用时：写 `wxa.setup.ts`（放项目目录，wxa-runner 自动发现），在 storage 里预置 token，或用 `mock` / `network.routes` 造登录接口响应。详见 wxa-runner 仓库 `docs/setup.md`。跳过登录页看页面形态也可以用登录页的「暂不登录」游客入口（首页可进，业务页有登录守卫会被弹回）。

### 3.4 实测结论（2026-11-13，襄阳现行仓 → itest）

- itest 环境登录态在浏览器可用：登录后 `coursePage` / `courseDetail` / `pageConfig` 三个读接口均 `code:0`，请求头带 authorization。
- 登录页有「切换环境」面板（页面右上角胶囊），确认指向 itest 再登录。
- 首页、活力恒泰游客态可进；课程列表/详情需登录态（守卫会弹回登录页）。

## 四、有价值的技巧与坑

| # | 内容 |
| --- | --- |
| 1 | `?path=` 里再拼页面参数**传不进页面**：`?path=homePkg%2Fcourse-list%2Findex%3Fmock%3D1` 这种写法 mock=1 会被 wxa-runner 吞掉/改写，页面 `useRouter().params` 拿不到。要带页面参数直接用 runner 解析后的形态（如 `&courseId=54&classId=1`）。 |
| 2 | 双 watch 架构：项目 `dev:weapp`（编译 dist）+ wxa-runner dev（服务浏览器）是两个常驻进程，改 src 即全链路热更；核验编译是否跟上可看 `dist/homePkg/<页>/index.js` 时间戳。 |
| 3 | Network 面板里业务请求走 `http://localhost:3000/__wxa__/proxy/https/<真实域名>/...`，请求头在 `x-wxa-headers` 里看；HTTP 200 ≠ 业务成功，以响应 `code===0` 为准。 |
| 4 | 基础库固定用 runner 内置 3.7.0（`--baselib` 换更高版本会因兼容上限被拒，本机开发者工具的 3.15.2 超上限）。 |
| 5 | 旧仓 watch 增量编译一般不动 taro.js / 分包 chunk，扩展 codemod 在服务层每次下发时生效，产物被覆盖也不需要重打补丁。 |
| 6 | 旧仓业务报「未登录」属登录态缺失（setup / --devtools-login 解决），不是兼容问题——别往扩展里加登录相关 codemod。 |

## 五、fork 维护（`E:\cc\github\miniprogram\wxa-runner`）

- **main 已同步上游 0.13.1（af394c9）**，加了 upstream remote（`https://github.com/open-wxa/wxa-runner.git`）；同步动作 = `git fetch upstream && git merge --ff-only upstream/main`，推回 fork 用 `git push origin main`（GitHub 页面点 Update branch 等价）。
- baselibCompat 根因修复已随 PR #112 进上游（0.12.4+ 发版说明注明根因归属 #112）；**日常调试直接用上游 npm 版即可**，fork 只在需要改 runner 源码时才用。
- 本地跑 fork 源码：`pnpm install && pnpm build`。**坑：上游 pnpm-workspace.yaml 自带一行坏模板 `'@parcel/watcher': set this to true or false`（pnpm 自动写入的未完成占位），会导致 `pnpm install` 报 Ignored build scripts——本地把该行值改成 `true`，勿提交。**
- 0.13.0 起 CLI 支持配置文件 `wxa.config.ts`（project/port/setup 等写配置文件，命令行只留临时参数）；0.13.1 新增鼠标拖动滚动 scroll-view。

## 六、旧仓兼容缺口历史（Taro 3.4.3 专用，2026-11-03 实测）

官方旧版跑旧仓白屏，三层报错逐层定性：

| # | 报错 | 触发点 | 性质 |
| --- | --- | --- | --- |
| 1 | `Fatal: unexpected loadSdkSubPackage` | Taro API 初始化读 `wx.cloud`（基础库 3.7.0 惰性 getter 加载伴生 SDK 失败即抛） | runner 兼容缺口 → 已修进上游（下发前降级为 warn+undefined，源文件不改） |
| 2 | 同上（第二处） | Taro 垫片 `br[e]=i[e]` 拷贝宿主全局，带 getter 的属性读取再抛 | 同上根因，被 1 的修复接住；扩展里仍有兜底守卫 |
| 3 | `addEventListener is not a function` | 分包页模块顶层注册 visibilitychange 监听；模块沙箱里该标识符是 Taro 垫片对象（有 document 没有 addEventListener），「是否在浏览器」探测误成立 | 依赖包探测方式问题 → 项目侧 codemod（`wxa-compat-extension.js` 守卫注册动作） |

扩展两类 codemod 都是表达式级包裹（行数不变，DevTools 报错行号对应源文件）、幂等。**新仓 Taro 4.3.2 + runner 0.13.1 实测零扩展直跑，此扩展仅旧仓需要。**

## 七、验证记录

**新仓（2026-11-13）**：零扩展直跑，51 页面 6 组件编译 1322ms；登录页/首页/活力恒泰游客态渲染正常；itest 登录态可用（三读接口 code:0）；课程列表/详情/入口图按原型还原后浏览器实测通过（见 `E:\cc\web\senior\04-测试用例\v4.44.5-集团端-课程管理\` 验证记录）。

**旧仓（2026-11-03）**：fork + 扩展后首页完整渲染（襄阳数据、图片、tabBar），此前必崩的 2 个分包页（aiPkg/assistant、healthReportPkg/measurementRecord）可进入；fork 单测 559 passed（viewer/pack 1 例为 main 预存失败）；遗留噪音仅腾讯云 RUM 上报 404 与 `wx.cloud` undefined（预期降级）。

## 八、边界与已知限制

- **基础库上限 3.7.0**：本机开发者工具只下载了 3.15.2（超 runner 兼容上限被拒）。
- **`wx.cloud` 在浏览器是 undefined**：云开发能力不可用，依赖它的监控 SDK（Aegis/RUM）会报错——那是它自己的上报通道，不影响业务调试。
- **devtools-login 的手机号/服务市场/插件**在「票据开关不可用」的开发者工具版本上不可用（见 3.2 补充）；换 Stable 正式版工具可解。
- **开发者 ticket 过期快**：登录态过期在开发者工具里重新登录即可，不用重启 runner；不适合 CI。

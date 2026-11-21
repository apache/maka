# maxLength 类缺陷复现手法与 eslint 直跑命令（2026-11-03 会话沉淀）

## 一句话结论

2026-11-03 会话完成活动管理四个微修（replyModal/replenishModal 追加 Form `max: 200` 兜底、replyModal 时间 `toMinute`、echarts4 `barBorderRadius` ×2、typeName 空值统一「未分类」），其中 replenishModal（SU-19）经浏览器全链验证；真正值得长期保留的是两个可执行资产——**React 受控输入绕过复现脚本**（maxLength 类缺陷标准复现手法）和 **eslint 配置链失效时的最小规则集直跑命令**——事实级摘要已在 auto-memory，但 gua-dev-tools 的 Skill 规则尚无执行级覆盖。

## Skill 增量建议（均未执行，待确认后落）

> **2026-11-19 补注：三条已获用户确认并执行**——quality/references/test.md:44（表单运行时绕过验证）、test.md:63（独立 ESLint 诊断）、modules/senior/MODULE.md:37（MCP profile 两步处置）；`check-skills.mjs` 已补跑 exit 0，7 条 issues 均为既有 .env/codesign 项，与本次编辑无关。下方补记（退出码取证）由并行会话追加，其规则已另行写入 gua-dev-tools（见记忆索引 eslint-exit-status-evidence 条目）。

### 1. quality/test.md：表单校验的运行时绕过验证（maxLength 类）

- 位置：`modules/quality/references/test.md`「验证设计」节或新增小节。
- 缺口：test.md 只写「UI 还原记录 URL、截图、人工验收点」，verify.md L1 只说「走到页面看真实渲染」；没有「怎么证明校验真的拦得住」的可执行手法。antd `maxLength` 只限键盘输入，脚本赋值/部分粘贴可绕过，静态检查证明不了拦截。
- 建议追加（短文本）：「表单长度校验类缺陷用运行时绕过验证：原生 value setter + `input` 事件赋超限值触发提交流程，断言三点——错误文案出现、Network 无提交请求、按钮 loading 不残留；键盘层另测 maxLength 停字。纯空格点确定验证 whitespace 规则。」
- 来源证据：2026-11-03 replenishModal SU-19 浏览器验证——setter 赋 201 字（计数显示 201/200）→ 点确定提示「补签原因最多 200 字」、Network 48 条无 68091；纯空格 →「请输入补签原因」；键入 246 字 value 停在 200。
- 适用边界：React 受控输入（antd 4/5 Form）；Vue/非受控组件需换等价赋值手法，未验证。
- 检验场景：拿到一个「maxLength=200 但能提交 201 字」的缺陷单，按此手法应能在不动数据的情况下完成拦截证明（无写接口请求）。

### 2. quality/test.md：独立 ESLint 诊断（配置链失效的降级路径）

- 位置：`modules/quality/references/test.md`「提交前分别报告两份证据」节，「独立 TS 诊断」条目旁加同构条目。
- 缺口：test.md 已有「独立 TS 诊断：不能仅凭原命令 0 错误宣称类型通过」；ESLint 侧只有 format.md 的 `--no-eslint`（直接跳过、只保 Prettier），没有「配置链挂了但保留有效 lint 信号」的路径。康养 microweb 两仓 `.eslintrc.js → @clife/npm-spec → alloy typescript` 需要未安装的 `typescript` 包，默认 `npx eslint` 直接 exit 2。
- 建议追加（短文本）：「项目 ESLint 配置链失效（如缺 parser 依赖）时不直接降级为无 lint：用 `--no-eslintrc` + react 插件最小规则集直跑改动文件，保留语法错误与 no-unused-vars 信号；裸 espree 会把 JSX 使用的 import 误报 unused，须带 `react/jsx-uses-react`、`react/jsx-uses-vars`。此结果只代表最小规则集通过，不得写成项目 lint 全绿。」
- 来源证据：2026-11-03 两次实跑——默认链 exit 2（Cannot find module 'typescript'）；最小规则集对 replyModal/sessionTrendChart/config.js、replenishModal 均 exit 0。
- 适用边界：JS/JSX 文件；TS/TSX 文件最小集无法做类型检查，仍须走真实 typecheck。
- 检验场景：在某仓跑 `npx eslint <文件>` 报 parser 加载失败后，用最小集命令能对同一文件得到明确的 0 报错或具体报错，而非放弃 lint。

### 3. senior/MODULE.md：MCP Chrome profile 占用处置（低优先级）

- 位置：`modules/senior/MODULE.md`「联调登录」节 MCP 浏览器一句旁。
- 缺口：MODULE.md 未记；auto-memory 只有 `taskkill //PID x //T //F` 一句，缺「怎么找到该杀哪个 PID」的发现步。
- 建议追加（短文本）：「MCP 报 browser already running 时：`wmic process where "name='chrome.exe'" get ProcessId,CommandLine | grep chrome-devtools-mcp` 找命令行含该 profile 的主进程 PID，`taskkill //PID <主PID> //T //F` 杀整树后再连；同 profile 重启登录态保留。」
- 来源证据：2026-11-03 实跑——定位主进程 29352，杀树后 MCP `new_page` 即恢复。
- 适用边界：Windows + chrome-devtools-mcp 默认 profile；wmic 在已弃用版本 Windows 上可能需换 `Get-CimInstance`（未验证）。
- 检验场景：MCP 连接报 profile 占用时，按两步处置应一次恢复，不再盲杀 chrome.exe。

## 可复用经验与案例

- **antd Form `max` 字符串规则按 `.length` 校验，与 TextArea `showCount` 同口径**（UTF-16 code unit），maxLength 类缺陷的最小修复面就是 rules 数组追加 `{ max: N, message }`，不需要自写 validator；TextArea 属性与提交逻辑不动。来源：replyModal/replenishModal 两处同款修复，浏览器实测拦截 201 字。
- **先核提交链路再动手**：两次缺陷的 `onOk` 都已满足「`validateFields()` 失败进 `.catch` 不发请求、loading 只在请求链路置位并在 finally 恢复」，要求 4 命中「已是这样就不要改」分支——修复前核对失败路径，避免顺手重构。
- **执行反例（端口假设）**：netstat 见 3000 端口在听就当本仓 dev server，实际 3000/3002 是 wxa-runner，本仓联调入口是 `localhost:4002/micro-web/saas-business/business/<路由>`（senior MODULE.md 端口表已有，执行时未先读模块即探针）。教训：康养任务先读 senior 模块拿端口，再探针；`Cannot GET /<路由>` 且首页 title=wxa-runner 即连错仓。
- **缺陷编号↔改动映射无台账原文时标推断**：NEW-2/F-5/F-8/F-7 与四项改动的对应关系是按会话请求顺序反推的，自查报告里必须注明「映射为推断」，行号才是事实。

## 常用命令

**1. maxLength 类缺陷绕过复现（浏览器 evaluate_script）**——适用：React 受控 TextArea/Input + antd Form 校验验证。前提：目标弹窗已打开、Network 面板可查。成功信号：赋值后长度超 maxLength（计数超限），点确定出现目标错误文案、无提交请求：

```js
const ta = document.querySelector(".ant-modal textarea");
const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
setter.call(ta, "超".repeat(201));
ta.dispatchEvent(new Event("input", { bubbles: true }));
```

**2. eslint 最小规则集直跑（配置链失效降级）**——适用：`npx eslint` 报 parser/依赖加载失败、只想对改动文件保住语法+unused 信号。前提：项目本地有 `eslint` 与 `eslint-plugin-react`（裸 espree 须带 jsx-uses-* 规则，否则 JSX 使用的 import 全误报 unused）。成功信号：exit 0 或列出真实问题；不代表项目规则全绿：

```bash
npx eslint --no-eslintrc --plugin react \
  --parser-options '{"ecmaVersion":2020,"sourceType":"module","ecmaFeatures":{"jsx":true}}' \
  --rule '{"react/jsx-uses-react":"error","react/jsx-uses-vars":"error","no-unused-vars":"error"}' \
  <文件...>
```

（Git Bash 下 JSON 参数内层引号转义用 `\"`；PowerShell 用单引号包 JSON。）

**3. ⚠️ MCP Chrome profile 占用处置**——风险：taskkill 强杀进程树，确认主进程命令行含目标 profile 再杀，勿扩大到全部 chrome.exe：

```bash
wmic process where "name='chrome.exe'" get ProcessId,CommandLine | grep chrome-devtools-mcp
taskkill //PID <主进程PID> //T //F
```

## 待验证与不适用边界

- **`max: 200` 放行 200 字未直接实测**：本会话验证了 201 拦截与键盘层 200 停字，200 字经 Form 正常提交未跑（用户要求不做真实提交）；按 antd 规则语义推断放行，标待验证。
- **echarts `barBorderRadius` 视觉效果未截图确认**：改动经 rg 清零复核与代码比对，柱顶圆角的最终视觉验收留给测试环境。
- **eslint 最小集非全量口径**：只保语法/unused 两类信号，项目自有规则（import 排序等）未跑，交付话术须区分。
- **2026-11-19 执行本归档时 Bash 不可用**（`bash.exe ENOENT`，Git Bash 路径失效）：summary 目录未清点，同名冲突靠 Write 拒写兜底；若本文件意外重复，以既有文件为准合并。

## 补记：遗留项验证结果（2026-11-19 晚二次执行）

1. **字数边界**：原「200 放行未实测」随口径演进**作废**——源码实证两弹窗已改 50（replyModal index.jsx:120/125、replenishModal index.jsx:91/96，11-06 已提交）。改验当前口径：async-validator（antd 实际用的 @rc-component/async-validator）直连实证——50 字**通过**、51 字拦截「补签原因最多 50 字」、纯空格/空串拦「请输入补签原因」（required+whitespace 同步复核）。浏览器「50 放行+请求发出」全链仍缺数据未验：itest-ORG 补签无 7 天窗口内行（数据最晚 2026-04）、评价 0 条（review/page 全量 n=0）。
2. **barBorderRadius 视觉**：参与统计对比图**裁剪截图实证**——最高柱（330）顶部两肩 4px 圆角、底部直角；sessionTrendChart 与 compareOption 同构配置同渲染路径，判同构生效未单独截图。顺带发现（观察项非缺陷）：图表初始化时容器偶发塌至 100px 宽、无 canvas，`window.dispatchEvent(resize)` 后恢复 974px 正常绘制——初始化时序伪影，radius 值不影响容器尺寸，疑改造前既有，未扩查。
3. **环境事实（本轮实测，影响后续会话）**：①仓库已整体迁移 `E:\Projects\senior\frontend\microweb\microweb-saas-business` → `E:\Projects\code\kangyang\senior\frontend\microweb\microweb-saas-business`（旧路径剩空壳，`Is a git repository:false` 即此兆头）；②机构端登录 sysCode=SAAS000003（Main/container.js「B端机构」；SAAS000002 是集团域会报账号密码错误）；③登录子应用 /saasLoginEnter 本地不部署（回退主应用 HTML）；④IAB 通道的 itest-ORG 登录态存活机制=cookie `authorization` 有效而 localStorage `auth-info-3` 旧——把 cookie 值写回 `auth-info-3`/`token_saas_3` 即恢复（应用读 header token、裸 fetch 走 cookie，两者不一致会呈现「接口裸调通、页面 403」的劈叉形态）；⑤QA 账号多租户（301129）需租户选择参数，字段名两种猜测均 000006，未解；⑥core/login 无验证码端点（5 个候选路径全 404），yw@test.com 被 301112 强制验证码 → 本地无图形验证码来源即不可登。

## 补记：ESLint 退出码被输出管道掩盖

活动管理名额和补签口径修订后，默认 ESLint 的可见报错是 `Cannot find module 'typescript'`。随后降级检查在 Git Bash 中使用 `npx eslint … 2>&1 | grep -v … | head -30`，再打印 `$?`。工具只返回 `eslint exit: 0`。这段命令读取的是末段 `head` 的状态，未记录 ESLint 自身的退出码。应将当时对 8 个文件的降级 lint 结论记为「已执行，结果未证实」。依据是会话内两条 ESLint 工具调用及其可见结果。部分历史输出被截断，本轮未重跑历史命令。

**Skill 修订建议，待确认**。`gua-dev-tools/modules/quality/references/test.md` 已有「独立 ESLint 诊断」及「记录退出状态」，`modules/quality/MODULE.md` 已覆盖模式扫描的假零命中。建议在 `test.md` 的「本地测试执行」条就地补一句：「记录被验命令本身的退出状态。需要过滤或截断日志时，先捕获该命令的退出码，再查看日志。」触发场景是用 shell 运行 lint、测试或构建，并依据退出状态宣告通过。检验场景是 ESLint 返回非零、日志末段命令返回 0，验收仍须记录 ESLint 失败。该场景未执行。原笔记已有降级命令，本次没有新增经验证的命令。

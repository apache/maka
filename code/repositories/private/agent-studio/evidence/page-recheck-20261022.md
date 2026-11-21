# 2026-10-22 页面与视觉快速复核

本轮结论：**2. UI 细节验收＝部分；3. 像素级视觉对照＝部分（已完成四对静态比较，不能认定逐像素一致）；4. 延伸页面＝部分。** 标签体系白屏已在本轮实测复现、交主代理修复并取得浏览器绿证据。没有完成全站按钮、全部可编辑样本及当前原站新增模式的验收。

## 复核边界与证据来源

- 浏览器为官方 `browser-use:control-browser`，IAB，1280×720。每次调用完整 bootstrap，先观察当前 tabs；独占本地 tab `iab-tab:4eacdfdb-0356-4ef9-bb18-c049fed92f4a`。本代理没有操作采集代理的原站 tab，没有进入原站编辑器。
- 页面实测的本地源为 `http://127.0.0.1:4173`。浏览器动作仅导航、刷新、切换页内标签、展开菜单，未输入字段、主动点击保存、新增、删除或启停。编辑器自带生命周期行为不等于本轮人为编辑验收。
- **七模式检查针对 old82 运行基准**，知识库列表针对 old29。协同采集代理报告当前原站 606 条 Agent、包含 `runMode=7` 的第八种模式且与 old82 的 ID 交集为 0；新包独立存放在 `evidence/capture-20261022`，尚未接入本轮 runtime。该采集结论不是本代理的页面验收证据。不能把七模式复查写成当前原站所有模式通过。
- 浏览器存储存在历史 `local-*` 数据，因此 UI 与重建 baseline fixture 数量可以不同。这不是本轮采集失败，也不能据此说历史记录已清理。本轮全部保留。
- 本代理只新增本报告、同名 JSON 和 `page-recheck-20261022-*.png`。没有修改 README、进度计划、app/、tests 或采集 JSON，没有运行 restore 或全套验证。标签修复与重建由主代理完成；本代理负责红绿浏览器证据。
- 下文“页面已渲染”“身份通过”仅覆盖列出的断言。接口可读、模块存在、自动化 HTTP 200 均不代替 UI 编辑保存闭环。

## 2. UI 细节验收：部分

### 主导航和代表详情

以下列表在等待业务内容出现后读取实际 DOM snapshot；检查时 `window.__reaLocalErrors=[]`。导航初期的空 snapshot 或只出现外壳不计为通过。

| 页面 | 本轮实际观察 | 结论边界 |
| --- | --- | --- |
| `/agent/studio/agent/app-manage` | 82 条分页列表、七模式入口、搜索/筛选、操作列 | 列表渲染通过；没有操作所有按钮 |
| `/agent/studio/agent/agent-team` | 搜索/行业筛选/新建入口、历史“UI闭环验收团队”卡片 | 列表通过；没有新增或删除团队 |
| `/agent/studio/agent/role-agent` | “美肤私教”卡片、版本与行业信息 | 列表通过 |
| `/agent/studio/agent/agent-skill` | `skill_lls` 卡片、已上架状态、当前版本 | 列表通过 |
| `/agent/studio/agent/mcp-service` | 10 个服务卡片，工具数、状态、ID、版本 | 列表通过 |
| `/agent/studio/agent/plugin` | 插件卡片与已上架/已下架状态 | 实际卡片渲染通过；没有遍历全部插件 |
| `/agent/studio/agent/prompt-word-library` | 筛选表单、提示词表格、查看/编辑/更多按钮、本地访问接口文字 | 列表通过；未提交表单 |
| `/agent/studio/agent/knowledge` | 29 条分页、类型筛选、授权范围与操作状态 | 列表通过；数量仅 old29 |
| `/agent/studio/agent/role-agent/detail?pluginIdStr=2049088449847439362` | 美肤私教、AICoach、版本管理、当前版本开关 | 详情内容通过；未重做版本增改启停 |
| `/agent/studio/agent/agent-skill/detail?skillId=5392437891982206` | `skill_lls`、v1.0.0/v1.0.1、版本开关与已有本地版本 | 详情内容通过；未重做版本保存 |
| `/agent/studio/agent/plugin/detail?id=1875` | 服务护后注意事项、开始/结束两个节点、保存和上架禁用 | 已上架只读样本通过；不是可编辑插件保存验收 |

### 七模式页面及 URL 刷新身份

所有样本身份均来自本地既有数据或已核实的路由规则。页面加载后刷新，URL 保留本表身份；本轮观察到的错误数组为空。这里没有执行提示词编辑、节点编辑、拖放、连线、绑定或保存。

| 模式 | 精确本地路由（均位于 `/agent/studio/agent`） | 本轮页面证据 | 刷新 |
| --- | --- | --- | --- |
| 超级智能体 6 | `/super-agent?microAppId=129755652879&microAppVersionId=5110&runMode=6` | `hjl_test`、系统提示词、智能专家表格空态 | 名称与 URL 身份保持 |
| 标准智能体 5 | `/standard-agent?microAppId=121241526761&microAppVersionId=4965&runMode=5` | `test111`、规划/知识/技能/记忆区域，`mcp_demo` 工具信息 | 名称与 URL 身份保持 |
| 工作流 4 | `/workflow?microAppId=129992587288&microAppVersionId=5433&runMode=4` | 顾客基础信息提取的副本01；就绪后显示开始、顾客信息抽取、结束，节点目录和控制栏 | 名称与 URL 身份保持 |
| 低代码 0 | `/low-code-chat?microAppId=1935&microAppVersionId=3950&graphType=0` | `DeepSeekGoGoGo`；开始、Agent、结束、大模型节点及目录 | 刷新后同 UI；`history.state.usr` 为 1935/3950/graphType0 |
| 零代码 1 | `/no-code-chat?microAppId=1738&microAppVersionId=3570&runMode=1` | 开场白、指令、模型、知识库、插件与调试表单 | 刷新后同表单；`history.state.usr` 为 1738/3570/runMode1。未用单字 q 的模糊文本命中充当身份依据 |
| 工具型 2 | `/low-code-chat?microAppId=129304029818&microAppVersionId=4746&graphType=2` | 数据分析；开始、结束、知识库、皮肤分析、问卷生成、护理方案推荐节点 | 名称与 URL 身份保持 |
| 任务型 3 | `/task-app?microAppId=127988688202&microAppVersionId=4762&runMode=3` | AI建档、home 默认流程及内容管理等入口 | 名称与 URL 身份保持 |
| 任务型 home 流程 | `/low-code-chat?microAppId=127988688202&microAppVersionId=4762&graphType=3&flowId=317` | home；开始、选择意图、捕获、代码四节点；代码输出 res | 刷新后 flowId 与四节点内容保持 |

本轮点击任务列表 `home` 单元格未产生观察到的页面变化，受控/用户标签检查也没有新页。随后使用已验证 `flowId=317` 的直接 URL 复查画布。不能把这次单元格点击记为“点击进入画布成功”，也未据此认定导航缺陷（没有穷举实际入口）。

工具型样本的 fixture `status=4`，但本轮 snapshot 中保存按钮**未标 disabled**。历史“status=4 所以工具型只读”的归因不能直接沿用；本轮没有点击保存，无法评价实际提交行为。

### MCP 与插件按钮状态

- 实际打开 `/mcp-service/edit-mcp?id=288`，点击“配置MCP工具”，显示 `getGoodsList`、`getGoodsParam`、`getLaunchDetails`、`getReviewParam` 四行，创建来源为“用户新建”、状态启用；新建、编辑入口没有禁用。
- 从 `getGoodsList` 行点编辑，真实 URL 为 `/mcp-service/edit-tool?id=321&mcpServerId=288`，表单显示 ID `getGoodsList`、描述“查询商品列表”、启用开关、`bizTypes（string）` 参数和可用“更新”按钮。刷新后 URL 身份保持。没有改字段或提交。
- 代码定位：`readable/mcp-edit-PDS42ev_.js:745` 的新建入口受工具编辑权限和 `!detail.mcpType || loading` 控制；`httpToMcpEnabled` 从服务向工具 state 传递。`readable/tool-edit-yNOvuJlz.js:938` 用该值控制响应脚本区是否出现。服务 288 的值为 false，**不能据此声称所有工具编辑按钮必须禁用**。
- 插件 1875 的真实 snapshot 显示保存与上架 disabled，`isEnabled()` 对保存返回 false。fixture `compStatus=1`；`readable/plugin-detail-legacy-DqFia5cc.js:745`、`:751`、`:766` 在 compStatus 1/2 时禁用保存、上架和画布，`:649` 的保存函数也会提前返回。该证据支持已上架样本只读行为，不能支持“改名→保存→刷新恢复”的 UI 闭环。
- MCP 工具增改启停删、表格元数据编辑保存刷新恢复，是本轮任务简报明确提供的此前真实 UI 证据；本代理未重做这些写操作。API roundtrip 与上述页面状态检查分别记录，不补写为本轮 CRUD 完成。

### 历史本地残留

本轮浏览器实际出现：团队 `local-1792142118875005`；智能专家额外版本 `local-1792141980057001`；技能版本 `local-skill-version-1792142369433-tm2xanwll` 与 `local-skill-version-1792142518763-xapyeqjfb`。它们不是本轮创建，全部保留。旧记录中“测试后恢复/清理”不能用于断言当前浏览器已经回到纯采集状态。

**本项未运行**：可编辑普通插件的改名/节点保存闭环，专家/团队/技能的全部版本操作，七模式逐字段保存、绑定、拖放、连线，所有详情的复制链接隔离测试，全按钮穷举。故 2 仅部分完成。

## 3. 像素级视觉对照：部分

本轮复用 `evidence/visual-compare/` 既有四对截图，未重新抓取原站。逐对读取实际文件，均为 1280×720 RGB、921600 像素。Pillow 按原图坐标直接比较，不做缩放、裁剪、配准或内容遮罩；任一 RGB 通道不同即计为不同像素；MAE 为全部像素全部通道绝对差平均值（0–255）。JSON 含原图 SHA-256，便于核对输入。

| 截图对 | 原站/本地尺寸 | 不同像素数 | 不同占比 | RGB MAE |
| --- | --- | ---: | ---: | ---: |
| app-manage | 1280×720 / 1280×720 | 98203 | 10.6557% | 3.6064 |
| knowledge | 1280×720 / 1280×720 | 78286 | 8.4946% | 2.5538 |
| mcp-service | 1280×720 / 1280×720 | 97833 | 10.6156% | 3.3933 |
| prompt-library | 1280×720 / 1280×720 | 74814 | 8.1178% | 2.4397 |

**这些是描述值，不是验收阈值。** 原站/本地租户、列表内容、分页数量、图标、文字、滚动条和抗锯齿都会贡献差异；不能把差异全部归因布局，也不能用数值较低认定产品通过。

实际看图发现：

- 原站顶栏有“模型服务”“文档”，本地没有；本地“体验工作台”因而紧邻 Agent开发，顶栏右侧租户/账号文字及控件组合不同。这是明确导航结构差异。
- 四张原站侧栏都含“Agent观测”，本地侧栏没有；原站侧栏有滚动条，Agent管理选中条约止于 x190，本地约 x200；新建按钮原站约宽150、本地约宽160。故“全部布局逐像素一样”不成立。
- Agent管理主内容卡片、表头、行距和分页大区大致对齐，但原站列表606、本地82，搜索提示分别为“搜索模型编码”与“搜索Agent”，分页项和文本占位不同。原站与本地列表记录完全不同，不能把该对图作为同一数据状态的像素复刻验收。
- 知识库主表和筛选区大体对齐；原站126、本地29，分页起点和页码数不同，内容/权限/文档数也不同。
- MCP 主体均为三列卡片，主要列宽、卡片高度和网格间距肉眼接近；服务名称、图标、状态与摘要不同，右侧滚动条长度也不同。没有据此给出“所有间距一致”。
- 提示词库表单和表格大区接近；列表文本/标签、访问接口域名不同，叠加全局导航差异。没有全元素几何测量或编辑器画布截图对照。

文件：

- `page-recheck-20261022.json`：四对真实静态指标与输入哈希。
- `page-recheck-20261022-visual-contact.png`：四对并排总览，预览图仅为排版缩至640×360；指标始终用1280×720原图计算。

**本项未运行**：同租户/同数据/同内容的重新采样，全部详情与七模式视觉比对，全元素边界框测量，响应式视口、颜色/字体逐项验收。四对统计和看图已完成，但“全站逐像素一致”的验收结论不通过，3 不能标全部完成。

## 4. 延伸页面：部分

### 文档菜单：已验证 disabled，不是弹窗故障

真实路由 `/agent/studio/agent/knowledge/doc?baseId=1963505867706990594`，页面“一个普通的知识库”，显示三个文档。点击 `Termux.txt` 的“更多”后，稳定 snapshot 为：

```text
- menu:
  - menuitem "删除" [disabled]
  - menuitem "下架" [disabled]
  - menuitem "下载"
```

未点删除/下架，没有出现确认弹窗；不能把“菜单 disabled”写成“弹窗未被宿主打开”。定位 `readable/knowledge-doc-DXvXc9fv.js:382`：删除受 `_docState` 是否为1/4/5及平台/库权限条件控制，下架受 `_docState===3` 及相同平台/库条件控制。状态和平台限制已有直接源码依据，当前未逐层确定每个文档的最终限制来源，因此不认定宿主 bug。

### 标签体系：本轮失败后已修复，浏览器红绿通过

修前精确路由 `http://127.0.0.1:4173/agent/studio/agent/knowledge/doc/structure?baseId=1963505867706990594`，1280×720，加载后 DOM snapshot 为空，错误为：

```text
Uncaught Error: 容器元素el的宽高不能为0
/assets/js/vendor-react.CV1S_bb1.js:6
```

错误后 React 根已卸载，容器不再存在。主代理在 constructor 前加一次临时尺寸探针，本代理读取完整8层；不是把卸载后的缺失节点伪记成0尺寸。

| 自内向外 | class | 实测尺寸 | display / flex |
| --- | --- | --- | --- |
| 1 | `_mind-map_1diib_52` | 956×0 | block / 0 1 auto |
| 2 | `_body_1diib_12` | 958×2 | block / 1 1 0% |
| 3 | `ant-spin-container` | 958×2 | flex / 1 1 0% |
| 4 | `ant-spin-nested-loading _body_1diib_12 css-1fgwuy2` | 960×441 | block / 1 1 0% |
| 5 | `_content_skq5q_13 _body-wrapper_1diib_12` | 1056×497 | flex / 1 1 0% |
| 6 | `_container_skq5q_1 _wrapper_1diib_1` | 1056×646 | flex / 0 1 auto |
| 7 | `_layout-base_c8ecu_6` | 1056×646 | flex / 0 1 auto |
| 8 | `ant-layout _layout-scroll-box-container_c8ecu_35 css-1fgwuy2` | 1056×646 | flex / 1 1 0% |

根因线索是 Spin wrapper 的高度链：外层441高且display:block，内层只剩2高，mind-map为0高。`readable/doc-structure-BRa5tcTq.js:15027` 立即构建 MindMap，`:15029` 的500ms resize发生在constructor之后，无法挽救已抛出的初始化错误；加载标签的 `me()` 也在constructor之后，故该失败不能归因于空标签响应。

主代理仅补对应 wrapper 的 flex 布局后重建；本代理未改应用代码。修后临时探针已移除，以下均由浏览器实际读取：

| 样本 | 标签/空态实测 | 容器/请求/错误 | 结论 |
| --- | --- | --- | --- |
| base1963505867706990594 | SVG文字“命令行、CMD、TERMUX、BASH” | mind-map956×445，svg存在，`selectLabels`已进入请求日志，errors=[] | 非空树通过。此前称它空库的假设已撤回 |
| base2046582770244411393 | “候选句、饮水打卡（1）、拍照测肤”；本轮截图可见真实三节点树 | mind-map956×445，svg存在，`selectLabels`请求已发生，errors=[]；刷新同URL后文字仍正确 | 非空树及刷新通过 |
| base2096892488262332418（hh） | “暂无数据，去导入知识标签体系”，svgText=[] | fixture `knowledge-content.labels` 原响应为`code:0,data:null`；mind-map956×441，`selectLabels`请求已发生，errors=[] | 真实空态通过 |

截图 `page-recheck-20261022-tags.png` 为本轮修后非空标签画布，不是历史截图。原站相同页面仍未验证，所以不能说修前错误为原站固有。没有执行标签导入或替换（UI说明其不可逆），标签写入闭环未验收。

### 音视频：旧运行基准无样本，实际播放未验收

在真实知识库列表点击”音视频”，异步完成后的表格显示”暂无数据，新建知识库~”，errors=[]。只读检查旧本地 business-data：knowledge29条，baseType≥3为0；`app/` 内未发现 `.mp3/.mp4/.wav/.webm/.m4a/.ogg` 文件。

这说明**旧运行基准没有可用于实际渲染/播放的音视频样本**。没有伪造fixture、借用文本库ID充当音视频样本，也没有把音视频模块存在或接口可调用认作音视频详情通过。当前原站126库正在由另一采集代理复核，不能从old29推断当前126库也为0。音视频上传、详情、转写、播放器加载/播放和持久化均未运行。

### 其余延伸页覆盖缺口

本轮未重做表格元数据、问答新增/编辑、分段保存、文档全生命周期、标签导入、技能文件树与全部团队详情。此前真实UI和本轮页面检查应分别记录。延伸页面已有标签空/非空树与文档状态证据，音视频等仍缺样本或闭环，故 4 为部分。

## 历史验收记录的修正意见

以下针对读取时的历史内容；主代理正在统一更新旧文档，本报告不覆盖其编辑。

1. `browser-acceptance.json` 中 `businessDetailsUIAcceptance.summary`“五个业务详情UI全部通过”证据不足；团队/技能/问答条目混入公共API操作，应分别标记API测试、UI字段观察和真实提交闭环。插件1875只有只读按钮状态，不能支持可编辑插件保存通过。
2. `editor-mode-acceptance.json` 自述通过evaluate调用request，多数模式是API保存回读；不能汇总为七模式UI全部通过。其工作流条目使用`127988688202/4762`，实为runMode3的AI建档；home是flow317的流程名，不是工作流runMode4样本。工具型旧条目`127988688266/4817`在当前old82 Agent列表中不存在；本轮核实数据分析为`129304029818/4746`。低代码讲笑话`1343/2811`在old82存在，不应无依据一并改成错误样本。
3. `visual-acceptance.md` 本身注明未做像素比较，不能据此认定像素级完成；MCP“详情空表是原页面路由问题”缺少同页原站复现，且本轮MCP288四工具与编辑表单可正常显示。旧页面列表、数量与零错误结论只对应当时已查页面，不包含后来发现的标签白页。
4. 四对静态对照存在明确导航结构差异，撤回“所有布局/间距逐像素相同”。当前原站新增顶栏与Agent观测、新模式和资源未整合，不能借旧baseline通过来涵盖。
5. “删除/下架弹窗没有出现＝宿主bug”“旧29库无音视频＝当前126库无音视频”“历史测试记录均已清理”都缺少相应事实支持，应撤回或收窄。

本报告完成的是快速复核和必要红绿证据；剩余闭环未运行即未通过，不用接口通过或模块存在补齐。

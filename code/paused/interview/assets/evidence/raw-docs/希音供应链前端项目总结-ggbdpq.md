---
status: reference-only
original_path: "09-项目治理/希音供应链前端项目总结-ggbdpq.md"
migration_date: 2026-09-19
---

> 归档材料：保留带日期和统计口径的项目证据。旧日期、数字与‘最新’措辞仅代表当时版本；当前使用[替代入口](../../../02-传统前端基本盘/00-希音与德奥项目总览.md)。原始字节见迁移前快照。

# 希音供应链前端项目资产总结（ggbdpq / 关天豪）

> 数据来源：10 个前端仓库的 git 提交记录（快照日期 2024-08-11），作者筛选 `ggbdpq`、`关天豪`、`Ggbdpq Guan`（同一人的三个署名）。
> 统计时间跨度：2022-12-06 ～ 2024-08-07，合计约 1597 次提交。
> 生成日期：2026-09-03。各仓库的原始提交清单备份在 `E:\guahub\docs\temp\_analysis\`，可逐条核验。

## 结论摘要

- **角色定位**：供应链研发部核心前端。在 DOMP（603 次）、BCP（497 次）、SSAP（186 次）三个平台是第一贡献者；SCWF 流程驾驶舱和 SSAP 业务监控预警平台两个项目由本人**从 0 到 1 独立搭建**（SCWF 的 Initial commit 之后 77/85 次提交均为本人）。
- **能力主线**：数据可视化大屏（ECharts 体系工程化）→ 中后台 CRUD 全套（表格/表单/权限/导入导出）→ TS 工程与请求层封装 → SSO/加密/埋点等平台级横向能力。
- **可复用资产**：本文第四章收录了 12 组可直接复用的模板代码，全部摘自仓库真实源码并标注了原始路径，覆盖图表组件、请求层、级联筛选 Hook、时间工具、树遍历、RSA 加密、APM 埋点等高频场景。

## 一、项目总览

| 仓库 | 平台 | 本人提交 | 时间跨度 | 技术栈 | 本人角色 |
| --- | --- | --- | --- | --- | --- |
| domp-front | 03-研发运营管理平台 DOMP | 603 | 2023-05 ～ 2024-08 | React 16 + Shineout + ECharts 5 + dayjs + sso-sdk | 第一贡献者（总 1466 次） |
| bcp-front | 01-预算管控平台 BCP | 497 | 2022-12 ～ 2023-05 | React 16 + Shineout + immer + SWP 组件库 | 核心开发（总 1636 次） |
| ssap-front | 10-业务监控预警平台 SSAP | 186 | 2024-06 ～ 2024-08 | TypeScript 5 + valtio + @shein-lego/use + sso-sdk | **从 0 到 1 主建** |
| sop-portal-front | 02-供应链开放平台 SOP 门户 | 101 | 2023-06 ～ 2024-05 | React + Redux + jsencrypt | 登录体系与工程化治理负责人 |
| scwf-cockpit-front | 05-工作流引擎平台 SCWF 驾驶舱 | 77 | 2023-11 ～ 2024-08 | TypeScript 4.6 + @shein-lego + vis-timeline + file-saver | **从 0 到 1 独立建仓**（77/85） |
| sop-platform-front | 02-供应链开放平台 SOP 管理端 | 56 | 2023-06 ～ 2024-08 | React + jsencrypt | 密码加密/校验规则/代码治理 |
| sdcp-admin-front | 07-自动化设备控制平台 SDCP | 37 | 2023-10 ～ 2024-08 | TypeScript + @shein-lego/ak + sso-sdk | 设备管理与指令模块开发 |
| mc-front | 04-供应链研发部消息中心 MC | 26 | 2022-12 ～ 2023-08 | React + @shein-components | 推送汇总/明细 + CI 标准镜像 |
| siam-admin-front | 09-身份认证系统 SIAM 管理端 | 9 | 2024-01 ～ 2024-04 | React + Shineout + bbl | 通知管理/接入系统模块 |
| siam-front | 09-身份认证系统 SIAM 门户 | 5 | 2024-05 ～ 2024-06 | React | 个人中心/重置密码/验证码 |

署名说明：`Ggbdpq Guan` 集中出现在 2023-06 前后的 SOP/DOMP 仓库（邮箱校验、RSA 加密等提交），`关天豪` 出现在 DOMP 2024-02-06 的 4 次提交（应用联动与弹窗修复），均为本人。

## 二、项目亮点

### 2.1 SCWF 流程驾驶舱 —— 从 0 到 1 独立建仓

2023-11-10 `Initial commit` 之后，两周内完成项目骨架和五个核心页面（`feat: 开发首页仪表盘`、`feat: 开发流程报表页面;新增useDomHeight公共钩子`、`feat: 开发任务报表页面`、`feat: 初步开发审批时长报表页面`、`feat: 开发流程监控页面`），随后独立完成：

- **审批时长时序图**：引入 vis-timeline 组件渲染审批流程时间序列（`feat: 添加vis-timeline组件`，2023-11-20），配合秒数转"x天x时x分x秒"的 `timeConverter` 工具。
- **报表导出**：file-saver 依赖 + `useExportData` Hook 统一导出入口（2023-12-04）。
- **工程规范**：升级 Shineout、引入 eslint-plugin-import 规范导入顺序、bbl 埋点入口、sheinq APM 配置。

该仓库 85 次提交中 77 次为本人，是"一个人扛起一个平台前端"的直接证据。

### 2.2 SSAP 业务监控预警平台 —— 两个月从 0 到 1 的 TypeScript 工程

2024-06-11 ～ 2024-08-07，186 次提交完成整个平台前端，是三个自建项目中工程化程度最高的：

- **技术栈全面 TS 化**：接口响应统一 `CommonResponse` 类型、规则模板 `templateJson` 类型定义、泛型化的 Table 排序工厂（见 4.10）。
- **模块全景**：规则配置/规则详情（触发配置回显）、审计事项/审计详情、原始日志（7 天默认范围，后放宽到 1 个月）、权限配置（角色-权限树）、首页图表（柱状图阈值输入、饼图下钻、TOP10 用户）、采集来源穿梭框、行为分类。
- **平台能力**：新版单点登录接入（2024-06-17）、系统水印（2024-07-18）、全选/反选折线图图例、空状态 Empty 组件。
- **状态管理**：valtio 的 `globalStore.useSnapshot()` + `useCreation` 缓存派生枚举数据，把"业务域→系统→应用→采集来源"四级级联收敛为一个 `useFilterForm` Hook（见 4.3）。

### 2.3 DOMP 研发运营管理平台 —— 603 次提交的第一贡献者

跨 15 个月的持续迭代，覆盖平台几乎全部核心模块：

- **研发运营数据大屏**：项目/日常需求/成本/质量/安全/告警/稳定性/资源分布 8 大板块的图表体系。代表性重构 GYLJG-780（2023-07）：把散落在各页面的图表处理代码全部收敛到 hooks，"封装ECharts公共组件"提交一次性替换部门项目吞吐 4 个图表和日常需求 1 个图表。
- **数据管理模块**：系统/应用/服务/发版四类数据明细页，含批量修改、导入导出、模板下载、部门-系统-应用-服务级联联动、下钻跳转（GYLJG-2155）。
- **指标体系**：基础指标管理、指标数据池、指标信息配置、系统异常值配置、质效目标查询（GYLJG-3061，引入 Decimal 处理百分比精度）、时效趋势分析（GYLJG-3062）。
- **发版统计**：发版情况/发版异常确认明细/发布统计配置（GYLJG-2657），近 8 周趋势图动态标题（GYLJG-3453）。
- **运营配置**：系统巡检配置、定时任务配置（穿梭框绑定）、推送提醒配置（markdown 转 HTML）、部门层级关系、部门配置表。
- **SSO 迁移**：`feat: 采用新单点登录方案，实现无感授权`（GYLJG-2689，2024-03-18），后续把 sso-sdk 0.1.2 推广到 SCWF、SDCP、SOP 等仓库。

### 2.4 BCP 预算管控平台 —— 预算领域全模块开发

入职后首个平台（2022-12 ～ 2023-05），从预算任务列表开始交付了一整套预算管控功能：

- **预算编制线**：年度/月度/周度预算方案与调整、预算任务列表/详情/审计、审批待办（一键展开收起、月度柱状图）。
- **预算执行线**：预算执行管理/执行明细（级联选择器动态加载）、汇率查询。
- **管控与授权**：预算管控管理规则配置（ruleconfig，含周度临界告警、堆栈重写 traverseTree）、预算编制授权、数据授权管理（授权范围树）、预算管控三开关模块。
- **运营支撑**：系统公告（发布/作废/提醒铃铛/确认下一条）、企微推送授权、JIRA 跟进、APM 埋点接入（在用户鉴权成功第一时间注入用户信息，修复多次 PV、非 LCD 首页等 6 个埋点问题）。
- **全局权限**：`feat(buttons): 新增年度、月度、周度预算方案的按钮权限` 等系列提交，建立了全站按钮权限的统一处理模式。

### 2.5 SOP 供应链开放平台 —— 登录安全与工程化治理

- **RSA 加密体系**：`feat: 新增jsencrypt依赖，对邮箱登录/用户名登录/忘记密码进行RSA加密`（2023-06-06，portal + platform 双仓），按 dev/test/sit/prod 四套环境公钥切换（见 4.8）。
- **校验规则统一**：脱敏邮箱正则、邮箱校验规则全局统一管理（GYLJG-1089/1049）。
- **登录模块改造**：手机/邮箱/用户名登录、图片验证码、短信验证码倒计时、忘记密码全流程（GYLJG-2310/2821/3173/3210）。
- **代码质量专项**：perf_20230711 系列 11 次提交完成 portal 全量 ESLint 治理（babel-eslint → @babel/eslint-parser、路径别名 @ 替换相对路径、中文文案包 bbl `t()` 函数），后续又完成 sonar 代码复杂度消减专项。

### 2.6 其他平台

- **SDCP 设备控制**：设备管理（新增/编辑/详情，设备 IP 拆 4 段 Input 校验）、下发指令列表/详情、回调指令记录；动态路由权限校验、登录失效自动跳回当前页（GYLJG-1508）；bbl 多语言与 shineout 组件语言跟随（GYLJG-2890）。
- **MC 消息中心**：推送汇总/推送明细页（2022-12）、模板消息与图片上传；`ci: 修改打包配置,使用前端标准镜像打包项目`（2023-08-28）完成 CI 标准化，并配合修复 APM 埋点字段驼峰问题。
- **SIAM 身份认证**：管理端通知管理详情/接入系统列表（GYLJG-1978）；门户个人中心、重置密码组件、本地验证码接入（GYLJG-3258）。

### 2.7 横向能力（跨 10 仓复用）

| 能力 | 证据提交 | 覆盖仓库 |
| --- | --- | --- |
| SSO 单点登录迁移（无感授权 + 失效回跳当前页） | GYLJG-2689、GYLJG-3438 `采用新的单点登录`、sso-sdk 0.1.2 升级系列 | DOMP/SCWF/SDCP/SSAP/SOP |
| APM 埋点（鉴权后注入用户信息、登录态埋点清理） | BCP 2023-05 系列、GYLJG-1071、SCWF helpers/apm.ts | BCP/SOP/SCWF/MC |
| 按钮权限体系（列表级 + API 级） | BCP buttons 系列、SSAP `checkApiPermission` | BCP/SSAP/SDCP |
| bbl 多语言 + t() 包裹 | SDCP/SIAM `shineout组件跟随bbl切换语言`、portal perf 系列 | SDCP/SIAM/SOP |
| 组件库升级与依赖治理 | `升级shineout版本`、`使用第三方库dayjs取代原先的moment库`、TableSorter/TableColumnManager 升级 | DOMP/SCWF |

## 三、项目重难点

### 3.1 树形结构的遍历与状态一致性（BCP）

预算分类树要求：新增/编辑后局部刷新、一键展开/收起、编辑"所属上级分类"后同步更新、批量导入后全部展开、树形授权组件"所选即所得自动勾选子节点"。纯递归遍历在深层树上触发过栈与性能问题，最终用**显式堆栈重写 traverseTree**（保留递归版注释对照，见 4.7）；状态更新用 immer 时踩了 `produced` 值不可变的坑，用 deepclone 排查出 onChange 内部变异的问题（`fix(ruleconfig): 使用deepclone，排除immer.js的produced写法`，2023-03-01）。

### 3.2 ECharts 图表体系工程化（DOMP/SCWF/SSAP）

大屏有 30+ 张图表，初始写法是每个页面内联 option。GYLJG-780 用一个月重构成三层：`base-chart` 通用组件（实例生命周期/自适应/防抖/销毁，见 4.1）+ 按模块的 `useEcharts` 数据→配置 Hook（usePrevious + isEqual 避免无效重渲染，见 4.2）+ 模块级 option 工厂函数。期间修复了图表卸载未重置数据、海外部门新增后图表空数据、横坐标显示不全、tooltip 图例遮挡等一系列渲染问题（GYLJG-1645/1458/3760）。

### 3.3 大型表格的交互完整性（全仓库）

列表页是所有平台的主战场，反复打磨的细节构成一套完整模式：搜索/重置后页码条数重置（GYLJG-1839）、请求前后 loading 状态与防连点（GYLJG-2155 控制请求频率修页面崩溃）、动态列 + 列排序（TableColumnManager、TableSorter 降级兼容，GYLJG-3571）、周数按年-周双键排序（GYLJG-2266）、导入导出（含失败原因弹窗、模板下载、导出文件名修复）、底部平均值/总和栏、冻结列、0 值与空数据的展示约定（横杠、不显示负号场景）。

### 3.4 多级级联筛选与下钻（DOMP/SSAP）

部门→系统→应用→服务（DOMP 数据管理）和业务域→系统→应用→采集来源（SSAP）都存在"上级变更清空下级、下级枚举按上级过滤、切页保持/重置语义区分、权限决定默认值"的复杂联动。SSAP 把整套联动收敛为 `useFilterForm`（见 4.3），DOMP 则统一了部门/系统/应用/服务的枚举接口管理（`统一管理部门、系统、应用、服务相关枚举接口`，2024-05-08）。下钻跳转还要处理 state 传递与空参数过滤（GYLJG-2155）。

### 3.5 时间语义（全仓库）

统计平台的时间筛选远不止选个日期：年/月/周/日四维切换、周数字段、快速选择范围（近两周默认到上一周、上个月、今年以来，GYLJG-3533）、最大可选天数限制（checkDuration，见 4.6）、趋势图动态标题（近八周）、验证码倒计时不能为负（GYLJG-2821）、月周时间最大值限制（GYLJG-3006）。最终沉淀出 `getDateBeginTime/getDateEndTime/quickSelect/checkDuration/timeConverter` 一组工具（4.6）。

### 3.6 认证、安全与权限

- **无感授权**：新 SSO 方案要求请求层拦截 401 抛 `AuthError` 由 SDK 静默续登，失败才跳 ULP，且跳转后回到当前页（SDCP `实现登录失效自动跳转到当前页`）。实现在请求层统一处理（4.4）。
- **API 级权限**：SSAP 在请求发出前校验 URL 权限（`校验API权限增加过滤路径查询字符后缀`，GYLJG-3841），非生产环境报错带 URL 便于定位。
- **传输安全**：RSA 多环境公钥（4.8）、脱敏邮箱回显时的正则校验（`fix: 修复脱敏邮箱的校验规则`）。
- **UI 安全**：SSAP 系统水印（GYLJG-3760）。

### 3.7 代码质量治理（SOP/MC/SDCP）

三波专项：portal 的 ESLint 全量治理（11 次提交，换 parser 解可选链、去 no-unused-vars、统一 @ 路径）；sonar 复杂度消减（`消除存在质量问题的相关代码复杂度`、`降低代码复杂度;优化camel2Under函数`）；以及 DOMP 的 quality scan 修复（`style: 修复代码质量扫描发现的样式问题`）。经验是治理必须配 Prettier 自动格式化 + 小步提交，否则冲突不可控。

### 3.8 数值精度与展示一致性

金额/百分比场景引入 Decimal.js（`feat: 新增Decimal精度库和修改百分比显示`，GYLJG-3061）；目标是 0 时的显示逻辑（`修复质效目标-周月数据的目标值为0显示的问题`）；`Math.ceil` vs `Math.round` 的取舍（BCP organize）；元/万元单位全局切换（BCP todo/month/organize 系列提交）。

## 四、模板代码（摘自仓库真实源码）

> 以下代码均可在对应仓库当前快照中找到，路径已标注，可直接作为同类中后台项目的脚手架素材。

### 4.1 ECharts 通用容器组件 base-chart（DOMP）

路径：`domp-front/src/public-component/echarts/base-chart.jsx`

要点：SVG 渲染器、`ResizeObserver` + debounce 自适应、实例复用校验、卸载 dispose 防内存泄漏、`useImperativeHandle` 暴露实例、受控 loading。

```jsx
import React, { useRef, useEffect, useLayoutEffect, useImperativeHandle } from 'react';
import PropTypes from 'prop-types';
import { debounce } from 'lodash';
import echarts from './echarts.config';

function EChart(props, ref) {
  const { options, loading = false, onClick, style = {} } = props;
  const cDom = useRef(null);
  const cInstance = useRef(null);

  const getInstance = () => cInstance.current;

  // 窗口自适应并开启过渡动画
  const resize = () => {
    cInstance.current && cInstance.current?.resize({ animation: { duration: 300 } });
  };
  const debounceResize = debounce(resize, 500);

  useEffect(() => {
    if (cDom.current) {
      // 校验 DOM 节点上是否已经挂载了 ECharts 实例，只有未挂载时才初始化
      cInstance.current = echarts.getInstanceByDom(cDom.current);
      if (!cInstance.current) {
        cInstance.current = echarts.init(cDom.current, null, { renderer: 'svg' });
      }
      cInstance.current.on('click', (event) => {
        if (event && onClick) onClick(event);
      });
      options && cInstance.current.setOption(options);
    }
    return () => {
      // 容器被销毁之后，销毁实例，避免内存泄露
      cInstance.current.dispose();
    };
  }, [cDom, options]);

  useLayoutEffect(() => { resize(); }, [style.width, style.height]);

  useEffect(() => {
    const viewElem = cDom.current;
    const resizeObserver = new ResizeObserver(() => { debounceResize(); });
    resizeObserver.observe(viewElem);
    return () => { resizeObserver.unobserve(viewElem); };
  }, []);

  useEffect(() => {
    loading ? cInstance.current.showLoading() : cInstance.current.hideLoading();
  }, [loading]);

  useImperativeHandle(ref, () => ({ getInstance }));

  return <div ref={cDom} style={{ width: '100%', height: '80%', ...style }} />;
}

export default React.memo(React.forwardRef(EChart));
```

### 4.2 数据→配置的 useEcharts 模式（DOMP）

路径：`domp-front/src/pages/board/*/hooks/useEcharts.js`（8 个模块各一份）

要点：`usePrevious` + `isEqual` 只在数据真变化时重建 option，一个 `useEffect` 只监听一个数组（这是 GYLJG-780 重构时定下的写法约束）。

```js
const prevAddNumList = usePrevious(addNumList);

useEffect(() => {
  if (!isEqual(prevAddNumList, addNumList)) {
    setAddOption(echartsOption(addNumList, DEPT_PROJECT_TYPE.ADD_QUANTITY));
  }
}, [addNumList]);
```

配套 Hook：`usePrevious` + `isEqual` 的用法来自 `src/hooks/usePrevious.js`（**该文件经 git 取证为同事 Eric Tan 所写，你是重度使用者**，在 8 个模块的 useEcharts 里用同一招控制重渲染）。

### 4.3 级联筛选统一 Hook useFilterForm（SSAP）

路径：`ssap-front/src/hooks/use-filter-form.tsx`

要点：valtio 快照读枚举、`useCreation` 做派生缓存、`usePersistFn` 包渲染函数、上级变更时原子化重置下级。适用于任何"部门/系统/应用"式级联。

```ts
export default function useFilterForm(
  searchInfo: SearchInfo,
  setSearchInfo: (params: SearchInfo) => void,
  pageType: 'log' | 'config' | 'monitor' | 'behavior-classify' | 'collect-source',
) {
  const { auditDepartment, formatId, sourceSystem, application } = searchInfo;
  const { systemReady, auditDepartmentList, systemList, collectTypeList, collectNameList } =
    globalStore.useSnapshot();

  // 系统列表按业务域过滤（缓存）
  const searchSystemList = useCreation(
    () => systemList.filter((n) => n.auditDepartment === auditDepartment),
    [auditDepartment, systemList],
  );

  // 应用列表按页面类型取全量或汇总口径
  const searchAppList = useCreation(() => {
    const systemInfo = searchSystemList.find((item) => item.system === sourceSystem);
    if (!systemInfo) return [];
    const { appList, sumAppList } = systemInfo;
    if (['log', 'behavior-classify', 'collect-source'].includes(pageType)) return appList;
    if (['config', 'monitor'].includes(pageType)) return sumAppList;
    return [];
  }, [sourceSystem, searchSystemList]);

  // 业务域变更：更新全局 + 原子化清空下级
  const onAuditDepartmentChange = (auditDepartment: string) => {
    changeGlobalData('auditDepartment', auditDepartment);
    setSearchInfo({ ...searchInfo, auditDepartment, sourceSystem: '', application: '' });
  };

  useEffect(() => {
    systemReady && fetchCollectEnumData(); // 就绪后再拉采集来源枚举
  }, [systemReady]);

  return { searchSystemList, searchAppList, onAuditDepartmentChange, /* ... */ };
}
```

### 4.4 统一请求层：SSO + API 权限 + 命名转换 + 错误码（SSAP）

路径：`ssap-front/src/fetch/index.ts`

要点：请求前做 API 权限校验（非生产带 URL）；GET 参数 `camel2Under` 后拼 query、响应 `under2Camel` 还原；`code === '0'` 时 info 判空给默认值；错误码映射 + 未登录抛 `AuthError` 交给 sso-sdk 无感续登。

```ts
async function request(url: string, data: Record<string, any>, options: Record<string, any> = {}): Promise<any> {
  try {
    if (!checkApiPermission(url)) {
      const errorMsg = isProd
        ? t(ERROR_MSG.API_PERMISSION_DENIED)
        : `${t(ERROR_MSG.API_PERMISSION_DENIED)} ${url}`;
      throw new Error(errorMsg);
    }

    const { uri, config } = preprocessRequestData(url, data, options);
    const res = await fetch(uri, config);
    const resData = await res.json();

    let formatResData = resData;
    try {
      formatResData = under2Camel(resData);
    } catch (error) {
      Message.error(t('请求返回值出现{}', ERROR_MSG.JSON_PARSE_ERROR));
    }
    const emptyDefaultValue = options.responseType === 'object' ? {} : [];
    const { code, msg, info } = formatResData;
    if (code === '0') {
      return { code, msg, info: info || emptyDefaultValue };
    }
    if (ERROR_MSG[code]) {
      Message.error(t(ERROR_MSG[code]));
      if (code === ERROR_CODE.NOT_LOGIN) {
        // sso单点登录实现，登录失效跳转至当前页面
        throw new AuthError('');
      }
    } else {
      throw new Error(msg);
    }
  } catch (error) {
    if (error instanceof AuthError) throw error;
    Message.error(`${t('请求出错：{}', error.message)}`);
    return {};
  }
}
```

### 4.5 命名风格互转 + 类型守卫（SCWF/SSAP）

路径：`scwf-cockpit-front/src/helpers/fetch.ts`、`src/helpers/check-types.ts`（SSAP 同名文件）

```ts
// 下划线转小驼峰：字符串/数组/普通对象三类递归，其余原样返回
export function under2Camel(target: any): typeof target {
  if (isString(target)) {
    return target.replace(/_(.)/g, (_, letter) => letter.toUpperCase());
  }
  if (isArray(target)) return target.map(under2Camel);
  if (isPlainObject(target)) {
    return Object.entries(target).reduce((result, [nativeKey, nativeVal]) => {
      const resultKey = under2Camel(nativeKey);
      result[resultKey as string] = isObject(nativeVal) ? under2Camel(nativeVal) : nativeVal;
      return result;
    }, {});
  }
  return target;
}

// check-types.ts：基于 Object.prototype.toString 的守卫集合
export const toRawType = (val: unknown) => objectToString.call(val).slice(8, -1);
export const isPlainObject = (val: unknown): val is Record<string, any> =>
  toTypeString(val) === '[object Object]';
export const isFunction = (val: unknown): val is (...args: any) => any =>
  toTypeString(val) === '[object Function]' || typeof val === 'function';
```

### 4.6 时间工具集（SCWF）

路径：`scwf-cockpit-front/src/helpers/date.ts`

```ts
// 指定日期的开始/结束时间：beforeDay 前推，可指定时刻
const getDateBeginTime = ({ day = new Date(), beforeDay = 0, isNeedAppointTime = false }: DateTimeOptions = {}) =>
  dayjs(day).subtract(beforeDay, 'day').format(`YYYY-MM-DD ${isNeedAppointTime ? 'HH:mm:ss' : '00:00:00'}`);

// 日期面板禁用规则：限制起止跨距 maxLimitDay（<=0 表示不限制）
const checkDuration = (d: Date, type: 'start' | 'end', start?: Date, end?: Date, maxLimitDay = -1) => {
  const ONE_DAY = 1000 * 60 * 60 * 24;
  const limit = maxLimitDay * ONE_DAY;
  if (type === 'end' && start) {
    return (
      d.getTime() < start.getTime() - ONE_DAY ||
      (limit > 0 ? d.getTime() >= start.getTime() + limit : false)
    );
  }
  if (type === 'start' && end) {
    return (
      d.getTime() > end.getTime() ||
      (limit > 0 ? d.getTime() <= end.getTime() - limit : false)
    );
  }
  return false;
};

// 秒数 → x天x时x分x秒（审批时长报表专用）
const timeConverter = (seconds) => {
  const days = Math.floor(seconds / (24 * 60 * 60));
  const hours = Math.floor((seconds % (24 * 60 * 60)) / (60 * 60));
  const minutes = Math.floor((seconds % (60 * 60)) / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${days > 0 ? `${days}${t('天')}` : ''}${hours > 0 ? `${hours}${t('时')}` : ''}${minutes > 0 ? `${minutes}${t('分')}` : ''}${remainingSeconds || 0}${t('秒')}`;
};

// 快速选择范围（今日/昨日/最近7天/最近30天）
const quickSelect = [
  { keygen: 'TODAY', name: t('今日'), value: [getDateBeginTime(), getDateEndTime()] },
  { keygen: 'RECENTLY_WEEK', name: t('最近7天'), value: [getDateBeginTime({ beforeDay: 6 }), getDateEndTime()] },
  /* ... */
];
```

### 4.7 树遍历：递归版 + 堆栈版（BCP）

路径：`bcp-front/src/component/ruleconfig/control/utils.jsx`（datalicensing/utils.jsx 同款）

```js
// 递归写法（条件命中执行 actionFn）
export const traverseTree = (data, conditionFn, actionFn) => {
  if (data?.length > 0) {
    const recursionTree = (info) => {
      if (info?.length > 0) {
        info.forEach((item) => {
          if (conditionFn(item)) actionFn(item);
          if (item?.childList?.length > 0) recursionTree(item.childList);
        });
      }
      return false;
    };
    recursionTree(data);
    return data;
  }
  return null;
};

// 堆栈写法（深层树更稳）
// export const traverseTree = (data, conditionFn, actionFn) => {
//   if (!data || !data.length) return null;
//   const stack = [...data];
//   while (stack.length) {
//     const item = stack.pop();
//     if (conditionFn(item)) actionFn(item);
//     if (item.childList && item.childList.length) stack.push(...item.childList);
//   }
//   return data;
// };

// 复合用法：按 id 找节点 / 收集全部 key（一键展开）
export const getNodeFromKey = (data, id) => {
  let result = null;
  traverseTree(data, (item) => item.cateId === id, (item) => { result = item; });
  return result;
};
export const getAllKeysArr = (list) => {
  const allKeys = [];
  traverseTree(list, () => true, (item) => { allKeys.push(item?.cateId); });
  return allKeys;
};
```

### 4.8 RSA 加密（SOP portal/platform）

路径：`sop-portal-front/src/lib/encrypt-rsa.js`

要点：按 `process.env.BUILD_ENV` 切换 dev/test/sit/prod 四套公钥；`publicEncrypt(str)` 供登录、忘记密码、重置密码复用。

```js
import JSEncrypt from 'jsencrypt';

const generatePublicKey = () => {
  switch (process.env.BUILD_ENV) {
    case 'dev':  return devPublicKey;
    case 'test': return testPublicKey;
    case 'sit':  return sitPublicKey;
    case 'prod': return prodPublicKey;
    default:     return prodPublicKey;
  }
};

export function publicEncrypt(str) {
  const encrypt = new JSEncrypt();
  encrypt.setPublicKey(generatePublicKey());
  return encrypt.encrypt(str);
}
```

### 4.9 APM 埋点配置（SCWF）

路径：`scwf-cockpit-front/src/helpers/apm.ts`

```ts
export default function setApmConfig(userInfo: UserInfo): void {
  const { enName = '', name = '', employeeId = '' } = userInfo;
  conf({
    customAuthInfoSync: { name, enName, emplid: employeeId, systemName: 'SCWF-COCKPIT' },
    request: { errorsIgnore: [401, (status) => status >= 300 && status < 400] },
    plugin: {
      error: {
        sendErrorToLogcenter: true,   // 错误埋点发送到日志中心
        reportConsoleError: true,     // 拦截 console.error 收集错误埋点
      },
    },
  });
}
```

### 4.10 泛型 Table 排序工厂（SCWF）

路径：`scwf-cockpit-front/src/helpers/common.ts`

```ts
function createSorter<T extends TableRowData, K extends keyof T>(
  field: K,
): (order: TableColumnOrder) => (a: T, b: T) => number {
  return (order: TableColumnOrder) => (a: T, b: T) => {
    return order === 'asc' ? a[field] - b[field] : b[field] - a[field];
  };
}

// 应用于 shineout Table 的 sorter 属性
export const onSorterField: TableSorter = (name, order) => createSorter(name)(order);
```

### 4.11 两个自建 Hook（SCWF）

路径：`scwf-cockpit-front/src/hooks/`

> 归属备注：`use-next-tick.tsx` 经取证为同事 erictan 所写，不计入；你的自建 Hook 是下面两个。

```ts
// use-dom-height.tsx：监听 resize 防抖取容器高度（仪表盘自适应）
export default function useDomHeight(selector: string) {
  const [domHeight, setDomHeight] = useSafeState(0);
  const getDomHeight = useDebounceFn(() => {
    setDomHeight(document.querySelector(selector)?.clientHeight || 0);
  }, { wait: 300 });
  useEventListener('resize', getDomHeight);
  useMount(() => { getDomHeight(); });
  return domHeight;
}

// use-next-tick.tsx：requestAnimationFrame 版 nextTick
// use-export-data.tsx：报表导出入口，createExportDataFn(pathname, params) 复用到四个报表页
```

### 4.12 页面级 `index.hook.tsx` 分层约定（SCWF/SSAP）

自建项目的页面目录约定：视图与逻辑分离，每个页面一组固定文件。

```
src/pages/<module>/<page>/
├── index.tsx          # 视图：只做渲染，逻辑全部来自 hook
├── index.hook.tsx     # 逻辑：状态、请求、事件
├── constants.ts(x)    # 页面常量与列配置
└── components/        # 页面私有组件
```

配套全局分层：`api/`（接口定义与类型）、`fetch/`（请求层统一出口，见 4.4）、`helpers/`（纯函数工具）、`hooks/`（通用 Hook）、`globalStore/`（valtio 全局枚举）、`components/`（base-chart/empty/loading/search-form 等公共组件）。

## 五、统计口径说明

- 提交数按 `git log --author` 统计，含 merge 提交；DOMP 中 GYLJG-2144 等需求因多次分支合并存在少量重复计数，不影响量级结论。
- 各仓库完整提交清单（`<repo>-commits.txt`）与高频改动文件（`<repo>-topfiles.txt`）备份于 `E:\guahub\docs\temp\_analysis\`，提交内容可用 `git log --grep="<JIRA号>"` 在对应仓库复核。
- 模板代码摘自 2024-08-11 快照的工作区源码，个别文件在后续 master 上可能有演进。

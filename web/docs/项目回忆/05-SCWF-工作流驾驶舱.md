# 05 · SCWF 流程驾驶舱 — 你的代码回忆录

> 仓库：`V:\程序开发\05-前端进阶\项目资产\05-广州希音[1.88GB]\05-工作流引擎平台[SCWF]\代码仓库\scwf-cockpit-front-20240811\scwf-cockpit-front`
> 你的提交：**77 / 85**（2023-11-10 ～ 2024-08-08）。`Initial commit`（159a004，2023-11-10）就是你自己打的——**这个项目从第一行代码起就是你的**。

**技术栈**：React 17 + TypeScript 4.6 + @shein-lego + shineout + @shined/reactive（页面级 store）+ redux slice（全局）+ echarts 5（按需注册 + SVG）+ vis-timeline + dayjs + file-saver + sso-sdk + sheinq APM。
**架构模式**：`index.tsx（视图）/ index.hook.tsx（逻辑）/ store.ts（状态）/ index.css（样式）` 四件套，从 0 到 1 自建。代码注释统一带 `@author ggbdpq @since` 时间戳，自带签名。

> **归属备注**：`src/hooks/use-next-tick.tsx` 文件头署名 `@author erictan`，不计入你的作品；你的三个自建 hook 是 useDomHeight / useExportData（本篇）+ 后续在 SSAP 的 useFilterForm。

---

## 一、你写过的核心 TS/TSX 代码

### 1.1 useDomHeight — 报表页高度自适应

`src/hooks/use-dom-height.tsx`
归属：`49cc379 2023-11-16 feat: 开发流程报表页面;新增useDomHeight公共钩子`

```tsx
import { useMount, useSafeState, useEventListener, useDebounceFn } from '@shein-lego/use';

/**
 * @desc 获取dom高度hooks
 * @param selector dom选择器
 */
export default function useDomHeight(selector: string) {
  const [domHeight, setDomHeight] = useSafeState(0);

  const getDomHeight = useDebounceFn(
    () => {
      setDomHeight(document.querySelector(selector)?.clientHeight || 0);
    },
    { wait: 300 },
  );

  useEventListener('resize', getDomHeight);
  useMount(() => { getDomHeight(); });

  return domHeight;
}
```

点评：防抖 + resize 监听 + 安全 setState 三合一，解决"搜索区高度变化时表格自适应"的报表经典问题——从流程报表页开始被四个报表页共用。

### 1.2 useExportData — 柯里化导出工厂

`src/hooks/use-export-data.tsx`
归属：`6ee3a47 2023-11-28 feat: 开发页面新增导出功能`

```tsx
/**
 * @desc 下载表格数据
 * @author ggbdpq
 * @since 2023-11-27 16:02:38
 */
import { usePersistFn } from '@shein-lego/use';
import { fetchExportData } from '@/ak/store';
import { ExportDataParams } from '@/api/common';

export default function useExportData() {
  const getExportData = usePersistFn((pathname: string, params: ExportDataParams) => {
    fetchExportData(pathname, params);
  });

  const createExportDataFn = (getExportDataFn) => (pathname, params) =>
    getExportDataFn(pathname, params);

  const onExportFn = createExportDataFn(getExportData);
  return { onExportFn };
}
```

点评：柯里化工厂让每个列表页生成自己的导出回调，配合 ak/store 里 file-saver 的下载链路。

### 1.3 file-saver 导出全链路

`src/ak/store.ts`
归属：`6ee3a47 2023-11-28` → `0011649 2023-12-04 feat: 增加file-saver依赖;前后期导出Excel表格联调`

```ts
export const fetchExportData = globalStore.defineFire(
  (setState) => async (pathname: string, params: ExportDataParams) => {
    const defaultName = `${t('默认报表导出')}-${dayjs().format('YYYYMMDDHHmmss')}.xlsx`;
    setState((state) => { state.onExportLoading = true; });
    const res = await getExportData(pathname, params);
    setState((state) => { state.onExportLoading = false; });
    const { headers, status, statusText } = res;
    const filename =
      decodeURIComponent(headers.get('Content-Disposition').split?.('filename=')?.[1]) ||
      defaultName;
    if (status === 200 || statusText === 'ok') {
      const blobRes = await res.blob();
      const blob = new Blob([blobRes], { type: 'application/octet-stream' });
      fileSaver.saveAs(blob, filename);
      Message.success(t('导出成功'));
    } else {
      Modal.error({ title: t('导出失败') });
    }
  },
);
```

点评：从 Content-Disposition 解析文件名并 decodeURIComponent，失败兜底时间戳命名，loading 状态全程闭环。

### 1.4 APM 埋点配置（上线第 3 天就接好监控）

`src/helpers/apm.ts`
归属：`c00b45e 2023-11-13 feat: 新增bbl、apm、echarts和timeline相关依赖…`（项目第 2 个提交）

```ts
export default function setApmConfig(userInfo: UserInfo): void {
  const { enName = '', name = '', employeeId = '' } = userInfo;
  conf({
    customAuthInfoSync: { name, enName, emplid: employeeId, systemName: 'SCWF-COCKPIT' },
    request: { errorsIgnore: [401, (status) => status >= 300 && status < 400] },
    plugin: {
      error: {
        sendErrorToLogcenter: true,   // 错误埋点发送到 日志中心
        reportConsoleError: true,     // 全局错误拦截插件，对console.error的内容进行错误埋点收集
      },
    },
  });
}
```

点评：`errorsIgnore` 用谓词数组过滤 3xx 噪音——建仓第三天就把监控接好了。

### 1.5 泛型 Table sorter 工厂

`src/helpers/common.ts`
归属：`5a92a98 2023-11-23 增加Table指定字段的sort功能` → `dd39d03 2023-11-27 分类整理`

```ts
type TableColumnOrder = 'asc' | 'desc';
type TableRowData = { [key: string]: number };
type TableProps = TYPE.Table.Props<TableRowData, TableRowData>;
type TableSorter = TableProps['sorter'];

function createSorter<T extends TableRowData, K extends keyof T>(
  field: K,
): (order: TableColumnOrder) => (a: T, b: T) => number {
  return (order: TableColumnOrder) => (a: T, b: T) => {
    if (order === 'asc') { return a[field] - b[field]; } else { return b[field] - a[field]; }
  };
}

// 应用于 table 组件的sorter 排序函数
export const onSorterField: TableSorter = (name, order) => createSorter(name)(order);
```

点评：用组件库自身的 `TYPE.Table.Props` 反查 sorter 类型再写泛型工厂——类型推导完全贴着 shineout 走。

### 1.6 under2Camel / camel2Under（建仓第一天就写好）

`src/helpers/fetch.ts`
归属：`159a004 2023-11-10 Initial commit`

```ts
export function under2Camel(target: any): typeof target {
  if (isString(target)) {
    return target.replace(/_(.)/g, (_, letter) => letter.toUpperCase());
  }
  if (isArray(target)) { return target.map(under2Camel); }
  if (isPlainObject(target)) {
    return Object.entries(target).reduce((result, [nativeKey, nativeVal]) => {
      const resultKey = under2Camel(nativeKey);
      result[resultKey as string] = isObject(nativeVal) ? under2Camel(nativeVal) : nativeVal;
      return result;
    }, {});
  }
  return target;
}
// camel2Under 与上面对称，依赖自写 check-types.ts 的类型守卫
```

点评：解决后端下划线/前端驼峰的边界，是整个请求层的地基，后来原样平移进 SSAP。

### 1.7 checkDuration — 时间范围双约束

`src/helpers/date.ts`
归属：`25adfe6 2024-05-20 完善时间处理函数` → `d75f704 2024-05-21 完善限制时间函数逻辑`（同一天三连改）

```ts
const checkDuration = (
  d: Date, type: 'start' | 'end', start?: Date, end?: Date, maxLimitDay = -1,
) => {
  const ONE_DAY = 1000 * 60 * 60 * 24;
  // 判断 maxLimitDay 变量是否为负数，若负数则设置不限制天数。
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
```

点评：把 DatePicker 的禁用判断抽象成"边界 + 最大跨度"双约束，负数即不限制的哨兵设计。

### 1.8 SSO 请求层

`src/fetch/index.ts`
归属：`3990474 2024-02-29` → `3959c99 2024-08-07 sso-sdk版本升级到0.1.2`（最后一笔提交）

```ts
const sso = new SSOSDK({ ulpOrigin: process.env.LOGIN_ADDR as string });

async function request(url, data, options = {}): Promise<any> {
  try {
    if (!checkApiPermission(url)) {          // API 权限前置校验
      Message.error(ERROR_MSG.API_PERMISSION_DENIED);
      return {};
    }
    const config = cloneDeep(options);
    config.headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers);
    let uri = url;
    if (options.method === 'GET') {
      const paramsStr = new URLSearchParams(camel2Under(data)).toString()?.replace(/\+/g, '%20');
      uri = paramsStr ? `${url}?${paramsStr}` : url;
    } else if (options.method === 'POST') {
      if (options.isFileStream) {            // 导出：直接返回文件流
        config.body = JSON.stringify(camel2Under(data));
        return fetch(uri, config);
      }
      config.body = JSON.stringify(camel2Under(data));
    }
    const res = await fetch(uri, config);
    let formatResData = under2Camel(await res.json());
    const { code, msg, info } = formatResData;
    if (code === '0') return info || {};
    if (ERROR_MSG[code]) {
      Message.error(t(ERROR_MSG[code]));
      if (code === ERROR_CODE.NOT_LOGIN) throw new AuthError(''); // 未登录交给 sso-sdk
    } else throw new Error(msg);
  } catch (error) {
    if (error instanceof AuthError) throw error;
    Message.error(`${t('请求出错：{}', error.message)}`);
    return {};
  }
}
const wrapGet = sso.wrapRequest(get);
const wrapPost = sso.wrapRequest(post);
export { request, wrapGet as get, wrapPost as post };
```

点评：一层请求同时处理 API 权限、驼峰/下划线双向转换、文件流短路、错误码表、SSO 登录态失效上抛——小而完整的企业级 request 内核。

### 1.9 vis-timeline 封装（命令式库的教科书封装）

`src/components/timeline/index.tsx`（41 行）
归属：`15a2a01 2023-11-20 添加vis-timeline组件` → `b933071 2024-01-17 降低代码复杂度`

```tsx
import { DataSet } from 'vis-data/esnext';
import { Timeline as VisTimelineCtor } from 'vis-timeline/esnext';
import type { Timeline as VisTimeline, TimelineOptions } from 'vis-timeline/types';
import 'vis-timeline/styles/vis-timeline-graph2d.min.css';

export default function TimeLine(props: TimelineProps) {
  const { initialItems, options = { width: '100%', height: 300 } } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<VisTimeline>();
  const [items] = useState(new DataSet(initialItems || []));

  useEffect(() => {
    if (!containerRef.current) return false;
    timelineRef.current = new VisTimelineCtor(containerRef.current, items, options);
    return () => { timelineRef.current?.destroy(); };
  }, []);

  return <div ref={containerRef} />;
}
```

点评：双 ref + 空依赖 useEffect + destroy 清理，esnext 子路径引入压体积——用于审批时长报表的时间序列图。

### 1.10 公共表格组件（表格引擎）

`src/components/table/index.tsx`（253 行）
归属：`c00b45e 2023-11-13` 创建 → `8d95c4d/b457925 2023-12` → `b933071 2024-01-17 降低代码复杂度`

```tsx
const TableCmp = forwardRef(function Cmp(props: TableCmpProps, ref: any) {
  const [pageInfo, setPageInfo] = useSafeState({
    count: 0, pageNum: 1, pageSize: 20, pageSizeList: [20, 50, 100],
  });
  const prevFetchParams = usePrevious(fetchParams);
  const prevPageNum = usePrevious(pageInfo.pageNum);
  const prevPageSize = usePrevious(pageInfo.pageSize);

  const fetch = usePersistFn(
    async ({ pageNum = pageInfo.pageNum, pageSize = pageInfo.pageSize } = {}) => {
      if (!isReadyToFetch || loading) return;      // 提前退出 + 防连点
      setLoadingTrue();
      const params = isSetPagination ? { ...fetchParams, pageNum, pageSize } : fetchParams;
      const { meta = {}, data = [] } = await fetchApi(clearEmpty(paramTrim(params)));
      const formatList = formatListFunc ? formatListFunc(data) : data;
      setList(formatList);
      setPageInfo({ ...pageInfo, pageNum, pageSize, count: meta.count || 0 });
      setLoadingFalse();
      setSelectedRows([]);
    },
  );

  // 搜索参数变化：深比较后才重发请求
  useUpdateEffect(() => {
    if (!isNeedReFetchByParamsChange || !prevFetchParams || isEqual(prevFetchParams, fetchParams))
      return;
    // ...
  }, [fetchParams]);

  useImperativeHandle(ref, () => ({ init, refresh }));
```

点评：`forwardRef + useImperativeHandle` 暴露 init/refresh，`usePrevious + isEqual` 防抖重请求，`clearEmpty(paramTrim())` 出参清洗——与 DOMP 的 table.jsx 一脉相承，但换成了 TS。

### 1.11 echarts 按需注册 + ComposeOption

`src/components/echarts/echarts.config.tsx`
归属：`c00b45e 2023-11-13` → `906de54 2023-11-21 规范导入顺序` → `eb3fd39 2023-11-23 流程模板详情增加饼图显示`

```ts
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { LegendComponent, TitleComponent, GridComponent, TooltipComponent, DatasetComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import type { ComposeOption } from 'echarts/core';
import { LabelLayout, UniversalTransition } from 'echarts/features';
import { SVGRenderer } from 'echarts/renderers';

echarts.use([BarChart, LineChart, PieChart, LegendComponent, TitleComponent,
  GridComponent, TooltipComponent, DatasetComponent, LabelLayout, UniversalTransition, SVGRenderer]);
export default echarts;

export type EChartsOption = ComposeOption<
  | BarSeriesOption | LineSeriesOption | PieSeriesOption
  | LegendComponentOption | TitleComponentOption | GridComponentOption | TooltipComponentOption | DatasetComponentOption
>;
```

点评：官方推荐的按需注册 + ComposeOption 合成类型——SSAP 里同款文件（连 `@since 2023-11-10` 注释都保留）追加了 DataZoomComponent，自己沉淀的基础设施直接平移。

### 1.12 代表页面：审批时长报表

`src/pages/approval/list/index.hook.tsx`（406 行，21 次修改）+ `index.tsx`（132 行，23 次修改），文件头 `@author ggbdpq @since 2023-11-15/17`

```tsx
export default function useHook() {
  const { systemReady, onExportLoading } = globalStore.useState();
  const approvalDurationState = approvalDurationStore.useSnapshot();
  const { searchInfo, processModelMap, recordCount, detailSearchInfo, approvalDetailInfo } =
    approvalDurationState;
  const nextTick = useNextTick();
  const tableRef = useRef<TableCmpProps>(null);
  // 通过高级搜索组件的高度去动态计算表格容器高度
  const tableReducedHeight = useDomHeight(`.${styles.form}`);
  const columns: TYPE.Table.ColumnItem<Record<string, any>>[] = [
    { title: 'ID', align: 'center', width: 50, render: (_, i) => i + 1 },
    { title: t('审批时效'), align: 'center', width: 160,
      sorter: 'totalApproveTime', render: (row) => timeConverter(row?.totalApproveTime) },
    { title: t('操作'), align: 'center', width: 120,
      render: (row) => (
        <ModalDetail btnName={t('查看详情')} modalTitle={t('流程明细')} modalWidth={1200}
          modalFetchApi={() => detailDataFn(row)} childrenType='detail' keygen='processId'
          columns={detailColumns} fetchApi={getApprovalDetailList} />
      ) },
  ];
```

视图层日期禁用直接引用 helper：

```tsx
<DatePicker disabled={loading || ((d, type, start, end) =>
  checkDuration(d, type, start, end, 365))} />
```

点评：hook 里组合全局 store + 页面 reactive store + 自研 hook 三件套，视图只做声明式拼装——"逻辑视图分离"执行得非常彻底。

---

## 二、你写过的 CSS 样式

23 个 CSS Modules 文件：全局 `src/index.css`（全文两行 `@import '@/assets/styles/reset.css'; @import '@/assets/styles/override.css';`）、`assets/styles/reset.css|override.css`、components 和各 pages 的 index.css。无 scss/less/styled-components。

摘录 1 — `src/pages/approval/list/index.css`（9 次修改）：

```css
.page { height: 100%; }
.form { padding-bottom: 12px; }
.radioContainer { display: flex; justify-content: flex-end; }
.model {
  overflow-x: hidden;
  overflow-y: auto;
  :global(.so-card-body) {      /* 穿透 shineout 组件内部类名 */
    margin-top: 10px;
  }
}
```

摘录 2 — `src/pages/dashboard/index.css`（8 次）：

```css
.tableContainer {
  height: 220px;
  background-color: #187afa;
  border-radius: 5px;
}
th.columnsColor, td.columnsColor {
  color: #fff !important;
  background-color: #187afa !important;
  border-bottom: 0 !important;
}
.chartContainer { height: calc(100vh - 345px); border: 1px solid #eeeff1; }
```

点评：轻 CSS Modules + `:global` 穿透组件库；仪表盘用希音蓝 #187afa 做反白数据卡，`calc(100vh - 345px)` 配合 useDomHeight 做自适应。

---

## 三、项目配置与优化

1. **package.json**（`0011649` 加 file-saver、`3959c99` 升级 sso-sdk）：`packageManager: pnpm@8.6.5`；关键依赖 `@shein-lego/use`（useSafeState/usePersistFn）、`@shein-lego/ak + ak.macro`（宏定义 store namespace）、`@shined/reactive`、sso-sdk、sheinq、vis-timeline、file-saver、TS 4.6.4；commitlint + commitizen(git-cz) + husky + lint-staged 全家桶。
2. **tsconfig.json**：`strict: false` 但开 `noImplicitReturns` / `forceConsistentCasingInFileNames`；别名 `@/* → src/*`、`@@/* → src/.lego/*`；`experimentalDecorators` 配合 ak.macro。
3. **config/.legorc.ts**（`e102d7f 2023-11-22 修改lego基础配置`）：externals 掉 react/react-dom/shineout 走 CDN 全局变量；`experiments.lazyCompilation` 按需编译、`reactFastRefresh`、路由级 `loading: '@/components/loading'`；`defineInProcessEnv` 注入 `RUN_ENV` 和 `LOGIN_ADDR`。
4. **本地反向代理**（`e19a64b 2023-11-14 修改本地反向代理的配置项`）：

```ts
dev: {
  host: 'localhost', port: 8888,
  headers: { 'Access-Control-Allow-Origin': '*' },
  proxy: {
    '/': { target: 'http://scwf-cockpit-end-cneast-dev-dev.dev.paas-dev.sheincorp.cn/',
           secure: false, changeOrigin: true },
  },
},
```

5. **.eslintrc.js**（`906de54 2023-11-21 增加eslint-plugin-import依赖，规范导入顺序`）：自定义 `import/order` 分组——react/shineout 最前 → `@shein-*` → `@/` 别名 → 相对路径 → `./index.css` 收尾，`alphabetize: asc` 强制字母序，全文 import 排版由机器保证。

---

## 四、值得回忆的提交瞬间

| hash | 日期 | subject |
| --- | --- | --- |
| `159a004` | 2023-11-10 | Initial commit（**项目从这里开始**，全是脚手架 + 核心 helpers） |
| `c00b45e` | 2023-11-13 | 新增bbl、apm、echarts和timeline相关依赖，增加table、echarts公共组件 |
| `49cc379` | 2023-11-16 | 开发流程报表页面;新增useDomHeight公共钩子 |
| `15a2a01` | 2023-11-20 | 添加vis-timeline组件,增加基本使用的案例演示 |
| `5a92a98` | 2023-11-23 | 增加秒数时间格式转换组件;增加Table指定字段的sort功能 |
| `6ee3a47` | 2023-11-28 | 开发页面新增导出功能 |
| `0011649` | 2023-12-04 | 增加file-saver依赖;前后期导出Excel表格联调 |
| `b933071` | 2024-01-17 | 降低代码复杂度,优化代码（自查自纠式大重构） |
| `7057d9f` | 2024-02-28 | 增加bbl设置，修复中文的多语种配置 |
| `3959c99` | 2024-08-07 | sso-sdk版本升级到0.1.2（最后一笔） |

**一句话画像**：从 `Initial commit` 到最后一笔，85 次提交里 77 次是你的名字——仪表盘、流程报表、任务报表、审批时长报表、流程监控五个页面 + hooks/helpers/components 三层基建，全部出自一人之手，而且 1 月那次"降低代码复杂度"说明你建完还回头自己拆了自己。

# 10 · SSAP 业务监控预警平台 — 你的代码回忆录

> 仓库：`V:\程序开发\05-前端进阶\项目资产\05-广州希音[1.88GB]\10-业务监控预警平台[SSAP]\代码仓库\ssap-front-20240811\ssap-front`
> 你的提交：**186 次，全仓第一**（2024-06-11 ～ 2024-08-07）。仓库 Initial commit 由 Eric Tan 创建（2024-06-07），**你的第一笔是 `a4c4a99 2024-06-11 安装dayjs、新增时间和日期辅助函数`**——此后主体页面均由你完成。两个月，一个完整的 TS 平台前端。

**技术栈**：React 18.3 + TypeScript 5.4 + @shein-lego/cli 1.5 + shineout 3 + **@shined/reactive**（globalStore：create/mutate/useSnapshot）+ echarts 5.5 + sso-sdk 0.1.2 + dayjs。
**相比 SCWF 的进化**：状态层从 redux-slice + ak.macro 换成纯 @shined/reactive；构建配置收敛到单文件 .legorc.ts；TS 4.6→5.4，React 17→18。

> **归属更正**：`src/pages/security-audit/dashboard/utils.ts`（趋势图数据转换、tooltip 定位）经 git 取证全部 5 笔提交来自同事 ChinleyHuang，**不是你的代码**，本篇不收录。`src/hooks/use-next-tick.tsx` 亦是 erictan 所写。

---

## 一、你写过的核心 TS/TSX 代码

### 1.1 SSO + 权限请求层（二次沉淀版）

`src/fetch/index.ts`
归属：`ce04c9f 2024-07-11 请求接口统一下划线` → `73992d0/8290e45 2024-07-16 优化后端接口返回null的请求处理`

```ts
const isProd = process.env.RUN_ENV === 'prod';
const sso = new SSOSDK({ ulpOrigin: process.env.LOGIN_ADDR as string });

/** 对传入的数据和URL进行预处理 */
function preprocessRequestData(url, data, options) {
  const config = cloneDeep(options);
  let uri = url;
  if (options.method === 'GET') {
    const paramsStr = new URLSearchParams(camel2Under(data)).toString()?.replace(/\+/g, '%20');
    uri = paramsStr ? `${url}?${paramsStr}` : url;
  } else {
    const { auditDepartment, ...restData } = data;
    // 如果有业务域参数，将业务域作为uri参数
    if (auditDepartment) {
      uri = `${url}?${new URLSearchParams({ audit_department: auditDepartment })}`;
    }
    config.body = JSON.stringify(camel2Under(restData));
  }
  config.headers = { 'Content-Type': 'application/json', ...options.headers };
  return { uri, config };
}

async function request(url, data, options = {}) {
  try {
    if (!checkApiPermission(url)) {
      const errorMsg = isProd
        ? t(ERROR_MSG.API_PERMISSION_DENIED)
        : `${t(ERROR_MSG.API_PERMISSION_DENIED)} ${url}`;   // 非生产暴露具体 url 便于排查
      throw new Error(errorMsg);
    }
    // ...
    const emptyDefaultValue = options.responseType === 'object' ? {} : [];  // null 兜底分流
```

点评：比 SCWF 版本多出预处理器抽取、业务域 query 注入、环境区分的报错信息、responseType 决定空值兜底形态——对旧请求层的再次提炼。

### 1.2 valtio 风格全局状态 + 类型安全更新器

`src/globalStore/index.ts`（15 次修改）
归属：`9c4875a 2024-07-17` → `afa90b7 2024-07-25 完善行为分类开发页面`

```ts
import { create } from '@shined/reactive';

export const globalStore = create<GlobalStore>({
  systemReady: false,
  userInfo: { employeeId: '', name: '', enName: '', roleList: [], system: '', systemGroup: '' },
  permissionMap: new Map<string, PermissionConfig>(),
  menus: BASIS_MENU,
  auditDepartment: '',
  auditDepartmentList: [],
  systemList: [],
  appList: [],
  collectTypeList: [], collectNameList: [], riskLevelList: [],
  auditStatusList: [], statistPeriodList: [],
});

export const fetchPermissionMap = async () => {
  const { userInfo } = globalStore.mutate;
  const { info } = await getPermission(userInfo?.name);
  const flattenPermissionMap = new Map<string, PermissionConfig>();
  const menus = cloneDeep(BASIS_MENU);
  generatePermissionMap(flattenPermissionMap, info?.permissionTreeList || []);
  generateMenus(menus, info?.permissionTreeList || []);
  globalStore.mutate.permissionMap = flattenPermissionMap;
  globalStore.mutate.menus = menus;
};

/** 泛型受限的单字段更新器 */
export const changeGlobalData = <K extends keyof GlobalStore>(dataName: K, data: GlobalStore[K]) => {
  globalStore.mutate[dataName] = data;
};
```

点评：`changeGlobalData<K extends keyof GlobalStore>` 把"字段名-值"联动做成类型安全 API，八个枚举列表统一进全局，页面只消费 snapshot。

### 1.3 useFilterForm — 五级级联筛选统一 hook

`src/hooks/use-filter-form.tsx`（8 次迭代）
归属：`bcd558b 2024-07-23 feat: 行为分类前端页面开发` → `9566977 2024-07-26 完善对首页-应用的数据来源过滤`

```tsx
export default function useFilterForm(
  searchInfo: SearchInfo,
  setSearchInfo: (params: SearchInfo) => void,
  pageType: 'log' | 'config' | 'monitor' | 'behavior-classify' | 'collect-source',
) {
  const { auditDepartment, formatId, sourceSystem, application } = searchInfo;
  const { systemReady, auditDepartmentList, systemList, collectTypeList,
          collectNameList, statistPeriodList } = globalStore.useSnapshot();

  const searchSystemList = useCreation(
    () => systemList.filter((n) => n.auditDepartment === auditDepartment),
    [auditDepartment, systemList],
  );

  const searchAppList = useCreation(() => {
    const systemInfo = searchSystemList.find((item) => item.system === sourceSystem);
    if (!systemInfo) return [];
    const { appList, sumAppList } = systemInfo;
    if (['log', 'behavior-classify', 'collect-source'].includes(pageType)) {
      return appList;          // 部分页面只能看非SWP应用
    } else if (['config', 'monitor'].includes(pageType)) {
      return sumAppList;
    }
    return [];
  }, [sourceSystem, searchSystemList]);

  // 采集来源下拉：按类型+应用双重过滤
  const collectSourceData = useCreation(
    () => collectNameList
      .filter((item: any) =>
        (!formatId || item?.formatId === formatId) &&
        (!application || item?.application === application))
      .map((item: any) => ({ ...item, label: item?.label, value: item?.value })),
    [collectNameList, formatId, application],
  );

  const onAuditDepartmentChange = (auditDepartment: string) => {
    changeGlobalData('auditDepartment', auditDepartment);
    setSearchInfo({ ...searchInfo, auditDepartment, sourceSystem: '', application: '' }); // 级联清空
  };
```

点评：业务域→系统→应用→采集来源→类型五级联动收进一个 hook，`pageType` 决定数据可见性，切换上级自动清空下级——五个列表页共享同一套筛选逻辑。这是你在 DOMP 时代"统一管理枚举接口"理想的最终形态。

### 1.4 时间辅助：API 自我进化

`src/helpers/date.ts`
归属：`a4c4a99 2024-06-11`（进项目第一个 commit）→ `251e8d3 2024-07-25 完善ID字段显示,增加默认时间范围`

```ts
export const formatStart = 'YYYY-MM-DD HH:mm:ss';

/** 创建【快速选择】时间区间 */
export const quickSelect = (
  today: string | Date = new Date(),
  options?: { start?: string; end?: string; excludesType?: (3 | 7 | 30)[] },
) => {
  const { start = formatStart, end = formatEnd, excludesType = [] } = options || {};
  const selectList = [
    { type: 3,  name: t('近3天'),  value: [dayjs(today).subtract(3, 'day').format(start), dayjs(today).format(end)] },
    { type: 7,  name: t('近7天'),  value: [dayjs(today).subtract(7, 'day').format(start), dayjs(today).format(end)] },
    { type: 30, name: t('近30天'), value: [dayjs(today).subtract(30, 'day').format(start), dayjs(today).format(end)] },
  ];
  return selectList.filter((item) => !excludesType.includes(item.type as 3 | 7 | 30));
};

export const checkDuration = (
  d: Date, type?: 'start' | 'end',
  options: { start?: Date; end?: Date; maxLimitDay: number } = { maxLimitDay: -1 },
) => {
  // 与 SCWF 相同的双约束算法，但签名升级为 options 对象传参
```

点评：SCWF 的五连参数 `checkDuration(d, type, start, end, maxLimitDay)` 在这里重构为 options 对象 + quickSelect 参数化（可排除快捷项）——一年内对自己 API 的两次进化清晰可见。

### 1.5 三级权限校验

`src/helpers/permission.ts`
归属：`5715315 2024-07-06 完善一级菜单按照sort字段排序`

```ts
export const checkApiPermission = (url: string) => {
  if (API_WHITELIST.includes(url)) return true;
  const { permissionMap } = globalStore.mutate;
  const permission = permissionMap.get(url);
  return permission && [PERMISSION_TYPE.API].includes(permission.type);
};

export const checkBtnPermission = (url: string) => {
  const { permissionMap } = globalStore.mutate;
  const permission = permissionMap.get(url);
  return permission && [PERMISSION_TYPE.BTN].includes(permission.type);
};
```

点评：页面/API/按钮三级权限，数据源从 redux slice 换成 reactive 的 mutate，请求层每个调用前先过这一关——BCP 时代 isDisableByKey 的完全体。

### 1.6 枚举转换 transformEnumData

`src/helpers/data-process.ts`
归属：`ec2f329 2024-07-13 接口联调` → `8e8540f 2024-07-14 完善采集来源和采集来源类型以及应用字段的关系`

```ts
function isTransformFieldConfig(field: any): field is TransformFieldConfig {
  return field && typeof field === 'object' && 'label' in field && 'value' in field;
}

export function transformEnumData(data, fields, extraFields?) {
  if (isTransformFieldConfig(fields)) {
    return data?.map((item) => {
      const label = item[fields.label];
      const value = item[fields.value];
      if (label && value) {
        const extraData = extraFields ? extractExtraData(item, extraFields) : {};
        return { label, value, ...extraData };
      }
      return null;
    }).filter(Boolean);
  } else if (typeof fields === 'string') {
    const uniqueDataMap = new Map();     // 字符串字段去重生成枚举
    data?.forEach((item) => { /* ... */ });
    return Array.from(uniqueDataMap.values());
  }
  return data || [];
}
```

点评：一个函数吃两种字段配置（对象映射 / 字符串去重），类型守卫收窄分支，extraFields 透传业务域等附加维度。

### 1.7 动态搜索表单组件（children 内省 + cloneElement）

`src/components/search-form/index.tsx`
归属：`d673977 2024-06-14 feat: 搜索表单组件设计` → `cebf948 2024-06-17 完善搜索表单组件开发` → `80541c7/f8a6674 2024-06-19`

```tsx
const SearchForm: FC<SearchFormProps> = ({ searchInfo, onChange, onSearch, isNeedTimeRange = false, children }) => {
  const [searchSelectVal, setSearchSelectVal] = useState<SearchSelectVal>({
    searchFieldId: '', searchFieldName: '', inputValue: '', selectValue: '',
  });
  const [tags, setTags] = useState<TagProps[]>([]);        // 已选条件渲染为可删除 Tag

  useEffect(() => {
    if (Array.isArray(children)) {
      const data = children.map((item) => ({
        id: item.props.name, name: item.props.label, type: item.type.displayName,
      }));
      setSearchData(data);                                  // 从 children 反推可搜索字段
    }
  }, [children]);

  const getChildComponent = (data: SearchData) => {
    const foundChild = children.find((child) => child.props.name === data?.id);
    const isSelectType = foundChild?.type?.displayName === 'ShineoutSelect';
    return React.cloneElement(foundChild, {
      width: 200,
      className: styles.commonWrapper,
      onChange: (value: string) => handleChange(isSelectType ? 'selectValue' : 'inputValue', value),
    });
  };
```

配套 `type.ts` 的联合类型：`export type ListParams = LogListParams & RuleListParams & AuditListParams & IndexedParams;`

点评：用 `children.props` 内省 + `React.cloneElement` 注入 onChange，实现"字段选择器 + 动态输入项 + Tag 回显"的通用搜索器；类型上把三个页面参数集求交集兜底——设计先行的组件（有独立的"设计"提交）。

### 1.8 echarts.config — 自我平移的基础设施

`src/components/echarts/echarts.config.tsx`
归属：`a695ea8 2024-07-04 增加echarts图表依赖包` → `aada2ce 2024-07-10 完善首页-柱状图拉伸`

与 SCWF 版本逐字同源（**连 `@since 2023-11-10` 注释都保留**），新增 DataZoomComponent 注册——注释里的旧日期就是"出处水印"。

### 1.9 规则详情页：三态复用 + 留底脏检查

`src/pages/rules/config/index.hook.tsx`（34 次修改，全仓最多之一）
归属：`7ec08c1 2024-07-19 完善规则详情回显问题` → `f72b0ac 2024-07-26 规则列表页面新增行为分类和批量配置字段`；文件头 `@author ggbdpq @since 2024-06-14`

```ts
export default function useHook() {
  const { riskLevelList, statistPeriodList, collectTypeList,
          auditDepartmentList, systemList: globalSystemList, systemReady } = globalStore.useSnapshot();
  const ruleDetailState = ruleDetailStore.useSnapshot();

  const [searchParams] = useSearchParams();
  const pageType = useCreation<PAGE_TYPE, URLSearchParams>(
    () => (searchParams.get('type') as PAGE_TYPE) || PAGE_TYPE.VIEW, [searchParams]);  // view/add/edit 三态复用一页
  const ruleId = useCreation<number, URLSearchParams>(() => +(searchParams.get('ruleId') || ''), [searchParams]);

  const [formData, setFormData] = useState<RuleInfo>(defaultFormData);
  const [originalFormData, setOriginalFormData] = useState<RuleInfo>(defaultFormData);  // 留底对比脏检查
  const [behaviorTagList, setBehaviorTagList] = useState<TagEnumData[]>([]);
```

点评：同一页面承载查看/新增/编辑三态，`originalFormData` 留底用于离开确认与回显 diff——表单页状态管理的成熟写法。

### 1.10 折线图 option 工厂（稀疏数据补零）

`src/pages/dashboard/helpers/option.ts`（10 次修改）
归属：`3deb882 2024-07-06 feat: 开发首页页面` → `f4e6af4 2024-07-19 完善首页-柱状图请求默认参数`

```ts
export const createLineChartOptions = (data: any[]) => {
  const flatData = data.flat();
  // 分组数据，按tagName分组
  const groupedData = flatData.reduce((acc, curr) => {
    if (!acc[curr.tagName]) acc[curr.tagName] = [];
    acc[curr.tagName].push(curr);
    return acc;
  }, {});
  // 提取时间轴数据，确保数据唯一且排序
  const xAxisData = [...new Set(flatData.map((dataPoint) => dataPoint.startTime))]
    .sort((a, b) => new Date(a) - new Date(b));
  // 构建series数据，使用映射填充count值，未定义则为0
  const dataPoints = xAxisData.map((startTime) =>
    timeCountMap[startTime] !== undefined ? timeCountMap[startTime] : 0);
  // 默认选中前10个图例
  const selected = {};
  legendData.forEach((name, index) => { selected[name] = index < 10; });
```

点评：后端给稀疏时间序列，这里补零对齐 x 轴 + 图例超 10 个自动折叠——图表数据清洗层独立成 helpers。

---

## 二、你写过的 Less/CSS 样式

19 个文件：`components/page-loading/index.less`、`components/search-form/index.css`、`layouts/*`、各 pages 的 index.less。SSAP 引入了 LESS（SCWF 全是纯 CSS）。

摘录 `src/pages/dashboard/index.less`（LESS mixin 抽象"白卡片浮起"）：

```less
.shadowMixin() {
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
  background-color: white;
  transition: box-shadow 0.3s ease;
  border-radius: 8px;
  margin: 0 12px;
}

.pieChartMixin {
  flex-grow: 1;
  flex-basis: 0;
  min-width: 300px;
  height: 464px;
  background: linear-gradient(180deg, #ffffff 0%, #f2f7fc 100%);
  border-radius: 8px;
}

.searchWrapper {
  .shadowMixin;          /* mixin 复用卡片阴影 */
  display: flex;
  padding: 10px 20px;
  margin-bottom: 8px;
}
```

点评：mixin 复用卡片阴影，仪表盘渐变底色比 SCWF 更精致。

---

## 三、项目配置与优化

1. **package.json**（`a695ea8` 加 echarts、`75bd683` 加 empty 组件）：React **18.3** + **TS ^5.4.5** + `@shein-lego/cli ^1.5.4`（新版，无 apis/ak.macro）+ `@shined/reactive ^0.1.3` + shineout 3.1 + eslint-plugin-react-hooks；同款 commitlint/husky/lint-staged 工程链。
2. **.legorc.ts**（`6a9a582 2024-07-04 变更系统为业务监控平台`、`1394139 2024-07-18 feat: 系统增加水印`）：

```ts
advanced: {
  analysis: { appId: '9f3f217a-...' },
  watermark: { env: 'latest' },          // 水印插件，内网防截图溯源
},
experiments: {
  legoFuture: {
    routes: { delay: 200, loading: '@/components/loading', hoc: '@/components/apm' }, // 路由级 APM HOC
  },
  lazyCompilation: true,
},
devServer: {
  port: 8888,
  proxy: { '/': { target: 'http://ssap-admin-cneast-test-backend.test.paas-test.sheincorp.cn/',
                  secure: false, changeOrigin: true } },   // 代理直接内置主配置
},
```

对比 SCWF：配置 API 全面换代（`html→htmls`、`defineInProcessEnv→define`），proxy 从 local 覆盖文件收进主配置。
3. **tsconfig.json**：`extends: ./src/.lego/config/base-tsconfig.json`（基座托管），只覆写 `target: es2015` 等 6 项——比 SCWF 手写全量更省心。
4. **node 版本锁定**：`3644415 2024-06-17 fix: 修改node版本为20.11.1`——进项目第一周锁定 CI/本地 node 大版本。
5. **SSO 切换**：`7f188dd 2024-06-17 feat: 采用新的单点登录`——sso-sdk 0.1.2 + ULP，与 fetch 层 AuthError 上抛配合。

---

## 四、值得回忆的提交瞬间

| hash | 日期 | subject |
| --- | --- | --- |
| `a4c4a99` | 2024-06-11 | feat: 安装dayjs第三方库，新增时间和日期辅助函数（**你在本仓库的第一笔**） |
| `d673977` | 2024-06-14 | feat: 搜索表单组件设计（自研通用组件的起点） |
| `84a83ee` | 2024-06-14 | feat: 规则详情页面开发 |
| `7f188dd` | 2024-06-17 | feat: 采用新的单点登录 |
| `3644415` | 2024-06-17 | fix: 修改node版本为20.11.1 |
| `4329542` | 2024-07-03 | feat: 开发权限配置页面 |
| `6a9a582` | 2024-07-04 | feat: 变更系统为业务监控平台 |
| `3deb882` | 2024-07-06 | feat: 开发首页页面（echarts 仪表盘） |
| `1394139` | 2024-07-18 | feat: 系统增加水印 |
| `bcd558b`/`c596523` | 2024-07-23/24 | 行为分类前端页面开发 / 采集来源页面开发以及接口联调 |

**一句话画像**：两个月从 dayjs 安装开始，交付了规则配置、审计事项、原始日志、权限配置、首页图表、采集来源、行为分类七大模块 + 请求层/全局store/级联筛选hook/搜索组件四层基建——这是你四年沉淀（BCP 的权限、DOMP 的图表、SCWF 的基建）的集大成之作，也是你自己代码被自己一代代重构的终点站：TS 4.6→5.4、React 17→18、redux→reactive、五连参数→options 对象。

# 03 · DOMP 研发运营管理平台 — 你的代码回忆录

> 仓库：`V:\程序开发\05-前端进阶\项目资产\05-广州希音[1.88GB]\03-研发运营管理平台[DOMP]\代码仓库\domp-front-20240811\domp-front`
> 你的提交：**603 / 1467**（2023-05-23 ～ 2024-08-06），全仓第一贡献者。首提交即 `0e245855 封装适用于数据管理模块的表单公共组件`，最后一笔 `161eaa3d 修复zIndex带来的问题`。
> 触碰 490 个文件，样式文件 138 处触碰。

**技术栈**：React 16.8.6（class + hooks 混用）、generator 风格自研 store（redux-saga 语义）、shineout 组件库（1.x→2.0）、echarts 5、dayjs + date-fns、Less/CSS Modules、@shein-lego 构建、`t()` i18n。

> **归属更正**：`src/hooks/usePrevious.js`、`useListHeight.js` 经 git 取证是同事 Eric Tan / 李根源写的，你是重度使用者（useEcharts 里大量用 usePrevious 做浅比较）。本篇只收录你亲笔的代码。

---

## 一、你写过的核心 JS/JSX 代码

### 1.1 ECharts 通用容器 base-chart（代表作）

`src/public-component/echarts/base-chart.jsx`（111 行）
归属：`f28cf81d 2023-07-14 重构目录结构`、`768c22cb 统一@路径`、`d5a69bbf 2023-07-24 修复base-chart的id问题`，全部 GYLJG-780

```jsx
useEffect(() => {
  if (cDom.current) {
    // 校验 DOM 节点上是否已经挂载了 ECharts 实例，只有未挂载时才初始化
    cInstance.current = echarts.getInstanceByDom(cDom.current);
    if (!cInstance.current) {
      cInstance.current = echarts.init(cDom.current, null, { renderer: 'svg' });
    }
    // 绑定鼠标点击事件
    cInstance.current.on('click', (event) => {
      if (event && onClick) onClick(event);
    });
    // 设置配置项
    options && cInstance.current.setOption(options);
  }
  return () => {
    // 容器被销毁之后，销毁实例，避免内存泄露
    cInstance.current.dispose();
  };
}, [cDom, options]);

// 监听窗口大小
useEffect(() => {
  const viewElem = cDom.current;
  const resizeObserver = new ResizeObserver(() => { debounceResize(); });
  resizeObserver.observe(viewElem);
  return () => { resizeObserver.unobserve(viewElem); };
}, []);

// 对父组件暴露获取 ECharts 实例的方法，可直接通过实例调用原生函数
useImperativeHandle(ref, () => ({ getInstance }));

export default React.memo(React.forwardRef(EChart));
```

点评：2023 年就写对的 echarts 封装范本——`getInstanceByDom` 防重复初始化、ResizeObserver + debounce 自适应（对应 React 性能守则的容器级监听去重）、`useImperativeHandle` 开实例逃生口、卸载 dispose 防内存泄露、最外层 `React.memo + forwardRef` 收口。

### 1.2 数据→配置的 useEcharts 模式

`src/pages/board/comprehensive/hooks/useEcharts.js`（118 行；board 下 8 个模块各一份同构）
归属：`e7978ff6 2023-09-15`、`80741391 修复Echart组件卸载重置数据问题`、`0e94fbc4 2024-01-04`

```js
const prevAddNumList = usePrevious(addNumList);
const prevCompleteNumList = usePrevious(completeNumList);
// ...

useEffect(() => {
  if (!isEqual(prevAddNumList, addNumList)) {
    setAddOption(echartsOption(addNumList, DEPT_PROJECT_TYPE.ADD_QUANTITY));
  }
}, [addNumList]);
```

点评：`usePrevious + lodash.isEqual` 做"数据真的变了才重算 option"，一个 useEffect 只监听一个数组（GYLJG-780 定下的写法约束）；每个 state 上方写 `/* 页面位置：xxx */` 中文定位注释，接口路径也注在解构处（`"项目一级页面吞吐" => "/query_project_first"`）——为联调的人着想。

### 1.3 公共表格 table.jsx（你改最多的公共组件，19 次）

`src/public-component/table/table.jsx`（303 行）
归属：`fd86df4e 2024-04-10 重构数据管理页面;完善Table增加请求完成函数`、`90190ef4 下放公共表格组件的列伸缩属性`

```js
async ({ pageNum = pageInfo.pageNum, pageSize = pageInfo.pageSize } = {}) => {
  try {
    if (!isReadyToFetch || loading) return;          // 提前退出 + 防连点
    setLoading(true);
    const params = isSetPagination ? { ...fetchParams, pageNum, pageSize } : fetchParams;
    const trimParams = isUseEmptyParams
      ? paramTrim(params)
      : clearEmpty(paramTrim(params));               // 参数清洗
    const { code, info, msg } = await fetchApi(trimParams);
    if (code === '0') {
      const formatList = formatListFunc ? formatListFunc(info) : info?.data || [];
      setList(formatList);
      setResData(info);
      if (isSetPagination) {
        const count = formatListCountFunc ? formatListCountFunc(info) : info?.meta?.count;
        setPageInfo({ ...pageInfo, pageNum, pageSize, count });
      }
    } else {
      Modal.error({ title: msg });
    }
  } catch (err) {
    Modal.error({ content: err?.msg || err?.reason?.message });
  } finally {
    setLoading(false);
    setSelectedRows([]);
    onFetchCompleted && onFetchCompleted();          // 请求完成回调（父组件可感知）
  }
},
```

点评：请求前洗参数、`code === '0'` 判成功、finally 统一清 loading 和选中行——把"每个列表页都该做的事"固化成一个组件。它直接调用了你写的 `deal-func.js` 的 `paramTrim/clearEmpty`，utils 和公共组件是配套设计的。

### 1.4 声明式表单 form.jsx（入职首周作品）

`src/public-component/form/form.jsx`（542 行，class 组件）
归属：`0e245855 2023-05-23 封装适用于数据管理模块的表单公共组件`（首提交）、`bb374951`、`119265cc 2024-04-29`

```js
/**
 * @description 全局表格组件
 * @param { Function } onSearch 搜索条件事件触发引用 必填
 * @param { Array } formItemArray 表单项 <item> 必填
 *  @eg formItemArray: [
    @————{
    @——————type: 'input',  // 输入框渲染类型
    @——————subFields: ['abc', 'cba', 'nba'] // 这些字段用来控制对应组件是否显示
    @————},
    @————{
    @——————type: 'select-dept',  // 部门下拉框渲染类型
    @——————subFields: ['dept', 'biz', 'sys', 'app']
    @————},
 * @————]
*/

// constructor 里手动给三个方法绑 debounce —— 老派 class 功底
this.getRecentYear = debounce(this.getRecentYear, 200);
this.getEnumInfo = debounce(this.getEnumInfo, 200);
this.getSearchInfo = debounce(this.getSearchInfo, 200);

getSearchInfo = (searchValue) => {
  const { formatFieldsMap, onSearch } = this.props;
  // 根据字典生成关系，生成符合onSearch默认搜索查询的参数
  const params = renameObjectProperties(searchValue, formatFieldsMap);
  onSearch(params);
};
```

点评：声明式 `formItemArray` 驱动表单渲染（type + subFields 控制显隐），配 ASCII 画的 `@—` 示例 JSDoc——入职一个月就敢写"配置即页面"的设计。

### 1.5 generator store（自文档化的状态层）

`src/pages/board/comprehensive/store.js`（1193 行，27 次触碰）
归属：`e825b3ad 2024-01-02` 等 GYLJG-2146/2155 系列

```js
export default {
  state: defaultState,
  changeData(state, data) { Object.assign(state, data); },

  /** 加载阈值配置 */
  * loadThresholdConfig() {
    const { deptInfoSelect } = yield '';
    yield getThresholdConfig(deptInfoSelect, PAGE_NAME.RD);
    // 只选中二级部门时，需要额外加载部分模块的阈值配置
    if (deptInfoSelect.length === 1) {
      yield getThresholdConfigByModule(PAGE_NAME.RD, t('稳定性'));
    }
  },

  // 页面初始化
  * init() {
    const { deptInfo } = yield navStore.getDeptData();
    const dataPermission = yield navStore.getDataPermission();
    if (dataPermission === DATA_PERMISSION.NONE) {
      Modal.error({ title: t('没有数据权限，请联系管理员维护后重试') });
      return;
    }
    const yearList = getYearList();
    const { deptSelect, deptSelectName } = getDeptSelect(deptInfo);
    navStore.changeData({ deptInfoSelectName: deptSelectName });
    yield this.changeData({ deptInfo, deptInfoSelect: deptSelect, deptInfoSelectOld: [deptInfo[0].id], yearList });
    yield this.loadThresholdConfig();
    yield this.fetchDemandsTypeEnum();
    yield this.search();
  },
```

点评：`* init()` 用 yield 串起"权限校验 → 枚举 → 阈值 → 搜索"的编排；defaultState 约 100 行**每个字段都带中文注释**（`loading: 1, // 0加载中 1加载成功 2加载失败`）——全仓库最典型的自文档化痕迹。

### 1.6 色块宽度动态计算

`src/pages/board/comprehensive/components/system-data/index.jsx`（32 次触碰）
归属：`92873287 2024-01-04 完善色块组件`、`e825b3ad 2024-01-02 动态计算宽度`

```jsx
// 动态计算系统数据-系统 色块宽度
const lengthCal = useMemo(() => {
  if (Array.isArray(sysList) && sysList.length > 0) {
    if (sysList.length > 2) { return 50; }
    if (sysList.length === 2) { return 40; }
  }
  return 30;
}, [sysList]);

<div className={styles.divWrapper} style={{ width: `${lengthCal}%` }}>
```

点评：用 useMemo 把"1 个系统占 30%、2 个占 40%、更多对半分"的产品规则收敛成纯函数（useMemo 缓存派生值，正是 React 性能守则 rerender 系的标准做法）——小而务实。

### 1.7 时间工具 date-helper（周数是主战场）

`src/utils/date-helper.js`（209 行，16 次触碰）
归属：`f44998cd 2024-06-26 修复近四周和近两周到默认上一周问题`、`4487d4d3 2024-06-27 修复上个月取数逻辑`

```js
// 引入 weekOfYear 插件 和 isoWeek 插件以兼容 ISO 周标准
dayjs.extend(weekOfYear);
dayjs.extend(isoWeek);

export const getLastWeeksDate = () => {
  // 假设我们按照 ISO 周来计算（即一年的第一个周四在该年的第一周内）
  const currentWeekNumber = dayjs().isoWeek();
  const lastWeeksNum = currentWeekNumber - 1;
  // 因为 Day.js 默认不支持直接格式化为 'YYYYWW'，我们需要手动构造
  const formatWeekOfYear = (year, week) => {
    const weekStr = week.toString().padStart(2, '0');   // 周数补零，如 '05'
    return `${year}${weekStr}`;
  };
  const lastWeekTime = formatWeekOfYear(dayjs().isoWeekYear(), lastWeeksNum);
  return { startTime: lastWeekTime, endTime: lastWeekTime };
};
```

点评：dayjs 管 ISO 周、date-fns 管格式化，手动构造 `YYYYWW` 周编码——连续三个 commit 都在修周/月边界。

### 1.8 参数清洗 deal-func（全文件 59 行）

`src/utils/deal-func.js`
归属：`e825b3ad`、`cad98167 2023-12-27 解决下钻跳转的空参数处理问题`

```js
export function clearEmpty(param, cludeArgs = []) {
  if (param instanceof Array) {
    return param.filter(v => v || cludeArgs.includes(v)).map(v => clearEmpty(v, cludeArgs));
  }
  if (param && typeof param === 'object') {
    const result = {};
    const keys = Object.keys(param);
    keys.forEach((key) => {
      if (param[key] || cludeArgs.indexOf(param[key]) > -1) {
        // 清除空数组
        if (!(Array.isArray(param[key]) && !param[key].length)) {
          result[key] = clearEmpty(param[key], cludeArgs);
        }
      }
    });
    return result;
  }
  return param;
}

export function getParamStr(params) {
  const paramsArray = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) {   // 明确只过滤 null，保留 0 和 ''
      paramsArray.push(`${key}=${encodeURIComponent(value || '')}`);
    }
  }
  return `?${paramsArray.join('&')}`;
}
```

点评：递归洗空值，`getParamStr` 只过滤 null、保留 0——与 commit"下钻跳转过滤掉 null"完全互证。

### 1.9 表格过滤器工厂 form-helper

`src/utils/form-helper.js`（43 行）
归属：`e3084e79 2024-04-23 统一管理搜索条件过滤函数`

```js
export const renameObjectProperties = (searchValue, formatFieldsMap = {}) => {
  const finalValue = {};
  Object.keys(searchValue).forEach((key) => {
    const mappedKey = formatFieldsMap[key] || key;
    finalValue[mappedKey] = searchValue[key];
  });
  return finalValue;
};

export const handleFilter =
  (dealField, isCaseSupport = true) =>
    (text) =>
      (row) => {
        const filterField = typeof dealField === 'function' ? dealField(row) : row[dealField];
        return isCaseSupport
          ? filterField?.toLowerCase?.()?.indexOf?.(text?.toLowerCase?.()) >= 0
          : filterField?.indexOf?.(text) >= 0;
      };
```

点评：三层柯里化 `(dealField) => (text) => (row)` 生成表格过滤器，全程 `?.` 防御。

### 1.10 帮助提示类型表 tip-helper

`src/utils/tip-helper.js`（420 行，13 次触碰）
归属：`534d0a49 GYLJG-1185 移动helpTipTypeRender函数到辅助方法目录`、`7d34e8aa GYLJG-2905`

```js
import { t } from '@shein-bbl/react';
import commonStyle from '@pages/common.less';

const helpTipTypeRender = (type) => {
  if (type) {
    switch (type) {
      case 'board-project':
        return {
          name: t('项目数据'),
          popoverStyle: commonStyle.popoverStyleTop,
          leftStyle: commonStyle.popoverContentleft,
          spanLeftStyle: commonStyle.popoverContentleftTwo,
          rightStyle: commonStyle.popoverContentright,
          spanRightStyle: commonStyle.popoverContentRightProject,
          iconStyle: { marginLeft: '5px', cursor: 'pointer' },
          idContainer: '#projectTip',
        };
```

点评：巨型 switch 把 30+ 个"温馨提示"的样式与 `#xxxTip` 容器 id 收敛成一张类型表——JS 与样式层的桥梁文件。

---

## 二、你写过的 Less/CSS 样式

40+ 个文件、138 处触碰，全部 .less/.css（CSS Modules），无 styled-components。Top：`system-data/index.less`(13)、`board/time/style.less`(8)、`board/comprehensive/style.less`(8)、`pages/common.less`(7)。

摘录 1 — `system-data/index.less`（`92873287`、`dfd45a10 2024-02-20 修复代码质量扫描发现的样式问题`）：

```less
@import "@less/constants/font.less";

/* 样式复用 */
.center {
  display: flex;
  /* 垂直居中 */
  align-items: center;
  /* 水平居中 */
  justify-content: center;
}

.iconLayout(@justifyContent: flex-start) {
  display: flex;
  justify-content: @justifyContent;
  padding: 0 30px;
}

.titleWrapper {
  .center();
  height: 30px;
  font-size: 15px;
  font-weight: bold;
}

.dialogTitle {
  line-height: 22px;
  font-size: 15px;
  font-family: @fontPingFang;
  font-weight: 500;
  color: #333E59;
  padding: 16px 0 0 0;
  margin: 0 0 10px 10px;
}
```

摘录 2 — `pages/common.less`（`be677161 2024-08-02 修复dev和test公共样式问题`）：

```less
.popoverStyle  { width: 70vw; background: #f6f6f6; padding-bottom: 20px; }
.popoverStyle1 { width: 1000px; }
.popoverStyleTop { width: 940px; }
```

点评：带参 less mixin（`.iconLayout(@justifyContent)`）用得地道；`common.less` 为每个页面的温馨提示浮层维护一族宽度类，与 tip-helper.js 的字段一一对应——样式即配置的一部分。

---

## 三、项目配置与优化

**你改过的配置**：package.json（15 次）、.eslintrc（6 次）、.legorc.dev/test.ts（SSO 切换）、src/server/fetch.js、echarts.config.js。**未触碰**：index.ejs（胡露/李根源）。

### 3.1 依赖治理四部曲（package.json）

| 提交 | 变更 | 目的 |
| --- | --- | --- |
| `09124522 2023-07-31` GYLJG-1185 | 删 moment，6 个业务文件替换 import | dayjs 取代 moment，减包体 |
| `8b195d03 2024-05-30` GYLJG-3061 | `+ decimal.js ^10.4.3` | 百分比精度，告别浮点误差 |
| `927456ce 2024-07-04` GYLJG-3571 | shineout ^1.12.22 → ^2.0.12 | UI 库大版本升级 |
| `cf8ce5c3`/`e2cb33dd`/`ed174258` 同周 | 变更列排序组件 → 降级 TableSorter → 修复动态列排序 | 升级后回滚止损："升了不对就先降回来" |
| `f76cb5ea 2024-08-01` GYLJG-3841 | sso-sdk ^0.0.8 → ^0.1.2 | 单点登录 SDK 升级 |
| `211a7ec3 2023-12-29` | 升级 TableColumnManager | Table 动态列 |

### 3.2 SSO 无感授权（删代码式优化）

`5e33b758 2024-03-18` GYLJG-2689，改动 `.legorc.dev/test.ts`（注入 LOGIN_ADDR）、package.json、fetch.js：

```js
// src/server/fetch.js（新增）
import SSOSDK, { AuthError } from '@shein-components/sso-sdk';
const sso = new SSOSDK({ ulpOrigin: process.env.LOGIN_ADDR });
// 旧代码：code==='400106' 时手拼 https + setTimeout 3 秒后跳 ULP —— 整段删除，替换为：
throw new AuthError('');
```

点评：把 30 行手写的"未登录跳 ULP"收敛成 SDK 抛 AuthError——你"删代码式优化"的最好样本。

### 3.3 .eslintrc（airbnb + prettier + 内部 bbl 三合一）

```jsonc
"extends": ["airbnb", "prettier", "plugin:@shein-bbl/bbl/pdcNewSDKConfig"],
"parser": "@babel/eslint-parser",
"max-len": [2, { "code": 120 }],
"max-params": [2, 4],
"@shein-bbl/bbl/translate-i18n-byT": [2, { "loose": true, "functionName": "t", "moduleNames": "@shein-bbl/react" }],
// 路径别名与 .legorc.ts 完全对齐
["@src", "./src"], ["@utils", "./src/utils"], ["@public-component", "./src/public-component"]
```

点评：你所有代码"中文注释 + 120 列 + 参数不超 4 个"的体感就来自这里。

### 3.4 .legorc.ts（lego 构建）

```js
entry: path.resolve(__dirname, './src/bbl.js'),
alias: { '@src': ..., '@hooks': './src/hooks/index.js', '@public-component': './src/public-component/' },
externals: { 'react': 'window.React', 'shineout': 'window.Shineout' },
html: { template: './index.ejs' },
```

归属：`3b6432e0 2023-07-14 修改lego的sit环境配置文件`、`5e33b758` 改 dev/test 的 LOGIN_ADDR。多环境 `.legorc.{dev,test,sit,pro}.ts` 靠 `-c` 切换。

---

## 四、值得回忆的提交瞬间

| hash | 日期 | subject |
| --- | --- | --- |
| `0e245855` | 2023-05-23 | 封装表单公共组件（**入职首提交**） |
| `09124522` | 2023-07-31 | 使用第三方库dayjs取代原先的momment库 |
| `f28cf81d` | 2023-07-14 | 重构目录结构，按需和规范放置非公共的页面配置文件 |
| `d5a69bbf` | 2023-07-24 | 修复base-chart的id问题（base-chart 定型之日） |
| `e825b3ad` | 2024-01-02 | 系统动态计算宽度;url 下钻跳转过滤掉null的情况 |
| `fd86df4e` | 2024-04-10 | 重构数据管理-慢SQL,可用性,响应时间页面;完善Table增加请求完成函数 |
| `5e33b758` | 2024-03-18 | 采用新单点登录方案，实现无感授权 |
| `8b195d03` | 2024-05-30 | 新增Decimal精度库和修改百分比显示 |
| `927456ce` + `e2cb33dd` | 2024-07-04 | 升级shineout版本 / 降级TableSorter（升级与回滚同日） |
| `161eaa3d` | 2024-08-06 | 修复zIndex带来的问题（**仓库内最后一次提交**） |

**一句话画像**：以"封装表单公共组件"进场，一年内把 echarts（base-chart）、表格（table.jsx）、搜索（form.jsx + form-helper）、参数清洗（deal-func）、时间（date-helper）、帮助提示（tip-helper）六件套沉淀进 utils 和 public-component，8 份同构 useEcharts 铺满数据看板；提交习惯 `[GYLJG-xxxx] type: 中文描述;`，代码习惯中文行注 + `?.` 防御 + usePrevious/isEqual 变更检测 + less mixin。

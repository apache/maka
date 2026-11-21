# 01 · BCP 预算管控平台 — 你的代码回忆录

> 仓库：`V:\程序开发\05-前端进阶\项目资产\05-广州希音[1.88GB]\01-预算管控平台[BCP]\代码仓库\bcp-front-20240811\bcp-front`
> 你的提交：497 次（2022-12-06 ～ 2023-05-15），全仓第一贡献者。**这是你入职后的第一个项目**，第一枪是 `30da84c6 feat: 开发年度预算管理-预算任务列表`，收官是 `341fc8c5 fix(common): 404页面优化`。

**技术栈**：lego 框架 + React + shineout 组件库 + `@shein-components/*` 私有组件 + pnpm + hash 路由 + CSS Modules。
**主战场**：`ruleconfig/control`（预算管控/分类树）、`organize/{year,month,week,tasklist}`（预算编制）、`todo/approve`（审批待办）、`manage/notice`（系统公告）、`manage/datalicensing`（数据授权）、`execute/detail`（执行明细）、`maindata/budget`（业务预算分类）。

---

## 一、你写过的核心 JS/JSX 代码

### 1.1 预算分类树遍历 traverseTree（递归版 + 堆栈版）

`src/component/ruleconfig/control/utils.jsx`
归属：`68398860 2023-04-06 开发预算管控三开关模块页面`、`65eb0f96 2023-03-01 使用堆栈重写traverseTree`

```jsx
export const traverseTree = (data, conditionFn, actionFn) => {
  if (data?.length > 0) {
    const recursionTree = (info) => {
      if (info?.length > 0) {
        info.forEach((item) => {
          if (conditionFn(item)) {
            actionFn(item);
          }
          if (item?.childList?.length > 0) {
            recursionTree(item.childList);
          }
        });
      }
      return false;
    };
    recursionTree(data);
    return data;
  }
  return null;
};

// 堆栈写法（当年那次"重写"最终以注释形式留在了文件里——一次自我迭代的化石）
// export const traverseTree = (data, conditionFn, actionFn) => {
//   if (!data || !data.length) { return null; }
//   const stack = [...data];
//   while (stack.length) {
//     const item = stack.pop();
//     if (conditionFn(item)) { actionFn(item); }
//     if (item.childList && item.childList.length) { stack.push(...item.childList); }
//   }
//   return data;
// };

// 提取所有的 Id（用于展开所有表格节点）
export const getAllKeysArr = (list) => {
  const allKeys = [];
  traverseTree(list, () => true, (item) => { allKeys.push(item?.cateId); });
  return allKeys;
};
```

点评：条件函数 + 动作函数解耦的遍历器，配合 `getNodeFromKey` / `getAllKeysArr` 两个复合用法，成为整个 BCP 树形数据的统一操作层。数据授权模块里还有一份孪生版（`datalicensing/utils.jsx`，唯一差异是 `cateId` 换成 `deptId`）——早期"复制微调"阶段的真实痕迹。

### 1.2 一键展开/收起（树表格标准解法）

`src/component/ruleconfig/control/components/treeList.jsx`（你 30 次提交的最高频文件之一）
归属：`51861d78 2023-05-12`、`f9b0056b 2023-05-12 周度临界告警比例问题`

```jsx
const [treeExpandKeys, setTreeExpandKeys] = useState([]);

// 实时展开表格树形数据
useEffect(() => {
  if (allCateKeys.length > 0) {
    setTreeExpandKeys(allCateKeys);
  }
}, [allCateKeys]);

<Button
  onClick={() => {
    if (isShow) { setTreeExpandKeys(allCateKeys); } else { setTreeExpandKeys([]); }
    setIsShow(!isShow);
  }}
>
  {isShow ? '一键展开' : '一键收起'}
</Button>
```

点评：`getAllKeysArr` + `treeExpandKeys` 的组合，后来被你复制到全站 10+ 个树表格（2023-02-16 一天 5 连发：年度/月度/周度/审批待办全线装上展开收起）。

### 1.3 标签页路由 routeTabs（特殊路由去重）

`src/component/nav/modules/routeTabs.jsx`（15 次提交）
归属：`8593bd4f 2023-04-04 切换标签，弹窗提示`、`167fd6fe 2023-02-14 回退默认路由标签不去重`

```jsx
const tabsFilter = (current) => {
  const info = tabs?.find?.((item) => item.path === current?.path);
  if (!info && current?.path) {
    setTabs((prm) => {
      const params = [...prm].filter((item) => {
        // 特殊路由去重 - 满足审批待办单据的上下单切换支持循环切换
        // 点击上一单/下一单直接在原页面的同一标签加载切换即可。
        // 以及点击驳回和批准的时候，也是在当前页面自动加载下一张单据
        if (
          (item?.path?.indexOf?.('/todo/approve/detail') !== -1 &&
            current?.path?.indexOf?.('/todo/approve/detail') !== -1) ||
          (item?.path?.indexOf?.('/todo/approve/already-done-detail') !== -1 &&
            current?.path?.indexOf?.('/todo/approve/already-done-detail') !== -1)
        ) {
          // 仅判断路由是否相同，不需要判断type
          const [currentHash] = current.path.split('?');
          const [preHash] = item.path.split('?');
          return currentHash !== preHash;
        }
        // ...
```

点评：一段长注释把"审批待办上一单/下一单复用同一标签"的业务规则写给三个月后的自己——典型"给自己回忆"式注释。

### 1.4 金额工具库 deal-money

`src/lib/deal-money.js`
归属：`da55ed76 2023-01-06 feat(execute): 开发预算执行管理页面`

```js
/** 金额千分位处理 */
export const formatNumDec = (number, length = 3, fix = 2) =>
  formatNum(numFixed(number, fix), length);

/** 数字转千分位 */
export const thousandsFormatter = (value) =>
  `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** 千分位转回数字 */
export const parserFormatter = (value) => value.replace(/(,*)/g, '');
```

点评：预算系统绕不开的金额格式化全家桶，是你写公共 lib 的起点。

### 1.5 按钮权限 isDisableByKey 的规模化应用

封装本体在 `src/lib/utils.js`（同事 luzhongwei 所写 `1e0a731c`，**如实备注：不是你写的**），你是它在 20+ 个模块的规模化应用者：

```js
// src/component/ruleconfig/control/utils.jsx —— 你的模块级应用
// 统一设置按钮权限
// Ps:之所以取反，在设置disabled的时候，有按钮权限把"!ture"变成"false"
const btnAuthOfList = isDisableByKey(store, '/ruleconfig/control/grid-list');
const btnAuthEditSys = isDisableByKey(store, '/ruleconfig/control/grid-edit_sys');
const btnAuthEditWarning = isDisableByKey(store, '/ruleconfig/control/grid-edit_warning');
```

对应 2023-01-30 一天内的 `feat(buttons)` 五连发（业务预算分类/年度预算任务/年月周方案/编制授权/数据授权），把按钮权限铺满全站。

### 1.6 金额单位切换（元/万元）

审批待办侧 `src/component/todo/approve/components/year/index.jsx`，归属 `0c4dd97c 2023-04-20`、`6e85d48b 2023-04-25 默认设置为切换为万元`：

```jsx
const [unit, setUnit] = useState('万元');          // 默认单位万元
const [buttonText, setButtonText] = useState('切换为元');

const onSwitchUnit = () => {
  if (unit === '元') {
    setUnit('万元'); setButtonText('切换为元');
  } else {
    setUnit('元'); setButtonText('切换为万元');
  }
};
```

编制侧 `src/component/organize/year/components/approverDetail.jsx`（`a2eec511 2023-04-19`）多一步树形换算：

```jsx
if (unit === '元') {
  setUnit('万元'); setButtonText('切换为元');
  setBudgetTree(yearNewAmountData(list));   // 编制页数字要真正除以 10000，不是只改文案
} else {
  setUnit('元'); setButtonText('切换为万元');
  setBudgetTree(list);
}
```

月/周共用的 `todo/approve/components/budgetTable.jsx` 是两条战线的交叉点：`isShow`（一键展开）和 `unit`（元/万元）两个状态在同一组件汇合，`useEffect` 监听 `[budgetInfo?.resultList, unit]` 重算列表。

### 1.7 系统公告弹窗（确认下一条）

`src/component/manage/notice/components/noticeModal.jsx`
归属：`b12c9dcc 2023-04-06 修复已发布已读，不显示确认下一条按钮`

```jsx
const NoticeModal = (props) => {
  const [hasLength, setHasLength] = useState(false);
  const [detail, setDetail] = useState();

  // 确认下一条的处理逻辑
  const onConfirmNext = async () => {
    const done = await Store.doConfirmNext({ id: noticeId });
    if (done) {
      setDetail(done);        // 没有下一条数据，置灰按钮
    } else {
      setHasLength(true);
    }
  };
```

点评：公告模块 3/21 ～ 4/6 两周 20+ 次提交，从列表页到全系统弹窗一条龙（铃铛提醒、emoji 过滤、标题空格过滤都在这一波）。

### 1.8 本地调试 token 写 cookie + APM 埋点注入

`src/component/nav/reducers.js`
归属：`5b59c82a 2023-02-21 fix(token): 修复BCP前端本地调试写入cookie`、`d3ed1532 2023-05-11 修复APM埋点问题，在用户鉴权成功第一时间处注入就行`

```js
// BCP前端本地调试写入cookie（给自己省事的本地联调后门）
if (process.env.NODE_ENV === 'development') {
  const { tokeninfo } = params?.match?.query || {};
  if (tokeninfo) {
    clearCookieOfUlpToken();
    document.cookie = `ulp_token=${tokeninfo};path=/;`;
    window.location.replace(window.location.origin);
  }
}
```

```js
// 设置缓存发送埋点，在用户鉴权成功第一时间处注入就行
conf({
  needCache: { request: 10, event: 10, pv: 10, leave: 10 },
  request: { threshold: 100, errorsIgnore: ['403'] },
  customAuthInfoSync: {
    name: this.state.userInfo?.name,
    enName: this.state.userInfo?.enName,
    emplid: this.state.userInfo?.emplid,
    systemName: 'BCP-AUTH',
  },
});
```

点评：后者是你 5/7～5/12 六连修 APM 的最终形态——commit message 本身就是注释。

---

## 二、你写过的 CSS 样式

触碰过 22 个样式文件（21 个 `.css` + 1 个 `.less`，无 scss/sass），全部是组件同目录 CSS Modules。Top3：`organize/tasklist/styles.css`(10)、`organize/styles.css`(9)、`ruleconfig/control/style.css`(7)。

摘录 1 — `organize/tasklist/styles.css`（`8122c27c 2023-05-03`）：

```css
.main {
  width: 100%;
  height: 100%;
  background-color: #fff;
  padding: 40px 25% 20px 25%;
  overflow-y: auto;
}

/* :global 深改 shineout 复选框选中态 */
.main :global(.so-checkinput-checked i.so-checkinput-checkbox.so-checkinput-indicator) {
  border-color: #197afa;
  background: #197afa;
}
```

摘录 2 — `ruleconfig/control/style.css`（`f9b0056b 2023-05-12`）：

```css
.radioStyle :global(.so-checkinput-group) { min-width: 88px; }
.radioStyle :global(.so-checkinput-radio-container) { margin-right: 0 !important; }
```

摘录 3 — `error/style.less`（`341fc8c5 2023-05-15`，全项目唯一 less，也是你在这个项目的收官提交）——13 层 text-shadow 做立体"404"：

```less
.block404 {
  span {
    text-shadow: 0 0 2px #686868, 0 1px 1px #ddd, 0 2px 1px #d6d6d6,
      0 3px 1px #ccc, 0 4px 1px #c5c5c5, 0 5px 1px #c1c1c1, 0 6px 1px #bbb,
      0 7px 1px #777, 0 8px 3px hsla(0, 0%, 39.2%, 0.4),
      0 9px 5px hsla(0, 0%, 39.2%, 0.1), 0 10px 7px hsla(0, 0%, 39.2%, 0.15),
      0 11px 9px hsla(0, 0%, 39.2%, 0.2), 0 12px 11px hsla(0, 0%, 39.2%, 0.25),
      0 13px 15px hsla(0, 0%, 39.2%, 0.3);
    font-size: 130px;
    font-weight: 700;
    color: #fff;
  }
}
```

---

## 三、项目配置与优化

| 配置动作 | 提交 | 内容与目的 |
| --- | --- | --- |
| PrivilegeManagement 2.0.17 | `4515ffb7 2023-04-07` | 权限组件升级 |
| swp 组件升级 | `56afab5d 2023-04-10` | 解决角色权限编辑复选框样式 + 全系统弹窗附件新开标签 |
| 锁定公共组件版本 | `9c4dfecc 2023-02-08` | 去浮动版本号保稳定 |
| 本地调试 token 写 cookie | `5b59c82a 2023-02-21` | nav/reducers.js 3 行解决本地拿不到登录态 |
| 构建别名迁移 | `ec6c3e4a 2023-04-12` | `.legorc.ts` +2 行注册 `utils`/`auth` 别名，随后把 120 行通用函数从页面目录迁到 `src/utils/maindata/budget/` |
| APM 埋点专项 | `c7080a63`～`0c77b8e4` 2023-05 六连 | adminName 字段 → 注入用户信息 → 非 LCD 首页 → 最终"鉴权成功第一时间注入" |
| 模板下载与批量导入 | `312cdef9`→`b368284a`→`04199920`→`9f2920b5` 2023-04 | 按钮 → 联调 → 大小写差异 → 失败原因弹窗（`batchImport.jsx` 里 `doDownloadFailFile({ downloadKey })` 下载失败明细） |
| 页面级 me.json | 25 个 | lego 框架页面行为开关，如 `{ "mobx": true }` |

构建别名 diff：

```js
// .legorc.ts
+    utils: path.resolve(__dirname, './src/utils/'),
+    auth: path.resolve(__dirname, './src/utils/auth/'),
```

---

## 四、值得回忆的提交瞬间

| hash | 日期 | subject |
| --- | --- | --- |
| `30da84c6` | 2022-12-06 | feat: 开发年度预算管理-预算任务列表（入职第一枪） |
| `b8d73272`~`ed2e6029` | 2023-02-16 | 一天 5 连发：全站树表格"一键展开和一键收起" |
| `5b59c82a` | 2023-02-21 | fix(token): 修复BCP前端本地调试写入cookie |
| `65eb0f96` | 2023-03-01 | fix(ruleconfig): 使用堆栈重写traverseTree |
| `91a905c4`/`6ed8e0c6` | 2023-03-21/04-03 | 系统公告列表初始化 → 全系统页面公告弹窗 |
| `312cdef9` | 2023-04-11 | feat(budget): 新增模版下载和批量导入分类按钮 |
| `a2eec511`/`fe8a6927`/`0c4dd97c` | 2023-04-19~20 | 三天三连：编制/执行明细/审批待办全线金额单位切换 |
| `56afab5d` | 2023-04-10 | feat(swp): 升级swp组件版本 |
| `d3ed1532` | 2023-05-11 | fix(common): 修复APM埋点问题，在用户鉴权成功第一时间处注入就行 |
| `341fc8c5` | 2023-05-15 | fix(common): 404页面优化（本项目收官） |

**一句话画像**：12 月从预算任务列表起步，2 月给全站树表格装上展开/收起，3 月用 traverseTree 和恢复默认按钮打磨预算管控，4 月给全站金额装上元/万元切换并铺满按钮权限，5 月收尾于 APM 埋点和 404 立体字——递归遍历、"一键展开"、权限应用是你留下的三类最深指纹。

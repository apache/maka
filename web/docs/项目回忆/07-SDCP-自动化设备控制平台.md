# 07 · SDCP 自动化设备控制平台（管理端）— 你的代码回忆录

> 仓库：`V:\程序开发\05-前端进阶\项目资产\05-广州希音[1.88GB]\07-自动化设备控制平台[SDCP]\代码仓库\sdcp-admin-front-20240811\sdcp-admin-front`
> 你的提交：37 次（2023-10-11 ～ 2024-08-05）。主线是 GYLJG-1508（设备管理与指令模块），后续做了 bbl 多语言和新单点登录迁移。

**技术栈**：React 17 + TypeScript + shineout + @shein-lego（ak/ak.macro/use/styled）+ @shined/reactive + redux + react-router 6 + @shein-bbl/react 多语言 + sso-sdk + sheinq APM。
**高频文件**：`device-manage/list`(15)、`device-manage/detail`(12)、`task-manage/send/list`(10)、`types/response-type.ts`(9)、各页 index.hook.tsx。

---

## 一、你写过的核心 TS/TSX 代码

### 1.1 设备 IP 拆成 4 个 Input + 双层校验（本仓最见心思的一笔）

`src/pages/device-manage/detail/index.tsx`
归属：`55e3b8b 2023-10-13 拆分设备IP为4个Input组件;给变量、函数声明增加数据类型`、`b045fc6 修复IP表单校验`

```tsx
const onSubmitForm = usePersistFn(async (data: DeviceInfo) => {
  const originalDeviceIp = Object.values(data.deviceIp);
  const isIpEmpty = originalDeviceIp.every((v) => v === '');
  const deviceIp = isIpEmpty ? '' : originalDeviceIp?.map((item) => +item)?.join('.');
  // 提取部分有效的表单数据，并设置表单提交数据
  const { bizSystem, deviceCode, deviceStatus, deviceType, id } = data;
  const commonData = { deviceStatus, deviceType, deviceIp };
  const submitData = isAddPageType(pageType)
    ? { bizSystem, deviceCode, ...commonData }
    : { id, ...commonData };
  const fetchApi = isAddPageType(pageType) ? fetchAddDevice : fetchUpdateDevice;
  const done = await fetchApi(submitData);
  if (done) {
    await Message.success(t(`${pageType === 'add' ? '新增' : '修改'}${t('设备成功')}`));
    backToDeviceList();
  }
});

const rule = Rule({
  // 设备IP数值范围为0-255
  isIpInRange: {
    func: (value, _, callback) => {
      const intValue = parseInt(value, 10);
      if (intValue >= 0 && intValue <= 255) {
        callback(true);
      } else if (value === '') {
        callback(true);          // 可以不填
      } else {
        callback(new Error(t('设备IP数值范围为0-255')));
      }
    },
  },
  // 设备IP必须填写完整
  isIpComplete: {
    func: (value, _, callback) => {
      const deviceIp = Object.values(value);
      const isIpEmpty = deviceIp.every((v) => v === '');
      const isIpError = !isIpEmpty && deviceIp.some((v) => v === '');
      if (isIpError) {
        callback(new Error(t('请输入正确的设备IP')));
      } else {
        callback(true);
      }
    },
  },
});
```

渲染侧，`Form.FieldSet` 包住 4 个 Input，中间补 `.`：

```tsx
<Form.Item label={t('设备IP')}>
  <Form.FieldSet name='deviceIp' rules={[rule.isIpComplete()]}>
    <>
      {Object.keys(deviceIp).map((item: string, index: number) => (
        <div className={styles.ipItemWrapper} key={item}>
          <Input type='number' name={item} width={45} trim
            integerLimit={3} digits={0} rules={[rule.isIpInRange()]} />
          {index < 3 && <div className={styles.ipPoint}>.</div>}
        </div>
      ))}
    </>
  </Form.FieldSet>
</Form.Item>
```

点评：单格校验 0-255 + 整组"要么全空要么填满"双层规则，提交时再合回 `a.b.c.d`——表单校验设计的小型教科书。

### 1.2 设备详情 hook：PAGE_TYPE 状态机 + useHook 命名

`src/pages/device-manage/detail/index.hook.tsx`（文件头署名 `@author ggbdpq`）
归属：`1dc16c5`（初建）、`15abfe1 2024-04-08 变更变量命名useHooks为useHook`

```ts
export const enum PAGE_TYPE {
  VIEW = 'view',
  ADD = 'add',
  EDIT = 'edit',
}

const isViewPageType = (type: PAGE_TYPE): boolean => type === PAGE_TYPE.VIEW;
const isAddPageType = (type: PAGE_TYPE): boolean => type === PAGE_TYPE.ADD;
const isEditPageType = (type: PAGE_TYPE): boolean => type === PAGE_TYPE.EDIT;

export default function useHook() {
  const { systemReady } = globalStore.useState();
  const deviceDetailState = deviceDetailStore.useSnapshot();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // 从url中获取页面类型
  const pageType = useCreation<PAGE_TYPE, URLSearchParams>(
    () => (searchParams.get('type') as PAGE_TYPE) || PAGE_TYPE.ADD,
    [searchParams],
  );
  const deviceId = useCreation<string, URLSearchParams>(
    () => searchParams.get('deviceId') || '',
    [searchParams],
  );
```

点评：view/add/edit 三态全靠 URL 驱动，useCreation 缓存解析结果——2024 年那笔提交专门把 `useHooks` 统一改名 `useHook`，对命名较真。

### 1.3 动态路由权限校验（前端小型路由权限网关）

`src/helpers/permission.ts`
归属：`4a0a127 2023-11-03 优化校验页面匹配动态路由的权限`

```ts
export const checkPagePermission = (pathname: string) => {
  if (['/', '/dashboard'].includes(pathname)) return true;
  const { permissionMap } = globalStore.getState();
  let permission = permissionMap.get(pathname);

  // 匹配动态路由
  if (!permission) {
    for (const [key, value] of Array.from(permissionMap.entries())) {
      // 如果是动态路由
      if (/^(\/\w+)*(\/:\w+)+$/.test(key)) {
        const pathnameReg = new RegExp(key.replace(/:\w+/g, '\\w+'));
        if (pathnameReg.test(pathname)) {
          permission = value;
          break;
        }
      }
    }
  }
  return !!permission && [PERMISSION_TYPE.MENU, PERMISSION_TYPE.SUB_MENU].includes(permission.type);
};
```

点评：精确匹配不中时，把 `/task-manage/callback/detail/:taskId` 这类权限 key 编译成正则再匹配。

### 1.4 登录失效跳当前页 + sso-sdk

`src/fetch/index.ts`
归属：`dd70e6a 2023-10-19 实现登录失效自动跳转到当前页`、`df9e059 2024-06-06 改用新的单点登陆方式`、`beaf8d3 sso-sdk 0.1.2`

```ts
const sso = new SSOSDK({ ulpOrigin: process.env.LOGIN_ADDR });

// request 内部：
const { code, msg, info } = formatResData;
if (code === '0') { return info || {}; }
if (ERROR_MSG[code]) {
  Message.error(t(ERROR_MSG[code]));
  // 如果出现未登录，跳转到ULP
  if (code === ERROR_CODE.NOT_LOGIN) { throw new AuthError(''); }
} else { throw new Error(msg); }
```

```ts
const wrapGet = sso.wrapRequest(get);
const wrapPost = sso.wrapRequest(post);
export { request, wrapGet as get, wrapPost as post };
```

点评：业务层只管抛 AuthError，重定向回当前页由 `sso.wrapRequest` 统一接住——这套三层结构后来原样搬进了 SIAM 和 SSAP。

### 1.5 bbl 多语言入口：npid 双环境隔离

`src/shein-bbl-entry.ts`
归属：`4773b05 2024-04-07 修复bbl中npid属性区别不同开发环境的问题`、`37a8fec 完善bbl相关设置`

```ts
import { configure } from '@shein-bbl/react';
import { getLocaleLanguage } from '@/helpers/shein-bbl';

const isTest = ['dev', 'test'].includes(process.env.RUN_ENV);

configure({
  npId: isTest ? 1000161 : 459,             // 系统id：测试/生产隔离字条
  env: isTest ? 'test' : 'production',
  enableMissingReport: isTest,              // 字条缺失上报
  enableUsedReport: true,
  locale: getLocaleLanguage('bbl'),
  fallback: getLocaleLanguage('bbl'),
  projectName: 'sdcp-admin',
})
  .catch((e) => { console.error(e); })
  .finally(() => { require('./index'); });  // 翻译资源加载完才启动应用
```

点评：`configure().finally(() => require('./index'))`——翻译资源就绪才启动应用，dev/test 与生产用不同 npId。

### 1.6 回调指令记录列表（13 列大表）

`src/pages/task-manage/callback/list/index.tsx`
归属：`96c0b8b 2023-10-18 开发回调指令记录相关页面`、`a396f24 操作编码改名为指令类型`

```tsx
const renderStatus = (status: number) => {
  const cmdStatus = statusList?.find((item) => +item.value === status);
  const tagType = { 10: 'initTag', 20: 'successTag', 30: 'errorTag' };
  return <Tag className={styles[`${tagType[cmdStatus?.value]}`]}>{cmdStatus?.label}</Tag>;
};
```

```tsx
<DatePicker
  clearable inputable range itemClass={styles.datePicker}
  label={t('创建时间')} name={['startTime', 'endTime']} type='datetime'
  defaultTime={['00:00:00', '23:59:59']}
  placeholder={[t('请选择起始时间'), t('请选择截止时间')]}
  disabled={(d, type, start, end) => checkDuration(d, type, start, end, 365)}
  quickSelect={quickSelect}
/>
```

点评：含 TraceId、重试次数、转发时间的 13 列大表；状态 10/20/30 映射三种 Tag；`send/detail` 页引入 react-json-view 展示指令报文。

### 1.7 菜单激活判断 checkActive

`src/layouts/menu/index.hook.tsx`
归属：`6b3019b 优化左侧菜单的checkActive函数`、`43f7b10 修复收起样式渲染问题`

```ts
const checkActive = usePersistFn((d: MenuItem) => {
  return (
    menuState.activePath === d.path ||
    (menuState.activePath.indexOf(d.path) === 0 &&
      menuState.activePath.replace(d.path, '').indexOf('/') === 0)
  );
});
```

点评：前缀匹配 + 强调"剩余部分必须以 / 开头"，避免 `/a` 误激活 `/abc`。

### 1.8 日期辅助 quickSelect

`src/helpers/date.ts`（文件头 `@author ggbdpq`）
归属：`a75e939 2023-10-17 开发下发指令列表;增加dayjs和react-json-view相关依赖`

```ts
export const today = new Date();
export const formatStart = 'YYYY-MM-DD 00:00:00';
export const formatEnd = 'YYYY-MM-DD 23:59:59';

export const quickSelect = [
  { name: t('昨天'), value: [dayjs(today).subtract(1, 'day').format(formatStart),
                             dayjs(today).subtract(1, 'day').format(formatEnd)] },
  { name: t('近一周'), value: [dayjs(today).subtract(7, 'day').format(formatStart), dayjs(today).format(formatEnd)] },
  { name: t('近90天'), value: [dayjs(today).subtract(90, 'day').format(formatStart), dayjs(today).format(formatEnd)] },
];
```

---

## 二、你写过的 CSS 样式

全部为 CSS Modules `.css`：`device-manage/detail/index.css`(4)、`task-manage/send/list/index.css`(3)、`dashboard/index.css`(3)、`send/detail`、`callback/list`、`callback/detail`、`device-manage/list`、`_404.css`、`layouts/{index,header}/index.css`。

摘录 `device-manage/detail/index.css`（IP 点号与底部固定按钮）：

```css
.bottomBtnContain {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 64px;
  box-shadow: 0 -5px 10px 0 #f5f5f5;
}

.ipItemWrapper {
  display: inline-flex;
  align-items: flex-end;
  text-align: center;
}

.ipPoint {
  width: 10px;
  height: 20px;
  font-weight: bold;
}
```

---

## 三、项目配置与优化

| 配置动作 | 提交 | 内容与目的 |
| --- | --- | --- |
| sso-sdk 引入与升级 | `df9e059`/`beaf8d3` | `@shein-components/sso-sdk` → ^0.1.2，单点登录换代 |
| dayjs + react-json-view | `a75e939` | 指令列表时间处理 + 指令 JSON 可视化 |
| API 白名单 | `bf83f04` `src/constants/api-whitelist.ts` | 登出等接口豁免 checkApiPermission |
| bbl 系统级配置 | `4773b05`/`37a8fec` | shein-bbl-entry.ts：npid 1000161/459 双环境 |
| shineout 跟随 bbl | `c4bc1f8 2024-04-09` | 改 src/index.tsx，组件库语言包切换 |

当前依赖快照：`@shein-bbl/react ^1.0.1`、`@shein-lego/ak ^0.2.2`、`@shined/reactive ^0.0.11`、shineout ^2.0.7、pnpm@8.6.5。

---

## 四、值得回忆的提交瞬间

| hash | 日期 | subject |
| --- | --- | --- |
| `55e3b8b` | 2023-10-13 | feat(device-manage): 拆分设备IP为4个Input组件;给变量、函数声明增加数据类型 |
| `1dc16c5` | 2023-10-12 | feat(device-manage): 开发新增/编辑/查看详情页；新增表单文本显示组件 |
| `a75e939` | 2023-10-17 | feat(task-manage): 开发下发指令列表;增加dayjs和react-json-view相关依赖 |
| `96c0b8b` | 2023-10-18 | feat(task-manage): 开发回调指令记录相关页面 |
| `dd70e6a` | 2023-10-19 | refactor: 实现登录失效自动跳转到当前页 |
| `4a0a127` | 2023-11-03 | refactor: 优化校验页面匹配动态路由的权限 |
| `7d44e5a` | 2023-12-05 | fix: 点击搜索发送请求,手动重置页码和条数 |
| `4773b05` | 2024-04-07 | refactor: 修复bbl中npid属性区别不同开发环境的问题 |
| `df9e059` | 2024-06-06 | feat(sso): 改用新的单点登陆方式 |

**一句话画像**：一个月内从设备管理做到指令下发/回调全链路——IP 四格校验、动态路由权限、登录失效回当前页是三处签名；次年再回来做的是 bbl 多语言和 sso 换代，说明这个平台的"地基"也是你打的。

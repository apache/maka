# 09 · SIAM 身份认证系统 — 管理端（siam-admin-front）— 你的代码回忆录

> 仓库：`V:\程序开发\05-前端进阶\项目资产\05-广州希音[1.88GB]\09-身份认证系统[SIAM]\代码仓库\siam-admin-front-20240811\siam-admin-front`
> 你的提交：9 次（2024-01-03 ～ 2024-04-09）。提交不多，但每一笔都是"接手后的代码洁癖大扫除"——修 fetch 预处理、修 sort 变异、删 331 行 mock、补接口注释。

**技术栈**：与 SDCP 同族——React + TypeScript + shineout + lego + ak/redux + bbl + sso-sdk。
**高频文件**：`system-manage/list/index.hook.tsx`(5)、`notice-manage/detail/*`(3)、`src/fetch/index.ts`(2)。

---

## 一、你写过的核心 TS/TSX 代码

### 1.1 通知管理详情页（三段式卡片）

`src/pages/notice-manage/detail/index.tsx`（文件头 `@author ggbdpq, since 2024-01-08`）
归属：`4536d5e/e08f006 2024-01-08 详情页开发`、`a417859 2024-01-09 增加通知详情栅格间距样式`

```tsx
return (
  <div className={styles.page}>
    {renderButton()}
    {!isEmptyData ? (
      <>
        <div className={styles.title}>{t('通知详情')}</div>
        <div className={styles.detailWrapper}>
          <Grid gutter={16}>
            <Grid className={styles.grid} width={1 / 3}>{t('通知标题：')}{title}</Grid>
            <Grid className={styles.grid} width={1 / 3}>{t('状态：')}{NOTICE_STATUS_MAP[status]}</Grid>
            <Grid className={styles.grid} width={1 / 3}>{t('发送时间：')}{sendTime}</Grid>
            <Grid>{t('发送方式：')}{SEND_TYPE_MAP[sendType]}</Grid>
          </Grid>
        </div>

        <div className={styles.title}>{t('发送统计')}</div>
        <div className={styles.detailWrapper}>
          <Table className={styles.table} bordered width={480} keygen='id'
            columns={columns} data={data} empty={t('暂无数据')} />
        </div>

        <div className={styles.title}>{t('通知内容')}</div>
        <div className={styles.detailWrapper}>
          <Textarea value={content} autosize rows={8} disabled />
        </div>
      </>
    ) : (
      <div className={styles.emptyData}>{t('无数据，请联系系统管理员')}</div>
    )}
  </div>
);
```

点评：通知详情栅格 / 发送统计小表 / 只读 Textarea 三段式，第二天专门补了一笔栅格间距样式。

### 1.2 fetch 预处理函数修复（数组解构 → 具名对象）

`src/fetch/index.ts`
归属：`bde7208 2024-04-03 修复fetch的预处理函数问题`，diff 逐字：

```diff
-function handleRequestData(
+function preprocessRequestData(
   url: string,
   data: Record<string, any>,
   options: Record<string, any>,
-): [string, Record<string, any>] {
+): { uri: string; config: Record<string, any> } {
   const config = cloneDeep(options);
   let uri = url;
   if (options.method === 'GET') {
@@
-  return [uri, config];
+  return { uri, config };
 }
@@
-    const [uri, config] = handleRequestData(url, data, options);
+    const { uri, config } = preprocessRequestData(url, data, options);
-    } catch (_error) {
+    } catch {
```

点评：把"数组解构 + 下标约定"换成"对象返回 + 具名解构"——修的其实是可读性/语义 bug：`[uri, config]` 的位置耦合很容易被改错顺序。修复后的函数体就是 SDCP 同款 GET 拼 query / POST JSON.stringify + camel2Under。

### 1.3 sort 函数用法修复（一行写进新人手册）

`src/pages/notice-manage/send-notice/index.hook.tsx`
归属：`6e67e04 2024-04-03 增加必要请求接口注释;…修复sort函数用法;增加404页面的bbl`

```diff
-      const sortedData = data.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
+      const sortedData = [...data].sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
```

修复后上下文（当前 138-142 行）：

```ts
const sortedData = [...data].sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
if (pageNum === 1) {
  changeUserList(sortedData);
} else {
  changeUserList([...sortedData, ...userList]);
}
```

点评：`sort` 原地变异 React 状态数组，浅拷贝后再排——经典一行。同笔 commit 还删掉了 317 行 mock 数据、把 ColumnItem 补上泛型。

### 1.4 shineout 组件跟随 bbl 切换语言

`src/index.tsx`
归属：`c2cc993 2024-04-09`

```tsx
import './index.css';
import { render } from 'react-dom';
import { enableTrace } from 'sheinq';
import { setConfig, setLocale } from 'shineout';
import App from '@@/routes';
import { getLocaleLanguage } from '@/helpers/shein-bbl';

// 设置全链路埋点
enableTrace(1);

/** 设置 shineout 组件默认语言包 */
setLocale(getLocaleLanguage('shineout') || 'zh-CN');

setConfig({ delay: 0 });
render(<App />, document.getElementById('app'));
```

点评：`t()` 只管业务文案，日期/分页等组件内文案要靠 `setLocale` 单独喂——补上了组件库层的多语言盲区。

### 1.5 接入系统列表页（截断 + Popover 全量）

`src/pages/system-manage/list/index.hook.tsx`
归属：`526dc37 2024-01-03 feat: 接入系统列表页面开发`

```tsx
{
  title: t('系统负责人'),
  width: 200,
  render: (record) => {
    const managers = (record.systemManagers || []).map((n) =>
      n.id ? `${n.username}(${n.id})` : n.username,
    );
    return (
      <>
        <p className={styles.managerContent}>{managers.join(', ')}</p>
        {managers.length ? (
          <Popover>
            <div className={styles.managerList}>
              {managers.map((n) => (
                <p className={styles.managerItem} key={n}>{n}</p>
              ))}
            </div>
          </Popover>
        ) : null}
      </>
    );
  },
},
```

点评：超宽负责人列表"截断 + Popover 全量"的经典解法。

---

## 二、你写过的 CSS 样式

清单：`notice-manage/detail/index.css`(2)、`system-manage/{list,detail}/index.css`、`user-manage/{list,detail}/index.css`、`layouts/menu/index.css`。

摘录 `notice-manage/detail/index.css`（`4536d5e`）：

```css
.detailWrapper {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 16px;
  margin: 0 16px;
  font-size: 14px;
  color: #333e59;
  word-wrap: break-word;
  background-color: #fff;
  border: 1px solid #e8ebf0;
  border-radius: 8px;
}

.grid { margin-bottom: 16px; }
```

（`.grid { margin-bottom: 16px; }` 正是 `a417859`"栅格间距样式"的落点。）

---

## 三、项目配置与优化

- **请求层重构双笔**：`6e67e04`（注释/删 mock/降复杂度）+ `bde7208`（预处理函数改对象返回），并接 sso-sdk（同 SDCP 模式：`new SSOSDK({ ulpOrigin: process.env.LOGIN_ADDR })` + `wrapRequest`）。
- **代码洁癖大扫除**（`6e67e04` 一次提交）：删 `src/data/{permission,user}.json` 共 331 行模拟数据、增加 `api/{user,system,notice,admin}.ts` 接口注释、`_404.tsx` 加 bbl。
- **empower.js**（1 次）：埋点/授权配置脚本。
- 本仓无 CI/Docker 文件改动（走 lego 标准管线）。

---

## 四、值得回忆的提交瞬间

| hash | 日期 | subject |
| --- | --- | --- |
| `526dc37` | 2024-01-03 | feat: 接入系统列表页面开发 |
| `4536d5e` | 2024-01-08 | feat: 通知管理模块详情页面开发 |
| `a417859` | 2024-01-09 | refactor: 增加通知详情栅格间距样式 |
| `7f30480` | 2024-04-02 | refactor: 消除已经注释和暂时无用的代码 |
| `6e67e04` | 2024-04-03 | refactor: 增加必要请求接口注释;…修复sort函数用法;增加404页面的bbl |
| `bde7208` | 2024-04-03 | refactor: 修复fetch的预处理函数问题 |
| `c2cc993` | 2024-04-09 | refactor: 设置shineout组件跟随bbl切换语言 |

**一句话画像**：提交最少的一个仓库，但密度最高——三天里把接手代码的 fetch 预处理语义、sort 变异、mock 残留、注释缺失一次清干净，是"代码洁癖"最集中的一次展示。

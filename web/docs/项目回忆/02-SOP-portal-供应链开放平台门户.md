# 02 · SOP 门户（sop-portal-front）— 你的代码回忆录

> 仓库：`V:\程序开发\05-前端进阶\项目资产\05-广州希音[1.88GB]\02-供应链开放平台[SOP]\代码仓库\sop-portal-front-20240811\sop-portal-front`
> 你的提交：101 次（2023-06-06 ～ 2024-05-31）。第一笔是 `0882aae feat: 新增jsencrypt依赖，对邮箱登录/用户名登录/忘记密码进行RSA加密`。

**技术栈**：React 16.8 + react-redux + shineout + rrc-loader-helper（generator 风格 reducer store）+ webpack + @shein-bbl/react（i18n `t()`）+ jsencrypt + crypto-js + sheinq APM。
**主打方向**：RSA 加密与邮箱校验（2023-06）→ APM 埋点（2023-06）→ 全量 ESLint 治理 perf_20230711（2023-07~08）→ UI 橙红改版 + home/nav 重构 GYLJG-1419（2023-09）→ sonar 质量治理 GYLJG-2310（2024-01）→ 登录模块改造 GYLJG-3210（2024-05）。

---

## 一、你写过的核心 JS 代码

### 1.1 RSA 多环境公钥加密

`src/lib/encrypt-rsa.js`
归属：`0882aae 2023-06-06`（引入）、`a7308a2/7ad6efb/290a1af 2023-07-03`（三连换密钥）

```js
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

export default {};  // 让 HMR/校验工具不报默认导出缺失
```

点评：`BUILD_ENV` 切换 dev/test/sit/prod 四套 PEM 公钥（文件前部内联）。这份文件与 platform 管理端的 `src/utils/encrypt-rsa.js` 是同源双胞胎——两个仓库同一套加密口径。

### 1.2 全局统一邮箱校验规则

`src/lib/utils/constant.js`（全文 3 行）
归属：`6c72bd1 2023-06-15 设置变量全局统一管理邮箱校验规则`、`f038806 2023-06-30 GYLJG-1089 统一修改邮箱校验规则`

```js
export const emailRegRule = /^[\w-]+(\.[\w-]+)*@[\w-]+(\.[\w-]+)*(\.[\w-]{2,})$/;

export default {};
```

点评：GYLJG-1089 的落点——把散落各页面的邮箱正则收敛成一个全局常量。

### 1.3 带次数限制的 throttle（业务版防刷）

`src/lib/utils/dealFunc.js`
归属：`806687d 2024-01-16 优化throttle函数`（sonar 治理期）

```js
/**
 * 节流函数——限制一个函数在一定时间内只能执行一次
 * @param {*} cb 调用函数
 * @param {*} wait 等待时间
 * @param {*} timesLimit 限制次数
 */
export const throttle = (cb, wait = 1000, timesLimit = 2) => {
  let timeoutId = null;
  let callCount = 0;
  return function (...args) {
    if (timeoutId && callCount >= timesLimit) {
      Modal.error({ title: t('请勿频繁点击!'), maskCloseAble: false });
      return;
    }
    callCount += 1;
    if (!timeoutId) {
      timeoutId = setTimeout(() => {
        clearTimeout(timeoutId);
        timeoutId = null;
        callCount = 0;
      }, wait);
    }
    cb.apply(this, args);
  };
};
```

同文件还有密码校验（sonar 治理时的 `no-useless-escape` 注释原样保留）：

```js
export const passReg = (password) => {
  const a = /[a-z]+/;      // 包含小写字母
  const b = /[A-Z]+/;      // 包含大写字母
  const c = /\d+/;         // 包含数字
  // eslint-disable-next-line no-useless-escape
  const d = /[。，、；：？！“（）《》.?!,:;\[\]{}/\\()`"'~@#$￥%&*+=_|<>”]/; // 包含常用符号
  const e = /[\u4e00-\u9fa5]/; // 不包含汉字
  const len = (password?.length < 8) || (password?.length > 20);
  return a.test(password) && b.test(password) && c.test(password) && d.test(password) && (!e.test(password)) && !len;
};
```

点评：不是教科书 throttle，是"1 秒窗口内最多点 2 次、超了直接弹 Modal"的防刷，专治验证码按钮狂点。

### 1.4 camel2Under 复杂度优化

`src/lib/camal-case-convertor.js`
归属：`232cba4 2024-01-16 降低代码复杂度;优化camel2Under函数处理逻辑`

```js
export const camel2Under = function camel2Under(target) {
  if (typeof target === 'string') {
    return target.replace(
      /([a-z])([A-Z])/g,
      (_, letter1, letter2) => `${letter1}_${letter2.toLowerCase()}`,
    );
  }
  if (target instanceof Array) {
    return target.map((item) => camel2Under(item));
  }
  if (typeof target === 'object' && target !== null) {
    const resultObj = {};
    Object.keys(target).forEach((key) => {
      const newkey = camel2Under(key);
      let value = target[key];
      if (
        (typeof value === 'object' && !(value instanceof Array)) ||
        (value instanceof Array && value.length > 0 && typeof value[0] !== 'string')
      ) {
        value = camel2Under(target[key]);
      }
      Object.assign(resultObj, { [newkey]: value });
    });
    return resultObj;
  }
  return target;
};
```

点评：同一提交里 loginForm.jsx 和 personal/table.jsx 各砍了约 80 行——把重复的下划线转换收敛到这个工具函数，"降复杂度 + 抽公共"的 sonar 治理手法。

### 1.5 登录表单：验证码倒计时 + 图片验证码

`src/components/login/jsx/loginForm.jsx`（20 次提交触及，全仓最高频文件）
归属：`8bc7579 2024-03-07 修复手机登录的短信验证码倒计时功能`、`8fb0358/abfa632 2024-05 登录模块改造`

```jsx
if (!imgCode) {
  Store.set({ 'loginRegisterData.imgCodeErrorMsg': t('请输入图片验证码!') });
  flag3 = false;
}
if (flag1 && flag2 && flag3) {
  Store.fetchMessageCode({ mobile, areaCode, code: imgCode, key: imgKey, type: 'mobile-login' });
}
```

```jsx
{!countdownFlag ? t('获取验证码') : <CountDown count={count} />}
```

邮箱分支校验：

```jsx
if (loginTabsValue === 'email') {
  if (!email) {
    Store.set({ 'loginRegisterData.emailErrorMsg': t('请输入邮箱!') });
    return;
  } else if (!emailRegRule.test(email) || email.length > 50) {
    Store.set({ 'loginRegisterData.emailErrorMsg': t('邮箱地址格式有误!') });
    return;
  }
}
```

点评：flag1/flag2/flag3 手动汇聚式校验 + 错误文案全进 store 的 `loginRegisterData.*ErrorMsg`，是把登录模块从 this.state 迁到 rrc-loader-helper store 的产物；倒计时用时间戳做截止点，修过负数 bug（`0a3d150`）。

### 1.6 忘记密码的图片验证码

`src/components/login/jsx/forgetVali.jsx`
归属：`f0e640e 2024-03-29 GYLJG-2821`、`0a3d150 2024-04-01 修复点击返回倒计时为负数展示的问题`

```jsx
<div className={style.imgCodeWrapper}>
  <Input
    clearable
    className={style.inputStyle}
    style={{ borderColor: getErrorTipsColor(imgCodeErrorMsg) }}
    value={imgCode}
    placeholder={t('输入图片验证码')}
    digits={0}
    onChange={(val) => { Store.set({ 'loginRegisterData.imgCode': val || '' }); }}
  />
  <Image
    src={`data:image/gif;base64,${captchaCode}`}
    title={t('图片验证码')}
    className={style.imageStyle}
    style={{ display: getDisplayFromCode(captchaCode) }}
    onClick={throttle(() => Store.fetchCaptchaCode(), 1000, 2)}
  />
</div>
```

点评：base64 验证码 + 自己写的 throttle 闭环用在刷新验证码的点击上；`getErrorTipsColor` 也是你 2024-01 专门优化过的辅助函数（`fb54236`）。

### 1.7 reducer：发邮箱验证码与重置密码加密

`src/components/login/reducer.js`（19 次提交触及）
归属：`8c50340 2024-05-15 GYLJG-3173 修复重置密码后重新发送邮箱验证码问题`

```js
*fetchEmailCaptcha() {
  const { loginRegisterData: { email, userName } } = yield '';
  const res = yield sendEmailApi({ email, userName });
  if (res.code === '0') {
    // 让按钮置灰60s
    yield this.changeData({
      countdownFlag: true,
      count: new Date().getTime() + 1000 * 60,
      forgetFlag: false,
      forgetValidFlag: true,
    });
    yield this.backToLoginPage(4);
  } else {
    Modal.error({ title: res.msg });
  }
},

*resetPassword() {
  const { loginRegisterData: { code, email, userName, password, imgKey, imgCode } } = yield '';
  const saltPassword = publicEncrypt(password);   // RSA 落地点
  const res = yield resetPasswordApi({ /* ... */ });
```

点评：generator 当 action、`yield this.changeData(...)` 是 rrc-loader-helper 的风味；倒计时存"截止时刻"而非秒数——所以才有"点击返回倒计时为负数"这种 bug 又自己修掉。

### 1.8 home/nav reducer 重构（菜单高亮四件套）

`src/components/home/reducer.js`
归属：`363182f 2023-09-26 重构home目录reducer的写法`、`bf6b81e 2023-09-20 抽取公共代码,重构home和nav的store部分代码`

```js
*getMenuList() {
  try {
    const menuInfo = yield getServerList();
    if (menuInfo.code === '0') {
      /* 转换动态菜单路由，拼接动态菜单路由组成完成的树结构，遍历树结构生成treeId，
         用于初始化找到对应的item，以便高亮显示 */
      const menuData = generateTreeId(getMenuTreeData(convertToTree(menuInfo?.info)));
      yield this.setStore({ menuData, ready: true });
    } else {
      Modal.error({ title: menuInfo.msg });
    }
  } catch (err) { window.console.error(err); }
},

/* 统一处理左侧菜单栏选中高亮操作 */
const treeItem = getNodeFromTreeId(menuData, `${part}-${id}`);
yield this.setStore({ menuActive: treeItem?.key });
```

点评：`@lib/menu-helper` 的 convertToTree / getMenuTreeData / generateTreeId / getNodeFromTreeId 四件套（你 2023-09 亲手写）把"刷新后菜单高亮丢失""二级菜单 404"一次治好。

### 1.9 APM 埋点接入链路

归属：`f7d654d 2023-06-20 feat: 接入APM埋点`、`40d218f 2023-06-27 去掉home和login的conf配置,直接在root根文件引入`、`fdd460e 2023-06-27 修复埋点登录问题`

`f7d654d` 往 index.ejs 注入的打点脚本（历史 diff）：

```html
<script>
  ! function(f, b, e, v, n, t, s) {
    if (f.sheinq) return;
    n = f.sheinq = function() {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments)
    };
    n.push = n; n.loaded = !0; n.version = '1.0'; n.queue = [];
    t = b.createElement(e); t.async = !0; t.src = v;
    s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
  }(window, document, 'script', 'https://monitor-web.dotfashion.cn/burypoint/analysis.js');
  sheinq.push('init', { appId: 'f441ae8b-56a5-534f-9a1e-6ddbcce39112' });
</script>
```

当前 root.jsx 的 ErrorBoundary 上报：

```js
import { sendError } from 'sheinq';
// ...
  sendError(error, { errorPosition: 'ErrorBoundary' });
```

> 如实备注：`src/lib/apm-config.js` 的最终 conf() 封装是同事 Eric Tan 2023-06-29 重构的；你的贡献是整条 GYLJG-1071 链路（index.ejs 注入、root 启动即接入、登录/登出埋点清空刷新），以及"把 home/login 的重复 conf 删掉集中到 root"的架构决定。

---

## 二、你写过的 Less/CSS 样式

触及 25 个样式文件，Top：`aside/style.less`(10)、`header/style.less`(9)、`content/style.less`(9)、`assets/less/index.less`(9)、`login/jsx/style.css`(6)。

主题色 `src/assets/less/color.less` 全文（`26932f8 2023-09-11 样式调整,颜色主题设置为橙红色`）：

```less
@primary-color: #f16440;
```

左侧菜单栏 hover 过渡 `src/components/common/aside/style.less`：

```less
.sider-container {
  background-color: #f5f6fb;
  position: sticky;
  top: 84px;
  width: 260px;
  margin-right: 20px;
  height: 100%;
  border-radius: 10px;
  animation: bounceInLeft 1s cubic-bezier(0.215, 0.61, 0.355, 1);

  &::-webkit-scrollbar { width: 0 !important; }

  :global {
    .so-menu-wrapper {
      .so-menu-title {
        text-indent: 5px;
        box-shadow: 0px 0px #f16440 inset;
        transition: box-shadow 0.3s, text-indent 0.3s;

        &:hover {
          text-indent: 15px;
          box-shadow: 3px 0px #f16440 inset;
          transition: box-shadow 0.3s linear, text-indent 0.3s linear;
        }
      }
    }
    // 左侧菜单栏过渡效果代码（被注释掉的展开高度过渡实验）
    // .so-menu-list.so-menu-inline .so-menu-list.so-menu-inline {
    //   overflow: hidden; height: 0; transition: height 0.3s ease;
    // }
```

点评：inset box-shadow 做 3px 橙红指示条 + text-indent 位移，下面还留着被注释的过渡实验——"样式调整/查漏补缺"十几次提交的现场感。另有固定头部 `header/style.less`（`position: fixed; height: 64px; box-shadow: 0 10px 10px -15px #000;`）和按钮 loading 悬浮样式（`609d764`，覆盖 so-button-primary/outline/disabled 一族）。

---

## 三、项目配置与优化（本仓的重头戏）

### perf_20230711 系列：16 个提交的 ESLint 全量治理战役

| hash | 日期 | 内容 |
| --- | --- | --- |
| `31c0a62` | 07-11 | 为中文字符串包裹一层 bbl 的 t 函数（i18n 规则落地） |
| `a7893cc` | 07-11 | 为 count、id 添加 propTypes 检验 |
| `f557bf8`/`0bacd30`/`0ac795e` | 07-11 | 全量代码格式校验整理（home/description、home/detail、查漏补缺） |
| `88db714` | 07-11 | **用 @babel/eslint-parser 替换旧版 babel-eslint，解决可选链问题** |
| `838423f` | 07-12 | 增加一些 eslint 校验规则 |
| `53714b6` | 07-12 | 消除 no-unused-vars 和增加 window 前缀 |
| `94b5606` | 07-12 | **用 @ 替换相对路径，大量修改 keymanagement/list/jsx/table.jsx** |
| `7848d19`~`b0a5b70` | 08-09~11 | 规则增删（no-plusplus 允许 for 后置、关闭 class-methods-use-this）、类型检查、消除控制台 Warning |

最终沉淀的 `.eslintrc` 关键段（13 次提交打磨）：

```json
{
  "extends": ["@shein/eslint-config-shein", "plugin:@shein-bbl/bbl/pdcNewSDKConfig"],
  "plugins": ["@shein-bbl/bbl"],
  "parser": "@babel/eslint-parser",
  "parserOptions": {
    "project": "./jsconfig.json",
    "requireConfigFile": false,
    "babelOptions": { "presets": ["@babel/preset-react"] }
  },
  "rules": {
    "max-len": ["error", 140],
    "no-plusplus": ["error", { "allowForLoopAfterthoughts": true }],
    "no-param-reassign": "off",
    "class-methods-use-this": "off",
    "@shein-bbl/bbl/translate-i18n-byT": [
      2,
      { "loose": true, "functionName": "t", "moduleNames": "@shein-bbl/react",
        "excludeAttribute": ["data-apmclick-type", "link", "href", "url", "data-apmclick"] }
    ]
  },
  "settings": {
    "import/resolver": {
      "alias": {
        "map": [
          ["@src", "./src"], ["@components", "./src/components"],
          ["@home", "./src/components/home"], ["@nav", "./src/components/nav"],
          ["@login", "./src/components/login"], ["@lib", "./src/lib"],
          ["@utils", "./src/lib/utils"]
        ],
        "extensions": [".ts", ".js", ".jsx", ".json"]
      }
    }
  }
}
```

配套 package.json 变化：devDeps 增加 `@babel/eslint-parser ^7.22.10`、`eslint-plugin-import ^2.28.1`、`eslint-import-resolver-webpack`；deps 增加 `jsencrypt ^3.3.2`、`crypto-js ^4.1.1`。

点评：这是一次完整的"parser 升级 → 别名治理 → 规则增删 → 全量格式化 → i18n t() 包裹"工程化流程，两个月 16 提交，webpack alias 同步 3 次提交。

---

## 四、值得回忆的提交瞬间

| hash | 日期 | subject |
| --- | --- | --- |
| `0882aae` | 2023-06-06 | feat: 新增jsencrypt依赖，对邮箱登录/用户名登录/忘记密码进行RSA加密（第一笔） |
| `f7d654d` | 2023-06-20 | feat: 接入APM埋点 |
| `88db714` | 2023-07-11 | 使用@babel/eslint-parser替换旧版babel-eslint,解决可选链以及其他问题 |
| `31c0a62` | 2023-07-11 | 为中文字符串包裹一层bbl的t函数 |
| `a632278` | 2023-09-11 | 样式调整,颜色主题设置为橙红色 |
| `bf6b81e` | 2023-09-20 | 抽取公共代码,重构home和nav的store部分代码 |
| `363182f` | 2023-09-26 | 重构home目录reducer的写法 |
| `806687d` | 2024-01-16 | 增加数组长度判空;优化throttle函数 |
| `f0e640e` | 2024-03-29 | 忘记密码-设置密码页面增加图片验证码;修复倒计时功能 |
| `abfa632` | 2024-05-17 | [GYLJG-3210] 完善登录模块相关页面改造 |

**一句话画像**：这个仓库是你的"安全 + 工程化"主场——RSA 四套公钥、防刷 throttle、验证码倒计时是安全线；ESLint 全量治理、菜单高亮四件套、橙红 UI 改版是工程线，两条线都在这里留下了可复用的沉淀。

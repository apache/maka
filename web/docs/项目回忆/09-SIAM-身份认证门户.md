# 09 · SIAM 身份认证系统 — 门户（siam-front）— 你的代码回忆录

> 仓库：`V:\程序开发\05-前端进阶\项目资产\05-广州希音[1.88GB]\09-身份认证系统[SIAM]\代码仓库\siam-front-20240811\siam-front`
> 你的提交：5 次（2024-05-31 ～ 2024-06-06），GYLJG-3258 一个需求打满——重置密码、个人中心、提示页、本地验证码四天连续交付。

**技术栈**：React（18 类型）+ TypeScript + shineout + `@shein-lego/use`（useSafeState/useStableFn/useThrottledFn）+ lego + bbl。
**高频文件**：`pages/info/*`、`components/reset-from`、`types/interface.ts`（各 2 次）。注：重置密码组件目录当时叫 `reset-from`（拼写笔误，后被他人更名为 `reset-form`）。

---

## 一、你写过的核心 TS/TSX 代码

### 1.1 重置密码组件（密码规则工厂 + 高阶校验器）

`src/components/reset-from/index.tsx`（按原提交 `git show c0c0973` 逐字）
归属：`c0c0973 2024-05-31 feat: 开发重置密码组件`

```tsx
/**
 * 生成密码规则
 * @param fieldErrorTip 字段错误提示
 */
const generatePasswordRules = (fieldErrorTip = t('请输入密码')) => {
  return [
    rule.required(fieldErrorTip),
    rule.regExp(
      /^(?=.*?[A-Z])(?=.*?[a-z])(?=.*?[0-9])(?=.*?[!@#$%^&*()_+-=,./?]).{8,25}$/,
      t('密码必须包含大小写字母、数字、特殊字符，长度8-25位'),
    ),
  ];
};

/**
 * 创建通用密码校验规则
 * @param {Function} ruleCondition - 校验条件
 * @param {string} errorMessage - 校验错误时的消息
 * @returns 返回一个函数，该函数基于提供的校验条件和错误消息执行具体的校验
 */
const createPasswordRule =
  (ruleCondition: any, errorMessage: string) => (value: string, formData: any, callback: any) => {
    if (ruleCondition(value, formData)) {
      callback(new Error(errorMessage));
    } else {
      callback();
    }
  };

/** 新密码和原密码对比规则 */
const passwordCompareRule = createPasswordRule(
  (value: string, formData: any) => value === formData.originPassword,
  t(`新密码和原密码不能保持一致`),
);

/** 确认密码和新密码对比规则 */
const confirmPasswordCompareRule = createPasswordRule(
  (value: string, formData: any) => value !== formData.password,
  t(`确认密码和新密码不一致`),
);
```

提交动作（同文件尾部）：

```tsx
const handleSubmit = (data: ModifyPasswordParams) => {
  onSubmit(data);
  resetForm();
  navigate('/warning');
};
```

点评：`createPasswordRule` 是手写柯里化校验器工厂——三个密码框的"新≠旧、确认=新"两条交叉规则全靠它拼出来；提交后直接导航去 /warning 提示页。

### 1.2 本地图片验证码组件（normal/geeTest 双模）

`src/components/captcha/index.tsx`
归属：`157598c 2024-06-05 feat: 新增本地验证码接入`（整文件）

```tsx
/** 刷新图片验证码 */
const handleRefreshCode = useThrottledFn(() => refresh(), { wait: 300 });

const getCaptchaCode = useStableFn(async () => {
  if (type === 'geeTest') {
    const { code, info } = await getGeeTestCaptcha();
    if (code === '0') {
      onCaptchaKeyChange(info.challenge || '');
    }
  } else if (type === 'normal') {
    const { code, info } = await getCaptcha();
    if (code === '0') {
      setCode('');
      setCaptchaData(info);
      onCaptchaKeyChange(info.key || '');
    }
  }
});
```

```tsx
{captchaData?.captcha ? (
  <Image
    src={`data:image/gif;base64,${captchaData?.captcha}`}
    title={t('图片验证码')}
    className={styles.captchaImage}
    onClick={handleRefreshCode}
  />
) : (
  <div className={styles.emptyCaptchaTips} onClick={handleRefreshCode}>
    {t('图片加载失败')}
  </div>
)}
```

点评：normal（本地 base64 图）与 geeTest（极验 challenge）双模设计；刷新节流 300ms、`useImperativeHandle` 暴露 `refresh()` 给父组件（登录失败后强制换图）；`gt.js`/`jquery-3.5.1.min.js` 也在同一提交进了 assets/js。

### 1.3 个人中心页（验证码联动）

`src/pages/info/index.tsx`
归属：`c0cd857 2024-05-31 开发个人中心页面`、`157598c`

```tsx
/** 获取验证码按钮禁用状态 */
const codeBtnDisabled = useCreation(() => {
  return counting || captchaInfo.captcha.length !== 5;
}, [counting, captchaInfo.captcha]);

/** 验证码规则 */
const validCodeRules = useCreation(() => {
  const rules = [rule.regExp(/^\d{6}$/, t('请输入6位数字验证码'))];
  if (type === FORM_TYPE.PHONE || type === FORM_TYPE.EMAIL) {
    rules.unshift(rule.required(t('请输入验证码')));
  }
  return rules;
}, [type, mode]);
```

点评：验证码按钮 disabled = 倒计时中 || 图片验证码没填满 5 位——把"先过人机再发码"的规则写进了 UI 状态。

### 1.4 提示页（缺参/非法参数白盒提示）

`src/pages/warning/index.tsx`
归属：`dcb8d93 2024-05-31 feat: 开发提示页面`

```tsx
export default function Warning() {
  const { state } = useLocation();
  const navigate = useNavigate();
  // TODO 根据state中的missingQuery和invalidQuery提示用户
  const { missingQuery = [], invalidQuery = [] } = state || {};

  return (
    <div className={styles.page}>
      <Icon name='invalid' className={styles.iconColor} fontSize={150} />
      {missingQuery?.length > 0 && (
        <div>
          <h3>{t('缺失的查询参数：')}</h3>
          <ul>
            {missingQuery.map((query: string, index: number) => (
              <li key={`missing-${index}`} className={styles.iconColor}>{query}</li>
            ))}
          </ul>
        </div>
      )}
```

点评：重置密码提交后的落点页，也承接 URL 鉴权失败时"缺了哪些参数/哪些非法"的白盒提示。

---

## 二、你写过的 CSS 样式

5 个文件，全是 CSS Modules `.css`：`components/{account-form,captcha,reset-from}/index.css`、`pages/info/index.css`、`pages/warning/index.css`。

摘录 `components/captcha/index.css`（`157598c`）：

```css
.captchaImage {
  flex-shrink: 0;
  width: 100px !important;
  height: 32px;
  padding-bottom: 0 !important;
  margin-left: 15px;
  cursor: pointer;
}

.emptyCaptchaTips {
  flex-shrink: 0;
  width: 100px;
  height: 32px;
  margin-left: 15px;
  line-height: 32px;
  color: rgb(0 0 0 / 45%);
  text-align: center;
  cursor: pointer;
  background: #f5f5f5;
  border-radius: 4px;
}
```

（另有 `a1aba31 2024-06-06 style: 修复登录界面出现滚动条样式问题`，落点在 `account-form/index.css`。）

---

## 三、项目配置与优化

`.legorc.ts`（`157598c`，逐字节选）：

```ts
export default defineConfig({
  // 前端标准镜像构建使用此PATH，构建时默认注入
  publicPath: process.env.LEGO_FRONTEND_PUBLIC_PATH,
  // 接入BBL，需要将入口文件改为BBL的入口文件
  entry: path.join(__dirname, 'src', 'shein-bbl-entry.ts'),
  advanced: {
    react: { runtime: 'automatic', refresh: true },
    analysis: { appId: '863b2edb-7d28-5b68-9b91-7875f3a41c23' },
  },
  experiments: {
    legoFuture: {
      routes: { delay: 200, loading: '@/components/loading', hoc: '@/components/apm' },
    },
  },
```

- **package.json**（`157598c`）：`@shein-lego/cli ^1.4.0`、`@shein-bbl/{core,react} ^1.0.2`、TS 5.3、`pnpm@8.6.5`。
- **src/api/index.ts**（`157598c`）：新增 `getCaptcha` / `getGeeTestCaptcha` 两个接口封装。

点评：门户切 lego 标准管线——镜像注入 publicPath、bbl 入口、路由级 loading/APM HOC，一套配置三件事。

---

## 四、值得回忆的提交瞬间

| hash | 日期 | subject |
| --- | --- | --- |
| `c0c0973` | 2024-05-31 | feat: 开发重置密码组件 |
| `c0cd857` | 2024-05-31 | feat: 开发个人中心页面 |
| `dcb8d93` | 2024-05-31 | feat: 开发提示页面 |
| `157598c` | 2024-06-05 | feat: 新增本地验证码接入 |
| `a1aba31` | 2024-06-06 | style: 修复登录界面出现滚动条样式问题 |

**一句话画像**：一天三页 + 两天验证码——重置密码的柯里化校验器工厂、normal/geeTest 双模验证码、5 位图片码锁发送按钮，是把"账号安全交互"做成了小品级的完整闭环。（此仓后续还有他人/未署名作者的 GYLJG-3258 提交，未计入。）

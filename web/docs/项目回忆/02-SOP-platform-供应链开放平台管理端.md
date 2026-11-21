# 02 · SOP 管理端（sop-platform-front）— 你的代码回忆录

> 仓库：`V:\程序开发\05-前端进阶\项目资产\05-广州希音[1.88GB]\02-供应链开放平台[SOP]\代码仓库\sop-platform-front-20240811\sop-platform-front`
> 你的提交：56 次（2023-06-06 ～ 2024-08-01）。开张提交 `27aa7f4 feat: 新增jsencrypt依赖，对重置密码进行RSA加密` 与 portal 的第一笔**同一天**；收官 `2bd4c06 sso-sdk版本升级到0.1.2`。

**技术栈**：**Vue 2.6.14** + Element UI + vue-router + vuex + axios + echarts 4（bmap 扩展）+ @shein-components/sso-sdk + ESLint/Prettier + pnpm。
**主打方向**：RSA 密码加密与脱敏校验正则（2023-06/07）→ Prettier 全量格式化 pref_20230712（2023-07）→ 代码质量治理（2024-05）→ 路由规则回显 GYLJG-3193（2024-05~07）→ sso-sdk 升级（2024-08）。

> 这是 10 个仓库里你唯一深度写 Vue 的地方。

---

## 一、你写过的核心 JS/Vue 代码

### 1.1 密码 RSA 加密（管理端版）

`src/utils/encrypt-rsa.js`
归属：`27aa7f4 2023-06-06`（开张提交）、`965776f 2023-07-03 修改dev公钥`、`dc56e16 2023-07-04 修复开发者管理账号密码加密问题`

```js
const generatePublicKey = () => {
  switch (process.env.BUILD_ENV) {
    case 'dev':  return devPublicKey
    case 'test': return testPublicKey
    case 'sit':  return sitPublicKey
    case 'prod': return prodPublicKey
    default:     return prodPublicKey
  }
}

export function publicEncrypt(str) {
  const encrypt = new JSEncrypt()
  encrypt.setPublicKey(generatePublicKey())
  return encrypt.encrypt(str)
}
```

配套 `config/dev.env.js`（`dc56e16` 加入 BUILD_ENV）：

```js
module.exports = merge(prodEnv, {
  NODE_ENV: '"development"',
  BASE_API: '"/"',
  BUILD_ENV: JSON.stringify('dev'),
  LOGIN_ADDR: JSON.stringify(process.env.LOGIN_ADDR || 'https://ulp.sheincorp.cn/'),
})
```

点评：与 portal 的 encrypt-rsa.js 同源（无分号 vs 有分号暴露了两个仓库的 Prettier 配置差异）；`BUILD_ENV` 变量就是你在 config/dev.env.js、config/prod.env.js 里自己加的。

### 1.2 邮箱/脱敏邮箱/密码校验正则

`src/utils/validate.js`（7 次提交触及，本仓第二高频文件）
归属：`b64bef5 2023-06-15 修复脱敏邮箱正则匹配规则`（一天 5 连 fix 之一）、`c52abe6/a7762d3 2023-06-30`、`95ba684 2023-07-04 修复密码校验规则`

```js
/** 校验邮箱 */
export function validateEmail(str, isDesensitization) {
  const emailReg = /^[\w-]+(\.[\w-]+)*@[\w-]+(\.[\w-]+)*(\.[\w-]{2,})$/
  const desensitizationReg = /^([\w-]+\*+|\*{1})@[\w-]+(\.[\w-]+)*(\.[\w-]{2,})$/
  const reg = isDesensitization ? desensitizationReg : emailReg
  return reg.test(str)
}

/** 校验密码：须由大写字母、小写字母、数字以及常用符号组成！ 8-20位 */
export function validatePassWord(str) {
  var pattern = /^(?![a-zA-Z0-9]+$)(?=.[^%&',;=?$\x22])(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9]).{8,20}$/
  return pattern.test(str)
}
```

点评：`isDesensitization` 一个参数吃两种形态——回显时后端返回 `a***@shein.com` 脱敏邮箱，2023-06-15 一天 5 个 fix 硬是把正则磨出来的。

### 1.3 路由规则回显 doLoad

`src/views/rule/inner/rule-content-edit.vue`
归属：`eea76a6 2024-07-04 完善doLoad处理函数`、`884dac3 2024-07-02 修复数组取值的兼容性问题`

```js
doLoad(ruleId) {
  get_route_rule(ruleId).then((resp) => {
    const rule_list = resp.rule_list || []
    this.rule_form = { ...resp, rule_list: [] }
    rule_list.forEach((v) => {
      v.predicates = v.predicates || []
      v.predicate_keys = v.predicates.map((predicate) => predicate.predicateName)
      this.rule_form.rule_list.push(v)
    })
  })
},
```

`884dac3` 的 diff 能看到演进过程（ASI 坑的防御写法）：

```js
-        rule_list?.forEach((v) => {
+        // 使用分号开始一个单独语句，避免自动插入分号错误
+        ;(rule_list || []).forEach((v) => {
           if (!v.predicates) {
             v.predicates = []
             v.predicate_keys = []
           } else {
             v.predicate_keys = []
-            v.predicates?.forEach((value) => {
+            ;(v.predicates || []).forEach((value) => {
```

点评：回显时把 predicates 派生成 predicate_keys 供下拉编辑；`;(x || []).forEach` 是配合 babel 修复（`8245649`）后仍有的自动分号坑。GYLJG-3193 分支共 13 个提交横跨两个月。

### 1.4 外部用户编辑：三态模式 + 按需加密

`src/views/externaluser/external-user-edit.vue`
归属：`dc56e16 2023-07-04`、`7a39d2d 2023-08-29`、`b759b10/e4a094e 2024-05-15 消除代码质量问题`、`198c0d4 2024-05-27 GYLJG-3122`

```js
/**
 * 检查重置模式
 */
isCheckMode(isChecked, value) {
  if (!isChecked) {
    return 0
  } else if (!value) {
    return 2
  } else {
    return 1
  }
},
setFormStatus(baseForm) {
  const { isMobileCheck, isEmailCheck, isPasswordCheck, mobile, email, password } = baseForm
  // 修改情况下，若mobile和email没有更改过 且为空时 不传这两个参数
  if (this.id) {
    return {
      // isMobileCheck：是否点击了重置手机号按钮；phoneMode：0未修改，1修改，2清空
      phoneMode: this.isCheckMode(isMobileCheck, mobile),
      emailMode: this.isCheckMode(isEmailCheck, email),
      passwordMode: this.isCheckMode(isPasswordCheck, password),
    }
  } else {
    return {}
  }
},
```

密码加密落点：

```js
let saltPassword
if (baseForm.password) {
  saltPassword = publicEncrypt(baseForm.password)   // 只有真改了密码才加密上传
}
return { ...baseForm, password: saltPassword, openApiIds: apiIds, isNewUser: !this.id, ips }
```

点评：0/1/2 三态（未修改/修改/清空）设计 + 2024-05 那轮把一坨 if-else 拆成 isCheckMode/setFormStatus/updateBaseForm/validateFormField/prepareFormData 五个带 JSDoc 的小函数——质量治理期的代表作。

### 1.5 百度地图 BMap window 挂载修复

`src/views/statistic/external-user-map.vue`
归属：`7dc1fec 2023-07-13 解决挂载到window上'BMap'没有被定义的问题`

```js
this.baiduMap = this.myChart.getModel().getComponent('bmap').getBMap({ enableMapClick: false })
// ...
this.baiduMap.addControl(new window.BMap.NavigationControl({
  type: [window.BMAP_NAVIGATION_CONTROL_LARGE] // 级别控件
}))
const bdary = new window.BMap.Boundary()
const ply = new window.BMap.Polyline(rs.boundaries[i], { strokeWeight: 2, strokeOpacity: 0.5 })
```

后续 `51035a0 2024-07-01 删除根文件对于百度地图外链的引用`（index.html 删掉百度地图 script 外链）收尾。

点评：echarts bmap 依赖异步加载的百度地图脚本，改成显式 `window.BMap` 引用 + 摘除外链，是典型的"治理全局副作用"动作。

---

## 二、CSS/SCSS 样式

如实说明：你在 platform 的样式产出极少——全部 56 个提交只触及 **1 个样式文件**。

`src/styles/sidebar.scss`（1 次，`65379a3 2023-06-12`，左侧菜单栏加宽）：

```scss
.main-container {
  min-height: 100%;
  transition: margin-left .28s;
  // margin-left: 180px;
  margin-left: 200px;
  position: relative;
}
```

其余 `.vue` 提交里的 style 块属于 Prettier 格式化，不算样式创作。样式重镇在 portal 仓库。

---

## 三、项目配置与优化

| 配置动作 | 提交 | 内容与目的 |
| --- | --- | --- |
| `.babelrc` 修复 | `8245649 2024-07-04 GYLJG-3193` | env + stage-2 presets、transform-runtime、transform-vue-jsx——兼容 `;(x \|\| [])` 写法和旧构建链 |
| `.eslintrc.js` 修复 | `25d37c8 2024-07-04` | lint script `eslint --ext .js,.ts,.vue --ignore-path .gitignore ./ --cache --quiet` + lint-staged/husky |
| jsencrypt 引入 | `27aa7f4 2023-06-06` | 开张提交，密码加密 |
| pnpm-lock 更新 / sso-sdk 升级 | `07e9f8b`/`2bd4c06` | 依赖治理，最后一笔业务提交是 sso-sdk ^0.1.2 |
| Prettier 全量格式化战役 pref_20230712 | `b988f1d`/`fd6bd06`/`9c35b2c`/`439346e`/`b40f0a1` 2023-07~08 | "很多代码都是自动修改"——api 目录空格缩进引号、json 格式、路由映射函数收尾 |
| 代码质量收尾 | `e4a094e`/`b759b10 2024-05-15`、`644d65d`、`58c7079` | 消除常见质量问题/复杂度、em 替换 i 标签 |

---

## 四、值得回忆的提交瞬间

| hash | 日期 | subject |
| --- | --- | --- |
| `27aa7f4` | 2023-06-06 | feat: 新增jsencrypt依赖，对重置密码进行RSA加密（开张，与 portal 同日） |
| `b64bef5` | 2023-06-15 | fix(global): 修复脱敏邮箱正则匹配规则（一天 5 连 fix 之一） |
| `dc56e16` | 2023-07-04 | [GYLJG-1019] 修复开发者管理账号密码加密问题 |
| `7dc1fec` | 2023-07-13 | [pref_20230712] 解决挂载到window上'BMap'没有被定义的问题 |
| `b988f1d` | 2023-07-12 | 代码格式化整理，手动修改小部分代码，很多代码都是自动修改 |
| `e4a094e` | 2024-05-15 | 消除常见代码质量问题 |
| `62ec2e5` | 2024-05-30 | [GYLJG-3193] 修复定义路由规则回显数据问题 |
| `eea76a6` | 2024-07-04 | [GYLJG-3193] 完善doLoad处理函数 |
| `8245649` | 2024-07-04 | [GYLJG-3193] fix: 修复babel配置 |
| `2bd4c06` | 2024-08-01 | [GYLJG-3888] sso-sdk版本升级到0.1.2（收官） |

**一句话画像**：你的 Vue 篇幅——RSA 加密与脱敏正则双仓同源、三态表单设计、`(x || []).forEach` 的 ASI 防御，以及"格式化机器干、语义人守"的一次全量 Prettier 战役。

> 备注：此前总结文档里提到的 "qiankun 微前端" 经核实不成立——platform 仓库无 qiankun 依赖，`doLoad` 是路由规则回显的加载函数。

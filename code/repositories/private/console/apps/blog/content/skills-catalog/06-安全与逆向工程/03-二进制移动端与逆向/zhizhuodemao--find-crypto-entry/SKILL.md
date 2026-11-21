---
name: find-crypto-entry
description: 定位 JS 加密参数的生成入口（函数位置+调用链）。
  TRIGGER when: 用户提到请求中的加密字段、签名参数、token生成、加密入口，或要求分析请求头/URL/Body中某个参数怎么来的。包括但不限于"找加密入口"、"xxx在哪生成"、"请求头里的xxx"、"签名怎么算的"、"这个token哪来的"、"定位加密函数"。
  DO NOT TRIGGER when: 用户只是想看请求内容、抓包、或分析非加密的普通参数。
argument-hint: [参数名]
---

# find-crypto-entry

定位加密参数 **$ARGUMENTS** 的生成入口。

**目标**：找到生成该参数的函数位置（脚本 URL + 行列号 + 函数名 + 调用路径）。

---

## 策略选择

根据信号选择策略，不要按固定顺序执行：

**优先静态搜索**：用 `search_in_sources` 搜参数名（带 `excludeMinified=false`）。大多数情况下直接找到赋值位置，然后读上下文追溯来源。

**静态搜不到时用 XHR 断点**：`break_on_xhr` 设在请求 URL 特征上，刷新页面触发。断点命中后从调用栈中找业务代码帧，用 `evaluate_on_callframe` 检查变量。

**两种策略可以组合**：先静态搜索定位赋值位置，再在赋值处设断点动态验证。

---

## 领域知识

agent 在逆向分析中容易踩的坑，这些是无法通过推理得出的经验：

### 加密参数的 3 种常见架构

1. **业务代码直接赋值** — 在请求函数中 `headers["x-sign"] = encrypt(data)`。静态搜索直接找到。
2. **请求拦截器统一加签** — axios interceptor 或 fetch wrapper 中统一添加。搜参数名可能只在拦截器中出现一次。
3. **外部安全 SDK** — 独立 JS 文件（通常混淆）挂载全局对象（如 `window.h5sign`），业务代码调用其方法。静态搜索能找到调用处，但 SDK 内部代码全被混淆。

### OB 混淆的影响

当加密逻辑在 OB 混淆的文件中（特征：`_0x` 前缀、大型字符串数组、RC4 解密函数），**所有字符串都被加密**，静态搜索在该文件内无法匹配任何明文。但调用该文件的业务代码通常未混淆，从业务代码侧搜索更高效。

### XHR 断点命中时的堆栈特点

XHR 断点命中在 `send()` 调用处，调用栈底部通常是框架代码（axios/fetch wrapper）。加密逻辑在栈的中上层。直接跳过底部框架帧，关注业务代码帧。

---

## 反模式

- **不要反复 step_into** — 容易掉进框架响应式系统（Vue reactivity、React fiber）。用 `evaluate_on_callframe` 直接检查变量比单步跟踪高效得多。
- **不要在 OB 混淆文件中搜字符串** — 所有明文都被加密了，搜不到。从非混淆的调用方搜。
- **不要频繁刷新页面** — 每次刷新所有 scriptId 失效。设好断点再刷新，一次到位。
- **断点命中时优先用 `evaluate_on_callframe` 指定帧** — `evaluate_script` 在暂停时会自动 fallback 到顶层帧，但如果需要检查特定调用帧的变量，必须用 `evaluate_on_callframe` 指定 `frameIndex`。

---

## 完成标准

找到以下信息即为完成：

```
入口位置：
- 参数：$ARGUMENTS
- 脚本：https://example.com/static/js/main.abc123.js
- 位置：第 X 行，第 Y 列
- 函数：functionName (或 anonymous)
- 调用路径：request → addSign → encrypt
- 加密类型：[标准算法名 | 外部SDK | 未知/需解混淆]
```

只找入口，不做算法还原。

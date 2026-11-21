---
title: React与TypeScript
status: active
updated: 2026-10-02
---

# React与TypeScript

## 必须讲清

- 渲染期计算UI；事件处理响应用户动作；Effect用于与外部系统同步，清理订阅和请求副作用。
- Effect的依赖是所读取的响应式值；过期请求用取消或请求标识隔离，切顾客尤其要测竞态。
- useEffect不保证总在绘制后运行；依赖变化先清理旧Effect，开发Strict Mode可能额外执行检查周期。
- Transition降低相关更新优先级，不延迟回调内的同步重计算；重计算需减少工作量或另行分担。
- React18新根支持Promise/定时器等回调内的自动批处理；不要套用旧版“一定不批处理”的说法。
- TypeScript约束编译期，API输入仍要运行时校验。DTO、ViewModel和组件Props分开，mapper承担转换。
- unknown先缩窄再使用；联合类型表达状态，穷尽检查比一堆可选字段更能发现遗漏。

## 项目落点与练习

P04：切换顾客时旧请求返回，如何防止覆盖新顾客数据？P08：筛选域切换如何清理下级状态？写出idle/loading/success/error判别联合，测试空值和异常响应。练习完成前不作为新履历。

自动批处理的版本背景见 [React 18 发布说明](https://react.dev/blog/2022/03/29/react-v18)。

## 从快照推导闭包与竞态

**学习推演**：一次 render 中 count=0，连续三次 `setCount(count + 1)` 使用同一旧值；函数式更新 `setCount(c => c + 1)` 才表达按队列前值递增。不要用“setState 永远异步”解释所有现象，关键是事件处理器看到该次 render 的快照。

切顾客可按时间演算：A 请求发出 → 切到 B → B 响应写入 → A 响应晚到。清理 Effect 可以停止旧订阅或忽略旧结果；仅清空 UI 没有阻止 A 再写回来。取消请求减少浪费，身份校验保护正确性。若同一顾客被重新查询，单比 customerId 仍可能放过较旧请求，还要区分请求代次。Effect 的清理顺序与忽略旧结果示例见 [React useEffect](https://react.dev/reference/react/useEffect)。

## 用类型表达允许发生的事

学习模型可分为 `loading {customerId}`、`success {customerId, data}`、`error {customerId, message}`，让 success 必有 data；“loading 且 error 且 data 为空”不再靠三个布尔值碰运气。外部响应先以 unknown 接住，在边界确认结构，再转 ViewModel；非法枚举不能强转成合法类型，缺金额也不能默认为 0 冒充已知金额。判别联合与穷尽检查见 [TypeScript Narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)。

递进追问：为什么一个完整顾客对象不全放全局 store？回答生命周期与订阅范围；为什么不用 Effect 同步派生字段？能在 render 算出的值不复制存储。Transition 适合降低非紧急更新的渲染优先级，不能把任意计算移出主线程。以上是解释与练习，P04 的实际取消路径和联合模型是否落地仍需回源码。

学习时还要区分“新建对象”与“值真的改变”：依赖里的对象每次新建，会导致 Effect 重新同步。优先把无须响应变化的定义移出组件，或在 Effect 内按必要值构造；不是删掉依赖让 linter 闭嘴。reducer 适合多个事件共同维护转换，不适合为一个独立开关增添模板。

## 依据与延伸

- [事实与证据](../00-事实与简历/05-项目归属与量化证据.md)

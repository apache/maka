# 10 · 源码笔记与已知边界

> 系统导航：[README](./README.md) | [上一篇：实战：添加新函数](./09-add-your-own-function.md)

读完本篇你会获得：

1. 七处阅读源码时值得标注的位置，每处都有可复现的事实依据
2. 用这个库时规避边界的实操建议
3. 把"用库的人"升级为"懂库的人"的最后一块拼图

这一篇的性质要说清楚：它不是缺陷清单，也不是评测报告。这些条目全部来自对当前版本（2.6.4）源码的逐行阅读，每一条都给出文件和行号附近的代码事实。工具库和所有软件一样，有设计完成的 parts，也有演进中的 parts。知道边界在哪，用起来才有底气。

## 1. getPackageSize 的模块级状态残留

`src/utils/packageSize.ts` 第 5 行：

```ts
const fileListTotal: number[] = [];
```

这个累加所有文件字节数的数组声明在**模块顶层**，而 `getPackageSize` 没有任何地方重置它。第一次统计一个 100MB 的目录得到正确结果；第二次统计一个 10MB 的目录，回调拿到的是 110MB——上一次的结果还在数组里。

规避方式：一个 Node 进程里每个目标目录只统计一次；确实要多次统计时，绕开这个函数自己写递归 `stat`，或调用前想办法清空（该数组未导出，实际清不掉）。

## 2. clone 对 Map 的克隆不完整

`src/utils/clone.ts` 的 `copyValue` 里 Map 分支：

```ts
case "[object Map]": {
  const restMap = getCativeCtor(val);
  restMap.forEach(function (item: any) {
    restMap.set(handleValueClone(item, isDeep));
  });
  return restMap;
}
```

`Map.prototype.set` 需要 `(key, value)` 两个参数，这里只传了一个。结果是克隆出的 Map 里每个条目的 key 和 value 是同一个值，原 Map 的真实键值对丢失。对照 Set 分支（`restSet.add(handleValueClone(item, isDeep))`）——Set 的 add 只要一个参数，所以 Set 是对的，Map 不是。测试文件没有覆盖 Map 克隆的用例，所以这个问题一直没被测试网住。需要深拷贝含 Map 的数据时，用 `deepEqual` 的近亲思路自己处理，或等上游修复。

## 3. isUrl 的 IPv6 分支实际不生效

`src/utils/is.ts` 的 `isUrl` 用字符串拼接构造正则，host 部分的 IPv6 分支是：

```ts
"(?:$[0-9a-fA-F:]+$)" + // IPv6 地址
```

写这条注释时的意图应该是 `\\[...\\]`（匹配方括号包裹的 IPv6），但拼进正则字符串后，两个 `$` 是行尾锚点：第一个 `$` 要求当前位置是字符串末尾，而匹配进行到 host 位置时几乎总在字符串开头附近，断言必然失败。结果：

```ts
isUrl("fe80::1");            // false，裸 IPv6 不认
isUrl("http://[::1]:8080");  // false，方括号形式也不认
```

IPv4、localhost、域名分支都不受影响（测试里的用例全部通过）。校验 IPv6 地址的场景需要自己补正则。git 历史里 2.4.8、2.4.9、2.5.0 三个版本连续优化这个函数，它是库里被反复打磨的高频改动区。

## 4. numberToChinese 的进位判断恒真

`src/utils/math.ts` 第 81 行：

```ts
case 4:
  if (!new RegExp("0{4}//d{" + (a[0].length - i - 1) + "}$").test(a[0])) re = unit[4] + re;
  break;
```

字符串里的 `//d` 应为 `\\d`（写成了两个正斜杠加字母 d）。作为正则，`//d` 匹配字面字符 `/`、`/`、`d`——数字字符串里永远不含这些字符，`test` 恒为 `false`，`!false` 恒为 `true`，于是"万"位单位无条件添加。对多数常见数字结果碰巧正确，但形如 `100000001` 这类中间四位连续为零的数字，"亿"和"万"的衔接处会多出一个"万"字。金额大写场景请用 `amount.ts` 的 `priceUppercase`（独立实现，无此问题），不要用 `numberToChinese` 顶替。

## 5. equal 与 deep 两套深度比较并存

| | `src/utils/equal.ts` | `src/utils/deep.ts` |
| --- | --- | --- |
| 入口 | `isEqual` / `isEqualObject` / `isEqualArray` | `deepEqual` |
| 循环引用 | 未处理，会栈溢出 | WeakMap 处理，安全 |
| 支持类型 | 对象、数组、函数、原始值 | 增加 Map、Set、Date、RegExp |

两套都是可用实现，但能力不对等。`array.ts` 里 `arrayAllExist`（浅，基于 Set）和 `arrayAllExistDeep`（深，基于 deepEqual）分别调用两套体系，同名成对、行为不同。**新代码统一用 `deepEqual` 一系**；`isEqual` 系留在库里主要因为历史 API 兼容。给对象数组做包含判断时想清楚选哪个：基本类型数组用 `arrayAllExist` 性能更好，结构复杂就用 Deep 版。

## 6. useWatermark 在实例上下文中的自清理

[第 6 篇](./06-use-watermark.md)详细拆过，这里只留速记：`setWatermark` 末尾检测 `getCurrentInstance()`，非空就立即 `clear()`，而水印背景是异步设置的——组件 setup/生命周期内同步调用可能导致水印刚建就被摘。稳妥用法是放进 `nextTick` 或异步回调后再调。定位：`src/hooks/useWatermark.ts` 的 `setWatermark` 函数末尾。

## 7. 主入口没有 getPackageSize

第 4 篇讲过的入口矩阵，换一个角度重述：`import { getPackageSize } from "@pureadmin/utils"` 在 Vite/Webpack 项目里得到 `undefined`，这个函数只存在于 CJS 入口（`require("@pureadmin/utils")`）。用 ESModule 的浏览器项目想统计包大小，要么走 `require`（打包器会警告），要么复制它的 35 行源码自己维护。同理 `getAbsolutePath`（`src/utils/path.ts`）。

## 一个观察框架：怎么自己判断"这个函数能不能信"

以上的条目都是用同一个框架从源码里筛出来的，你也可以用。三个问题依次问：

1. **有测试吗？** 打开 `src/tests/utils.test.ts` 搜函数名。有精确值断言的（`priceToThousands`、`monthDays`、`getTime`）可信度高；只有存在性断言的（`randomColor`、`buildUUID`）次之；没有用例的（全部 hooks、`getPackageSize`）靠自己验证。
2. **有模块级状态吗？** 源码里函数外部的 `let`/`const` 是共享状态，多次调用可能互相污染（条目 1 就是这么找到的）。
3. **边界输入有人管吗？** 拿 `null`、空串、`0`、负数、嵌套结构去戳一遍。库的惯例是 warn 加降级返回，但降级值是否是你要的（空数组还是 `undefined` 还是原值）要自己确认。

三个问题五分钟，胜过任何"这个库稳不稳"的二手结论。

## 系列结语

十篇下来，这个库从外到内过了一遍：怎么装、怎么用、为什么零依赖、两个核心 hooks 怎么工作、类型怎么组织、工程怎么跑、怎么加函数、边界在哪。

它值得学的地方很明确：convert 层的依赖反转、四入口的环境裁剪、贯穿全库的 SSR 防御三件套、以及注释密度极高的类型文件——这四样可以直接搬进你自己的工具库。它需要警惕的地方也很明确：hooks 无测试、少量双轨实现、几处历史遗留的字符笔误。

开源工具库的成熟不是"没有问题"，而是问题被持续发现、记录、修掉的过程——这份笔记本身就是这个过程的一部分。

**最后一份练习**：回到本篇开头的七个条目，挑一个你近期真的会用到的场景（比如对象数组包含判断），写一段 20 行的对比脚本，把两套实现的输出差异打印出来。跑过一次，比读十遍都记得牢。

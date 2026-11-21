# 07 · 类型系统：types.ts 如何撑起全库的补全体验

> 系列导航：[README](./README.md) | [上一篇：useWatermark 深度剖析](./06-use-watermark.md) | [下一篇：工程化体系 →](./08-engineering.md)

读完本篇你会掌握：

1. `types.ts` 的组织方式和"类型即文档"的实践
2. 库里最常用的四个泛型工具类型
3. `DeepClean` 条件类型的逐层拆解
4. 怎么给"一个参数支持四种写法"写类型

前六篇都在讲运行时。这一篇讲静态：为什么用这个库时，IDE 能在每个参数旁弹出中文说明，以及那些类型定义本身是怎么写的。对应源码 `src/types.ts`，730 行，全库唯一的集中类型文件。

## 组织方式：按模块分节，一个文件管全部

`types.ts` 内部用注释分节，每节对应一个 utils/hooks 模块：

```ts
/**
 * amount.ts
 */
export interface AmountOpt {
  /** 保留几位小数，默认 `0` */
  digit?: number;
  /** 小数位是否四舍五入，默认 `false` 不进行四舍五入 */
  round?: boolean;
}

/**
 * array.ts
 */
export type OrderType = "asc" | "desc" | "random";
```

三重习惯贯穿全文件：

1. **接口名 = 函数名 + Opt/Options/Type 后缀**。`AmountOpt`（amount 的选项）、`CleanOptions`（object 的选项）、`ScrollOptions`（useScrollTo 的选项），猜得到、找得到。
2. **每个字段一行 JSDoc**，写默认值和可取值。JSDoc 挂在字段上，IDE 悬浮提示直接显示——这就是"类型即文档"的字面含义：文档站上的参数说明和 IDE 提示是同一份内容。
3. **共享类型置顶**。`Awaitable`、`Recordable`、`ElementOf` 这些跨模块的泛型工具放在文件头部。

集中式的代价是 `types.ts` 单文件偏大；收益是**找类型只有一个地方**，对比"类型散在各模块文件里"的组织方式，检索成本低得多。库的 `index.ts` 最后一行 `export * from "./types"`，所有类型随包导出，使用方可以直接 `import type { CleanOptions } from "@pureadmin/utils"` 复用。

## 四个高频泛型工具类型

类型文件头部的这批导出，写业务时也能直接拿来用：

```ts
// 值可能是 T，也可能是 T 的 Promise——异步函数返回值的标准写法
export type Awaitable<T> = T | PromiseLike<T>;

// 键为 string 的对象，替代裸 object，保留值的类型信息
export type Recordable<T = any> = Record<string, T>;

// 从数组类型里抠出元素类型：ElementOf<string[]> = string
export type ElementOf<T> = T extends (infer E)[] ? E : never;

// 把联合类型压成交集：UnionToIntersection<{a:1} | {b:2}> = {a:1} & {b:2}
export type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void
  ? I
  : never;
```

`UnionToIntersection` 那行值得多看一眼：先用分布式条件类型把联合的每一项变成函数参数 `(k: A) => void | (k: B) => void`，再对函数参数位置做 `infer`——TS 在这个位置只可能推出参数的交集。函数参数逆变，联合逆变后变交集，这是标准技巧（文件里的注释也附了 Stack Overflow 出处）。

## 实战样本一：四态参数怎么写

`cleanObject` 的 `includeKeys` 支持 Set、数组、对象、函数四种写法，类型是并集：

```ts
includeKeys?:
  | Set<string | number>
  | (string | number)[]
  | Record<string, boolean>
  | ((key: string | number, value: any) => boolean);
```

类型如实描述了运行时。配套的运行时函数 `toSet`（`src/utils/object.ts`）负责把这四种形态归一成 Set：

```ts
export function toSet(value: any): Set<any> | undefined {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  if (typeof value === "object") {
    return new Set(Object.keys(value).filter(k => value[k] === true || value[k] === 1));
  }
  return undefined;
}
```

这是处理"多态参数"的通用套路：**类型上用并集保持灵活，实现上第一件事归一化，后续逻辑只面对一种形态**。`stripKeysInObjects` 更进一步，值可以是"字符串或函数组成的数组"，也可以是单个函数，类型照实写，运行时 `shouldStripField` 里逐个 `typeof` 判断。

## 实战样本二：DeepClean，类型层面的"洗对象"

`cleanObject` 运行时把空串、null 等无效值洗掉；`DeepClean<T>` 在**类型层面**做同样的事，让返回值的类型精确反映"这些字段已经没了"：

```ts
export type isInvalidLiteral<T> = T extends null | undefined | "" ? true : false;

export type DeepClean<T> = T extends object
  ? {
      [K in keyof T as isInvalidLiteral<T[K]> extends true ? never : K]: DeepClean<T[K]>;
    }
  : T;
```

三层结构，逐个拆：

1. `isInvalidLiteral<T>` 是个判空探针：类型是 `null`、`undefined` 或字面量 `""` 就返回 `true`。
2. `DeepClean<T>` 递归。`T extends object` 不成立（原始值）直接原样返回；成立则进入映射类型。
3. 映射类型里的 `as` 子句做**键重映射**：`isInvalidLiteral<T[K]>` 为 `true` 的键映射成 `never`，TS 对值为 `never` 的键直接从结果类型里删除。

效果：

```ts
type Input = { name: string; remark: "" | string; age: undefined; tags: string[] };
type Output = DeepClean<Input>;
// { name: string; remark: string; tags: string[] }
// age 消失了，remark 的 "" 字面量被剥掉
```

注意它的边界：能洗掉的是**类型上可判定的**字面量（`""`、`null`、`undefined`），运行时从 `"  "`（空白串）或空数组洗掉的东西类型层面推不出来，所以 `cleanObject` 的返回类型标注是 `DeepClean<T> | undefined`——兜底交给 `undefined` 分支和运行时。

`DeepMerge<F, S>` 同族，配合 `MergeInsertions` 先把 `&` 交叉摊平再逐键合并，同样是"先递归、再映射"的骨架。这两个类型放在一起读，条件类型的四大件就齐了：分布式条件、`infer`、键重映射（`as`）、递归。

## 实战样本三：环境差异的类型伪装

hooks 接受的元素参数既可能是 `ref`，也可能是字符串选择器。`types.ts` 里专门定义了容器类型：

```ts
export interface ElementRef<T = any> {
  value: T;
}
```

它刻意长得像 Vue 的 `Ref` 却不 import Vue——hooks 内部用 `unrefElement`（`src/helps.ts`）做运行时解包，类型层面只需要"有 value 字段"这个结构约定。结构类型系统的典型应用：**只要形状匹配，不关心来历**。这让同样的类型在无 Vue 的环境里也能通过编译。

类似的还有 `UtilsEChartsOption`：

```ts
export interface UtilsEChartsOption extends EChartsOption {
  clear?: boolean;
  addTooltip?: ToolTipType;
  delay?: number;
  resize?: boolean;
  container?: ElementRef<HTMLDivElement> | string | (ElementRef<HTMLDivElement> | string)[];
}
```

继承 echarts 的完整配置类型，追加四个自己的扩展字段。使用者的补全体验因此是"echarts 原生配置 + 库扩展"无缝混排，`triggerEvent: true` 这种 echarts 字段和 `addTooltip: "x"` 这种库字段出现在同一个对象里，都有提示。

## 新手常见误解：类型只是给 IDE 看的装饰

这个库里至少有两类类型在**运行时决策**里有一席之地：

1. **类型守卫改变控制流**。`isNumber(val)` 的返回类型标注是 `val is number`，if 通过之后 TS 收窄类型，后面的代码才能安全地把 `val` 当数字用。这不是装饰，是编译期契约。库内 40 多个 `isXxx` 大量使用这个模式，自己写判断函数时值得照抄：

   ```ts
   export function isDate(val: unknown): val is Date {
     return is(val, "Date");
   }
   ```

   参数类型用 `unknown` 而不是 `any`，守卫才有意义——`any` 进来什么都推得出来，守卫形同虚设。

2. **配置对象的类型就是校验文档**。`attr` 接口里 `shadowConfig?: Array<any>` 配着四行 JSDoc 说明"必填第一位 blur"——类型系统表达不了 tuple 每位的语义时，JSDoc 补位。看类型文件的注释密度就能判断一个库的维护态度。

## 下一步

静态和运行时都讲完了。[第 8 篇：工程化体系](./08-engineering.md)看这个库怎么构建、怎么测试、怎么发版——四份 tsup 配置、两条 CI 流水线、husky 加 commitlint 的完整工具链。

**动手练习**：在任意 TS 项目里定义一个嵌套三层的接口，中间夹几个 `""`、`undefined` 字段，用 `DeepClean` 推导一次，对照 `src/utils/object.ts` 的 `cleanObject` 跑一遍同样的输入，验证类型删除的字段和运行时删除的字段是否一致；找出那一个不一致的场景（提示：值类型标成 `string`、运行时值恰好是 `""` 的字段，类型层面洗不掉）。

# 02 · 工具函数实战：最常用的 25 个函数

> 系列导航：[README](./README.md) | [上一篇：初识](./01-getting-started.md) | [下一篇：hooks 实战 →](./03-hooks-in-action.md)

读完本篇你会掌握：

1. 六个高频场景下分别该用哪些函数
2. 每个函数的真实输入输出（示例值全部来自仓库测试文件 `src/tests/utils.test.ts` 的断言）
3. 几个容易用错的边界行为

先建立一张场景速查表，后文按场景展开。

| 场景 | 首选函数 | 所在文件 |
| --- | --- | --- |
| 判空、类型、格式校验 | `isEmpty` `isAllEmpty` `isUrl` `isPhone` | `src/utils/is.ts` |
| 数组判断与拆分 | `arrayAllExist` `randomDivide` | `src/utils/array.ts` |
| 对象删字段、清理无效值 | `delObjectProperty` `cleanObject` | `src/utils/object.ts` |
| 字符串截取与脱敏 | `subBefore` `hideTextAtIndex` | `src/utils/substring.ts` |
| 金额展示与精度运算 | `priceToThousands` `priceUppercase` `addition` | `src/utils/amount.ts` `src/utils/math.ts` |
| 扁平数据转树 | `handleTree` `getNodeByUniqueId` | `src/utils/tree.ts` |

## 场景一：判空和校验

库的判空分两档，这是新手最容易混的一对：

```ts
import { isEmpty, isAllEmpty } from "@pureadmin/utils";

isEmpty("");      // true，空字符串算空
isEmpty([]);      // true，空数组算空
isEmpty({});      // true，空对象算空
isEmpty(null);    // false！null 不在 isEmpty 的管辖范围

isAllEmpty(null); // true，直接视为空
isAllEmpty("");   // true
```

一句话记住：`isEmpty` 管"容器空"，`isAllEmpty` 在它基础上把 `null`、`undefined` 也判为空。表单搜索场景（空输入就不带这个参数发请求）用 `isAllEmpty` 更合适。

正则校验类函数签名统一是 `(value) => boolean`：

```ts
import { isUrl, isPhone, isEmail, isQQ, hasCNChars } from "@pureadmin/utils";

isUrl("http://localhost:8800/doc.html");   // true，支持 localhost
isUrl("http://192.168.2.121:8848/#/ext");  // true，支持 IP 加端口加 hash
isPhone("13812345678");                    // true，按大陆号段校验
isQQ("12345");                             // true，5 到 13 位数字
hasCNChars("12ab--中--");                  // true，含中文即 true
```

`hasCNChars` 还能验证"是否全是中文"，第二个参数传 `{ all: true }` 即可；传 `{ pure: true }` 会先删掉全部空格再判断。

## 场景二：数组

```ts
import { arrayAnyExist, arrayAllExist, randomDivide, intersection } from "@pureadmin/utils";

arrayAnyExist([1, 2, "3", "body"], ["body", "html"]);  // true，有交集
arrayAllExist([1, 2, "body"], ["body", 2]);            // true，子集
intersection([1, 2, 3], [2, 3, 4]);                    // [2, 3]
```

带 `Deep` 后缀的版本（`arrayAnyExistDeep`、`arrayAllExistDeep`）走深度比较，能识别内容相同的对象和 Map；不带后缀的版本用 `Set` 判断引用相等，性能更好但只适用于基本类型。

`randomDivide` 是个低调但好用的函数：把一个总数随机拆成 N 份，常用于红包、权重分配这类需求：

```ts
import { sum } from "@pureadmin/utils";

const parts = randomDivide(900, 10, { minPerPart: 20 });
// 类似 [95, 72, 88, ...]，每一份不小于 20
sum(parts); // 900，总和严格等于拆分前
```

第三个参数还支持 `maxPerPart`（每份上限）和 `order`（`'asc' | 'desc' | 'random'` 控制返回顺序）。内部用 Fisher-Yates 洗牌保证每份出现的概率均匀。

## 场景三：对象

删字段是最常见的需求，`delObjectProperty` 不改原对象：

```ts
import { delObjectProperty } from "@pureadmin/utils";

const next = delObjectProperty({ a: 1, b: 2, c: 3 }, ["b", "c"]);
// { a: 1 }
```

`cleanObject` 干的是更脏的活：把请求参数里的无效值整个洗掉，支持细粒度配置：

```ts
import { cleanObject } from "@pureadmin/utils";

cleanObject({
  name: "tom",
  age: undefined,
  remark: "",
  tags: [],
  extra: {}
});
// { name: "tom" }，undefined、空串、空数组、空对象全被移除

cleanObject(obj, {
  excludeWhitespaceStrings: true,  // 连 "   " 这种纯空白也移除
  excludeKeys: ["token"],          // 黑名单字段
  maxDepth: 3                      // 递归深度上限，防栈溢出
});
```

每个选项的完整说明见 `src/types.ts` 里的 `CleanOptions` 接口，注释是中文的，直接看类型文件就是文档。

## 场景四：字符串

```ts
import { subBefore, subAfter, subBetween, hideTextAtIndex } from "@pureadmin/utils";

subBefore("https://cn.vitest.dev/api/#expect", "api");  // "https://cn.vitest.dev/"
subAfter("https://cn.vitest.dev/api/#expect", "api");   // "/#expect"
subBetween("https://cn.vitest.dev/api/#expect", "api", "ec"); // "/#exp"
```

`hideTextAtIndex` 专做脱敏，支持三种索引写法：单位置、多个位置、区间：

```ts
hideTextAtIndex("hello world", 1);              // "h*llo world"
hideTextAtIndex("hello world", [1, 2, 8]);      // "h**lo wo*ld"
hideTextAtIndex("hello world", { start: 1, end: 9 }); // "h*********d"
hideTextAtIndex("hello world", { start: 1, end: 9 }, "-"); // 换符号
```

手机号中间四位打码、身份证保留前三后四，都用它。

## 场景五：金额和精度

```ts
import { priceToThousands, priceUppercase } from "@pureadmin/utils";

priceToThousands(123456789);                    // "123,456,789"
priceToThousands(123456789.567, { digit: 2 });  // "123,456,789.56"，直接截断
priceToThousands(123456789.567, { digit: 2, round: true }); // "123,456,789.57"，四舍五入

priceUppercase(1234.56); // "壹仟贰佰叁拾肆元伍角陆分"
```

`digit` 不传 `round` 时是**截断**而不是四舍五入，涉及退款、分账时要想清楚用哪种。

JavaScript 的浮点精度是老问题，`math.ts` 提供的四个运算函数先放大成整数再算，绕开误差：

```ts
import { addition, subtraction, multiplication } from "@pureadmin/utils";

0.1 + 0.2;                        // 0.30000000000000004
addition(1.4003, 100);            // 101.4003
subtraction(1.4003, 100);         // -98.5997
multiplication(1.4003, 100);      // 140.03
```

## 场景六：树形数据

后端返回扁平的部门列表，前端要渲染成级联选择器，`handleTree` 一步到位：

```ts
import { handleTree, getNodeByUniqueId } from "@pureadmin/utils";

const flat = [
  { id: 1, parentId: null, name: "总公司" },
  { id: 2, parentId: 1, name: "研发部" },
  { id: 3, parentId: 1, name: "市场部" }
];

handleTree(flat);
// [
//   { id: 1, parentId: null, name: "总公司",
//     children: [
//       { id: 2, parentId: 1, name: "研发部", children: [...] },
//       { id: 3, parentId: 1, name: "市场部", children: [...] }
//     ] }
// ]

// 字段名不叫 id / parentId 时可以自定义
handleTree(flat, "deptId", "parentDeptId", "subDepts");
```

`tree.ts` 里的另一组函数围绕 `uniqueId` 工作：`buildHierarchyTree` 给树节点补上 `id`、`parentId`、`pathList`、`uniqueId`，之后就能用 `getNodeByUniqueId(tree, "0-1")` 快速取节点、用 `appendFieldByUniqueId` 给指定节点加字段。vue-pure-admin 的菜单系统就是这么处理的。

## 场景七：本地存储

```ts
import { storageLocal, storageSession } from "@pureadmin/utils";

const local = storageLocal();
local.setItem("user", { id: 1, name: "tom" }); // 自动 JSON 序列化
local.getItem("user");                          // { id: 1, name: "tom" }，自动反序列化
local.removeItem("user");
```

比原生 `localStorage` 省掉了两头的 `JSON.stringify` / `JSON.parse`，存对象不再是 `"[object Object]"`。`storageSession` 用法完全相同。

## 三个容易踩的边界

1. **`randomColor` 的 rgb 格式依赖浏览器**。源码里 rgb 分支用了 `window.crypto.getRandomValues`，Node 里传 `{ type: "rgb" }` 返回 `undefined`。要随机色在服务端生成，用 `hex` 或 `hsl` 格式。
2. **`isUrl` 不接受无协议域名**。`github.com` 返回 `false`，协议部分写全才行。
3. **`isEmpty` 对数字恒为 `false`**。它只检查数组、字符串、Map、Set、对象的"空"，`isEmpty(0)`、`isEmpty(NaN)` 都是 `false`。数字判空自己写 `val === 0` 或 `Number.isNaN`。

## 下一步

工具函数是静态能力，hooks 是持续行为。[第 3 篇：hooks 实战](./03-hooks-in-action.md)讲怎么在 Vue 组件里用好水印、拖拽、暗色模式和剪贴板。

**动手练习**：用 `cleanObject` 处理一个嵌套两层的表单对象，其中内层对象所有字段都是空串，观察不加任何配置时内层对象是保留 `{}` 还是被整个移除；再打开 `src/utils/object.ts` 对照 `allowRootIfEmpty` 和 `excludeEmptyObjects` 两个选项，找到控制这个行为的那行代码。

# 09 · 实战：给库添加一个新函数

> 系列导航：[README](./README.md) | [上一篇：工程化体系](./08-engineering.md) | [下一篇：源码笔记与已知边界 →](./10-source-notes.md)

读完本篇你会掌握：

1. 新增一个库函数的完整流程：实现 → 类型 → 导出 → 测试 → 验证
2. 这个库的代码风格约定（JSDoc 模板、防御姿势、导出位置）
3. 每一步怎么验证

前八篇都是"读"。这一篇动手：以一个假想的 `clamp`（数字夹取范围）函数为例，完整走一遍新增流程。本篇在仓库里是教程性质——真要给开源库贡献代码，最后还要走 issue 沟通、fork、PR 的开源流程，技术部分是通用的。

## 目标函数

```ts
clamp(15, 0, 10);      // 10，超上界夹回
clamp(-5, 0, 10);      // 0，超下界夹回
clamp(5, 0, 10);       // 5，范围内原样返回
```

虽是假想例子，流程里每一步的规范都取自库里真实函数的写法。

## 第一步：写实现

数字类函数放 `src/utils/math.ts`。先看库里同类函数长什么样——`math.ts` 里的 `max`：

```ts
export const max = (list: Array<number>): number => {
  if (isArray(list) && list.length > 0) {
    return Math.max.apply(null, list);
  } else {
    return 0;
  }
};
```

风格要素：`export const` 箭头函数、显式参数与返回类型、入参先做防御检查、每个函数带中文 JSDoc。照这个风格写 `clamp`：

```ts
/**
 * @description 将数值限制在指定区间内，超出边界时返回最近的边界值
 * @param val 需要夹取的数值
 * @param min 下界
 * @param max 上界
 * @returns 夹取后的数值
 * @see 详细文档 https://pure-admin-utils.netlify.app/utils/math/math#clamp
 */
export const clamp = (val: number, min: number, max: number): number => {
  if (min > max) {
    console.error("clamp: 下界不能大于上界");
    return val;
  }
  return Math.min(Math.max(val, min), max);
};
```

四个风格约定：

1. **JSDoc 四件套**：`@description`（一句话功能）、`@param`（逐参数中文说明）、`@returns`、`@see`（指向文档站对应锚点，全库每个函数都有这行）。
2. **异常路径不抛错**。库的惯例是 `console.warn`/`console.error` 加安全返回值（`tree.ts` 传非数组 warn 后返回 `[]`，`url.ts` 非法 URL error 后返回 `{}`）。工具函数抛异常会打断调用方流程，静默降级是这里的一贯选择。
3. **能复用内部工具就复用**。如果实现里要判断类型，import `./is` 里的函数，不手写 `typeof`（参考 `array.ts` 顶部的 `import { isArray } from "./is"`）。
4. **函数不碰浏览器专属 API 就不用防御**。`clamp` 是纯计算，不需要 `isBrowser` 短路；如果新函数要碰 DOM，第一行照抄 `if (!isBrowser) return;`（见 `link.ts`、`svg.ts`）。

## 第二步：有选项就补类型

`clamp` 参数都是原始值，不需要接口。假设你的函数有 options 参数（比如 `clamp(val, { min, max, onClamped })`），就在 `src/types.ts` 里按模块分节追加：

```ts
/**
 * math.ts
 */
export interface ClampOptions {
  /** 下界，默认 `0` */
  min?: number;
  /** 上界，默认 `100` */
  max?: number;
}
```

类型文件的组织规则见[第 7 篇](./07-type-system.md)：接口名用"函数名 + Opt/Options"，每个字段单行 JSDoc 写默认值，放在对应模块的分节注释下。`types.ts` 已被 `index.ts` 全量导出，使用方自动拿到类型，不需要再动导出清单。

## 第三步：挂进导出清单

`math.ts` 本来就在 `src/index.ts`、`src/cjs.ts`、`src/iife.ts` 三份清单里（`export * from "./utils/math"`），纯函数不用改任何入口文件。

如果新建的是独立文件，比如 `src/utils/animation.ts`，要手工维护三处：

1. `src/index.ts` 追加 `export * from "./utils/animation"`——主入口，默认要加；
2. `src/cjs.ts`——纯函数才加，碰 DOM 的别加；
3. `src/iife.ts`——浏览器可用的加，碰 Node fs 的别加。

哪个文件放哪些模块的完整决策表在[第 4 篇](./04-zero-dependency-design.md)的四入口表格里。`clamp` 属于"三处都可用"，但它寄生在已有的 `math.ts` 里，零改动。

## 第四步：写测试

在 `src/tests/utils.test.ts` 的 `describe.concurrent` 里加一个 `it` 块。先看现有用例的风格：

```ts
it("math", async () => {
  expect(max(numList)).to.equal(6);
  expect(min(numList)).to.equal(1);
  // ...
});
```

照着写，**用精确值断言**（第 8 篇说过，这是这个测试文件里证明力更强的风格）：

```ts
it("clamp", async () => {
  expect(clamp(15, 0, 10)).to.equal(10);
  expect(clamp(-5, 0, 10)).to.equal(0);
  expect(clamp(5, 0, 10)).to.equal(5);
  expect(clamp(5, 10, 0)).to.equal(5);   // 非法区间，防御路径返回原值
});
```

测试数据需要对象/树之类的复杂结构时，加到 `src/tests/mock.ts` 里 export，不要在用例里内联大字面量——这是现有测试的组织方式（`list`、`treeList`、`deptList` 都来自 mock）。

## 第五步：过四道检查

```bash
pnpm test        # 1. 新用例和全部存量用例通过
pnpm typecheck   # 2. 严格模式类型检查通过
pnpm lint        # 3. eslint + prettier 格式归一（顺手把类型又查了一遍）
pnpm build       # 4. 四份产物正常产出
```

四道全绿之后，本地验证真实消费效果：

```bash
pnpm dev         # watch 模式构建，或一次性 pnpm build
```

然后在任意 Vue/Vite 项目的 `package.json` 里把依赖指向本地：

```json
{
  "dependencies": {
    "@pureadmin/utils": "file:../pure-admin-utils"
  }
}
```

在业务代码里 import 新函数，确认补全提示（第一步的 JSDoc 会出现在悬浮卡上）、运行结果、tree-shaking（构建产物里只有你用到的函数）都符合预期。这一步等价于把"未来使用者的体验"提前走了一遍。

## 流程总结

| 步骤 | 改哪里 | 验证什么 |
| --- | --- | --- |
| 1 实现 | `src/utils/xxx.ts` | 函数能被 import |
| 2 类型 | 有 options 才改 `src/types.ts` | 参数补全与中文提示 |
| 3 导出 | 新文件才改 `index.ts`/`cjs.ts`/`iife.ts` | 产物里有、环境归属正确 |
| 4 测试 | `src/tests/utils.test.ts` | 精确值断言通过 |
| 5 检查 | 无文件改动 | test/typecheck/lint/build 四绿 |

## 新手常见误解：测试通过就能发 PR

技术流程之上还有协作流程。给开源库提 PR 前先做三件事：搜一遍 issue 列表确认没有重复提案；开 issue 描述函数名、签名、使用场景，等维护者表态是否收录——工具库对"加什么"比"怎么加"敏感得多，一个没人用的函数是长期维护负担；PR 里保持单一关注点，一个 PR 一个函数，别顺手重构。这三步的成本比写代码本身高，但决定了 PR 的最终去向。

## 下一步

最后一步：把自己升级成"读得懂源码暗礁"的人。[第 10 篇：源码笔记与已知边界](./10-source-notes.md)整理了阅读源码时值得标注的位置——它们不是缺陷清单，是理解这个库真实成熟度的地图。

**动手练习**：把本篇的 `clamp` 真的加进本地仓库（记得先 `git checkout -b feat/clamp`），完整走完五步。然后给自己加一道难度：把签名改成 `clamp(val, options)` 并在 `types.ts` 里定义 `ClampOptions`，重新走一遍 typecheck 和测试，体会"改签名"比"加函数"多动哪些地方。

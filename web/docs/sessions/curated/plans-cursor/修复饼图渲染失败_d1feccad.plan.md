---
name: 修复饼图渲染失败
overview: 将 NutritionPieChart 的 echarts 引用从 subPackage 版切换到主包版本，解决在 Popup 弹层内 Canvas 节点查询失败的问题。
todos: []
isProject: false
---


## 问题

`NutritionPieChart` 渲染在 `<Popup>` 弹层内，但引用的 echarts 封装（`@/subPackage/components/echarts-taro3-react`）存在以下缺陷：

1. `Taro.createSelectorQuery()` 未使用 `.in(this)` 限定作用域，Popup 内节点查询返回 null
2. 无空值保护，`res[0].node` 直接崩溃
3. 无重试机制，首次失败后永远无法恢复

## 修复

修改 [src/components/A2UI/FoodAssessmentCheckln/NutritionPieChart.tsx](src/components/A2UI/FoodAssessmentCheckln/NutritionPieChart.tsx) 第 4-5 行 import 路径：

```diff
- import { EChart } from '@/subPackage/components/echarts-taro3-react';
- import * as echarts from '@/subPackage/components/echarts-taro3-react/ec-canvas/echarts';
+ import { EChart } from '@/components/echarts-taro3-react';
+ import * as echarts from '@/components/echarts-taro3-react/ec-canvas/echarts';
```

主包版本具备 `.in(this)` 作用域限定、空值保护、最多 8 次重试，可正确处理 Popup / 分包 / 嵌套场景。

## 改动范围

- 仅 1 个文件，仅 2 行 import
- 不涉及逻辑、样式、配置变更
- 主包与 subPackage 的 EChart 组件接口完全一致，兼容性无风险

## 验证

- 打开 AI 智能教练页面，点击饮食打卡，确认饼图正常渲染

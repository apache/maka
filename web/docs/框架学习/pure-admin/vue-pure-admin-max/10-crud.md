# 10 实战：新增一个完整业务模块

> 本篇目标：手把手新增一个"商品管理"模块，包含左侧菜单、列表页、搜索、新增编辑弹窗、假数据。全程照抄 `src/views/system/user/` 的既有范式，不走偏路。完成本篇你就具备了在本框架交付业务页面的完整能力。

## 一句话定义

新增业务模块 = 四件事：一个路由文件（进菜单）、一个 api 文件（定接口）、一个 mock 文件（供数据）、一个 views 目录（写页面）。

类比注册新门店：工商登记（路由，让你出现在"菜单"这条街上）、开对公账户（api，定资金通道）、备首批货（mock）、装修营业（views）。顺序就是依赖顺序。

## 范式参照物

本篇每一步都有现成参照。开写前先把 `src/views/system/user/` 目录结构过一遍：

```
src/views/system/user/
├── index.vue        # 页面骨架：布局、PureTableBar、pure-table、部门树插槽
├── tree.vue         # 左侧部门树
├── form/index.vue   # 新增/编辑弹窗表单
├── form/role.vue    # 分配角色弹窗
└── utils/
    ├── hook.tsx     # 逻辑层：状态 + columns + 全部事件函数（核心）
    ├── rule.ts      # 表单校验规则
    ├── types.ts     # 表单项类型
    └── reset.css    # 局部样式
```

分工原则一句话：`index.vue` 管"长什么样"，`hook.tsx` 管"怎么动"。columns 定义、onSearch、onAdd、onUpdate 全在 hook 里，页面组件只消费。全框架的 CRUD 页（role、dept、dict、tenant）都是这个结构。

## 第一步：路由文件（进菜单）

新建 `src/router/modules/goods.ts`：

```ts
import { $t } from "@/plugins/i18n";

export default {
  path: "/goods",
  redirect: "/goods/index",
  meta: {
    icon: "ri:shopping-bag-3-line",
    title: $t("menus.pureGoods"),   // i18n 词条，也可直接写中文字符串
    rank: 30                        // 新板块排最后
  },
  children: [
    {
      path: "/goods/index",
      name: "Goods",                // 全局唯一，且与页面组件 name 一致
      meta: {
        title: "商品管理",
        keepAlive: true             // 需要缓存就开，组件 name 必须叫 Goods
      }
    }
  ]
} satisfies RouteConfigsTable;
```

三个关键约束（违背会踩坑，出处见第 04 篇）：`name` 全局唯一；`keepAlive: true` 时组件 `name` 必须同路由 `name`；静态路由自动被扫描，**无需任何 import 注册**。保存后 dev server 热更，左侧菜单立刻出现"商品管理"。

`rank` 建议集中登记到 `src/router/enums.ts`（现在最后一个用到的是 `menuoverflow = 29`），追加 `goods = 30` 并导出，然后路由里写 `rank: goods`。

## 第二步：api 文件（定接口）

新建 `src/api/goods.ts`，完全模仿 `src/api/system.ts` 的写法：

```ts
import { http } from "@/utils/http";

type ResultTable = {
  code: number;
  message: string;
  data?: {
    list: Array<any>;
    total?: number;
    pageSize?: number;
    currentPage?: number;
  };
};

/** 商品列表 */
export const getGoodsList = (data?: object) => {
  return http.request<ResultTable>("post", "/goods", { data });
};
```

列表接口的分页结构固定为 `{ list, total, pageSize, currentPage }`，这是全框架表格页的契约（第 06 篇），别自创字段名。

## 第三步：mock 文件（供数据）

新建 `src/mock/goods.ts`：

```ts
import { defineFakeRoute } from "vite-plugin-fake-server/client";

const goodsList = [
  { id: 1, name: "机械键盘", price: 399, stock: 120, status: 1 },
  { id: 2, name: "显示器支架", price: 159, stock: 0, status: 0 }
];

export default defineFakeRoute([
  {
    url: "/goods",
    method: "post",
    response: ({ body }) => {
      const filtered = goodsList.filter(
        v => !body?.name || v.name.includes(body.name)
      );
      return {
        code: 0,
        message: "操作成功",
        data: {
          list: filtered,
          total: filtered.length
        }
      };
    }
  }
]);
```

`vite-plugin-fake-server` 的 include 配置是 `"mock"` 目录（`build/plugins.ts` 第 56 行），dev server 会自动加载新文件，无需重启；生产构建因 `enableProd: true` 也会带上（接后端后记得关，第 06 篇）。

## 第四步：views 页面（写页面）

新建目录 `src/views/goods/`，先写逻辑层 `utils/hook.tsx`。下面是最小可用版，注释标明了与 user 页的对应关系：

```tsx
import { message } from "@/utils/message";
import { addDialog } from "@/components/ReDialog";
import { getGoodsList } from "@/api/goods";
import type { Ref } from "vue";
import { h, reactive, ref, onMounted } from "vue";
import editForm from "../form/index.vue";

export function useGoods(tableRef: Ref) {
  const form = reactive({ name: "" });          // 搜索表单，对应 user 页的 form
  const dataList = ref([]);
  const loading = ref(true);
  const pagination = reactive({
    total: 0,
    pageSize: 10,
    currentPage: 1
  });

  const columns: TableColumnList = [            // 列定义，pure-table 的核心配置
    { type: "selection", align: "left" },
    { label: "商品编号", prop: "id" },
    { label: "商品名称", prop: "name" },
    { label: "价格", prop: "price" },
    {
      label: "状态",
      cellRenderer: ({ row }) =>
        h("span", row.status === 1 ? "在售" : "下架")   // 自定义单元格
    },
    {
      label: "操作",
      fixed: "right",
      slot: "operation"                         // 操作列留给页面插槽
    }
  ];

  async function onSearch() {
    loading.value = true;
    const { data } = await getGoodsList({
      ...form,
      page: pagination.currentPage,
      pageSize: pagination.pageSize
    });
    dataList.value = data.list;
    pagination.total = data.total;
    loading.value = false;
  }

  function openDialog(title: string, row?: any) {
    addDialog({                                 // ReDialog 函数式弹窗
      title,
      props: { formInline: { name: row?.name ?? "", price: row?.price ?? 0 } },
      contentRenderer: () => editForm,
      beforeSure: (done, { options }) => {
        message(`已提交：${options.props.formInline.name}`, { type: "success" });
        done();                                 // 关闭弹窗
        onSearch();
      }
    });
  }

  onMounted(() => onSearch());

  return { form, loading, columns, dataList, pagination, onSearch, openDialog };
}
```

再写弹窗表单 `form/index.vue`（user 页同款骨架，要素：`defineOptions({ name: "XXForm" })`、props 接 formInline、el-form 包 el-input）和页面 `index.vue`（结构照抄 `views/system/user/index.vue`：PureTableBar 包搜索区与按钮、pure-table 绑 columns 与 dataList、`#operation` 插槽放编辑按钮）：

```vue
<script setup lang="ts">
import { ref } from "vue";
import { PureTableBar } from "@/components/RePureTableBar";
import { useGoods } from "./utils/hook";

defineOptions({ name: "Goods" });   // 必须与路由 name 一致，keep-alive 依赖它

const tableRef = ref();
const {
  form, loading, columns, dataList, pagination, onSearch, openDialog
} = useGoods(tableRef);
</script>

<template>
  <div class="main">
    <PureTableBar title="商品管理" :columns="columns" @refresh="onSearch">
      <template #buttons>
        <el-button type="primary" @click="openDialog('新增')">
          新增商品
        </el-button>
      </template>
      <template v-slot="{ size, dynamicColumns }">
        <pure-table
          ref="tableRef"
          adaptive
          :height="size === 'default' ? undefined : 300"
          row-key="id"
          :data="dataList"
          :columns="dynamicColumns"
          :loading="loading"
          :pagination="pagination"
          @page-size-change="pagination.currentPage = 1; onSearch()"
          @page-current-change="onSearch"
        >
          <template #operation="{ row }">
            <el-button link type="primary" @click="openDialog('编辑', row)">
              编辑
            </el-button>
          </template>
        </pure-table>
      </template>
    </PureTableBar>
  </div>
</template>
```

保存刷新，菜单点进去：搜索、分页、新增弹窗全部可用，数据来自你的 mock。

## 第五步：补权限（可选但推荐）

给操作按钮加权限，两种二选一（概念见第 05 篇）：

```vue
<Perms value="goods:btn:edit">
  <el-button link type="primary" @click="openDialog('编辑', row)">编辑</el-button>
</Perms>
```

用 admin 登录（permissions 为 `*:*:*`）按钮可见；换普通账号登录则隐藏。后端接入后，把 `goods:btn:edit` 之类的权限码交由权限系统管理即可。

## 自检清单

对照 `views/system/user/` 逐项检查，这是接手人最容易追问的点：

| 检查项 | 标准 |
| --- | --- |
| 组件 name 与路由 name 一致 | 标签页缓存生效，刷新不丢状态 |
| 接口全部走 `src/api/goods.ts` | 页面里没有裸 http 调用 |
| mock 分页结构与契约一致 | `{ list, total, pageSize, currentPage }` |
| 列表 loading 有始有终 | 请求失败也不会永远转圈（try/finally） |
| 弹窗复用 | 新增与编辑共用一个 form 组件，靠 title 与入参区分 |
| 中文词条走 i18n | 菜单 title 用 `$t`，页面内文案初期可直接中文，后续统一迁移 `locales/` |

## 进阶方向

范式跑通后，按需叠加既有能力，都有现成参照：

- 左侧分类树：照抄 `user/tree.vue` + `handleTree`（`src/utils/tree.ts`）。
- 行内状态开关：照抄用户管理页的状态列（`usePublicHooks` 的 `switchStyle`）。
- 表格编辑、拖拽、导出 Excel：`src/views/table/edit/` 与 `table/high/excel/`。
- 导入导出、批量删除：用户管理页顶栏按钮区。
- 真实后端对接：回到第 06 篇的清单。

## 下一步

功能会做了，最后一篇 [11 精通：二次开发与精简指南](./11-mastery.md) 讲怎么把这个"全家桶"裁成你的产品，以及上线前的检查单。

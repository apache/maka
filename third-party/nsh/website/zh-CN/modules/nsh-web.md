---
title: nsh/web
description: Web 上应用所在页面的 API：Head（文档的标题、描述和元数据，供搜索引擎和链接预览使用）。
order: 12.6
---

# nsh/web

`nsh/web` 提供 Web 上应用所在页面的能力：[`Head`](#head)，即文档的标题、描述和元数据，供搜索引擎收录、链接预览展示。该模块在所有平台上都可以导入，因此同一个 bundle 可以在所有平台运行：在手机和桌面上，`Head` 不渲染任何内容。

```tsx
import { Head } from "nsh/web";
```

| 导出 | 类型 | 说明 |
|---|---|---|
| `Head` | `(props: HeadProps) => JSX.Element` | 在挂载期间设置页面的 `<head>`。 |

## Head

`Head` 在挂载期间设置页面的 `<head>`，本身不渲染任何内容。在应用的每个页面中放一个：放在 [`NavPage`](../elements/nav-stack.md) 里，它就在该页面显示时描述该页面。

```tsx
import { NavPage } from "nsh/base";
import { Head } from "nsh/web";

function NotePage(props: { note: Note }) {
  return (
    <NavPage title={props.note.title}>
      <Head
        title={`${props.note.title} · Market Notes`}
        description={props.note.summary}
        canonical={`/notes/${props.note.slug}`}
        meta={[{ property: "og:type", content: "article" }]}
        jsonLd={{ "@context": "https://schema.org", "@type": "Article", headline: props.note.title }}
      />
      …
    </NavPage>
  );
}
```

| 属性 | 类型 | 说明 |
|---|---|---|
| `title` | `string` | 文档的标题（`<title>`）；`meta` 未设置 `og:title` 时，也作为 Open Graph 标题。 |
| `description` | `string` | 页面的摘要（`<meta name="description">`）；`meta` 未设置 `og:description` 时，也作为 Open Graph 描述。 |
| `canonical` | `string` | 页面的规范 URL（`<link rel="canonical">`）：一个 URL，或站点内的路径（`"/notes/q3"`），从站点发布到的目录算起。 |
| `lang` | `string` | 页面的语言（`<html lang>`）：`"en"`、`"zh-CN"`。 |
| `meta` | `HeadMeta[]` | 更多 `<meta>`：每项是 `{ name, content }`（`"robots"`、`"twitter:card"`）或 `{ property, content }`（Open Graph 的 `"og:image"`）。 |
| `jsonLd` | `object` | 结构化数据（[schema.org](https://schema.org)），写成 JSON-LD `<script>`。 |

可以同时挂载多个 head：应用自己的，以及栈中每个页面各一个。最后挂载的 head 设置的内容生效，其余内容取自之前挂载的 head，因此位于顶部的页面决定文档标题，它被弹出后，下面的页面重新决定。不再有任何已挂载 head 设置的内容会被移除；没有 head 时，文档原有的标题和语言会恢复。每个属性都是响应式的：读取 signal 的 head 会随之更新。

[Web](../docs/web.md#搜索引擎) 展示了一个能被搜索引擎收录、每个页面都有自己 URL 的完整站点。

---
title: nsh/web
description: "The page around an app on the web: Head, the document's title, description and metadata for search engines and link previews."
order: 12.6
---

# nsh/web

`nsh/web` holds what the page around an app has on the web: [`Head`](#head), the document's title, description and
metadata, which search engines index and link previews show. The module can be imported on every platform, so one
bundle runs everywhere: on the phones and the desktops `Head` renders nothing.

```tsx
import { Head } from "nsh/web";
```

| Export | Type | Description |
|---|---|---|
| `Head` | `(props: HeadProps) => JSX.Element` | Sets the page's `<head>` while it is mounted. |

## Head

A `Head` sets the page's `<head>` while it is mounted, and renders nothing. Put one in each page of the app: in a
[`NavPage`](../elements/nav-stack.md), it describes that page while the page shows.

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

| Prop | Type | Description |
|---|---|---|
| `title` | `string` | The document's title (`<title>`), and its Open Graph title unless `meta` sets `og:title`. |
| `description` | `string` | The page's summary (`<meta name="description">`), and its Open Graph description unless `meta` sets `og:description`. |
| `canonical` | `string` | The page's canonical URL (`<link rel="canonical">`): a URL, or a path of the site (`"/notes/q3"`), from the directory the site is published to. |
| `lang` | `string` | The page's language (`<html lang>`): `"en"`, `"zh-CN"`. |
| `meta` | `HeadMeta[]` | More `<meta>`s: each `{ name, content }` (`"robots"`, `"twitter:card"`) or `{ property, content }` (Open Graph's `"og:image"`). |
| `jsonLd` | `object` | Structured data ([schema.org](https://schema.org)), written as a JSON-LD `<script>`. |

Several heads may be mounted at once: the app's own and one per page of a stack. The one mounted last wins for what it
sets, and the ones before it give the rest, so the page on top titles the document, and when it is popped the page
below it does again. What no mounted head sets any more is removed, and the document's own title and language come
back when none is left. Each prop is reactive: a head that reads a signal follows it.

[The web](../docs/web.md#search-engines) shows a whole site that search engines index, with each page a URL of its own.

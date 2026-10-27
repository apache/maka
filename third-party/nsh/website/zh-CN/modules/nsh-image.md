---
title: Image
description: Image：显示图片的元素，以及用于获取图片信息和预加载的 Image.getSize 与 Image.prefetch。
order: 2.2
---

# Image

`nsh` 导出 `Image`，即显示图片的 [`<Image>`](../elements/image.md) 元素。同一个 `Image` 还可以在不显示图片的情况下向原生图片加载器查询图片信息：尺寸，以及在显示之前预先加载。

```ts
import { Image, type ImageSize } from "nsh";
```

`Image` 是一个带有两个函数的组件：`<Image src=…>` 渲染原生图片视图（编译器像处理 `<View>` 一样就地创建它），`Image.getSize` / `Image.prefetch` 则直接在它上面调用。

```ts
const Image: ((props: ImageProps) => YNode) & {
  getSize(src: string | ImageAsset): Promise<ImageSize>;
  prefetch(src: string | ImageAsset): Promise<boolean>;
};
```

教程见[图片与资源](../docs/images-and-assets.md)。

## Image.getSize

```ts
getSize(src: string | ImageAsset): Promise<ImageSize>;

interface ImageSize {
  width: number;   // 像素（SVG 为点）
  height: number;
}
```

加载图片，并 resolve 为它的像素尺寸（源图片的尺寸，而不是降采样后的副本；SVG 为它以点为单位的固有尺寸，[在 Web 上为浏览器测得的尺寸](../docs/images-and-assets.md#svg-图片)）。带有[像素密度变体](../docs/images-and-assets.md#像素密度)的导入图片会加载视图在当前屏幕上加载的变体，并 resolve 为导入文件的尺寸，无论加载的是哪个变体（显示它的 `<Image>` 在 `onLoad` 中报告所加载变体的像素尺寸）。加载的数据会保留在内存中，接下来显示它的 `<Image>` 不会再次下载。图片无法加载时 Promise 会 reject。

```tsx
import { Image, signal } from "nsh";

const url = "https://picsum.photos/seed/nsh/1200/800";
const ratio = signal(1);

Image.getSize(url).then(({ width, height }) => ratio.set(width / height));

<Image src={url} style={{ width: "100%", aspectRatio: ratio() }} />;
```

## Image.prefetch

```ts
prefetch(src: string | ImageAsset): Promise<boolean>;
```

在显示之前预先加载图片。数据进入内存后 resolve 为 `true`（无法加载时为 `false`）。对于带有像素密度变体的导入图片，它加载视图在当前屏幕上加载的那个变体。适合用于相册的下一页，或点击后才会显示的图片。

```ts
const next = photos.slice(index + 1, index + 4);
next.forEach((p) => Image.prefetch(p.url));
```

## 相关内容

- [`<Image>`](../elements/image.md)：`src`、`placeholder`、`objectFit` 样式、`onLoad`、`onProgress`、`onError` 等属性。
- 导入图片文件（`import logo from "./logo.png"`）会得到一个 `ImageAsset`（`{ url, size, scales? }`，尺寸单位为点），`<Image src>` 和画布的 `drawImage` 都接受它。

> [!NOTE]
> 如果应用在 `nsh.json` 中声明了 `capabilities`，对远程 URL 调用 `getSize` 和 `prefetch` 需要像 `fetch` 一样在 `network` 中允许。见[沙箱与权限](../docs/sandbox-and-capabilities.md)。

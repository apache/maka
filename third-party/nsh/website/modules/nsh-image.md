---
title: Image
description: "Image: the image element, plus Image.getSize and Image.prefetch for image information and loading ahead."
order: 2.2
---

# Image

`nsh` exports `Image`, the [`<Image>`](../elements/image.md) element that shows images. The same `Image` also asks the native image loader about images without showing them: their size, and loading them before they are shown.

```ts
import { Image, type ImageSize } from "nsh";
```

`Image` is a component carrying two functions: `<Image src=…>` renders the native image view (the compiler makes it in place, as it does `<View>`), and `Image.getSize` / `Image.prefetch` are called on it directly.

```ts
const Image: ((props: ImageProps) => YNode) & {
  getSize(src: string | ImageAsset): Promise<ImageSize>;
  prefetch(src: string | ImageAsset): Promise<boolean>;
};
```

See [Images and assets](../docs/images-and-assets.md) for the guide.

## Image.getSize

```ts
getSize(src: string | ImageAsset): Promise<ImageSize>;

interface ImageSize {
  width: number;   // pixels (an SVG's: points)
  height: number;
}
```

Loads the image and resolves with its size in pixels (of the source image, not a downsampled copy; an SVG's intrinsic size in points, [on the web as the browser measures it](../docs/images-and-assets.md#svg-images)). An imported image with [pixel-density variants](../docs/images-and-assets.md#pixel-densities) loads the variant the views load on this screen and resolves with the imported file's size, whichever variant it loaded (an `<Image>` showing it reports the loaded variant's pixels in `onLoad`). The loaded bytes stay in memory, so the `<Image>` that shows it next does not download it again. The promise rejects if the image cannot be loaded.

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

Loads an image ahead of showing it. Resolves with `true` once its bytes are in memory (`false` when it could not be loaded). For an imported image with pixel-density variants, it loads the variant the views load on this screen. Use it for the next page of a gallery or the image behind a tap.

```ts
const next = photos.slice(index + 1, index + 4);
next.forEach((p) => Image.prefetch(p.url));
```

## Related

- [`<Image>`](../elements/image.md): `src`, `placeholder`, the `objectFit` style, `onLoad`, `onProgress`, `onError` and the other props.
- Importing an image file (`import logo from "./logo.png"`) gives an `ImageAsset` (`{ url, size, scales? }`, sized in points) that `<Image src>` and canvas `drawImage` accept.

> [!NOTE]
> When your app declares `capabilities` in `nsh.json`, `getSize` and `prefetch` of remote URLs must be allowed under `network`, like `fetch`. See [Sandbox and capabilities](../docs/sandbox-and-capabilities.md).

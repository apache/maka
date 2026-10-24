---
title: nsh/picker
description: "Picker：用系统的选择器让用户挑选照片，得到字节留在原生侧的文件，可以直接显示和上传。"
order: 8.6
---

# nsh/picker

选择器 API 显示系统的照片选择器，并把用户选中的图片交给应用：iOS 上是照片选择器（`PHPickerViewController`），Android
上是 Photo Picker，桌面上是打开面板或文件对话框，浏览器里是文件输入框。iOS 和 Android 的选择器运行在应用之外，只交出用户
选中的内容，所以不需要相册权限。每张选中的图片都是一个 `File`（TSX）或 `PickedFile`（Rust），它的字节留在原生侧：用
`URL.createObjectURL(file)` 交给 [`Image`](../elements/image.md) 显示，用 `fetch` 和 `FormData` 上传。Rust 代码调用
`nsh_core::ui::prelude` 的 `pick_images`；TSX 从 `nsh/picker` 导入 `Picker`。

```rust tabs
use nsh_core::picker::{PickRequest, PickedFile};
use nsh_core::ui::prelude::*; // pick_images
```

```tsx tabs
import { Picker, type PickedImage } from "nsh/picker";
```

```ts
const Picker: {
  pickImages(options?: PickImagesOptions): Promise<PickedImage[]>;
};

interface PickImagesOptions {
  multiple?: boolean; // 允许选多张（false：一张）
  limit?: number; // multiple 时最多几张（最多 100）
  maxDimension?: number; // 长边超过它（像素）的图片会被缩小
  quality?: number; // JPEG 质量，0 到 1（0.9）
  format?: "compatible" | "current"; // "compatible"：HEIC 等格式转为 JPEG
}

interface PickedImage {
  file: File; // 文件名、类型、字节数和字节
  size: { width: number; height: number }; // 像素，方向已摆正
}
```

| TS | Rust |
|---|---|
| `await Picker.pickImages(options)` | `pick_images(request).await -> Vec<PickedFile>` |
| `multiple`、`limit` | `PickRequest::new(multiple, limit)`（`limit` 为 0 表示最多 100） |
| `maxDimension` | `request.max_dimension = Some(DevicePixels(2048))` |
| `quality` | `request.quality = Some(Percentage(0.8))` |
| `format` | `request.format = PickFormat::Current` |
| `image.file.name`、`.type`、`.size` | `file.name`、`file.mime`、`file.data.len()` |
| `image.size` | `file.size`（`Size<DevicePixels>`） |

## Picker.pickImages

```ts
pickImages(options?: PickImagesOptions): Promise<PickedImage[]>;
```

显示选择器，按选中的顺序 resolve 为用户选中的图片；用户取消时 resolve 为 `[]`。Rust：`pick_images(request)`，在任务里
（`spawn`，或 `async` 模块函数）await 它的结果。超出范围的选项（`limit: 0`、不在 0 到 1 之间的 `quality`）会在调用时抛出
`RangeError`。

图片拿到手就可以发送：

- **所有浏览器和服务器都认的格式。** JPEG、PNG、GIF 和 WebP 原样交出；以其他格式保存的照片（iPhone 的 HEIC、HEIF、
  TIFF）转为 JPEG。`format: "current"` 保留保存时的格式。
- **在原生侧缩小。** 设置 `maxDimension` 时，长边超过它的图片会摆正方向、缩小到刚好放下并重新编码：PNG 仍是 PNG，其他都是
  `quality` 质量的 JPEG。手机照片有 1200 万到 4800 万像素，上传前缩到 2048 像素，就只有几百 KB。设置 `quality` 时 JPEG
  也会重新编码。
- **按显示的样子。** `size` 是图片显示时的像素大小，已经按拍摄方向摆正。NSH 重新编码的图片不带元数据（没有位置信息）；
  原样交出的图片保留它自己的元数据。

在 Windows、Linux 和 GPUI 窗口中，对话框只提供请求接受的格式（`"compatible"` 时是 JPEG、PNG、GIF 和 WebP），文件按保存时的
样子和大小交出。

聊天输入框附加一张照片，编辑消息时显示它，发送时上传：

```rust tabs
use nsh_core::geometry::{DevicePixels, Percentage};
use nsh_core::picker::{PickRequest, PickedFile};
use nsh_core::ui::prelude::*;

fn attach_button(attached: Signal<Option<PickedFile>>) -> impl IntoElement {
    view()
        .role(AccessibilityRole::Button)
        .accessibility_label("Choose a photo")
        .on_press(move || {
            let mut request = PickRequest::new(false, 1);
            request.max_dimension = Some(DevicePixels(2048));
            request.quality = Some(Percentage(0.85));
            let picked = pick_images(request);
            spawn(async move {
                if let Some(file) = picked.await.into_iter().next() {
                    attached.set(Some(file));
                }
            });
        })
        .child(text("Photo"))
}

async fn upload(file: &PickedFile) -> Result<HttpResponse, String> {
    let request = HttpRequest::post("https://example.com/upload", file.data.to_vec())
        .header("Content-Type", file.mime.as_str());
    fetch(request).await
}
```

```tsx tabs
import { Image, signal, Text, View } from "nsh";
import { Picker } from "nsh/picker";

const attached = signal<{ file: File; src: string } | null>(null);

async function choosePhoto() {
  const [picked] = await Picker.pickImages({ maxDimension: 2048, quality: 0.85 });
  if (picked) attached.set({ file: picked.file, src: URL.createObjectURL(picked.file) });
}

async function send(text: string) {
  const body = new FormData();
  body.append("text", text);
  if (attached()) body.append("photo", attached()!.file);
  await fetch("https://example.com/messages", { method: "POST", body });
  if (attached()) URL.revokeObjectURL(attached()!.src);
  attached.set(null);
}

<View class="flex-row items-center gap-2">
  <View role="button" accessibilityLabel="Choose a photo" onPress={choosePhoto}>
    <Text>Photo</Text>
  </View>
  <If when={attached()}>
    <Image src={attached()!.src} style={{ width: 48, height: 48, borderRadius: 8 }} />
  </If>
</View>;
```

一次选多张：

```rust tabs
let picked = pick_images(PickRequest::new(true, 9));
spawn(async move {
    let files = picked.await;
    photos.update(|list| list.extend(files));
});
```

```tsx tabs
const images = await Picker.pickImages({ multiple: true, limit: 9, maxDimension: 2048 });
photos.set([...photos(), ...images.map((image) => URL.createObjectURL(image.file))]);
```

## 嵌入 NSH 的应用

嵌入 NSH、并且有自己选择器（比如带有应用自己的相册）的应用可以自己回答选取：在 Rust 中，把 `PickerBackend`
（`nsh_core::picker`）交给引擎（`EngineConfig::picker`，GPUI 和 GPUI Kit 应用用 `AppView::set_picker`），它会收到每次选取的
`PickRequest` 并返回文件，系统的选择器不会出现。它返回的文件和平台给的一样会被补全：截到请求的数量上限，大小、类型和
扩展名从字节中读出。

## 测试

`nsh test` 在无界面运行时回答选取：`app.onPick(handler)` 返回用户选中的文件（`{ name, type, data }`），没有 handler 时
选取会被取消。见[测试](../docs/testing-and-trace.md)。

> [!NOTE]
> 应用在 `nsh.json` 中声明了 `capabilities` 时，需要用 `"picker": true` 授予选择器。没有授予时 `pickImages` resolve 为
> `[]`，什么也不显示，Rust 和 TSX 都一样。见[沙箱与能力](../docs/sandbox-and-capabilities.md)。

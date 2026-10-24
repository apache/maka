---
title: nsh/picker
description: "Picker: let the user pick photos with the system's picker and get them as files whose bytes stay native, ready to show and upload."
order: 8.6
---

# nsh/picker

The picker API shows the system's picker for photos and gives the app the images the user picks: the Photos picker on
iOS (`PHPickerViewController`), the Photo Picker on Android, an open panel or file dialog on the desktops and a file
input in a browser. On iOS and Android the picker runs outside the app and hands over only what the user picks, so it
needs no photo library permission. Each picked image arrives as a `File` (TSX) or a `PickedFile` (Rust) whose bytes stay
native: show it with `URL.createObjectURL(file)` in an [`Image`](../elements/image.md), upload it with `fetch` and
`FormData`. Rust code calls `pick_images` of `nsh_core::ui::prelude`; TSX imports `Picker` from `nsh/picker`.

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
  multiple?: boolean; // let the user pick several (false: one)
  limit?: number; // at most this many when multiple (up to 100)
  maxDimension?: number; // scale images whose longer side is longer, in pixels
  quality?: number; // JPEG quality from 0 to 1 (0.9)
  format?: "compatible" | "current"; // "compatible": HEIC and the like as JPEG
}

interface PickedImage {
  file: File; // name, type, size in bytes and the bytes
  size: { width: number; height: number }; // pixels, upright
}
```

| TS | Rust |
|---|---|
| `await Picker.pickImages(options)` | `pick_images(request).await -> Vec<PickedFile>` |
| `multiple`, `limit` | `PickRequest::new(multiple, limit)` (`limit`: 0 for up to 100) |
| `maxDimension` | `request.max_dimension = Some(DevicePixels(2048))` |
| `quality` | `request.quality = Some(Percentage(0.8))` |
| `format` | `request.format = PickFormat::Current` |
| `image.file.name`, `.type`, `.size` | `file.name`, `file.mime`, `file.data.len()` |
| `image.size` | `file.size` (`Size<DevicePixels>`) |

## Picker.pickImages

```ts
pickImages(options?: PickImagesOptions): Promise<PickedImage[]>;
```

Shows the picker and resolves with the images the user picked, in the order picked, or `[]` when the user cancels.
Rust: `pick_images(request)`, an answer to await in a task (`spawn`, or an `async` module function). Options out of
range (`limit: 0`, a `quality` outside 0 to 1) throw a `RangeError` in the call.

The images come ready to send:

- **Formats every browser and server take.** JPEG, PNG, GIF and WebP come as they are; a photo stored in another
  format (HEIC on iPhones, HEIF, TIFF) comes as a JPEG. `format: "current"` keeps the stored format.
- **Scaled down natively.** With `maxDimension`, an image whose longer side is longer is scaled to fit it, upright, and
  encoded again: a PNG as a PNG, anything else as a JPEG of `quality`. Phone photos are 12 to 48 megapixels; scaling
  them to 2048 pixels before an upload makes them a few hundred kilobytes. A `quality` encodes JPEGs again too.
- **What it shows.** `size` is the image's size in pixels as it shows, its camera orientation applied. An image NSH
  encodes again carries no metadata (no location); one that comes as it is keeps its own.

On Windows, Linux and in GPUI windows, the dialog offers the formats the request takes (with `"compatible"`: JPEG, PNG,
GIF and WebP) and the files come as they are stored, at their own size.

A chat composer attaches a photo, shows it while the message is written, and uploads it when it is sent:

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

Several photos at once:

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

## Embedding apps

An app that embeds NSH and has a picker of its own (one with the app's own albums, say) answers the picks itself: in
Rust, a `PickerBackend` (`nsh_core::picker`) given to the engine (`EngineConfig::picker`, or `AppView::set_picker` in
GPUI and GPUI Kit apps) receives every pick's `PickRequest` and returns the files, and the system's picker is not
shown. The files it returns are completed as the platform's are: cut to the request's limit, their sizes, types and
extensions read from their bytes.

## Tests

`nsh test` answers picks in headless runs: `app.onPick(handler)` returns the files the user picks (`{ name, type, data }`),
and without a handler a pick is cancelled. See [Testing](../docs/testing-and-trace.md).

> [!NOTE]
> When your app declares `capabilities` in `nsh.json`, the picker must be granted with `"picker": true`. Without it
> `pickImages` resolves `[]` and shows nothing, from Rust and TSX alike. See
> [Sandbox and capabilities](../docs/sandbox-and-capabilities.md).

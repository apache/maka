---
title: nshm
description: "nshm（NSH 模块）：任何 Native Shell 应用都能用 nsh add 安装的组件、模块和类，可以是 Rust crate 或纯 TSX；版本、锁文件、共享安装、平台 nshm，以及如何编写和发布。"
order: 5.7
group: start
---

# nshm

**nshm**（NSH 模块）为 Native Shell 应用提供组件、模块和类，就像 crate 为 Rust 程序提供代码。它有两种：

- **Rust nshm** 是一个 Rust crate，发布在 crates.io 或 Git 上。应用可以在 TSX 和 Rust 中使用它：同一份实现，在每个平台上都是原生的。
- **TSX nshm** 是用版本标签发布的 Git 仓库里的 TSX。它被打进应用的 bundle，所以只用 TSX nshm 的应用不需要 Rust，nshm 也随应用的包和 OTA 更新一起发布。

例如 [nsh-omarchy](https://github.com/huacnlee/nsh-omarchy) 为应用带来 [Omarchy](https://omarchy.org) 的风格：按钮、输入框、菜单、对话框、表格和图表，并随系统的 Omarchy 主题实时切换。

```sh
nsh add nsh-omarchy                  # 来自 crates.io
nsh add github:huacnlee/nsh-omarchy  # 或来自 GitHub
```

然后用应用所写的语言使用它。**TSX 应用**中，只要 nshm 向 TSX 导出了组件、模块或类，`nsh add` 安装后就能直接使用：按它的标识导入即可，这里是 `nsh-omarchy`。不需要升级 NSH，也不需要自己写 Rust 代码来扩展，`nsh` 会用这个 crate 构建应用的宿主。

```tsx
// App.tsx
import { mount, signal, View } from "nsh";
import { Body, Button, Omarchy, Panel, Switch, Toaster, toast } from "nsh-omarchy";

function App() {
  // 使用系统当前的 Omarchy 主题绘制，并跟随它的变化。
  Omarchy.followSystem();
  const notify = signal(true);
  const saved = signal(0);
  const save = () => {
    saved.set(saved() + 1);
    toast({ title: "Settings saved" });
  };
  return (
    <View class="flex-1 gap-4 p-6 bg-background">
      <Panel title="Settings">
        <Switch label="Notifications" checked={notify()} onChange={({ checked }) => notify.set(checked)} />
        <Button label="Save" variant="primary" onPress={save} />
      </Panel>
      <Body>{`Saved ${saved()} times`}</Body>
      <Toaster />
    </View>
  );
}

mount(() => <App />);
```

**Rust 应用**中，它的组件就是 crate 里的函数：

```rust
// src/lib.rs：应用的根组件
use nsh_core::prelude::*;
use nsh_omarchy::tokens;

#[component]
pub fn App() -> impl IntoElement {
    // 使用系统当前的 Omarchy 主题绘制，并跟随它的变化。
    nsh_omarchy::init();
    let notify = signal(true);
    let saved = signal(0_u32);
    view()
        .flex_1()
        .p(px(tokens::SPACE_6))
        .gap(px(tokens::SPACE_4))
        .bg(move || tokens::background())
        .child(
            nsh_omarchy::panel("Settings")
                .child(
                    nsh_omarchy::switch("Notifications")
                        .checked(move || notify.get())
                        .on_change(move |on: &bool| notify.set(*on)),
                )
                .child(nsh_omarchy::button("Save").primary().on_press(move || {
                    saved.update(|n| *n += 1);
                    nsh_omarchy::toast(nsh_omarchy::Toast::new("Settings saved"));
                })),
        )
        .child(nsh_omarchy::body(move || format!("Saved {} times", saved.get())))
        .child(nsh_omarchy::toaster())
}
```

nshm 让功能不必成为 NSH 的一部分，也能交到需要它的应用手中：它按自己的节奏发布，只有安装它的应用才承担它的体积、构建时间和依赖。

## 使用 nshm

`nsh add` 可以从 crates.io、GitHub、任意 Git 地址或本地目录安装 nshm：

```sh
nsh add nsh-omarchy                                             # crates.io：最新版本
nsh add github:huacnlee/nsh-omarchy                             # GitHub：默认分支，或 @<标签>
nsh add https://github.com/huacnlee/nsh-omarchy.git --rev main  # 任意 Git 地址
nsh add --path ../nsh-omarchy                                   # 本地目录，按当前内容使用
```

它像 `Cargo.toml` 一样按包名把 nshm 记录到 `nsh.json` 的 `"dependencies"`：crates.io 上的写版本要求（`nsh add nsh-omarchy` 写入 `"^<解析到的版本>"`，`nsh add nsh-omarchy@0.3` 保留 `"0.3"`），其他来源写带 `"github"`、`"git"` 或 `"path"` 的对象。Git 上的 nshm 以标签（`v1.4.0` 或 `1.4.0`）作为版本，所以同样写版本要求；`--tag` 或 `--rev` 则固定到某个标签或提交。

```json
{
  "dependencies": {
    "nsh-omarchy": "^0.3.2",
    "acme-ui": { "github": "acme/ui", "version": "^1.4" },
    "my-gauge": { "path": "../my-gauge" }
  }
}
```

NSH 为应用用到的每个 nshm（包括 nshm 自己依赖的 nshm）解析出一个版本：所有要求都接受的最新版本。解析结果锁定在 `nsh.json` 旁的 `nsh.lock`（两者都随应用提交），所有命令都用锁定的版本构建，所以在你改动之前，应用在每台机器上构建出的都一样：

```sh
nsh upgrade                # 把每个 nshm 升级到其要求接受的最新版本
nsh upgrade nsh-omarchy    # 只升级这一个
nsh remove nsh-omarchy     # 从 nsh.json、nsh.lock 和应用的 crate 中移除
```

每个版本在一台机器上只安装一次，放在 `~/.nsh/nshms`（`NSH_HOME` 可以改 `~/.nsh` 的位置），所有用到它的应用共享这一份：来自 crates.io 的是 `nsh-omarchy/0.3.2/`，来自标签的是 `github.com/acme/ui/1.4.0/`，来自提交的是 `github.com/acme/ui/<提交>/`。用 `--path` 添加的目录就地读取。Rust 只来自 nshm 的应用，会在 `~/.nsh/builds` 中以优化方式构建一次，所有用到相同 nshm 的应用共用：第一次 `nsh run` 之后，再启动不再编译，直到 nshm 或 nsh 有更新。30 天没有应用用到的构建会被移除。

应用有自己的 crate 时，Rust nshm 还会加入该 crate 的 `[dependencies]`，应用的 Rust 代码可以直接使用。只要应用的 nshm 里有 Rust nshm，nsh 就会像对带 crate 的应用一样用它构建宿主，因此开发机和 CI 需要 Rust 工具链（[用 Rust 开发](./rust.md)）。nshm 全是 TSX 的应用只需 `nsh` 即可构建。

Rust 只来自 nshm 的应用，宿主用运行它的那个 nsh 构建：正式版用 crates.io 上它那个版本的 crate，nightly 用它自己那个提交的 crate，在源码目录里构建的 `nsh` 用该目录里的 crate。`nsh-extra` 与 nsh 一起发布，所以按版本要求依赖它的应用拿到的就是同一个 nsh 的 `nsh-extra`（有自己 crate 的应用，则是该 crate 所用 nsh 的那一份），并记录在 `nsh.lock` 中。nsh 的版本不满足版本要求时会报错，并同时指出两者。写了 `"path"`、`"github"` 或 `"git"` 的条目按原样使用。

有自己 crate 的应用也可以只在 `Cargo.toml` 里依赖 Rust nshm，和依赖其他 crate 一样，来自 crates.io、Git（仓库子目录里的 crate 也可以）或本地路径。`nsh` 会在该 crate 的依赖（直接或间接）里找出 Rust nshm，像 `"dependencies"` 里的一样链接：它们的 `#[native_module]` 入口在应用启动时运行，启用该 crate 打开的 feature，`nsh run`、`nsh test` 和打包都一样，TSX 也按标识导入它们。同时列在 `"dependencies"` 里的只链接一次。

包含多个模块的 crate 把每个模块放在一个 Cargo feature 后面，应用只开启自己用到的，也只承担这些模块的体积、权限和商店声明。`--features` 用来开启它们，条目随之写成对象形式：

```sh
nsh add nsh-extra --features camera
```

```json
{
  "dependencies": { "nsh-extra": { "version": "^0.6.0", "features": ["camera"] } }
}
```

[CLI：nsh add](./cli.md#nsh-add) 介绍了每种来源写法；[nsh upgrade](./cli.md#nsh-upgrade) 和 [nsh remove](./cli.md#nsh-remove) 介绍了其他命令。

## nsh-extra

`nsh-extra` 是 Native Shell 的官方模块集：只有部分应用需要的功能，每个都是这个 crate 的一个 Cargo feature，TSX 从 `nsh-extra` 导入，Rust 里调用 `nsh_extra::<模块>`。

| Feature | TSX | 作用 |
|---|---|---|
| `camera` | `Camera` | 在 iOS 和 Android 上用系统相机拍一张照片 |
| `location` | `Location` | 在用户允许后读取设备位置，支持 macOS、iOS 和 Web |
| `photos` | `Photos` | 在用户允许后读取 iOS 上用户最近的照片 |
| `push` | `Push` | 在 iOS 上接收任意推送服务发来的远程通知，在 Android 上通过该服务的绑定接收 |
| `speech` | `Speech` | 在 macOS、iOS、Android、Windows 和 Web 上把用户说的话随说随转成文字 |

```tsx
import { Camera } from "nsh-extra";

if (await Camera.available()) {
  // 照片和 `Picker.pickImages` 选出的图片一样：JPEG、方向已摆正、在原生侧缩放。
  const photo = await Camera.takePhoto({ maxDimension: 2048 });
  if (photo) upload(photo.file);
}
```

用户取消时 `takePhoto` 返回 `null`；用户不允许应用使用相机时，它以错误码 `EACCES` 拒绝。应用可以在同一次点按里关掉 sheet 并请求拍照：相机会在 sheet 关好之后出现。没有相机可用的地方（桌面、Web、模拟器）`available()` 为 `false`，`takePhoto` 以 `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` 拒绝。开启这个 feature 后，打包的应用会带上它需要的条目：iOS 上的相机用途说明（应用可以在 `ios.infoPlist` 里写自己的 `NSCameraUsageDescription` 文案），Android 上对相机应用的查询声明。

### Location

`Location` 在用户允许后读取设备的位置：用 `current` 读一次，或用 `watch` 在位置变化时持续收到，形式和浏览器的 `navigator.geolocation` 一致。macOS 和 iOS 用 CoreLocation 读取，Web 用浏览器的 `navigator.geolocation`；应用第一次读取时，系统或浏览器会询问用户。只在应用使用期间读取，不支持后台定位。

```sh
nsh add nsh-extra --features location
```

```tsx
import { Location } from "nsh-extra";

if (await Location.available()) {
  const position = await Location.current({ accuracy: "high", timeout: 10_000 });
  showOnMap(position.coords.latitude, position.coords.longitude, position.coords.accuracy);

  const stop = Location.watch(
    (position) => moveMarker(position.coords),
    (error) => showError(error.code),
    { distanceFilter: 10 },
  );
  // 之后调用 stop()；启动它的组件销毁时也会停止。
}
```

- `available()` 在打包时开启了该 feature 的 macOS、iOS 应用，以及有 `navigator.geolocation` 的浏览器中为 `true`；在 Android、Windows、Linux、终端、headless 运行，以及以裸二进制运行的 Apple 应用（`nsh run --target macos`，没有 `Info.plist`，系统不会询问）中为 `false`。
- `authorization()` 不询问用户，直接给出当前允许的范围：`"notDetermined"`、`"whenInUse"`、`"always"`、`"denied"` 或 `"restricted"`。Web 只有 `"whenInUse"`（已允许）、`"denied"` 和 `"notDetermined"`（会询问）。`requestAuthorization()` 询问用户并给出回答；读取时会自动询问，只在想自己决定询问时机时才需要先调用。
- `current({ accuracy, timeout })` 给出一个 `Position`（`coords.latitude`、`longitude`、以米为单位的 `accuracy`、`altitude`、`altitudeAccuracy`、`heading`、`speed`，设备不知道的为 `null`；以及自 epoch 起的毫秒数 `timestamp`）。`accuracy` 可以是 `"best"`、`"high"`、`"balanced"`（默认）或 `"low"`。
- `watch(listener, onError?, { accuracy, distanceFilter })` 每有新位置就调用 `listener`，返回一个停止它的函数。`onError` 收到使 watch 结束的错误。
- 读取失败时得到一个 `Error`，其 `code` 为 `"EACCES"`（用户不允许）、`"ETIMEDOUT"`（`timeout` 内没有结果）、`"ERR_POSITION_UNAVAILABLE"`（设备找不到位置）或 `"ERR_FEATURE_UNAVAILABLE_ON_PLATFORM"`（这里读不到位置）；选项超出范围时抛出 `RangeError`。

该 feature 会在 iOS 和 macOS 应用的 `Info.plist` 中加入 `NSLocationWhenInUseUsageDescription`，并为沙盒化的 macOS 应用加入定位 entitlement。Rust 代码使用 `nsh_extra::location`：`available()`、`authorization().await`、`request_authorization().await`、`current(LocationRequest).await`，以及 `watch(LocationRequest)`，它的 `next().await` 给出每个位置（丢弃即停止）。

### Photos

`Photos` 在用户允许后读取用户的相册：最近的照片、每张用来显示的缩略图，以及用户选中的那张照片，后者和 `Picker.pickImages` 选出的图片一样交给应用。它用于一条最近照片，用户按一下就能添加；`Picker.pickImages` 不需要权限，仍是从整个相册里挑选的方式。

```sh
nsh add nsh-extra --features photos
```

```tsx
import { Photos } from "nsh-extra";

if (Photos.access() === "notDetermined") await Photos.requestAccess();
const access = Photos.access();
if (access === "full" || access === "limited") {
  const recent = await Photos.recent({ limit: 20 });
  // 缩略图是小的 JPEG，字节留在原生侧。
  const thumbs = await Promise.all(recent.map((photo) => Photos.thumbnail(photo.id, { maxDimension: 240 })));
  const urls = thumbs.map((thumb) => URL.createObjectURL(thumb.file));
  // 按下时：照片按选中的图片那样准备好。
  const photo = await Photos.load(recent[0].id, { maxDimension: 2048 });
  upload(photo.file);
}

// 拍了新照片、删了照片或改了选择：重新读这条。
Photos.on("change", () => refreshStrip());
```

- `access()` 不询问用户，只告诉用户允许了什么：`"full"`、`"limited"`（用户选中的照片）、`"notDetermined"`、`"denied"` 或 `"unavailable"`。`requestAccess()` 第一次时询问用户并以回答 resolve；之后只有系统设置能改。
- `recent({ limit })` 按从新到旧给出图片（不给时 30 张，最多 1000 张），不含隐藏的照片，每张带 `id` 和 `size`。`thumbnail(id, { maxDimension })` 给出最长边不超过 `maxDimension` 像素（默认 256）、方向已摆正的 JPEG；`load(id, { maxDimension, quality })` 给出和 `Picker.pickImages` 一样准备好的照片。只存在 iCloud 上的照片会下载。没有访问权限时它们以 `EACCES` 拒绝，照片不存在时以 `ENOENT` 拒绝。
- 有限访问时，`presentLimitedPicker()` 显示系统的选择面板让用户更改选择，并以用户选中的 `id` resolve。
- `on("change")` 在相册变化时通知应用，用户允许读取后生效。
- Android、桌面和 Web 上 `access()` 为 `"unavailable"`，读取以 `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` 拒绝。Android 只允许以照片为核心用途的应用读取整个相册（Google Play 对 `READ_MEDIA_IMAGES` 的政策）；其他应用使用系统的照片选择器，也就是 `Picker.pickImages` 显示的那个。
- 声明了 `"capabilities"` 的应用用 [`"picker": true`](./sandbox-and-capabilities.md#picker) 授予 `Photos`，和 `Picker` 用的是同一项能力：除 `access()` 外的每个函数都会先检查它。

开启这个 feature 后，打包的 iOS 应用会带上相册的用途说明（应用可以在 `ios.infoPlist` 里写自己的 `NSPhotoLibraryUsageDescription` 文案）。Rust 代码使用 `nsh_extra::photos`；用 `set_backend` 设置的 `PhotosBackend` 会代替系统相册应答（嵌入方自己的相册，或测试的照片）。

#### 内嵌的照片选择器

`PhotosPicker` 把系统的照片选择器放进应用的布局：iOS 17 及以上是一排相册照片，用户在里面选中照片、也能再取消选中，就像主流聊天应用在附件选项上方显示的那样。它由系统在应用进程外运行，所以不需要相册权限：应用只拿到用户选中的照片。

```tsx
import { PhotosPicker, Photos } from "nsh-extra";
import { Picker } from "nsh/picker";

let picker: { deselect(id: string): void } | undefined;
const selected = signal<string[]>([]);

{Photos.pickerViewAvailable() ? (
  <PhotosPicker
    ref={(node) => (picker = node)}
    selectionLimit={10}
    onChange={({ ids }) => selected.set(ids)}
    style={{ height: 120, borderRadius: 16, overflow: "hidden" }}
  />
) : (
  <Button onPress={() => Picker.pickImages({ multiple: true, limit: 10 })}>照片</Button>
)}

// 发送消息时：每张照片都按选中的图片那样准备好。
const photos = await Promise.all(selected().map((id) => Photos.loadPicked(id, { maxDimension: 2048 })));
// 附件上的移除按钮同时在选择器里取消选中。
picker?.deselect(id);
```

- 用户每次选中或取消选中一张照片，`onChange` 都给出当前所有选中照片的 id，按用户选中的先后排列，选择器上也按这个顺序给每张照片标序号。id 是不透明的；照片的字节留在原生侧，直到 `loadPicked(id, options)` 读取（选项同 `load`）。照片选中且选择器还在显示时 id 可读；之后以 `ENOENT` 拒绝。
- `selectionLimit` 限制最多选几张（默认 100，与 `Picker.pickImages` 一致；0 表示系统允许的最多张数），`filter` 显示 `"images"`（默认）、`"livePhotos"` 或 `"screenshots"`。
- 尺寸由样式决定：给它一个高度，用 `borderRadius` 和 `overflow: "hidden"` 做圆角。
- `pickerViewAvailable()` 为 `false` 的地方（iOS 16 及以下、Android、桌面和 Web）它不占空间、什么也不显示；应用改用 `Picker.pickImages` 让用户挑选。Android 的照片选择器需要较新设备上的系统扩展才能内嵌，Native Shell 暂未使用。
- `loadPicked` 和 `Photos` 的其他函数一样需要 `picker` 能力。

Rust 代码用 `photos_picker()` 创建它（`.selection_limit(10).on_change(..)`），通过 `component_ref::<PhotosPicker>()` 的 `PhotosPickerApi` 取消选中，用 `nsh_extra::photos::load_picked` 读取。

### Push

`Push` 向推送服务注册设备，把设备 token 交给应用，应用再把它发给自己的服务器。之后通知以事件的形式到达。iOS 上用的是系统的推送服务；Android 没有每台设备都有的推送服务，因此应用要链接一个推送服务的绑定，即基于 `nsh_extra::push`、封装该服务 SDK 的 crate：

```sh
nsh add nsh-extra --features push
```

```tsx
import { Notifications } from "nsh";
import { Push } from "nsh-extra";

if (await Push.available()) {
  // 显示通知需要用户授权；后台投递不需要。
  await Notifications.requestPermission();
  // token 可能晚于这次调用才到（离线时）：用事件接收，不要等待它。
  Push.on("token", ({ token }) => sendTokenToServer(token));
  Push.register().catch((error) => console.warn("not registered", error));
}

Push.on("press", ({ payload }) => openChat(payload));
Push.on("notification", ({ threadId }) => refreshInbox(threadId));
Push.on("background", async ({ payload }) => {
  const changed = await syncInbox(payload);
  return changed ? "newData" : "noData";
});

// 某个会话打开时，它的通知不弹横幅、不响铃。
function openConversation(threadId: string) {
  Push.setForegroundPresentation({ banner: false, sound: false }, { threadId });
}
function closeConversation(threadId: string) {
  Push.setForegroundPresentation(null, { threadId });
}
```

- `register()` 以 `{ token }` 完成，`token` 是推送服务要的字符串（iOS 上是十六进制）；设备未能注册时以服务给出的原因拒绝。服务要能连上才会答复，离线时这个 Promise 会一直等待：可靠的做法是 `on("token")`，token 变了它也会报告。每次启动都注册一次，`token()` 读取最近的一个。
- `press` 报告用户点按的通知，包括启动应用的那一条，它会等到第一个监听者。`notification` 报告应用在前台时到达的通知。两者都带它的 `id`、`threadId` 和推送服务发来的 `payload`。payload 是不可信输入。
- `background` 报告唤醒应用或在前台到达的投递（iOS 上是带 `content-available` 的那种，可见且带 `content-available` 的推送在前台到达时，也会报告给 `notification`；Android 上是绑定交来的投递）。系统会等它的监听者：返回一个 Promise 表示这项工作及其结果，须在投递到达后 25 秒内完成。到达时没有监听者的投递，最多等到到达后 5 秒。
- `setForegroundPresentation(presentation)` 决定应用在前台时通知怎么显示，`setForegroundPresentation(presentation, { threadId })` 决定某个 thread 的通知怎么显示；传 `null` 撤销。它们要在通知到达前设好（系统会立即询问），并对应用的所有界面生效。Android 上由绑定按它们发出通知。
- `closeThread(threadId)` 移除某个 thread（Android 上是通知分组）里已送达的通知，`Notifications.show` 显示的除外；`Notifications.close(id)` 移除单条。
- 独立运行的 iOS 应用里，以及应用链接了推送服务绑定的地方，`available()` 为 `true`。其他地方为 `false`，`register` 以 `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` 拒绝；`closeThread` 也一样，Android 除外。
- 声明了 `"capabilities"` 的应用用 [`"notifications": true`](./sandbox-and-capabilities.md#notifications) 授予 `Push`，与 `Notifications` 用的是同一项能力。token、投递和它们的显示方式属于整个应用，所以除 `available()` 外的每个函数都先检查这项能力。

开启这个 feature 后，打包的 iOS 应用会带上 `remote-notification` 后台模式。`aps-environment` entitlement 来自应用签名所用的描述文件（[iOS 真机](./packaging.md#ios-真机)）。Android 上它不添加任何条目：推送服务的 SDK 自带它的 manifest 所需。Rust 代码（比如某个推送服务 SDK 的绑定）使用 `nsh_extra::push`：`on_event` 收到同样的事件，并带 token 的原始字节；`set_foreground_presentation_decider` 在原生侧决定每条通知怎么显示；iOS 的启动参数从 `nsh_platform_ios::on_application_event` 取得（[应用事件](./ios.md#应用事件)）。绑定实现 `PushProvider`（向它的服务注册设备），在自己的 `#[native_module]` 入口里用 `set_provider` 设上，再用 `provide_token`、`provide_registration_failure`、`provide_notification` 和 `provide_background` 报告服务送来的内容。点按绑定发出的通知会以 intent 的 extras 携带 payload 打开应用，`press` 收到的 `payload` 就是这些 extras（Android 不告诉是哪条通知，所以没有 `id` 和 `threadId`）。

### Speech

`Speech` 把用户说的话变成文字（听写）：应用开始一个会话，系统监听麦克风，转写文本随说话逐步到达。macOS 和 iOS 使用系统的 Speech 框架识别，Android 使用设备上的语音识别服务（`SpeechRecognizer`），Windows 使用系统的听写（`Windows.Media.SpeechRecognition`），Web 使用浏览器的 Web Speech API；系统或浏览器会向用户请求一次麦克风权限（Apple 平台上还有语音识别权限）。Windows 的听写使用用户的联机语音识别，由用户在“设置 > 隐私和安全性 > 语音”中打开；关闭时会话以 `"not-allowed"` 结束。Linux 上没有识别器，终端应用（TUI 宿主，在任何操作系统上）也没有；用 GPUI 嵌入的应用在 macOS 和 Windows 上使用平台的识别器。显示麦克风按钮前先检查 `Speech.available()`：没有识别器的地方，会话会立即以 `"unavailable"` 结束。

```sh
nsh add nsh-extra --features speech
```

```ts
const Speech: {
  available(): Promise<boolean>;
  start(options?: SpeechOptions): SpeechSession;
};

interface SpeechOptions {
  /** 说话的语言，BCP 47 标签（"en-US"、"zh-CN"）；省略时为用户的语言。 */
  lang?: string;
  /** 用户说话时就报告结果（true，默认），或者只报告最终结果。 */
  interim?: boolean;
}

interface SpeechSession {
  on(event: "start", listener: () => void): () => void;
  on(event: "result", listener: (result: SpeechResult) => void): () => void;
  on(event: "end", listener: (end: SpeechEnd) => void): () => void;
  /** 到目前为止的完整转写。 */
  readonly text: string;
  readonly ended: boolean;
  stop(): void;
  abort(): void;
}

interface SpeechResult { text: string; isFinal: boolean }
interface SpeechEnd { text: string; error?: SpeechErrorCode }

type SpeechErrorCode =
  | "not-allowed" | "no-speech" | "audio-capture" | "network"
  | "language-not-supported" | "unavailable" | "failed";
```

```tsx
import { signal } from "nsh";
import { Speech, type SpeechSession } from "nsh-extra";

const transcript = signal("");
let session: SpeechSession | null = null;

function toggle() {
  if (session && !session.ended) {
    session.stop();
    return;
  }
  session = Speech.start({ lang: "en-US" });
  session.on("result", ({ text }) => transcript.set(text));
  session.on("end", ({ text, error }) => {
    if (error) console.warn("dictation ended:", error);
    else transcript.set(text);
  });
}
```

- `start` 立即返回会话。会话按顺序报告：麦克风打开、识别器开始监听时 `start`；转写每次变化时 `result`（`text` 始终是到目前为止的完整转写，应用照原样显示即可）；最后一次 `end`，之后不再有事件。`stop()` 停止监听，让识别器处理完已听到的内容：最后一个 `isFinal: true` 的结果，然后 `end`。`abort()` 立即结束会话，不带错误。麦克风只有一个，所以同一时间只运行一个会话：开始新会话会结束正在运行的会话。同一个应用在同一个视图里开始的新会话像 `abort()` 一样结束它，不带错误；进程里另一个应用或视图（嵌入应用的另一个 `AppView`）开始的会话以 `"audio-capture"` 结束它，因为麦克风被拿走了。
- `end` 带有最后的转写，会话失败时还带有 `error`，名称与 Web Speech API 一致：`"not-allowed"`（用户或系统不允许使用麦克风或语音识别，或应用在后台）、`"no-speech"`（没有听到说话）、`"audio-capture"`（无法使用麦克风）、`"network"`（识别器需要网络）、`"language-not-supported"`（识别器不认识 `lang`）、`"unavailable"`（这里没有识别器，或暂时不可用）和 `"failed"`。
- 选项类型不对时 `start` 抛出 `TypeError`，`lang` 不是语言标签时抛出 `RangeError`。
- macOS 和 iOS 上、有语音识别服务的 Android 设备上、有听写语言和麦克风的 Windows 上、支持 Web Speech API 的浏览器里（Chrome、Edge 等基于 Chromium 的浏览器，以及 Safari），以及应用给模块设置了自己的识别器的地方，`available()` 为 `true`。Linux 上和终端应用里为 `false`。
- 在 Web 上，页面需要安全上下文（HTTPS，开发时也可以是 `localhost`）才能使用麦克风；用 iframe 嵌入应用的页面需要允许麦克风（`allow="microphone"`）。Chrome 使用它的在线服务识别，所以连接断开时报告 `"network"`。
- 声明了 `"capabilities"` 的应用用 [`"speech": true`](./sandbox-and-capabilities.md#speech) 授予 `Speech`。没有授予时 `start` 抛出一个 `Error`，其 `code` 为 `"ERR_ACCESS_DENIED"`，`permission` 为 `"speech"`。

开启这个 feature 后，打包的应用会带上它需要的条目：iOS 和 macOS 上的麦克风和语音识别用途说明（应用可以在 `ios.infoPlist` / `macos.infoPlist` 里写自己的文案），macOS 上的音频输入 entitlement，Android 上的 `RECORD_AUDIO` 权限和对语音识别服务的查询声明。在 Web 上，模块通过 wasm-bindgen 调用浏览器，所以 `nsh` 会用 `wasm-bindgen` CLI 构建应用的 Web 运行时（[在 Rust 中使用浏览器 API](./web.md#在-rust-中使用浏览器-api)）；站点本身不需要任何声明。

Rust 代码使用 `nsh_extra::speech`：`available().await`，以及 `recognize(SpeechRequest)` 返回的会话，它的 `next().await` 给出每个 `SpeechEvent`（`stop()`、`abort()`；丢弃它即中止）。用自己的方式识别语音的应用（自己的引擎或服务，比如嵌入 NSH 的应用）用 `set_backend` 给模块一个 `SpeechBackend`：之后每个会话都交给它，而不是系统的识别器。

```rust
use nsh_extra::speech::{self, SpeechEvent, SpeechRequest};

async fn dictate() -> String {
    let mut recognition = speech::recognize(SpeechRequest::default());
    let mut text = String::new();
    while let Some(event) = recognition.next().await {
        match event {
            SpeechEvent::Result { text: heard, .. } => text = heard,
            SpeechEvent::End { .. } => break,
            _ => {}
        }
    }
    text
}
```

在 `nsh test`（以及 `nsh_testing::Headless`）中，会话运行在模块的模拟识别器上，它的名称是 `"nsh-extra/speech"`：会话立即开始监听，就像用户允许了麦克风；测试通过 [`app.fake`](./testing-and-trace.md)（Rust 中是 `Headless::call_fake`）调用这个模拟识别器，代替用户说话：

| 方法 | `args` | 作用和回答 |
|---|---|---|
| `hear` | `[text]` | 用户说出 `text`，即到目前为止的完整转写：正在运行的会话把它报告为非最终的 `result`（`interim: false` 时先留到结束）。resolve 为 `null`；没有会话运行时以 `no speech session listens` 拒绝。 |
| `end` | `[]` 或 `[error]` | 结束正在运行的会话：带 `error`（上面的错误码之一）时会话失败，否则像用户停下时一样：转写作为最终的 `result`，然后 `end`（什么都没听到时为 `"no-speech"`）。resolve 为 `null`；没有会话运行或 `error` 不是错误码时拒绝。 |
| `requests` | `[]` | resolve 为应用开始的会话，按顺序：`[{ lang, interim }]`，用户的语言时 `lang` 为 `null`。 |

```tsx
await app.press("label:Dictate");
await app.fake("nsh-extra/speech", "hear", ["hello"]);
await app.waitFor("text:hello");
await app.fake("nsh-extra/speech", "end");
```

## 应用自己的 Rust：`ext/`

需要自己写 Rust 的 TSX 应用（扫描器、解析器、数据库、原生视图）把 Rust 放在 `ext/`，与 `src/` 并列：`src/` 放应用的 TSX，`ext/` 放它的 Rust，每个目录一个 nshm crate。应用在 `nsh.json` 的 `"dependencies"` 里按路径列出每个 crate，TSX 像导入其他 nshm 一样导入它。`nsh init --template mixed` 创建的就是这种结构。

```text
my-app/
├── App.tsx                    入口
├── src/                       应用的 TSX 模块
├── ext/                       应用的 Rust
│   └── my-app-native/
│       ├── Cargo.toml         nsh-core 和这个 crate 自己的依赖
│       └── src/lib.rs         #[native_module("my-app-native")]
├── nsh.json                   "dependencies": { "my-app-native": { "path": "ext/my-app-native" } }
└── nsh.lock
```

磁盘占用分析工具 [Disktree](https://github.com/huacnlee/disktree) 就是这样构建的：界面是 `App.tsx` 和 `src/` 里的 TSX，文件系统扫描、SQLite 索引和删除文件是 `ext/disktree-native` 里的 Rust：

```json
// nsh.json
{
  "name": "disktree",
  "dependencies": {
    "disktree-native": { "path": "ext/disktree-native" }
  }
}
```

```rust
// ext/disktree-native/src/lib.rs（节选）
mod scanner;

use nsh_core::prelude::*;

/// Scans, browses and removes entries using the native disk index.
#[module]
pub struct DiskTree;

#[module]
impl DiskTree {
    /// Runs a filesystem operation with a JSON payload and returns its JSON result.
    pub async fn request(route: String, body: String) -> Result<String, String> {
        // async fn 在 TSX 中返回 Promise；blocking 让文件系统操作不占用 UI 线程。
        blocking(move || scanner::dispatch(&route, &body)).await
    }
}

#[native_module("disktree-native")]
fn native(registry: &mut Registry) {
    registry.module::<DiskTree>();
}
```

```ts
// src/runtime.ts
import { DiskTree } from "disktree-native";

const result = JSON.parse(await DiskTree.request("/scan", JSON.stringify({ path })));
```

为什么用 `ext/`，而不是把应用根目录做成 crate（`"rust": "."`）：

- **与其他 nshm 一样。** 应用自己的 Rust 和安装的 nshm 用同样的方式列出、锁定和构建；以后把 `ext/` 里的 crate 发布到 crates.io 或单独的仓库，只需改它在 `nsh.json` 里的条目。
- **每个 crate 独立。** 它有自己的 `Cargo.toml`、依赖和测试（在它的目录里 `cargo test`），并在 `~/.nsh/builds` 里优化构建一次，直到它改变。应用根目录仍是 TSX 项目。
- **接口小。** TSX 只能通过 `#[native_module]` 注册的内容访问 Rust，声明由 Rust 签名生成（`.nsh/types/<crate>.d.ts`），边界有类型，评审时一目了然。

用 `cargo new --lib ext/<name>` 新增 crate，写上 `#[native_module("<name>")]`，再运行 `nsh add --path ext/<name>`。界面留在 TSX，需要原生性能、平台能力或 crates.io 生态的部分放进 Rust；必须原生的视图也可以由 crate 导出为组件（[Rust nshm](#rust-nshm)）。

## 编写 nshm

### Rust nshm

Rust nshm 是普通的 Cargo 库，根部有 `#[native_module("<标识>")]` 入口，与应用自己的 crate 相同：标识就是 TSX 导入它的名字，函数注册它导出的内容（[用 TSX 扩展 Rust 应用](./rust.md#用-tsx-扩展-rust-应用)）。一个小例子：

```toml
# Cargo.toml
[package]
name = "my-gauge"
version = "0.1.0"
edition = "2024"
keywords = ["nshm"]

[dependencies]
nsh-core = "0.6"
```

```rust
// src/lib.rs
use nsh_core::prelude::*;

#[native_module("my-gauge")]
fn native(registry: &mut Registry) {
    registry.register::<Gauge>();
}

#[derive(Clone, PartialEq, Props)]
pub struct GaugeProps {
    /// The value shown, from 0 to 1.
    pub value: Prop<f32>,
}

/// A horizontal gauge.
#[component]
pub fn Gauge(props: GaugeProps) -> impl IntoElement {
    view()
        .h(px(8.0))
        .rounded_full()
        .bg(rgb(0xe5e7eb))
        .child(
            view()
                .h_full()
                .rounded_full()
                .bg(rgb(0x2563eb))
                .w(move || relative(props.value.get())),
        )
}
```

nshm 兼容的 NSH 版本就是它自己对 `nsh-core` 的版本要求（`nsh-core = "0.6"`），`nsh add` 在编译前会与当前 `nsh` 比对。它的 TypeScript 声明由 Rust 类型生成，应用检查 TSX 时会像检查自己的 crate 一样检查对它的使用。

[nsh-omarchy 的 `src/lib.rs`](https://github.com/huacnlee/nsh-omarchy/blob/main/src/lib.rs) 是一个完整的例子：它的组件由 `#[native_module("nsh-omarchy")]` 导出给 TSX，另有 `Omarchy` 主题模块。

### 打包的应用需要什么

用到系统功能的 nshm 在 `Cargo.toml` 里声明打包的应用需要什么：写在 `[package.metadata.nsh]` 下；只有某个 feature 需要时，写在 `[package.metadata.nsh.features.<feature>]` 下。`nsh` 构建安装包时，会把应用链接的每个 crate 的条目（按 Cargo 实际开启的 feature）加进去；开发宿主拿到其中的 iOS `Info.plist` 键和 Android 条目：

```toml
[package.metadata.nsh.features.scanner.ios.infoPlist]
NSCameraUsageDescription = "扫描相机对准的条码。"

[package.metadata.nsh.features.scanner.android]
permissions = ["CAMERA"]
queries = ['<intent><action android:name="android.media.action.IMAGE_CAPTURE"/></intent>']
application = ['<service android:name="com.example.scanner.Sync" android:exported="false"/>']
libraries = ["android/libs/scanner-glue.jar"]
```

| 键 | 添加的内容 |
|---|---|
| `ios.infoPlist` | iOS 应用 `Info.plist` 的键，与 `nsh.json` 的 `ios.infoPlist` 相同 |
| `ios.infoPlistStrings` | 这些键在其他语言下的文字，按语言给出，与 `nsh.json` 的 `ios.infoPlistStrings` 相同（[打包](./packaging.md#其他语言的-infoplist-文字)） |
| `ios.entitlements` | iOS 应用的 entitlements |
| `macos.infoPlist` | macOS 应用 `Info.plist` 的键，与 `nsh.json` 的 `macos.infoPlist` 相同 |
| `macos.infoPlistStrings` | 这些键在其他语言下的文字，与 `ios.infoPlistStrings` 相同 |
| `macos.entitlements` | macOS 应用的 entitlements |
| `android.permissions` | `<uses-permission>` 元素，写法与 `nsh.json` 相同（`CAMERA` 即 `android.permission.CAMERA`） |
| `android.queries` | manifest `<queries>` 里的 `<intent>`、`<package>`、`<provider>` 元素 |
| `android.application` | `<application>` 里的 `<service>`、`<receiver>`、`<provider>`、`<activity>`、`<meta-data>` 元素；`${applicationId}` 是应用的包名，其他占位符取应用的 `android.manifestPlaceholders` |
| `android.libraries` | Java 库：jar、Android 库（`.aar`）和 dex 文件，路径相对于 crate 的 `Cargo.toml`，打包方式与 `nsh.json` 的 `android.libraries` 相同（[Java 代码](./packaging.md#java-代码)） |

crate 不能设置 `android.manifestPlaceholders`，设置了会报错：占位符的值（例如某个服务的 key）属于应用，写在应用的 `nsh.json` 里。
两个 crate 带了同一个 Android 库的不同版本时，用应用在自己的 `android.libraries` 里列出的那个版本。两个库定义了同名资源时，
应用列出的库优先，其次是 crate 名排序靠前的（[Java 代码](./packaging.md#java-代码)）。

应用自己的 `nsh.json` 优先：它设置过的键保留它的值，数组（例如 `UIBackgroundModes`）合并。两个 crate 给同一个键设置了不同的值时（例如两段不同的相机用途说明），由应用在 `ios.infoPlist`、`ios.entitlements`、`macos.infoPlist` 或 `macos.entitlements` 里写这个键来决定；应用没写之前，打包该平台应用会报错并指出这两个 crate。NSH 自己设置的键（包标识、版本等）不能由 crate 设置。

crate 翻译的是各 crate 在 `ios.infoPlist`（macOS 是 `macos.infoPlistStrings` 翻译 `macos.infoPlist`）里设置的键，按它们的措辞翻译；按应用开启的 feature 没有 crate 设置的键（例如所在 feature 没开），它的翻译会被略过并给出警告。应用只采用自己支持的语言的 crate 翻译，即 `locales` 里的语言或应用自己 `ios.infoPlistStrings`（`macos.infoPlistStrings`）里的语言（写一个空的 `{}` 就是只声明语言、不写自己的文字），所以 crate 可以带上很多语言，而不会给应用增加语言。应用自己设置了的键不采用任何 crate 的翻译，因为那些翻译说的不是应用自己的文字。两个 crate 对同一个键给出不同的翻译时，同样由应用在 `ios.infoPlistStrings`（`macos.infoPlistStrings`）里写这个键来决定。

在应用旁边开发时用 `nsh add --path ../my-gauge`，按目录当前内容使用。发布方式与普通 crate 相同（`cargo publish`），加上关键词 `nshm`，便于在 [crates.io](https://crates.io/keywords/nshm) 上找到；也可以推送到 Git 并给版本打标签。

### 封装原生 SDK

封装 Apple SDK 的 nshm 在 `#[cfg(target_os = "ios")]` 或 `#[cfg(target_os = "macos")]` 下从 Rust 调用它。通过 `objc2` 系列 crate 使用的系统 framework 无需更多设置。厂商预编译的库（`.xcframework` 或 `.a`）由 nshm 自己的 `build.rs` 链接：Cargo 会把所有依赖的 `rustc-link-lib` 和 `rustc-link-search` 传给应用的可执行文件，应用本身不用写任何配置，NSH 也没有按平台的 SDK 设置。

```rust
// build.rs
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("ios") {
        return;
    }
    // 模拟器和 Mac Catalyst（`nsh run --target catalyst`）也是 iOS 目标。
    let slice = match std::env::var("CARGO_CFG_TARGET_ABI").as_deref() {
        Ok("sim") => "ios-arm64_x86_64-simulator",
        Ok("macabi") => "ios-arm64_x86_64-maccatalyst",
        _ => "ios-arm64",
    };
    let root = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    println!("cargo:rustc-link-search=native={root}/vendor/Sdk.xcframework/{slice}");
    // +whole-archive is -force_load: it keeps Objective-C categories, like -ObjC.
    println!("cargo:rustc-link-lib=static:+whole-archive=Sdk");
    println!("cargo:rustc-link-lib=framework=AdSupport");
}
```

- 用 `rustc-link-lib`，不要用 `rustc-link-arg`：链接参数只作用于本 crate 自己的目标。
- 静态库的隐私清单条目写进应用的 `ios.privacyManifest`。
- NSH 不嵌入动态 framework，优先使用 SDK 的静态版本。
- 许可证要求用户能替换的库（LGPL，例如 libmpv）只能动态链接，由应用自己携带；NSH 的打包没有对应设置。像上面那样在 nshm 的 `build.rs` 里链接它（`rustc-link-lib=framework=…`、`rustc-link-search=framework=…`）。可执行文件的运行路径写在应用的 `.cargo/config.toml` 里（在 `[target.aarch64-apple-darwin]` 下写 `rustflags = ["-C", "link-arg=-Wl,-rpath,@executable_path/../Frameworks", "-C", "link-arg=-Wl,-rpath,<framework 所在目录>"]`），因为 crate 的 `rustc-link-arg` 到不了 `nsh run`、`nsh check`、`nsh test`。`nsh package --target macos` 之后，把 framework 复制到应用的 `Contents/Frameworks/`，用 `install_name_tool -delete_rpath` 去掉开发时的运行路径，再按先 framework、后应用的顺序，用打包时的身份重新签名（`codesign --force --sign <身份> --options runtime --entitlements <应用的 entitlements>`，ad hoc 包用 `--sign -`），最后用 `codesign --verify --deep --strict` 检查。
- 在 Linux 和 Windows 上，同样由 `build.rs` 链接 SDK（Linux 上是 `.a` 和 `.so`，Windows 上是 `.lib`）。NSH 同样不会把共享库（`.so`、`.dll`）放进包里；请优先使用 SDK 的静态版本。

### TSX nshm

TSX nshm 是一个 Git 仓库，由其中的 `nsh.json` 描述：包名和版本、适用的 NSH 版本，以及导出的内容，即每个标识对应的 TSX 入口文件：

```json
{
  "name": "acme-badge",
  "version": "0.1.0",
  "nsh": ">=0.6",
  "exports": { "acme-badge": "src/index.tsx" },
  "dependencies": { "acme-icons": { "github": "acme/icons", "version": "^1" } }
}
```

```tsx
// src/index.tsx
import { Text, View } from "nsh";

/** A rounded label. */
export function Badge(props: { label: string }) {
  return (
    <View class="rounded-full bg-primary px-2 py-0.5">
      <Text class="text-xs text-primary-foreground">{props.label}</Text>
    </View>
  );
}
```

导出的标识是包名本身或以它开头（`acme-badge`、`acme-badge/icons`），文件都在仓库之内。应用像导入自己的模块一样导入它，`nsh check` 用它的源码检查应用的 TSX。给版本打标签即发布（`git tag v0.1.0 && git push --tags`），标签的版本必须与 `nsh.json` 里的一致。

Rust nshm 也可以导出 TSX：在 `Cargo.toml` 旁放一个带同样 `"exports"` 的 `nsh.json`，写基于其原生模块的 TSX 辅助代码。这时它的名字和版本取自 crate。

### 依赖

nshm 在自己的 `nsh.json` 的 `"dependencies"` 中列出需要的 nshm，写法与应用相同：来自 crates.io 或 Git，版本要求尽量宽到它能工作的范围，这样应用和它用到的其他 nshm 才能协调出同一个版本。已发布的 nshm 不能依赖本地目录。某个包从哪里来由应用自己的条目决定：应用可以从 fork 或本地目录取它的 nshm 所依赖的 nshm，而这些 nshm 的版本要求依然有效。

## 平台 nshm

nshm 可以提供自己的 target，例如 NSH 不构建的平台：在 `nsh.json` 中写 `"platform"`，并在 crate 中提供名为 `nsh-platform-<name>` 的二进制。crate 只提供 target 时不需要 `#[native_module]`；没有它时，应用不会链接这个 crate，也不会因此变成 Rust 应用：

```json
{ "name": "nsh-harmony", "version": "0.1.0", "platform": "harmony" }
```

`nsh add nsh-harmony` 之后，应用的 `nsh run`、`nsh dev`、`nsh test` 和 `nsh package` 带上 `--target harmony` 时，会构建这个二进制（在应用的 `.nsh/platforms/harmony` 中，不改动共享安装）并把它作为[外部 target](./cli.md#外部-target) 运行。以 `nsh-platform-<name>` 安装在 `PATH` 上的平台不必是 nshm，所有应用都能用；应用的 nshm 优先。[构建平台](./platform-extensions.md)介绍了平台需要实现什么。

## 安全

nshm 的构建脚本和过程宏会在应用构建时执行，它的代码（无论 TSX 还是 Rust）以应用的权限运行。应用依赖图里的任何 crate 还能通过 `[package.metadata.nsh]` 给打包的应用加系统权限、清单组件、Java 库和 Android 库（连同其中的原生代码）以及 entitlements。请像审查应用自己的代码一样审查它的源码和 `nsh.lock` 的变更。

---
title: nsh/updater
description: "打包后的应用自我更新：向 nsh.json 指定的来源检查新版本，带进度下载压缩包，替换应用并重启，或运行代码的新签名包。"
order: 12.7
---

# nsh/updater

`nsh/updater` 为打包后的应用检查新版本、下载并替换应用。更新从哪里来由 [`nsh.json` 的 `"updater"`](#nshjson) 决定，调用模块的代码无法指定。每一步都在 Rust 中校验：清单签名、应用 id、版本更新、压缩包的大小和 SHA-256。界面由你自己画，模块负责返回状态和完成工作。从设置来源到发布版本的完整流程见[应用更新](../docs/app-updates.md)。

它也能只更新应用的代码：一个更新构建号的[签名包](../docs/signed-packages.md)，应用在所有原生平台（包括 iOS 和 Android）下次启动时运行它（见 [OTA 更新](#ota-更新)）。

```tsx
import { checkForUpdate, downloadUpdate, installAndRestart } from "nsh/updater";
import { checkForPackage, downloadPackage, restartToPackage, runningPackage, shellInfo } from "nsh/updater";
```

这个模块在所有平台上都可以导入：

| 平台 | `checkForUpdate` | `downloadUpdate`、`installAndRestart` | 包 |
| --- | --- | --- | --- |
| macOS、Windows、Linux（打包后） | 检查来源 | 下载并替换应用 | 检查、下载，`restartToPackage` 重启进入新包 |
| iOS、Android | 检查来源；`url` 是应用商店链接（`nsh update-manifest --link`） | 拒绝：引导用户打开 `url` | 检查并下载；包在下次启动时运行 |
| Web、开发运行、没有 `"updater"` 的应用 | 返回 `null` | 拒绝 | `checkForPackage` 返回 `null`，`runningPackage()` 为 `null`，`shellInfo()` 没有 `version` |

它不需要任何能力声明，`capabilities.network` 对它不生效，因为应用代码无法决定这些请求发往哪里。请求走平台自己的网络栈，和 `fetch` 一样。

## checkForUpdate

```ts
function checkForUpdate(): Promise<AppUpdate | null>;

interface AppUpdate {
  version: string;
  notes?: string | null;
  url: string;
  canInstall: boolean;
}
```

从 `nsh.json` 中的来源获取清单，返回其中描述的新版本；应用已是最新、没有 `"updater"`，或运行在不更新的环境（Web、`nsh run`）时返回 `null`。正在运行该版本或更高版本的[包](#checkforpackage)时也算最新：应用本身的版本仍是安装时的版本，但代码已经是该版本的。

| 字段 | 含义 |
| --- | --- |
| `version` | 新版本号，semver |
| `notes` | 更新说明，即清单的 `--notes` 文件内容 |
| `url` | 用户手动获取的地址：压缩包，或 iOS、Android 上的商店页面。`canInstall` 为 false 时交给 [`openUrl`](./nsh.md#openurl) |
| `canInstall` | 本次运行中 `downloadUpdate` 和 `installAndRestart` 是否可用：装在用户可写位置的桌面打包应用为 true。iOS、Android 上为 false，装在只有系统可写的目录（系统包）时也为 false |

来源无法访问或清单不可接受时会 reject：设置了 `publicKey` 但签名错误或缺失、清单属于其他应用、URL 不是 HTTPS。版本相同或更旧的清单不算更新，因此过期的清单无法让应用降级。

## downloadUpdate

```ts
function downloadUpdate(onProgress?: ((progress: UpdateProgress) => void) | null): Promise<void>;

interface UpdateProgress {
  received: number;
  total?: number | null;
}
```

把上一次 `checkForUpdate` 找到的更新压缩包下载到应用的数据目录，收到数据时调用 `onProgress`（服务器未给出大小时没有 `total`），然后按清单校验大小和 SHA-256。没有找到更新或 `canInstall` 为 false 时以 `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` reject；下载失败或校验不符时也会 reject。

```tsx
const progress = signal(0);
await downloadUpdate(({ received, total }) => progress.set(total ? received / total : 0));
```

## installAndRestart

```ts
function installAndRestart(): Promise<void>;
```

把下载好的压缩包解压到应用旁边，校验新应用（id、可执行文件，macOS 上还有代码签名），替换进去，然后像 `Application.restart()` 一样重启应用：当前进程像用户退出时那样退出，进程结束后新版本启动。Promise 只在失败时才会结束，失败时已安装的应用保持原样：没有下载过更新或应用无法替换时 reject。

Linux 和 macOS 上整个目录或 `.app` 一起替换，保留用户给它起的名字；Windows 上逐个文件替换，有一个失败就全部恢复。

## OTA 更新

OTA（over-the-air，空中下发）更新把打包应用的 TSX 作为签名包（`nsh publish`）下发，而不必发新应用。设置、发布和设备上的行为见 [OTA 更新](../docs/ota-updates.md)。`nsh.json` 信任包根密钥（`"updater": { "packages": { "roots": [...] } }`，见[下文](#nshjson)）的应用会在同一份清单里找到它，下载后从下次启动开始运行。NSH 运行时本身的改动仍然需要新的应用构建：每个包都写明能运行它的最低运行时，较旧的应用不会收到它。

### checkForPackage

```ts
function checkForPackage(): Promise<PackageUpdate | null>;

interface PackageUpdate {
  version: string;
  build: number;
  notes?: string | null;
  size?: number | null;
}
```

像 `checkForUpdate` 一样获取清单，当其中的包构建号比当前运行的更新（正在运行的包的构建号，否则是应用自带的构建号），并且当前运行时能运行它时，返回这个包。没有新包、应用没有信任任何包根密钥，或运行在不更新的环境（Web、`nsh run`）时返回 `null`。出错时与 `checkForUpdate` 一样拒绝。

### downloadPackage

```ts
function downloadPackage(onProgress?: ((progress: UpdateProgress) => void) | null): Promise<void>;
```

下载上一次 `checkForPackage` 找到的包，按清单核对大小和 SHA-256，并按应用下次启动时的方式验证它：由某个根密钥认证的发布密钥签名、属于本应用、构建号比当前运行的以及之前运行过的都新、适用于当前运行时。之后它在应用的数据目录中等待下次启动。上次检查没有找到包时以 `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` 拒绝；下载失败或包被拒绝时以说明原因的错误（`package refused: …`）拒绝，且不留下任何文件。

### restartToPackage

```ts
function restartToPackage(): Promise<void>;
```

在 macOS、Windows 和 Linux 上，像 `Application.restart()` 一样重启应用并进入下载好的包；只有失败时 promise 才会结束。没有下载任何包时拒绝；在 iOS 和 Android 上以 `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` 拒绝，包在应用下次启动时运行。

### runningPackage

```ts
function runningPackage(): RunningPackage | null;

interface RunningPackage {
  version: string;
  build: number;
}
```

本次运行的代码所来自的包；运行应用自带的代码时为 `null`。

### shellInfo

```ts
function shellInfo(): ShellInfo;

interface ShellInfo {
  version: string | null;
  build: number | null;
  nshVersion: string;
  packages: boolean;
}
```

本次代码所运行在的已安装应用，即它的外壳：打包时的 `version` 和 `build`（来自 `nsh.json`；在 iOS 上就是它的
`CFBundleShortVersionString` 和 `CFBundleVersion`）、外壳内置的 NSH 运行时版本，以及它能否运行签名包。包替换的是应用的代码，
不是外壳：`runningPackage()` 说明运行的是哪份代码，`shellInfo()` 说明由什么来运行它，所以需要更新运行时（`minRuntime`）的包，
可以据此提示用户安装完整的新应用。没有在 `nsh.json` 中配置 `"updater"` 的应用，以及 Web 和开发运行时，`version` 和
`build` 为 `null`，`packages` 为 `false`。

### 下次启动时

应用运行通过验证、且比自带构建号更新的最新包。新包第一次运行是试运行：从第一帧起运行 10 秒，或用户退出应用后，它成为已安装的包。如果它启动失败、VM 被停止，或在此之前应用崩溃，应用会回到之前运行的包（或自带的代码），并删除新包。包以已安装应用的身份运行：使用它的 id、URL scheme 和更新来源，能力最多为已安装应用声明的能力。构建号更新的应用更新会替换旧构建的包。

```tsx
import { checkForPackage, downloadPackage, restartToPackage } from "nsh/updater";

const found = await checkForPackage();
if (found) {
  await downloadPackage();
  // 桌面端：立即重启。iOS 和 Android：下次启动时运行。
  await restartToPackage().catch(() => {});
}
```

## 进行中的调用

同一时间只运行一个检查、下载或安装：其中一个进行时再调用任何一个都会 reject。进行期间请禁用按钮。

```tsx
import { openUrl, signal } from "nsh";
import { checkForUpdate, downloadUpdate, installAndRestart, type AppUpdate } from "nsh/updater";

const update = signal<AppUpdate | null>(null);
const busy = signal(false);

async function run<T>(work: () => Promise<T>) {
  busy.set(true);
  try {
    return await work();
  } finally {
    busy.set(false);
  }
}

export const check = () => run(async () => update.set(await checkForUpdate()));

export const install = () =>
  run(async () => {
    const found = update();
    if (!found) return;
    if (!found.canInstall) return openUrl(found.url);
    await downloadUpdate();
    await installAndRestart();
  });
```

## nsh.json

`"updater"` 指定一个来源：`github`，即最新 GitHub Release 中带有 `latest.json` 的 `owner/repo`；或 `url`，即自己服务器上的清单，此时必须配 `publicKey`。`publicKey` 是 `nsh keygen` 生成的 `.pub` 文件内容；配了它，未签名的清单会被拒绝。

```json
{
  "id": "com.example.notes",
  "version": "1.2.0",
  "updater": { "github": "example/notes", "publicKey": "<keys/update.pub 的内容>" }
}
```

| 键 | 类型 | 含义 |
| --- | --- | --- |
| `github` | string | `owner/repo`：清单是其最新 Release 的附件 `latest.json`，跳过 draft 和 prerelease |
| `url` | string | 自己服务器上清单的 HTTPS 地址；压缩包的相对地址相对它解析 |
| `publicKey` | string | 给清单签名（`latest.json.sig`）的 Ed25519 公钥。使用 `url` 时必填 |
| `packages.roots` | string[] | 根公钥（`nsh keygen` 的 `root.pub`），由它们认证的发布密钥为应用的 [OTA 包](#ota-更新)签名。没有它时应用不运行任何包 |

`nsh package` 会校验这些键，并把它们连同应用的 `build` 放进包里，所以来源在构建应用时就已确定。`version` 必须是 semver。`nsh update-manifest` 为一个版本的压缩包和包生成 `latest.json` 和签名（[CLI](../docs/cli.md#nsh-update-manifest)）。

## Rust

Rust 应用（`nsh.json` 的 `"root"`）直接使用 `nsh-updater` crate，并自带 HTTP 客户端：`Config::check` 校验清单，`Download` 校验压缩包，`Installation::install` 替换应用，`nsh_core::element::desktop::restart()` 启动新版本（[应用更新](../docs/app-updates.md#rust-应用)）。

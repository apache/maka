---
title: OTA 更新
description: "把打包应用的 TSX 作为签名包下发，iOS 和 Android 也适用，无需构建新应用：密钥、从 CI 发布、应用内流程、试运行与回滚。"
order: 20.7
group: delivery
---

# OTA 更新

OTA（over-the-air，空中下发）更新把打包应用的 TSX 作为[签名包](./signed-packages.md)（`.nshpkg`）下发：已安装的应用下载、验证它，并从下次启动开始运行。所有原生平台（包括 iOS 和 Android）都适用，无需构建新应用。一次发布就是这个包加一份签名的清单，放在 GitHub Releases 或自己的服务器上。在应用中，[`nsh/updater`](../modules/nsh-updater.md#ota-更新) 的四个函数负责检查、下载、重启进入和报告包。第一次启动就失败的包会被删除，应用回到之前运行的版本。

| 平台 | OTA 的行为 |
| --- | --- |
| macOS、Windows、Linux | 检查并下载；`restartToPackage()` 重启应用进入新包，或在下次启动时运行 |
| iOS、Android | 检查并下载；包在应用下次冷启动时运行，`restartToPackage()` 会拒绝 |
| Web | 无需处理：部署即更新应用，`checkForPackage()` 返回 `null` |

## OTA 还是新的应用构建

包里是 `nsh publish` 从应用 TSX 构建出的内容：代码、它导入的图片和字体，以及它声明的能力。其余部分都属于已安装的应用，修改它们需要新的应用构建：iOS 和 Android 上通过应用商店，桌面端通过[应用更新](./app-updates.md)或应用商店。

| 改动 | OTA | 新的应用构建 |
| --- | --- | --- |
| 界面、逻辑、样式、导入的图片和字体（TSX） | 可以 | |
| TSX 需要更新版本的 NSH | | 需要 |
| 应用的 Rust 代码：其 crate 的组件、模块和原生视图 | | 需要 |
| 平台从已安装应用读取的内容：名称、图标、URL scheme、`ios`、`android` 和 `macos` 键、权限 | | 需要 |
| 超出已安装应用声明的[能力](./sandbox-and-capabilities.md) | | 需要：包最多获得已安装应用的能力 |
| `nsh.json` 的 `"updater"`：清单来源、信任的根密钥 | | 需要 |

每个包都写明能运行它的最低 NSH 运行时（`minRuntime`），默认是发布它的 `nsh` 的版本；运行时更旧的应用不会收到它。请用构建线上应用时的 `nsh` 版本发布 OTA 版本；如果 TSX 只用了旧运行时已有的功能，也可以用 `--min-runtime` 发布（见[哪些运行时能运行包](./signed-packages.md#哪些运行时能运行包)）。应用需要更新的运行时时，请发布新的应用构建；下文的应用会先检查包，没有包时再检查新应用。

## 一次性设置

### 密钥

```sh
nsh keygen keys/root      # 应用信任它；keys/root.secret 离线保管
nsh keygen keys/release   # 给包签名，放在 CI 中
nsh keygen keys/update    # 给清单签名，放在 CI 中
nsh certify --root keys/root.secret --key keys/release.pub --apps com.example.notes -o keys/release.cert
```

根密钥为应用 id 认证发布密钥；应用只信任根密钥，所以更换发布密钥或证书都不需要更新应用。证书默认有效 365 天（可用 `--days` 指定），到期前请重新认证发布密钥。密钥的说明，以及如何吊销发布密钥或包，见[签名包](./signed-packages.md#密钥两个层级)。

> [!CAUTION]
> 请离线保管 `root.secret`，例如放在保险柜里的加密硬盘上：拿到它的人可以让每一台安装了该应用的设备运行他的代码。不要提交任何 `.secret` 文件。

### nsh.json

```json
{
  "id": "com.example.notes",
  "version": "1.2.0",
  "build": 12,
  "updater": {
    "github": "example/notes",
    "publicKey": "<keys/update.pub 的内容>",
    "packages": { "roots": ["<keys/root.pub 的内容>"] }
  }
}
```

`"packages": { "roots" }` 列出根公钥，由它们认证的发布密钥可以为应用的包签名；配多个根密钥就可以轮换。配了 `publicKey`，应用会拒绝不是由 `keys/update.secret` 签名的清单；用 `"url"` 代替 `"github"` 时它是必填的（见[应用更新](./app-updates.md#设置来源)）。

`nsh package` 会把 `"updater"` 和 `build` 写进应用，所以应用信任哪些根密钥、拿哪个构建号和包比较，在构建应用时就已确定。只有用这份配置构建的应用才接收 OTA 更新：请在第一次 OTA 发布前先发布这样一个应用构建。

### CI 密钥

把发布密钥、它的证书和清单密钥存为发布仓库的 secret：

```sh
gh secret set NSH_RELEASE_KEY < keys/release.secret
gh secret set NSH_RELEASE_CERT < keys/release.cert
gh secret set NSH_UPDATE_KEY < keys/update.secret
```

## 发布版本

### 构建号

`nsh.json` 中的 `build` 是应用构建和包共用的计数器：每次发布其中任何一个都要调高它。只有包的构建号高于应用构建时的构建号，应用才运行它；应用也只会收到比当前运行的代码更新的包。当用户装上构建号为 20 的新应用时，已下载的 15 号包是旧代码，会被删除，下一个 OTA 版本必须是 21 号。`version` 也请一起调高；`runningPackage()` 会报告包的版本和构建号。

### 手动发布

```sh
mkdir -p dist
nsh publish --key keys/release.secret --cert keys/release.cert -o dist/com.example.notes-13.nshpkg
nsh update-manifest --package dist/com.example.notes-13.nshpkg --notes CHANGES.md --key keys/update.secret -o dist
```

`nsh publish` 以 release 模式构建应用并签名，id、`version` 和 `build` 取自 `nsh.json`（可用 `--app-version` 和 `--build` 覆盖）。`nsh update-manifest` 按应用 id 和 `nsh.json` 中的根密钥校验包，然后写出带 `"package"` 的 `dist/latest.json`，并签名为 `dist/latest.json.sig`：

```json
{
  "id": "com.example.notes",
  "version": "1.2.1",
  "notes": "Faster search.",
  "platforms": {},
  "package": {
    "version": "1.2.1",
    "build": 13,
    "url": "com.example.notes-13.nshpkg",
    "sha256": "9f2c…",
    "size": 48213,
    "minRuntime": "0.4.0"
  }
}
```

包的 `url` 是它的文件名，与清单放在一起；`--base-url` 可以放到别处。只有包的版本不传压缩包也不传 `--link`，所以 `checkForUpdate` 在其中找不到新应用。一个版本也可以两者都有：`nsh update-manifest *.tar.gz *.zip --package … --link ios=…`（见[应用更新](./app-updates.md#发布新版本)）。

把包、`latest.json` 和 `latest.json.sig` 上传到 GitHub Release：

```sh
gh release create v1.2.1 dist/com.example.notes-13.nshpkg dist/latest.json dist/latest.json.sig --notes-file CHANGES.md
```

或放到自己服务器的同一目录：先传包，最后传清单和签名，这样应用不会找到一份包还没上传的清单。GitHub 上标记为 draft 或 prerelease 的版本不会被推送。

### 从 GitHub Actions 发布

调高 `nsh.json` 中的 `version` 和 `build`，提交，再推送一个 `v1.2.1` 这样的 tag：

```yaml
# .github/workflows/ota.yml
name: OTA release
on:
  push:
    tags: ["v*"]

jobs:
  ota:
    runs-on: macos-latest
    permissions:
      contents: write # 创建 release
    env:
      # 构建线上应用所用的 nsh，例如 v0.5.0（仓库变量）；为空时用最新版
      NSH_VERSION: ${{ vars.NSH_VERSION }}
    steps:
      - uses: actions/checkout@v4

      - name: Install nsh
        run: |
          curl -fsSL https://nsh.dev/install.sh | sh
          echo "$HOME/.local/bin" >> "$GITHUB_PATH"

      - name: Write the keys
        env:
          RELEASE_KEY: ${{ secrets.NSH_RELEASE_KEY }}
          RELEASE_CERT: ${{ secrets.NSH_RELEASE_CERT }}
          UPDATE_KEY: ${{ secrets.NSH_UPDATE_KEY }}
        run: |
          mkdir -p "$RUNNER_TEMP/keys"
          printf '%s\n' "$RELEASE_KEY" > "$RUNNER_TEMP/keys/release.secret"
          printf '%s\n' "$RELEASE_CERT" > "$RUNNER_TEMP/keys/release.cert"
          printf '%s\n' "$UPDATE_KEY" > "$RUNNER_TEMP/keys/update.secret"

      - name: Publish the package and the manifest
        run: |
          mkdir -p dist
          PACKAGE="dist/$(jq -r .id nsh.json)-$(jq -r .build nsh.json).nshpkg"
          nsh publish --key "$RUNNER_TEMP/keys/release.secret" --cert "$RUNNER_TEMP/keys/release.cert" -o "$PACKAGE"
          nsh update-manifest --package "$PACKAGE" --notes CHANGES.md --key "$RUNNER_TEMP/keys/update.secret" -o dist
          echo "PACKAGE=$PACKAGE" >> "$GITHUB_ENV"

      - name: Create the release
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh release create "$GITHUB_REF_NAME" "$PACKAGE" dist/latest.json dist/latest.json.sig --notes-file CHANGES.md
```

发布到自己的服务器时，把最后一步换成你的上传命令，并按上面的顺序上传。

## 在应用中

和 `nsh/updater` 的其他函数一样，这些函数一次只运行一个：另一个检查、下载或安装进行时再调用会 reject。下面这个模块先检查包，没有包时才检查新应用：

```tsx
// updates.ts
import { openUrl, signal } from "nsh";
import { isAvailable as canRestart } from "nsh/desktop";
import {
  checkForPackage,
  checkForUpdate,
  downloadPackage,
  downloadUpdate,
  installAndRestart,
  restartToPackage,
  type AppUpdate,
} from "nsh/updater";

/** 包已下载，应用可以重启进入它（桌面端）。 */
export const packageReady = signal(false);
/** 新应用，用于包无法承载的改动。 */
export const appUpdate = signal<AppUpdate | null>(null);

export async function checkForUpdates() {
  try {
    if (await checkForPackage()) {
      await downloadPackage();
      // iOS 和 Android：无需提示，包在下次冷启动时运行。
      packageReady.set(canRestart);
      return;
    }
    appUpdate.set(await checkForUpdate());
  } catch (error) {
    console.warn("update check failed:", error); // 下次检查时再试
  }
}

export const restart = () => restartToPackage();

export async function installApp() {
  const update = appUpdate();
  if (!update) return;
  if (!update.canInstall) return openUrl(update.url); // 应用商店
  await downloadUpdate();
  await installAndRestart();
}
```

应用启动后调用一次 `checkForUpdates()`；如果应用会长时间开着，隔一段时间再调用。在桌面端提示用户重启：

```tsx
import { Text, View } from "nsh";
import { Button } from "nsh/base";
import { packageReady, restart } from "./updates";

export function UpdateBanner() {
  return (
    <If when={packageReady()}>
      <View class="flex-row items-center gap-3 rounded-(--radius) bg-muted px-4 py-2">
        <Text class="flex-1 text-foreground">新版本已就绪。</Text>
        <Button onPress={restart} class="rounded-(--radius) bg-primary px-3 py-1.5 active:bg-primary/90">
          <Text class="text-primary-foreground">重启</Text>
        </Button>
      </View>
    </If>
  );
}
```

`restartToPackage()` 像 `Application.restart()` 一样重启应用：本次运行像用户退出时那样结束，应用再次启动并进入新包。用户不重启的话，下次打开应用时就会运行新包。

`runningPackage()` 说明本次运行的是哪份代码，`shellInfo()` 说明由什么来运行它：已安装应用自己的版本、构建号和 NSH 运行时。两者都可用于“关于”页面或错误报告：

```tsx
import { runningPackage, shellInfo } from "nsh/updater";

const running = runningPackage(); // { version, build }；运行应用构建时自带的代码时为 null
const shell = shellInfo(); // { version, build, nshVersion, packages }：已安装的应用
```

在支持包之前安装的应用（或用不支持包的运行时构建的应用）永远收不到包：这时 `packages` 为 false；比 `shellInfo` 更早的运行时连这个函数都没有。只有重新安装完整应用才能解决。

所有函数及其错误见 [nsh/updater](../modules/nsh-updater.md#ota-更新)。

## 设备上发生了什么

包放在应用数据目录（`process.dataDir`）下的 `updates` 目录中：

| 文件 | 含义 |
| --- | --- |
| `next.nshpkg` | 已下载并验证，尚未运行 |
| `trying.nshpkg` | 已启动，正在试运行 |
| `current.nshpkg` | 最近一个证明运行正常的包 |
| `trust/` | 之前接受过的构建号和吊销列表 |
| `packages/` | 正在运行的包的图片和字体 |

| 平台 | 应用数据目录 |
| --- | --- |
| macOS | `~/Library/Application Support/<app id>` |
| Windows | `%APPDATA%\<app id>` |
| Linux | `$XDG_DATA_HOME/<app id>`（`~/.local/share/<app id>`） |
| iOS | 应用容器中的 `Library/Application Support/nsh/<app id>` |
| Android | 应用内部存储中的 `files/nsh/<app id>` |

### 每次启动时

1. 如果 `trying.nshpkg` 还在，说明上次启动没能证明运行正常：应用在试运行期间崩溃或被强制结束。它会被删除。
2. `next.nshpkg` 会再验证一次：由某个根密钥认证的发布密钥签名、未被吊销、属于本应用、适用于当前运行时、构建号高于应用自带的构建号，并且不低于之前接受过的任何构建号。通过后它变成 `trying.nshpkg` 并开始试运行；被拒绝则删除。
3. 否则，如果 `current.nshpkg` 仍能通过验证且构建号高于应用自带的构建号，就运行它；否则删除它。
4. 否则运行应用构建时自带的代码。

应用总能启动：包有任何问题都会记录到日志，然后按顺序运行下一个选择。

包以已安装应用的身份运行：使用它的 id（因此存储和数据不变）、URL scheme 和更新来源，能力最多为已安装应用声明的能力。

### 试运行

试运行中的包从第一帧起运行 10 秒，或用户在此之前退出应用，就算运行正常。它随后成为 `current.nshpkg`，其构建号被记录为已接受。如果它的代码加载失败（例如模块顶层抛出异常），或它的 VM 被停止（超出内存或时间限制），就算失败：包被删除，下次启动运行之前的版本。试运行期间崩溃或被强制结束会留下 `trying.nshpkg`，下次启动时被删除。之后才抛出的错误（例如在事件处理函数中）照常报告，不会结束试运行。

### 回滚保护

被接受的构建号会抬高下限：此后应用拒绝更旧的构建，即使它由受信任的密钥签名，因此带有已知缺陷的旧包无法再被运行。要撤回有问题的包，请发布修复后更高的构建号；如果它在任何地方都不能再运行，再[吊销](./signed-packages.md#吊销密钥和包)它。

## 问题排查

### `checkForPackage()` 返回 `null`

- 应用构建时没有 `"packages": { "roots" }`，或运行在 `nsh run` 或 Web 上。
- 清单里没有 `"package"`：给 `nsh update-manifest` 传 `--package`。
- 包的构建号不高于应用正在运行的代码：`runningPackage()` 的构建号，否则是应用自带的 `build`。
- 它的 `minRuntime` 比应用的运行时新：用构建应用时的 `nsh` 发布，或发布新应用。
- GitHub 上该版本是 draft 或 prerelease，或者最新的版本里没有包。

清单无法获取、没有用 `publicKey` 对应的密钥签名，或属于其他应用时，它会像 `checkForUpdate` 一样 reject。

### `downloadPackage()` reject

错误以 `package refused:` 开头，并说明原因：

| 消息 | 含义 |
| --- | --- |
| `update download: SHA-256 …, the manifest says …` 或 `… bytes, the manifest says …` | 服务器上的文件不是清单里的那个：被重新上传过，或拿到了旧缓存 |
| ``signed by key `…`, which is not trusted`` | 发布密钥的证书来自应用不信任的根密钥 |
| `the signature does not verify` | 包在签名后被改过 |
| `the release key's certificate does not cover this package: …` | 证书已过期或覆盖的是其他应用 id：重新认证密钥 |
| `revoked: …` | 发布密钥或包已被吊销 |
| ``app `…` build 13 is older than build 14, which was accepted before`` | 回滚保护：发布更高的构建号 |
| `its build 13 is not newer than the app's 13` | 调高 `build` |
| `it is com.example.other, the app is com.example.notes` | 这是其他应用的包 |
| `the package needs runtime 0.5.0 or newer; this runtime is 0.4.0` | 为旧运行时发布，或发布新应用 |

不会留下任何文件，应用继续运行原来的代码。

### 下次启动时包没有运行

启动器会在终端或平台日志中记录原因（Apple 平台上是“控制台”或统一日志，Android 上是 `adb logcat`）：

```text
updates: downloaded package refused: …
updates: the package started last never ran 10s without a fatal error; it is deleted and the app goes back
updates: the installed package does not run: its build 13 is not newer than the app's 20
running package com.example.notes 1.2.1 (build 13), shipped build 12
```

### 在本机试用

1. 在 `nsh.json` 中配好 `"packages": { "roots" }`，打包并安装应用，例如 `nsh package --target macos`。
2. 改一些 TSX，调高 `build`，发布一个包，并像应用那样校验它：

   ```sh
   nsh publish --key keys/release.secret --cert keys/release.cert -o next.nshpkg
   nsh verify next.nshpkg --root keys/root.pub
   ```

3. 把它放到下载会放的位置，然后启动应用：

   ```sh
   mkdir -p ~/Library/Application\ Support/com.example.notes/updates
   cp next.nshpkg ~/Library/Application\ Support/com.example.notes/updates/
   ```

   应用会试运行它，10 秒后它成为 `current.nshpkg`。若要试回滚，可以让包的 `App.tsx` 在顶层抛出异常：应用会报告错误，下次启动运行之前的代码。

要试完整流程，可以在本机提供 `latest.json` 和包（`"url": "http://127.0.0.1:8000/latest.json"`，并配 `publicKey`；明文 HTTP 只允许访问本机），然后调用 `checkForUpdates()`。

## 另请参阅

- [签名包](./signed-packages.md)：密钥、证书、校验和吊销
- [应用更新](./app-updates.md)：更新整个应用
- [nsh/updater](../modules/nsh-updater.md)：API
- [CLI](./cli.md)：`nsh publish`、`nsh update-manifest`、`nsh verify`

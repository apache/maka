---
title: 应用更新
description: "让打包后的应用自我更新：从 GitHub Releases 或自己的服务器，清单签名，下载校验。"
order: 20.5
group: delivery
---

# 应用更新

`nsh/updater` 让打包后的应用检查新版本、下载并替换自己。界面由你自己画，模块只提供状态和动作。它更新的是整个应用；如果只想更新打包应用的 TSX，请看 [OTA 更新](/zh-CN/docs/ota-updates)；如果只想给宿主应用下发 NSH 界面，请看[签名包](/zh-CN/docs/signed-packages)。

| 平台 | 行为 |
| --- | --- |
| macOS、Windows、Linux | 检查、下载、替换应用并重启 |
| iOS、Android | 只检查，并给出引导用户前往的链接 |
| Web | 无需处理，部署即更新，`checkForUpdate` 返回 `null` |
| 所有原生平台 | 以签名包运行更新的 TSX 版本（见 [OTA 更新](#ota-更新)） |

## 设置来源

从 GitHub Releases 更新，写在 `nsh.json`：

```json
{ "version": "1.2.0", "updater": { "github": "owner/repo" } }
```

从自己的服务器更新必须配签名密钥，否则谁控制了服务器，谁就控制了应用运行的代码（`nsh keygen keys/update`，`.secret` 不要放进仓库）：

```json
{
  "version": "1.2.0",
  "updater": {
    "url": "https://dl.example.com/app/latest.json",
    "publicKey": "<keys/update.pub 的内容>"
  }
}
```

`github` 也可以配 `publicKey`，配了之后会拒绝未签名的清单。

## 使用

```tsx
import { checkForUpdate, downloadUpdate, installAndRestart } from "nsh/updater";
import { openUrl } from "nsh";

const update = await checkForUpdate(); // 已是最新时为 null
if (update?.canInstall) {
  await downloadUpdate(({ received, total }) => setProgress(received / (total ?? 1)));
  await installAndRestart();
} else if (update) {
  await openUrl(update.url);
}
```

`update` 包含 `version`、`notes`、`url` 和 `canInstall`。iOS、Android 上 `canInstall` 为 false；桌面端如果应用装在用户无法写入的位置（如系统包），也为 false。开发运行时 `checkForUpdate` 返回 `null`。

`installAndRestart` 像 `Application.restart()` 一样重启应用：当前进程像用户退出时那样退出，进程结束后新版本启动。如果失败，应用保持原样。每个函数、它的错误以及 `nsh.json` 的键见 [nsh/updater 参考](../modules/nsh-updater.md)。

## 发布新版本

`nsh.json` 的 `version` 必须符合 [semver](https://semver.org)，并且每次发布都要增大。设置 `"updater"` 后，`nsh package` 还会写出一个以平台命名的压缩包。在各平台分别打包，然后生成清单：

```sh
nsh package --target linux   # My-App-1.3.0-linux-x86_64.tar.gz
nsh package --target macos   # My-App-1.3.0-macos-aarch64.tar.gz
nsh package --target windows # My-App-1.3.0-windows-x86_64.zip

nsh update-manifest *.tar.gz *.zip \
  --notes CHANGES.md \
  --key keys/update.secret \
  --link ios=https://apps.apple.com/app/id000000000
```

把压缩包、`latest.json` 和 `latest.json.sig`（使用 `--key` 时）上传为 GitHub Release 的附件，或放到自己服务器的同一目录。GitHub 上标记为 draft 或 prerelease 的版本不会被推送。

## OTA 更新

只改了 TSX 的版本不需要新应用：[OTA 更新](/zh-CN/docs/ota-updates)把它作为签名包下发，已安装的应用从下次启动开始运行它，所有原生平台（包括 iOS 和 Android）都适用。优先用 OTA，改动需要更新的 NSH 运行时或原生代码时再发新应用。一份清单可以同时包含两者，应用先检查包，再检查新应用：

```tsx
import { checkForPackage, checkForUpdate, downloadPackage } from "nsh/updater";

if (await checkForPackage()) {
  await downloadPackage(); // 下次启动时运行
} else {
  const update = await checkForUpdate();
  // …同上
}
```

密钥、`"packages"` 配置、从 CI 发布以及设备上的行为，见 [OTA 更新](/zh-CN/docs/ota-updates)。

## 校验内容

- 清单签名（配了 `publicKey` 时）。
- 清单的应用 id，必须是当前应用。
- 版本号：只提供更新的版本，旧清单无法让应用降级。
- URL：只允许 HTTPS（明文 HTTP 仅限本机测试）。
- 压缩包的大小和 SHA-256。
- 新应用的 id 和可执行文件，macOS 上还有代码签名。
- 当前进程就是这个包本身：运行在其他应用内的 NSH 模块无法替换宿主。
- OTA 包：按 `packages.roots` 校验签名、应用 id、比当前运行及之前运行过的都新的构建号、所需运行时、大小和 SHA-256。

macOS 上 `nsh package` 用的是 ad hoc 签名，可用于测试，但在其他 Mac 上可能被 Gatekeeper 拦截。正式分发时，请用 Developer ID 给 `.app` 签名并公证，再以同样的文件名重新打包（`tar -czf <压缩包> <Name>.app`），然后运行 `nsh update-manifest`。

## Rust 应用

原生 Rust 应用直接使用 `nsh-updater`，并提供自己的 HTTP 传输。
用 `Config::check` 验证清单，用 `Download` 验证更新包；之后调用
`Installation::install`，成功后调用 `nsh_core::element::desktop::restart()`：
应用像 `Application.restart()` 那样退出，进程结束后新版本启动。`install`
失败时，应用保持原样。

`Config`、`Manifest`、`Asset` 和 `Available` 均为非穷尽结构体。
使用 `Default::default()` 创建，再给所需字段赋值。

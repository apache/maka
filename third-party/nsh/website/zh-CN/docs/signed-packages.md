---
title: 签名包
description: 发布由宿主应用下载并验证的应用代码：密钥、证书、nsh publish、重新签名、验证、吊销与回滚保护。
order: 20
group: delivery
---

# 签名包

签名包（`.nshpkg`）让宿主应用能够运行并非随应用一起发布的 NSH 代码：可以是应用自身 NSH 页面的更新，也可以是第三方
小程序。`nsh publish` 负责构建并签名应用；宿主应用在运行任何代码之前，会依次验证签名、证书链、吊销状态和构建号。

包里装的是 TSX。宿主应用的 Rust 代码（用 Rust 编写的应用，以及它的 crate 中的组件、模块和类）属于宿主应用本身，随它一起发布；
包里的 TSX 像任何 TSX 一样按说明符导入它们（[用 Rust 开发](./rust.md#用-tsx-扩展-rust-应用)）。因此 Rust 应用可以把核心留在 Rust 中，
把经常变化的页面作为签名包发布。

<div class="diagram-scroll">
<img class="diagram diagram-light" src="/diagrams/signed-packages-light.svg" alt="签名包：离线的根密钥为发布密钥签发证书，限定应用 ID；nsh publish 用发布密钥签名包；在设备上，NshTrust 只信任根密钥和最新的吊销列表，依次检查证书、吊销、签名、应用 ID、文件哈希和构建号，然后运行模块或拒绝它。">
<img class="diagram diagram-dark" src="/diagrams/signed-packages-dark.svg" alt="签名包：离线的根密钥为发布密钥签发证书，限定应用 ID；nsh publish 用发布密钥签名包；在设备上，NshTrust 只信任根密钥和最新的吊销列表，依次检查证书、吊销、签名、应用 ID、文件哈希和构建号，然后运行模块或拒绝它。">
</div>

> [!NOTE]
> NSH 只负责验证和运行包，不负责分发。包从哪里来（你的更新服务器、CDN、小程序商店）以及应用何时下载，都由宿主应用
> 自行决定。打包的 NSH 应用更新自己的 TSX 是例外：[OTA 更新](./ota-updates.md)替它获取、验证、运行和回滚包。

## 为什么要签名

宿主应用运行的 JS 能访问应用[授予](./sandbox-and-capabilities.md)的一切，因此它必须来自应用信任的一方。另一个原因是：
NSH 以 QuickJS 字节码的形式发布应用，加载比源码更快，但 QuickJS 不会校验字节码，精心构造的字节码可以破坏内存。所以
NSH 只从三个地方加载字节码：应用自身（经系统签名）的资源、开发者所连接的开发服务器，以及通过验证的包。其他来源一律
只能是 JS 源码。

## 密钥：两个层级

- **根密钥（root key）** 离线保存。宿主应用信任它的公钥；宿主应用可以同时信任多个根，轮换根密钥就是靠这一点实现的。
- 根密钥 **为发布密钥（release key）签发证书**：证书中写明发布密钥、它可以为哪些 app id 签名，以及有效时间段。
- **包由发布密钥签名**，并附带该密钥的证书。因此，发布密钥可以轮换（或吊销），而无需更新只认识根密钥的宿主应用。

每个密钥都有一个由公钥派生的 id（其 SHA-256 的前 8 个字节，十六进制表示），每条命令都会打印出来。

### 创建密钥

```sh
nsh keygen keys/root
nsh keygen keys/release
```

```text
key 4e0b637f5e10f6a6: keys/root.secret (keep it secret), keys/root.pub
key 3428d7136788c9ee: keys/release.secret (keep it secret), keys/release.pub
```

每个密钥由两个文件组成：`<name>.secret`（仅所有者可读）和 `<name>.pub`，内容都是一行 base64。`nsh keygen` 绝不会
覆盖已有的密钥。

> [!CAUTION]
> 请将 `root.secret` 离线保存，例如放在保险箱里的加密硬盘上。拿到它的人可以签发证书，而所有信任该根密钥的宿主应用都会
> 接受这些证书。发布密钥则应放在构建机器上或 CI 的 secrets 中。

### 为发布密钥签发证书

```sh
nsh certify --root keys/root.secret --key keys/release.pub --apps 'com.example.*' -o keys/release.cert
```

```text
keys/release.cert: key 3428d7136788c9ee certified by root 4e0b637f5e10f6a6 for com.example.* until 365 days from now
```

| 参数 | 说明 |
|---|---|
| `--root <file>` | 根密钥的私钥。 |
| `--key <file>` | 发布密钥的公钥。 |
| `--apps <pattern>` | 它可以为哪些 app id 签名：`*`（任意）、`com.example.*`（`com.example.` 下的 id）或某个确切的 id。可重复指定。 |
| `--days <n>` | 从现在起可以签名的天数。默认 365。 |
| `-o, --out <file>` | 要写入的证书文件。 |

证书是一个很小的 JSON 文件，不需要保密。

## 发布包

```sh
nsh publish App.tsx --key keys/release.secret --cert keys/release.cert
```

```text
.nsh/out/com.example.counter-2.nshpkg: com.example.counter 1.0.0 (build 2), 0 assets, 12 KB, signed by 3428d7136788c9ee, for runtime 0.1.1 or newer
```

`nsh publish` 以 release 模式构建应用并签名。app id、名称、版本和构建号取自入口文件旁的 `nsh.json`，可以用下列参数覆盖：

| 参数 | 说明 |
|---|---|
| `--key <file>` | 发布密钥的私钥。 |
| `--cert <file>` | 它的证书。 |
| `-o, --out <file>` | 要写入的包。默认 `.nsh/out/<id>-<build>.nshpkg`。 |
| `--id <id>` | app id，例如 `com.example.app`。 |
| `--app-version <version>` | 版本，例如 `1.2.0`。 |
| `--build <n>` | 构建号。必填（在此处或 `nsh.json` 中指定）；每次发布都必须递增。 |
| `--source-map <where>` | `package`（默认）：放进包里。`file`：写到包旁边的 `<package>.map`，不放进包里。`none`：不输出。见[已发布包的报错](#已发布包的报错)。 |
| `--strip-debug` | 字节码中不保留行号和列号表：包更小，但报错调用栈里没有位置。 |
| `--min-runtime <version>` | 能运行该包的最低运行时版本，例如 `0.2.0`（`nsh.json` 中的 `minRuntime`）。默认：本 CLI 的版本。见[哪些运行时能运行包](#哪些运行时能运行包)。 |

凡是设备会拒绝的包，`nsh publish` 也拒绝签名：app id 必须是单独一级路径，且证书必须覆盖该 app id 和当前时间。

```text
error the release key's certificate does not cover this package: it does not cover app `com.example.counter` (only com.other.app)
```

### 哪些运行时能运行包

包里写明了能运行它的最低 NSH 运行时版本，运行时比它旧的宿主应用会在运行任何代码之前拒绝它：

```text
error the package needs runtime 0.2.0 or newer; this runtime is 0.1.1
```

默认值是构建该包的 CLI 的版本：bundle 是按这个 CLI 的模块编译的，所以已知能运行它的就是这个版本的运行时。如果线上的宿主
应用运行时更旧，而应用只用到了那个运行时已有的功能，就用 `--min-runtime`（或 `nsh.json` 中的 `minRuntime`）为它发布：

```sh
nsh publish App.tsx --key keys/release.secret --cert keys/release.cert --min-runtime 0.1.0
```

版本号的格式是 `MAJOR.MINOR.PATCH`；带预发布后缀的版本（`0.2.0-beta.1`）按去掉后缀的版本计算。它不能比 CLI 更新。
上传之前，先在带有该运行时的宿主应用上试一下这个包：旧运行时缺少的导入或函数，会在模块加载时报错。

### 包里有什么

包是单个文件：先是一个 JSON 头（app id、名称、版本、构建号、声明的能力、字节码版本、最低运行时版本、签名时间、发布密钥的证书，以及
一张列出各文件及其 SHA-256 的文件表），然后是各个文件，最后是发布密钥对前面所有内容的 Ed25519 签名。其中的文件包括：

- 应用的 JS 源码（始终包含）；
- 它的字节码，仅当设备上运行时的字节码版本与之相同时才会使用（否则运行源码，因此包在更新的运行时上仍然可用）；
- 它的 source map（用 `--source-map file` 或 `none` 发布时除外）；
- 它导入的资源（图片、字体）。

包的标识（用于吊销）是整个文件的 SHA-256。

### 由更新版本的 NSH 签名的包

只要宿主应用的运行时不低于包的[最低运行时版本](#哪些运行时能运行包)，它就能运行由更新的 `nsh publish` 签名的包。新版本新增、而宿主运行时
不认识的内容会被略过，且绝不会扩大包能做的事：

- 不认识的头字段和文件会被忽略（它们依然受签名和哈希保护），除非包把某个字段标记为运行时必须理解的字段：这时更旧的
  运行时会拒绝该包；
- 不认识的[能力](./sandbox-and-capabilities.md)不会被授予；某项能力或某条 `http` 授权中出现不认识的键时，会整个被丢弃，
  因为这个键可能是对它的限制。

包加载时会把略过的内容记录到日志。

## 重新签名包

分发多个应用的包的平台，可以用自己的一个密钥为它们统一签名：CI 构建每个包，并用测试应用信任的密钥签名；平台再用正式应用信任的
密钥重新签名。

```sh
nsh publish ci/com.example.counter-2.nshpkg --key keys/platform.secret --cert keys/platform.cert -o com.example.counter-2.nshpkg
```

```text
com.example.counter-2.nshpkg: com.example.counter 1.0.0 (build 2), signed again by d0eb0d3cb453b71b, for runtime 0.3.0 or newer
```

| 参数 | 说明 |
|---|---|
| `--key <file>` | 发布密钥的私钥。 |
| `--cert <file>` | 它的证书。 |
| `-o, --out <file>` | 要写入的包。可以就是读入的那个包。默认：`.nsh/out/<id>-<build>.nshpkg`。 |

包里 CI 放入的内容全部保留：文件，app id、版本和构建号，声明的能力，[最低运行时版本](#哪些运行时能运行包)，以及
[更新版本的 NSH](#由更新版本的-nsh-签名的包) 写入的内容。证书、签名时间和签名换成新密钥的，因此包有了自己的 SHA-256，
[吊销](#吊销密钥和包)时用的就是这个值。

签名前，`nsh publish` 会检查包是否完好（由其证书指明的密钥签名，文件表与数据吻合，每个文件都与其哈希一致），以及新证书是否
覆盖该 app id 和当前时间。此后由新签名为这个包担保，字节码也包括在内，所以平台只为自己的构建产出的包重新签名。Rust 工具用
`nsh_package::resign(&bytes, &key, &certificate)` 重新签名。

## 验证包

`nsh verify` 检查包的方式，与信任指定根密钥的宿主应用完全一致：

```sh
nsh verify .nsh/out/com.example.counter-2.nshpkg --root keys/root.pub
```

```text
valid: com.example.counter 1.0.0 (build 2), release key 3428d7136788c9ee, sha256 f40565358c13fafce369792e41125fea7f93fe87dd1bc24fd575dabc09b34fd4, 0 assets, bytecode for this runtime
```

| 参数 | 说明 |
|---|---|
| `--root <file>` | 受信任的根公钥。可重复指定。不指定时，只检查包自身的签名。 |
| `--revocations <file>` | 先应用的吊销列表。 |

设备按以下顺序检查：

1. 证书由受信任的根签名；
2. 发布密钥未被吊销；
3. 包由发布密钥签名；
4. app id 是单独一级路径（不含 `/`、`\`、`:` 或 NUL，也不是 `.` 或 `..`：设备用它给包的目录命名），且证书覆盖该 app id 和签名时间；
5. 包所需的最低运行时版本；
6. 文件表与数据完全吻合，且每个文件都与其哈希一致；
7. 包本身未被吊销；
8. 其构建号不低于此前已接受的该应用的最高构建号（回滚保护）。

被拒绝的包会抛出错误，指明哪一项检查失败；正在运行的应用会继续运行。

## 吊销密钥和包

根密钥可以签署 **吊销列表**：列出不得再加载的发布密钥和包。

```sh
# The first list.
nsh revoke --root keys/root.secret --sequence 1 \
  --package f40565358c13fafce369792e41125fea7f93fe87dd1bc24fd575dabc09b34fd4 -o revocations.json

# Later: keep everything in the last list and add a release key (sequence becomes 2).
nsh revoke --root keys/root.secret --extend revocations.json --key 3428d7136788c9ee -o revocations-2.json
```

| 参数 | 说明 |
|---|---|
| `--root <file>` | 根密钥的私钥。 |
| `--extend <file>` | 保留此列表（最近发布的那份）中的条目。 |
| `--sequence <n>` | 列表的序号，必须大于此前发布过的所有序号。使用 `--extend` 时，默认取该列表的序号加一。 |
| `--key <id>` | 要吊销的发布密钥 id。可重复指定。 |
| `--package <sha256>` | 要吊销的包的 SHA-256（即 `nsh verify` 打印的值）。可重复指定。 |
| `-o, --out <file>` | 要写入的列表。 |

信任存储只接受序号比当前所持列表更高的列表，因此无法通过重放旧列表来撤销吊销。请把最新的列表发布到应用获取它的地方，
并在打开包之前用 `updateRevocations` 应用它。

## 回滚保护

宿主应用接受一个包后，其信任存储会记录该 app id 的构建号，此后拒绝更旧的构建。即使攻击者拿到了一个存在已知漏洞的
旧签名包，也无法让应用运行它。这条记录保存在信任存储的状态目录中（`nsh-trust.json`），重启后依然有效。在 GPUI 上，宿主应用可以等新包被证明健康之后再记录（先
`verify_package`，再 `accept_package`，见下文）。

## 在宿主应用中加载包

验证需要对整个包做哈希并解出其资源（每个包只解一次，放在信任存储的目录下），因此应在 UI 线程之外执行；运行结果则在
UI 线程上进行。

**GPUI（Rust）**，宿主应用还可以等包被证明健康之后再接受它：

```rust
use nsh_platform_gpui::{accept_package, package::{PublicKey, TrustStore}, verify_package};

let mut trust = TrustStore::open(state_dir)?;
trust.add_root(PublicKey::from_base64(ROOT_PUB)?);

// Off the main thread: verified as strictly as ever, but the build is not recorded yet.
let package = verify_package(&trust, &bytes, &packages_dir)?;
view.read(cx).run_package(&package);
// Later, once its first frame showed and no fatal error came for a while:
accept_package(&mut trust, &package)?;
```

**iOS（Swift）**：

```swift
let trust = try NshTrust(stateDirectory: applicationSupport.appendingPathComponent("nsh"))
try trust.addRoot(rootPublicKey)                // the contents of root.pub
try trust.updateRevocations(latestListJSON)     // when you have one

let info = try await app.loadPackage(at: downloaded, trust: trust)   // verify off the main thread, then run
```

**Android（Java）**：

```java
NshTrust trust = new NshTrust(new File(getFilesDir(), "nsh"));
trust.addRoot(rootPublicKey);
trust.updateRevocations(latestListJson);

NshPackage pkg = trust.openPackage(downloaded);   // off the UI thread; throws NshPackage.RefusedException
runOnUiThread(() -> nsh.runPackage(pkg));
```

包被接受之前，此前接受过的构建依然能通过验证，所以新包出问题时宿主应用可以退回它之前运行的包（信号可以是
`AppView::on_error` 收到的致命错误，或者在接受之前崩溃）。比已接受构建更旧的包仍会被拒绝，期间被吊销的包也不会被接受。
`load_package` 会一次完成验证和接受，与 iOS、Android 上的 `openPackage` 相同。

包声明的[能力](./sandbox-and-capabilities.md)随包一起传递：包只能做它声明的事，并且还要在宿主应用授予的范围之内。

完整 API：[GPUI](./gpui.md#嵌入-gpui-应用)、[嵌入 iOS 应用](./ios.md)、
[嵌入 Android 应用](./android.md)。

## 已发布包的报错

包里的字节码保留了行号和列号表，所以报错带有位置；运行时会先用包里的 source map 把它们映射到你的源码，再交给宿主应用的
错误回调：

```text
Error: boom
    at n (App.tsx:5:3)
```

source map 里包含应用的原始源码，往往也是包里最大的文件：gallery 示例 2.6 MB 的包里大约一半是它。如果不想把它随包分发，
可以把它输出到包的旁边：

```sh
nsh publish App.tsx --key keys/release.secret --cert keys/release.cert --source-map file
```

```text
✓ wrote the source map to .nsh/out/com.example.counter-2.nshpkg.map (6.1 KB)
```

这时设备上报的是 bundle 中的位置（`at n (bundle.js:1:80)`）。把 source map 和对应的包一起保存好，再用 `nsh symbolicate`
映射宿主应用上报的内容：

```sh
nsh symbolicate .nsh/out/com.example.counter-2.nshpkg.map report.txt
```

```text
Error: boom
    at n (App.tsx:5:3)
```

`nsh symbolicate` 从文件或标准输入读取报错文本，接受 source map 文件，或带有 source map 的包。行号表会让字节码增大约
五分之一（对带 source map 的包而言是 3–5%）；`--strip-debug` 会去掉它们，此时调用栈显示为 `at n (<null>:0:1)`，
无法再映射。

## 在开发中试用包

`nsh run` 安装的开发宿主可以像嵌入式应用那样运行包。

在 iOS 上，宿主可执行文件接受 `--package <file>` 以及一个或多个 `--root <root.pub>`。在 `nsh run` 将宿主安装到模拟器
（`--target ios`）之后：

```sh
xcrun simctl launch booted com.longbridge.nsh.host \
  --package "$PWD/.nsh/out/com.example.counter-2.nshpkg" --root "$PWD/keys/root.pub"
```

在 Android 上，开发宿主（`DevActivity`，由 `nsh run --target android` 安装）接受 extras `package`（设备上的路径）和
`root`（base64 公钥，以逗号分隔）：

```sh
adb push .nsh/out/com.example.counter-2.nshpkg /sdcard/Android/data/com.longbridge.nsh.host/files/app.nshpkg
adb shell am start -S -n com.longbridge.nsh.host/com.longbridge.nsh.DevActivity \
  --es package /sdcard/Android/data/com.longbridge.nsh.host/files/app.nshpkg \
  --es root "$(cat keys/root.pub)"
```

它们的信任状态保存在临时目录（iOS）或缓存目录（Android）中，因此比已接受版本更旧的构建在这里同样会被拒绝。

## 发布检查清单

1. 根密钥离线保存；按团队或按应用系列签发发布密钥，有效期不超过一年。
2. 每次发布都提高 `nsh.json` 中的 `build`；没有构建号的包 `nsh publish` 会拒绝。
3. 上传前对包运行 `nsh verify --root root.pub`。
4. 将 `root.pub` 内置在宿主应用中；吊销列表单独分发，这样无需更新应用就能吊销。
5. 如果发布密钥泄露，吊销它（`nsh revoke --extend … --key <id>`），签发新的发布密钥并重新发布。
6. 由平台为应用统一签名时，给 CI 一个只有测试应用信任的根密钥，正式应用内置平台的根密钥；平台为 CI 的包重新签名（`nsh publish <package>`）。

## 另请参阅

- [沙箱与能力](./sandbox-and-capabilities.md)
- [嵌入 iOS 应用](./ios.md)、[嵌入 Android 应用](./android.md)
- [OTA 更新](./ota-updates.md)：以签名包下发打包应用自己的 TSX
- [CLI](./cli.md)

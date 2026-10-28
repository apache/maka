---
title: Android
description: 在 Android 上用 Android 视图运行 Rust 和 TSX 编写的 NSH 应用（模拟器或真机），打包成 .apk，并通过 nsh.aar 和 NshView 嵌入现有 Android 应用。
order: 12
group: platforms
---

# Android

NSH 应用在 Android 上用普通的 Android 视图和 `StaticLayout` 文本运行，要求 Android 9（API 28）及以上，支持 `arm64-v8a`、
`armeabi-v7a` 和 `x86_64`。用 Rust 和 TSX 编写的完整应用，运行和打包方式与其他平台相同；现有应用也可以在 `NshView` 中嵌入模块，加载它下载的签名包，并按自己设定的限制和能力运行它们。在
Android 上，`os()` 是 `Os::Android`（TSX 中 `platform.os` 是 `"android"`），TSX 的 `android={{…}}` 属性生效。

## 环境要求

- **Android SDK**（包括 `platforms;android-35`、build tools 和 `platform-tools`）和 **JDK**，可在 macOS、Windows 或 Linux
  上使用。见[安装](./installation.md#android)。
- 一个模拟器，或通过 `adb` 连接的设备。

## 运行应用

Rust 应用在自己的目录里运行，TSX 应用写明入口：

```sh
nsh run --target android               # Rust 应用
nsh run App.tsx --target android       # TSX 应用
```

先启动模拟器或连接设备（`adb devices` 会列出它们；NSH 使用第一个）。对 Rust 应用，`nsh` 用你的 crate 构建应用的 `libnsh.so`，
安装 APK 并启动它；修改 crate 的 Rust 代码会重新构建并安装。对 TSX 应用，`nsh` 会安装一个开发宿主 APK（只在运行时变化时重新构建），并通过
`adb reverse` 转发开发服务器的端口，因此通过 USB 即可工作，无需共享网络；你保存时应用会更新，日志显示在终端中。

## 打包

```sh
nsh package --target android --run             # Rust 应用：.nsh/out/<Name>.apk，安装并启动
nsh package App.tsx --target android --run     # TSX 应用
```

Rust 应用的 APK 带有它自己的 `libnsh.so`，用你的 crate 构建，其中的 activity 挂载根组件。

APK 用 SDK 的 build tools 构建，不需要 Gradle；除非传入发布用的 keystore，否则用调试密钥签名。发布签名和图标见[打包](./packaging.md#android)。

NSH 以 16 KB ELF 对齐构建 `libnsh.so`，并将未压缩的原生库按 16 KB ZIP 边界打包。
release APK 中的 `libnsh.so` 不带符号表和调试信息。完整的库位于运行时旁的 `symbols/<abi>/libnsh.so`（Rust 应用的在
`.nsh/rust/android-rust-release/symbols/<abi>/`）：把它交给 `ndk-stack`，或作为原生调试符号上传到 Play Console，即可还原原生崩溃堆栈。

## 嵌入 Android 应用

现有的 Android 应用可以在自己的界面中显示 NSH 应用。运行时以 Android 库 `nsh.aar` 的形式提供：创建一个
`com.longbridge.nsh.NshView`（一个 `FrameLayout`），把它加到任意布局中，再往里加载一个 TSX 应用或签名包即可。用 Rust 编写的应用在
Android 上以 `nsh package --target android` 构建的 APK 发布。NSH 应用用普通的 Android
视图渲染，与你自己的视图并列。

每个 `NshView` 都是一个独立的引擎，拥有自己的 JS VM；没有全局单例，所以可以同时运行多个。

<div class="diagram-scroll">
<img class="diagram diagram-light" src="/diagrams/host-app-light.svg" alt="一个宿主应用里有两个 nsh 视图（iOS 上是 NshAppView，Android 上是 NshView）：每个都是独立的引擎，有自己的线程、虚拟机、限制和能力；宿主授予能力、设置限制，并注册地图这样的原生组件。">
<img class="diagram diagram-dark" src="/diagrams/host-app-dark.svg" alt="一个宿主应用里有两个 nsh 视图（iOS 上是 NshAppView，Android 上是 NshView）：每个都是独立的引擎，有自己的线程、虚拟机、限制和能力；宿主授予能力、设置限制，并注册地图这样的原生组件。">
</div>

## 获取库

发行包中包含两个版本：

```text
dist/nsh/embed/android/nsh.aar       release: bundles and signed packages
dist/nsh/embed/android/nsh-dev.aar   also connects to a `nsh dev` server
```

AAR 包含 Java 运行时以及适用于 `arm64-v8a`、`armeabi-v7a` 和 `x86_64` 的 `libnsh.so`，库中带有符号：应用的 Gradle
构建在打包时去除符号，并保留它们用于崩溃报告。它声明了 `INTERNET`
权限，要求 **API 28**（Android 9）或更高版本。

把它加入应用模块，例如从 `libs` 文件夹引入：

```kotlin
// app/build.gradle.kts
dependencies {
    debugImplementation(files("libs/nsh-dev.aar"))
    releaseImplementation(files("libs/nsh.aar"))
}
```

## 随应用附带 bundle

把 TSX 应用构建到应用的 assets 中：

```sh
nsh build App.tsx --release --out app/src/main/assets/nsh
```

这会写出 `bundle.nshc`（字节码）、`bundle.js`（源码）、`bundle.js.map`、`capabilities.json`（当 `nsh.json`
声明了[能力](./sandbox-and-capabilities.md)时）以及 `assets/`（应用导入的图片和字体）。

## 显示应用

```java
import android.app.Activity;
import android.os.Bundle;
import android.util.Log;
import com.longbridge.nsh.NshView;

public final class MainActivity extends Activity {
    private NshView nsh;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        nsh = new NshView(this);
        nsh.setErrorListener(message -> Log.e("nsh", message));
        setContentView(nsh);
        nsh.loadAssetBundle("nsh");   // runs assets/nsh/bundle.nshc
    }

    @Override
    protected void onDestroy() {
        nsh.destroy();
        super.onDestroy();
    }
}
```

Kotlin 写法：

```kotlin
class MainActivity : Activity() {
    private lateinit var nsh: NshView

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        nsh = NshView(this)
        nsh.setErrorListener { message -> Log.e("nsh", message) }
        setContentView(nsh)
        nsh.loadAssetBundle("nsh")
    }

    override fun onDestroy() {
        nsh.destroy()
        super.onDestroy()
    }
}
```

`NshView` 也可以放在任意布局中，例如放在你自己的工具栏下方：

```java
LinearLayout column = new LinearLayout(this);
column.setOrientation(LinearLayout.VERTICAL);
column.addView(toolbar);
column.addView(nsh, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
setContentView(column);
```

视图的尺寸就是应用的窗口：NSH 按视图的尺寸布局应用，尺寸变化时重新布局。再次加载会替换正在运行的应用。完整示例见
`examples/embed-android/src/com/longbridge/nsh/embeddemo/MainActivity.java`。

## `NshView`

| 方法 | 说明 |
|---|---|
| `NshView(Context context)`、`NshView(Context context, boolean trace)` | 创建一个空视图。`trace` 会记录每次提交的耗时。 |
| `setErrorListener(ErrorListener listener)` | 在 UI 线程上接收应用的致命错误（加载失败、未捕获的 JS 异常、VM 因触及限制而停止）。错误总会写入日志。 |
| `setLimits(int memoryMb, int stackKb, int loadMs, int callMs, int maxNodes)` | 接下来加载的应用的 VM 限制；传 0 表示使用默认值。 |
| `setGrantedCapabilities(String json)` | 接下来加载的应用最多能做什么，JSON 格式与 `nsh.json` 的 `capabilities` 相同；`null` 表示授予每个应用所声明的能力。授权无效时返回 `false`（并被忽略）。 |
| `setLocale(Locale locale)` | 代替用户设置的语言和地区：`Intl`、`locale()` 和组件立即跟随，此后加载的应用也从它开始。`null` 跟随系统。 |
| `setFontScale(float scale)` | 代替系统字体大小的文字大小（1 为默认）：文字和输入框按它重新排版，`fontScale()` 读到它，立即生效，此后加载的应用也一样；长度保持原样。`0` 跟随系统。 |
| `setThemeOverrides(String json)` | 把宿主的品牌加在应用的[主题](./tailwind.md#主题-token)之上：格式与 `nsh.json` 的 `"theme"` 相同的主题文件。其中的 token 在浅色和深色模式下都覆盖应用的同名 token，应用的其他 token 保持不变。立即生效，并作用于之后加载的应用；`null` 恢复应用自己的主题。文件无法解析时抛出 `IllegalArgumentException`。 |
| `setStorageDirectory(File dir)` | 接下来加载的应用保存其[存储](../modules/nsh.md#storage)的目录；`null`：应用私有目录内的 `files/nsh/<app id>`，按应用自己的 id。 |
| `setCacheOptions(NshCacheOptions options)` | 接下来加载的应用保存缓存（[下载的图片](./images-and-assets.md#磁盘缓存)）的位置和每种缓存的大小。用 `NshCacheOptions.builder()` 构建：`location(File)`、`systemLocation()`（默认：缓存目录中的 `nsh`，每个应用在 `<app id>`）或 `noDiskCache()`；`imagesMaxMegabytes(int)`（默认 256）或 `imagesOff()`。 |
| `loadAssetBundle(String dir)` | 运行 APK assets 中的 `dir/bundle.nshc`；应用资源取自 `dir/assets/`。无法读取时返回 `false`（也会报告给错误监听器）。 |
| `loadBundleFile(File file)` | 运行一个 `bundle.js` 文件；资源取自同目录下的 `assets/`。拒绝 `.nshc` 文件。 |
| `runPackage(NshPackage pkg)` | 运行一个已验证的签名包，替换正在运行的应用。一个包只能运行一次。 |
| `registerComponent(String name, NshComponent.Factory factory)` | 注册一个[原生组件](./native-components.md)。 |
| `setParams(Object params)` | 之后加载的应用的启动参数（`Map` 或 `JSONObject`）：应用在启动时以 `host.params` 读取（[`host`](../modules/nsh.md#host)）。不是 JSON 对象时返回 `false`。 |
| `send(String name, Object data)` | 向应用发送一个事件（`host.on(name, …)`）；应用开始监听前会一直保留，没有应用运行时留给下一个应用。可在任意线程调用；`destroy()` 后返回 `false`。 |
| `handle(String name, HostHandler handler)` | 在 UI 线程处理应用对 `name` 的调用（`host.call`）和投递（`host.post`）；传 `null` 移除处理函数。处理函数通过它的 `NshHostReply` 在任意线程回答一次。 |
| `connectDevServer(String url)` | 开发用：从 `nsh dev` 服务器加载，每次修改后重新加载。使用 release 版 AAR 时返回 `false`。 |
| `handleBack()` | 让应用处理返回键（关闭对话框、弹出页面、执行 `BackHandler` 监听器）；返回它是否处理了。 |
| `destroy()` | 停止应用，并对它的每个原生组件调用 `destroy()`。此后该视图不能再使用。 |

> [!IMPORTANT]
> 编译字节码（`.nshc`）只能从 APK 自身的 assets 或签名包中加载。存储上的文件可能被替换，而 QuickJS 不校验字节码，所以
> `loadBundleFile` 只接受 JS 源码。应用下载的代码应以[签名包](./signed-packages.md)的形式提供。

`setLimits`、`setGrantedCapabilities`、`setStorageDirectory` 和 `setCacheOptions` 从下一次加载开始生效：请在 `loadAssetBundle` 等方法之前调用。

每个应用无需任何设置就按自己的 id 保存存储：签名包使用其发布密钥证书担保的 id，bundle 使用其 `nsh.json` 中的 `id`（`nsh package` 写入 APK assets 的 `nsh/app.json`）。如果宿主想把应用的数据放到自己选择的位置，调用 `setStorageDirectory`：

```java
nsh.setStorageDirectory(new File(getFilesDir(), "nsh/com.example.orders"));
nsh.loadAssetBundle("orders");
```

## 与应用通信

视图与它运行的应用通过一条专属通道通信（[`host`](../modules/nsh.md#host)）：应用在启动时读取的启动参数、宿主应用发来的事件，以及应用发出的调用和投递，数据都是 JSON（在这一侧是 map、list、字符串、数字和布尔值）。应用里不需要任何视图，也不需要原生组件。

```java
// 加载之前：应用首先打开的内容（TSX 中的 `host.params`）。
nsh.setParams(Map.of("conversation", intent.getStringExtra("conversation")));
nsh.loadAssetBundle("nsh");

// 应用的 `await host.call("user.profile", { id })`，在 UI 线程处理。
nsh.handle("user.profile", (data, reply) -> {
    Object id = ((Map<?, ?>) data).get("id");
    api.profile(id, profile -> reply.resolve(Map.of("id", id, "name", profile.name)),
            error -> reply.reject(error.getMessage()));
});

// 应用的 `host.post("analytics", …)`：没有回答。
nsh.handle("analytics", (data, reply) -> analytics.log(data));

// 之后：应用通过 `host.on("conversation.open", …)` 收到它。
nsh.send("conversation.open", Map.of("id", tappedConversation));
```

Kotlin 写法：

```kotlin
nsh.handle("user.profile") { data, reply ->
    val id = (data as Map<*, *>)["id"]
    lifecycleScope.launch {
        runCatching { api.profile(id) }
            .onSuccess { reply.resolve(mapOf("id" to id, "name" to it.name)) }
            .onFailure { reply.reject(it.message ?: "failed") }
    }
}
```

处理函数在 UI 线程运行；调用在应用中等待回答，不会阻塞任何一方。始终没有给出的 reply 在被回收时让调用失败，没有处理函数的名称的调用会立即失败。应用尚未监听的名称的事件会保留到它开始监听，没有应用运行时（`loadAssetBundle` 之前、重新加载期间）发送的事件交给下一个应用。
## 主题覆盖

嵌入在多个品牌宿主应用中的同一个应用会采用各个宿主的品牌：宿主给出其品牌要改的 token，格式与 `nsh.json` 的 `"theme"` 相同的主题文件（shadcn/ui 的 `cssVars`，值按 CSS 的写法）。它们覆盖应用的同名 token，应用的其他 token 保持不变。在 `dark` 下给出 token 的深色模式值（只在 `light` 或 `theme` 下设置的 token 在两种模式下都是这个颜色）：

```java
nsh.setThemeOverrides("{ \"cssVars\": {"
        + " \"theme\": { \"radius\": \"0.75rem\" },"
        + " \"light\": { \"primary\": \"#e11d48\", \"primary-foreground\": \"#ffffff\" },"
        + " \"dark\": { \"primary\": \"#fb7185\", \"primary-foreground\": \"#1c1917\" } } }");
nsh.loadAssetBundle("orders");
```

在加载之前或之后调用都可以：`bg-primary`、`rounded-(--radius)` 等类名立即更新样式，之后加载的每个应用在第一帧就带有这些覆盖。`setThemeOverrides(null)` 恢复应用自己的主题。

## 应用打开的链接

应用打开的 URL（[`openUrl`](../modules/nsh.md#openurl)，以及 `links="open"` 的 `TextView` 中的链接）先交给视图的 `OpenUrlHandler`，在 UI 线程调用：宿主应用自己处理了这个 URL（例如交给自己的路由）时返回 `true`，返回 `false` 则由系统用 `ACTION_VIEW` Intent 打开。没有设置处理函数时，所有 URL 都由系统打开。到达这里的 URL 都已通过应用的 `openUrl` 能力检查。

```java
nsh.setOpenUrlHandler(url -> {
    Uri uri = Uri.parse(url);
    // 宿主应用自己的链接在宿主应用里打开。
    if ("lb".equals(uri.getScheme()) || "longbridge.com".equals(uri.getHost())) {
        router.open(uri);
        return true;
    }
    return false;
});
```

## 限制

```java
// 128 MB heap, default stack, 10 s to load, 1 s per call, 50 000 nodes
nsh.setLimits(128, 0, 10_000, 1_000, 50_000);
```

默认值为：256 MB 堆、4096 KB 栈、加载 10 s、每次调用 2 s、200 000 个节点。各项限制触发时会发生什么，见[沙箱与能力](./sandbox-and-capabilities.md)。

## 能力

```java
nsh.setGrantedCapabilities(
    "{\"network\": {\"hosts\": [\"api.example.com\"]}, \"webview\": {\"hosts\": [\"help.example.com\"]}}");
nsh.loadAssetBundle("nsh");
```

一个请求必须既被应用在 `nsh.json` 中的声明允许，也被这里的授权允许。参见[沙箱与能力](./sandbox-and-capabilities.md)。

## 签名包

在 UI 线程之外验证下载的包，再回到 UI 线程上运行：

```java
NshTrust trust = new NshTrust(new File(getFilesDir(), "nsh"));
trust.addRoot(rootPublicKey);   // the contents of root.pub from `nsh keygen`

executor.execute(() -> {
    try {
        NshPackage pkg = trust.openPackage(downloadedFile);
        runOnUiThread(() -> nsh.runPackage(pkg));
    } catch (NshPackage.RefusedException e) {
        Log.w("nsh", "refused: " + e.getMessage());   // the running app stays
    }
});
```

| API | 说明 |
|---|---|
| `new NshTrust(File stateDir)` | 打开或创建信任库。它的状态（最新的吊销列表、每个应用已接受的最高构建号）持久化在该目录中，包的资源也解压到其下。在调用 `addRoot` 之前不信任任何密钥。可在任意线程使用；用完后调用 `close()`。 |
| `boolean addRoot(String publicKey)` | 信任一个根公钥（base64，即 `.pub` 文件的内容）。密钥无效时返回 `false`。 |
| `boolean updateRevocations(String json)` | 应用 `nsh revoke` 生成的吊销列表；该列表须由受信任的根签名，且比信任库现有的更新。 |
| `NshPackage openPackage(File file) throws NshPackage.RefusedException` | 验证包、解压资源并接受该包（此后该应用更旧的构建都会被拒绝）。大包耗时较长：请在 UI 线程之外调用。 |
| `NshPackage` | `appId`、`appName`、`version`、`build`；如果不运行它，调用 `close()`。 |

密钥、证书和吊销机制的工作方式见[签名包](./signed-packages.md)。

## 开发

使用 `nsh-dev.aar` 时：

```java
if (BuildConfig.DEBUG) {
    nsh.connectDevServer("ws://127.0.0.1:8790/ws");
} else {
    nsh.loadAssetBundle("nsh");
}
```

在电脑上运行 `nsh dev App.tsx`。对于模拟器或 USB 连接的设备，转发端口，让设备自己的 `127.0.0.1` 能访问到服务器：

```sh
adb reverse tcp:8790 tcp:8790
```

否则使用 `nsh dev` 打印的局域网地址。资源通过明文 HTTP 从开发服务器获取，因此 `nsh-dev.aar` 声明了
`android:usesCleartextTraffic="true"`，manifest 合并时会把它应用到你的应用上（应用自己的网络安全配置可以覆盖它）。release 版
`nsh.aar` 没有这项声明。

## Activity 配置

- **返回键。** 当应用需要处理返回键时（有打开的对话框、有被推入的页面、有 `BackHandler` 监听器），`NshView`
  会自己接收返回键，否则交给 Activity。在 Android 13 及更高版本上设置了 `android:enableOnBackInvokedCallback="true"`
  时，它注册一个 `OnBackInvokedCallback`；其他情况下（Android 12 及更早版本，或未开启该属性），它在 Activity 的
  `onBackPressed` 之前接收返回键事件，因此也先于 AndroidX 的 `OnBackPressedDispatcher` 和 Fragment 的回调。无论在
  Activity 还是 Fragment 中都无需手动转发。已经把返回键转发给 `handleBack()` 的宿主照常工作：一次按键只交给应用一次。

  如需在 Android 13+ 上支持预测性返回，请像打包出的 NSH 应用那样，在 `<application>` 上设置
  `android:enableOnBackInvokedCallback="true"`。
- **键盘。** `NshView` 会自行滚动，让获得焦点的输入框不被键盘遮挡。请不要设置 `android:windowSoftInputMode`，或使用
  `adjustResize`；若使用 `adjustPan`，系统会改为平移整个窗口。
- **安全区域。** 视图只把与它重叠的系统栏和键盘部分作为 insets 上报，所以位于工具栏下方的 `NshView` 不会有顶部
  inset。如需全面屏（edge-to-edge）内容，请在系统栏后方绘制，并让应用使用 `env(safe-area-inset-*)` 内边距 / `safeAreaInsets()`（Rust 中是 `safe_area()`）。
- **配置变更。** 旋转屏幕或切换主题时，Activity 被重建会销毁该视图，应用随之从头启动。若要让它保持运行，请声明由
  Activity 自行处理的配置变更；打包出的 NSH 应用使用的是：

  ```xml
  <activity android:name=".MainActivity"
      android:configChanges="orientation|screenSize|screenLayout|smallestScreenSize|keyboard|keyboardHidden|navigation|uiMode|density|fontScale|locale|layoutDirection"
      android:windowSoftInputMode="adjustResize" />
  ```

  `NshView` 会自行适应新的尺寸、配色方案、字体缩放、显示密度和布局方向，应用状态保持不变。滚动位置会按逻辑坐标恢复，并限制在新的内容范围内；吸顶视图和已打开的模态窗口也会适应新的密度。
- **生命周期。** 宿主 Activity 或 Fragment 销毁时调用 `destroy()`。

## 另请参阅

- [用 Rust 开发](./rust.md)
- [嵌入 iOS 应用](./ios.md)
- [原生组件](./native-components.md)
- [签名包](./signed-packages.md)
- [打包](./packaging.md)：无需编写任何 Java 代码即可生成独立 APK

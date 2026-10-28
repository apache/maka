---
title: Android
description: Run Rust and TSX NSH apps on Android with Android views, on an emulator or a device, package them as an .apk, and embed them in an existing Android app with nsh.aar and NshView.
order: 12
group: platforms
---

# Android

NSH apps run on Android with ordinary Android views and `StaticLayout` text, from Android 9 (API 28), on `arm64-v8a`,
`armeabi-v7a` and `x86_64`. Whole apps written in Rust and in TSX run and package as on the other platforms, and an existing app
can embed modules in an `NshView` and load signed packages it downloads, under limits and capabilities it sets. On Android, `os()` is `Os::Android` (`platform.os` is `"android"` in TSX) and TSX's
`android={{…}}` props apply.

## Requirements

- **The Android SDK** (with `platforms;android-35`, build tools and `platform-tools`) and **a JDK**, on macOS, Windows
  or Linux. See [Installation](./installation.md#android).
- An emulator, or a device connected over `adb`.

## Running an app

A Rust app runs from its directory, a TSX app names its entry:

```sh
nsh run --target android               # a Rust app
nsh run App.tsx --target android       # a TSX app
```

Start an emulator or connect a device first (`adb devices` lists them; NSH uses the first one). For a Rust app, `nsh`
builds the app's `libnsh.so` with your crate, installs the APK and starts it; a change to the crate's Rust code builds
and installs it again. For a TSX app, it installs a development host APK (rebuilt only when the runtime changes) and
forwards the dev server's port with `adb reverse`, so it works over USB without a shared network; the app updates as
you save, with logs in the terminal.

## Packaging

```sh
nsh package --target android --run             # a Rust app: .nsh/out/<Name>.apk, installed and launched
nsh package App.tsx --target android --run     # a TSX app
```

A Rust app's APK holds its own `libnsh.so`, built with your crate, whose activity mounts the root.

The APK is built with the SDK's build tools, without Gradle, and signed with the debug key unless you pass a release
keystore. Signing for release and icons: [Packaging](./packaging.md#android).

NSH builds `libnsh.so` with 16 KB ELF alignment and packages the uncompressed native libraries on 16 KB ZIP boundaries.

## Embedding in an Android app

An existing Android app can show NSH apps inside its own UI. The runtime ships as an Android library, `nsh.aar`: you
create a `com.longbridge.nsh.NshView` (a `FrameLayout`), add it to any layout and load a TSX app or a signed package
into it. An app written in Rust ships on Android as the APK `nsh package --target android` builds. The NSH app
renders with ordinary Android views next to your own.

Each `NshView` is one independent engine with its own JS VM; there are no global singletons, so several can run at
once.

<div class="diagram-scroll">
<img class="diagram diagram-light" src="/diagrams/host-app-light.svg" alt="One host app with two nsh views (NshAppView on iOS, NshView on Android): each is its own engine with its own thread, VM, limits and capabilities; the host grants capabilities, sets limits and registers native components such as a map.">
<img class="diagram diagram-dark" src="/diagrams/host-app-dark.svg" alt="One host app with two nsh views (NshAppView on iOS, NshView on Android): each is its own engine with its own thread, VM, limits and capabilities; the host grants capabilities, sets limits and registers native components such as a map.">
</div>

## Get the library

The distribution contains both variants:

```text
dist/nsh/embed/android/nsh.aar       release: bundles and signed packages
dist/nsh/embed/android/nsh-dev.aar   also connects to a `nsh dev` server
```

The AAR holds the Java runtime and `libnsh.so` for `arm64-v8a`, `armeabi-v7a` and `x86_64`. It declares the `INTERNET`
permission and needs **API 28** (Android 9) or newer.

Add it to the app module, for example from a `libs` folder:

```kotlin
// app/build.gradle.kts
dependencies {
    debugImplementation(files("libs/nsh-dev.aar"))
    releaseImplementation(files("libs/nsh.aar"))
}
```

## Ship a bundle with the app

Build the TSX app into the app's assets:

```sh
nsh build App.tsx --release --out app/src/main/assets/nsh
```

This writes `bundle.nshc` (bytecode), `bundle.js` (source), `bundle.js.map`, `capabilities.json` (when `nsh.json`
declares [capabilities](./sandbox-and-capabilities.md)) and `assets/` (the images and fonts the app imports).

## Show the app

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

In Kotlin:

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

`NshView` can also sit inside any layout, below your own toolbar for example:

```java
LinearLayout column = new LinearLayout(this);
column.setOrientation(LinearLayout.VERTICAL);
column.addView(toolbar);
column.addView(nsh, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
setContentView(column);
```

The view's size is the app's window: NSH lays the app out at the view's size and again whenever it changes. Loading
again replaces the running app. The complete sample is
`examples/embed-android/src/com/longbridge/nsh/embeddemo/MainActivity.java`.

## `NshView`

| Method | Description |
|---|---|
| `NshView(Context context)`, `NshView(Context context, boolean trace)` | Creates an empty view. `trace` logs the time of every commit. |
| `setErrorListener(ErrorListener listener)` | Receives fatal app errors (load failures, uncaught JS exceptions, a VM stopped by a limit) on the UI thread. They are always logged. |
| `setLimits(int memoryMb, int stackKb, int loadMs, int callMs, int maxNodes)` | VM limits of the apps loaded next; 0 keeps a default. |
| `setGrantedCapabilities(String json)` | The most the apps loaded next may do, as JSON in the form of `nsh.json`'s `capabilities`; `null` grants what each app declares. Returns `false` (and is ignored) for an invalid grant. |
| `setLocale(Locale locale)` | The app's language and region in place of the user's: `Intl`, `locale()` and the components follow it at once, and the apps loaded later start in it. `null` follows the system's. |
| `setFontScale(float scale)` | The text size in place of the system's font size (1 is the default): texts and inputs are laid out again at it and `fontScale()` reads it, at once and for the apps loaded later; lengths keep their size. `0` follows the system's. |
| `setThemeOverrides(String json)` | The host's brand over the app's [theme](./tailwind.md#theme-tokens): a theme file in the format of `nsh.json`'s `"theme"`. Its tokens win over the app's of the same names, in light and dark mode, and the app's others stay. Applies at once and to the apps loaded later; `null` gives the app its own theme back. Throws `IllegalArgumentException` for a file that does not parse. |
| `setStorageDirectory(File dir)` | Where the apps loaded next keep their [storage](../modules/nsh.md#storage); `null`: `files/nsh/<app id>` in the app's private directory, by the app's own id. |
| `setCacheOptions(NshCacheOptions options)` | Where the apps loaded next keep their caches, the [images they download](./images-and-assets.md#kept-on-disk), and how much each keeps. Build one with `NshCacheOptions.builder()`: `location(File)`, `systemLocation()` (the default: `nsh` in the cache directory, each app in `<app id>`) or `noDiskCache()`; `imagesMaxMegabytes(int)` (256 by default) or `imagesOff()`. |
| `loadAssetBundle(String dir)` | Runs `dir/bundle.nshc` from the APK's assets; app assets come from `dir/assets/`. Returns `false` if it cannot be read (also reported to the error listener). |
| `loadBundleFile(File file)` | Runs a `bundle.js` file; assets come from `assets/` next to it. Refuses `.nshc` files. |
| `runPackage(NshPackage pkg)` | Runs a verified signed package, replacing the running app. A package runs once. |
| `registerComponent(String name, NshComponent.Factory factory)` | Registers a [native component](./native-components.md). |
| `setParams(Object params)` | The launch parameters of the apps loaded next (a `Map` or `JSONObject`): the app reads them at start as `host.params` ([`host`](../modules/nsh.md#host)). Returns `false` when they are not a JSON object. |
| `send(String name, Object data)` | Sends an event to the app (`host.on(name, …)`); kept until it listens, or for the next app while none runs. Any thread; returns `false` after `destroy()`. |
| `handle(String name, HostHandler handler)` | Handles the app's calls (`host.call`) and posts (`host.post`) of `name` on the UI thread; `null` removes the handler. The handler answers through its `NshHostReply`, once, from any thread. |
| `connectDevServer(String url)` | Development: loads from a `nsh dev` server and reloads on every change. Returns `false` with the release AAR. |
| `handleBack()` | Lets the app handle a back press (closes dialogs, pops pages, runs `BackHandler` listeners); returns whether it did. |
| `destroy()` | Stops the app and calls `destroy()` on each of its native components. The view can no longer be used. |

> [!IMPORTANT]
> Compiled bytecode (`.nshc`) only loads from the APK's own assets or from a signed package. Files on storage can be replaced,
> and QuickJS does not validate bytecode, so `loadBundleFile` takes JS source only. Code the app downloads should come
> as a [signed package](./signed-packages.md).

`setLimits`, `setGrantedCapabilities`, `setStorageDirectory` and `setCacheOptions` apply from the next load: call them before `loadAssetBundle` and friends.

Each app keeps its storage under its own id with no setting: a signed package under the id its release key's certificate vouches for, a bundle under the `id` of its `nsh.json` (`nsh/app.json` among the APK's assets, written by `nsh package`). Call `setStorageDirectory` to keep an app's data somewhere of the host's choosing:

```java
nsh.setStorageDirectory(new File(getFilesDir(), "nsh/com.example.orders"));
nsh.loadAssetBundle("orders");
```

## Talking to the app

The view and the app it runs talk through a channel of their own ([`host`](../modules/nsh.md#host)): launch
parameters the app reads at start, events from the host app, and calls and posts from the app, with JSON data (maps,
lists, strings, numbers and booleans on this side). It needs no view in the app and no native component.

```java
// Before loading: what the app opens first (`host.params` in TSX).
nsh.setParams(Map.of("conversation", intent.getStringExtra("conversation")));
nsh.loadAssetBundle("nsh");

// The app's `await host.call("user.profile", { id })`, on the UI thread.
nsh.handle("user.profile", (data, reply) -> {
    Object id = ((Map<?, ?>) data).get("id");
    api.profile(id, profile -> reply.resolve(Map.of("id", id, "name", profile.name)),
            error -> reply.reject(error.getMessage()));
});

// The app's `host.post("analytics", …)`: no answer.
nsh.handle("analytics", (data, reply) -> analytics.log(data));

// Later: the app hears `host.on("conversation.open", …)`.
nsh.send("conversation.open", Map.of("id", tappedConversation));
```

In Kotlin:

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

Handlers run on the UI thread; a call waits for its answer in the app without blocking either side. A reply that is
never given fails the call once it is collected, and a call of a name with no handler fails at once. Events of names
the app does not listen to yet are kept until it does, and events sent while no app runs (before `loadAssetBundle`,
during a reload) go to the next one.
## Theme overrides

One app embedded in several branded host apps takes each host's brand: the host gives the tokens its brand changes,
as a theme file in the format of `nsh.json`'s `"theme"` (shadcn/ui's `cssVars`, values as CSS writes them). They win
over the app's tokens of the same names; the app's other tokens stay. Give a token its dark-mode value under `dark`
(one set only under `light` or `theme` is that color in both modes):

```java
nsh.setThemeOverrides("{ \"cssVars\": {"
        + " \"theme\": { \"radius\": \"0.75rem\" },"
        + " \"light\": { \"primary\": \"#e11d48\", \"primary-foreground\": \"#ffffff\" },"
        + " \"dark\": { \"primary\": \"#fb7185\", \"primary-foreground\": \"#1c1917\" } } }");
nsh.loadAssetBundle("orders");
```

Call it before or after loading: classes such as `bg-primary` and `rounded-(--radius)` restyle at once, and every app
loaded later starts with the overrides in its first frame. `setThemeOverrides(null)` gives the app its own theme back.

## Links the app opens

The URLs the app opens ([`openUrl`](../modules/nsh.md#openurl), a `TextView`'s links with `links="open"`)
reach the view's `OpenUrlHandler` first, on the UI thread: return `true` when the host app handled the URL, such as by
routing it through its own router, and `false` for the system to open it with an `ACTION_VIEW` intent. Without a
handler the system opens every URL. URLs reach it after the app's `openUrl` capability allowed them.

```java
nsh.setOpenUrlHandler(url -> {
    Uri uri = Uri.parse(url);
    // The host app's own links open in the host app.
    if ("lb".equals(uri.getScheme()) || "longbridge.com".equals(uri.getHost())) {
        router.open(uri);
        return true;
    }
    return false;
});
```

## Limits

```java
// 128 MB heap, default stack, 10 s to load, 1 s per call, 50 000 nodes
nsh.setLimits(128, 0, 10_000, 1_000, 50_000);
```

The defaults are a 256 MB heap, a 4096 KB stack, 10 s to load, 2 s per call and 200 000 nodes. What each limit does
when it is hit: [Sandbox and capabilities](./sandbox-and-capabilities.md).

## Capabilities

```java
nsh.setGrantedCapabilities(
    "{\"network\": {\"hosts\": [\"api.example.com\"]}, \"webview\": {\"hosts\": [\"help.example.com\"]}}");
nsh.loadAssetBundle("nsh");
```

A request must be allowed both by what the app declares in its `nsh.json` and by the grant. See
[Sandbox and capabilities](./sandbox-and-capabilities.md).

## Signed packages

Verify downloaded packages off the UI thread, then run them on it:

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

| API | Description |
|---|---|
| `new NshTrust(File stateDir)` | Opens or creates the trust store. Its state (newest revocation list, highest build accepted per app) persists there and packages' assets are extracted under it. Trusts no key until `addRoot`. Usable from any thread; `close()` when done. |
| `boolean addRoot(String publicKey)` | Trusts a root public key (base64, the contents of a `.pub` file). `false` for an invalid key. |
| `boolean updateRevocations(String json)` | Applies a revocation list from `nsh revoke`, signed by a trusted root and newer than the store's. |
| `NshPackage openPackage(File file) throws NshPackage.RefusedException` | Verifies, extracts the assets and accepts the package (older builds of the app are refused from then on). Slow for large packages: call it off the UI thread. |
| `NshPackage` | `appId`, `appName`, `version`, `build`; `close()` if it will not run. |

How keys, certificates and revocation work: [Signed packages](./signed-packages.md).

## Development

With `nsh-dev.aar`:

```java
if (BuildConfig.DEBUG) {
    nsh.connectDevServer("ws://127.0.0.1:8790/ws");
} else {
    nsh.loadAssetBundle("nsh");
}
```

Run `nsh dev App.tsx` on your computer. For an emulator or a USB device, forward the port so the device's own
`127.0.0.1` reaches the server:

```sh
adb reverse tcp:8790 tcp:8790
```

Otherwise use the LAN address `nsh dev` prints. Assets come from the dev server over plain HTTP, so `nsh-dev.aar`
declares `android:usesCleartextTraffic="true"`, which the manifest merger applies to the app (a network security
config of the app may override it). The release `nsh.aar` does not.

## Activity setup

- **Back button.** `NshView` gets back presses by itself while the app wants them (an open dialog, a pushed page, a
  `BackHandler` listener), and leaves them to the activity otherwise. With `android:enableOnBackInvokedCallback="true"`
  on Android 13 and newer it registers an `OnBackInvokedCallback`; elsewhere (Android 12 and older, or the attribute
  off) it takes the back key before the activity's `onBackPressed`, so before AndroidX's `OnBackPressedDispatcher`
  and the fragments' callbacks. No forwarding is needed, in an activity or a fragment. A host that already forwards
  presses to `handleBack()` keeps working: a press goes to the app once.

  For predictive back on Android 13+, set `android:enableOnBackInvokedCallback="true"` on the `<application>`, as
  packaged NSH apps do.
- **Keyboard.** `NshView` scrolls focused inputs clear of the keyboard itself. Leave `android:windowSoftInputMode` unset
  or use `adjustResize`; with `adjustPan` the system moves the whole window instead.
- **Safe area.** The view reports as insets only the parts of the system bars and the keyboard that overlap it, so an
  `NshView` below a toolbar gets no top inset. For edge-to-edge content, draw behind the system bars and let the app use
  `env(safe-area-inset-*)` padding / `safeAreaInsets()` (`safe_area()` in Rust).
- **Configuration changes.** An activity recreated on rotation or a theme change destroys the view, and the app starts
  again from scratch. To keep it running, declare the changes the activity handles itself; packaged NSH apps use:

  ```xml
  <activity android:name=".MainActivity"
      android:configChanges="orientation|screenSize|screenLayout|smallestScreenSize|keyboard|keyboardHidden|navigation|uiMode|density|fontScale|locale|layoutDirection"
      android:windowSoftInputMode="adjustResize" />
  ```

  `NshView` follows the new size, color scheme, font scale, display density and layout direction itself; the app keeps
  its state. Scroll positions are restored in logical coordinates within the new content bounds. Sticky views and
  open modal windows follow the new density too.
- **Lifecycle.** Call `destroy()` when the hosting activity or fragment goes away.

## See also

- [Building with Rust](./rust.md)
- [Embedding in iOS apps](./ios.md)
- [Native components](./native-components.md)
- [Signed packages](./signed-packages.md)
- [Packaging](./packaging.md): a standalone APK without writing any Java

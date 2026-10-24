# Embedding NSH in an Android app

`MainActivity.java` is an existing Android app that shows a NSH app below
its own native views.

1. Add `dist/nsh/embed/android/nsh.aar` (or `nsh-dev.aar` for development
   builds) to the app, e.g. in Gradle: `implementation(files("libs/nsh.aar"))`.
2. Build the NSH bundle into the app's assets:
   `nsh build ../embedded --release --out app/src/main/assets/nsh`.
3. Create a `com.longbridge.nsh.NshView`, add it to a layout and call
   `loadAssetBundle("nsh")`. Call `destroy()` when the activity goes away.

Native components: the app's own views, used from JS with `nativeComponent` (`nsh/native`).
`MainActivity` registers `embed.badge`, which `examples/embedded` shows:

```java
nsh.registerComponent("embed.badge", context -> new Badge(this, context));  // Badge implements NshComponent
```

The component gets its props (`setProp`, JSON as maps and lists) and commands, emits events with
`context.emit("tap", data)` and may report its size (dp) with `context.setSize(w, h)`.

The app and its host also talk without a view, through the view's channel (`nsh/host` in the app):

```java
nsh.setParams(Map.of("user", "Ada"));                               // host.params, read when the app starts
nsh.handle("time", (data, reply) -> reply.resolve(Map.of("time", now())));  // `await host.call("time")`
nsh.handle("tapped", (data, reply) -> log(data));                  // hears `host.post("tapped", …)`
nsh.send("message", Map.of("text", "Hello"));                      // `host.on("message", …)` in the app
```

Handlers run on the UI thread and answer once, now or later from any thread (`reply.resolve`, `reply.reject`).

Theme overrides: "Brand" puts the host's brand over the app's theme. The tokens of a theme file
(`nsh.json`'s `"theme"` format) win over the app's of the same names, light and dark, and
classes such as `bg-primary` restyle at once; `null` gives the app its own theme back:

```java
nsh.setThemeOverrides("{ \"cssVars\": { \"light\": { \"primary\": \"#e11d48\" } } }");
```

Signed packages (`nsh publish`; see `docs/dev/signed-packages.md`), e.g. updates the app
downloads: verify off the UI thread, then run on it.

```java
NshTrust trust = new NshTrust(new File(getFilesDir(), "nsh"));
trust.addRoot(rootPublicKey);                    // root.pub from `nsh keygen`
NshPackage pkg = trust.openPackage(downloaded);  // throws NshPackage.RefusedException
runOnUiThread(() -> nsh.runPackage(pkg));
```

`loadBundleFile` only takes JS source (`bundle.js`): bytecode loads from the APK's assets or a
signed package.

With `nsh-dev.aar`, `connectDevServer("ws://<mac ip>:8790/ws")` loads from
`nsh dev` instead and reloads on every change (for an emulator, run
`adb reverse tcp:8790 tcp:8790` and use `ws://127.0.0.1:8790/ws`). Assets then
come from the dev server over plain HTTP, so `nsh-dev.aar` declares
`android:usesCleartextTraffic="true"`, which the manifest merger applies to
the app; a network security config of the app may override it.

Keyboard: `NshView` scrolls focused inputs clear of the keyboard itself.
Leave `android:windowSoftInputMode` unset or use `adjustResize`; with
`adjustPan` the system moves the whole window instead.

The view reports the safe area and keyboard as the parts of the system bars
and the keyboard that overlap it, so an app embedded below other views gets
no top inset.

`NshView` needs the `INTERNET` permission (declared by the AAR) and API 28+.

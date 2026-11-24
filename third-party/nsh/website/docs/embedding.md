---
title: Embedding in an existing app
description: "Show an NSH app in part of an existing iOS, Android, macOS, Windows, Linux or GPUI app: which host view to use, whether it runs TSX or a Rust root, and the steps for each platform."
order: 10.5
group: platforms
---

# Embedding in an existing app

An existing native app can show an NSH app in part of its own UI: one screen, one tab, a card under a native toolbar.
The host adds one view, sizes it like any of its own views and loads an app into it. The NSH app lays itself out at the
view's size, renders with the platform's own views next to the host's, and stops when the view goes away. Each view is
an independent engine, so a host can show several at once.

## Choose the route

What the view runs depends on the language the host is written in, not on the platform:

| Host | Host view | Runs | Ships as |
|---|---|---|---|
| iOS app in Swift / Objective-C | `NshAppView` (a `UIView`) | TSX bundles, signed packages | `NativeShell.xcframework` |
| iOS app that links Rust | `AppView` (a `UIView`) | a Rust root, TSX bundles | the `nsh-platform-ios` crate |
| Android app in Java / Kotlin | `NshView` (a `FrameLayout`) | TSX bundles, signed packages | `nsh.aar` |
| macOS app in Rust (AppKit) | `AppView` (an `NSView`) | a Rust root, TSX bundles | the `nsh-platform-macos` crate |
| Windows app in Rust (Win32) | `AppView` (a child window) | a Rust root, TSX bundles | the `nsh-platform-windows` crate |
| Linux app in Rust (GTK 4) | `AppView` (a GTK widget) | a Rust root, TSX bundles | the `nsh-platform-linux` crate |
| GPUI app | `AppView` (a GPUI view) | a Rust root, TSX bundles, signed packages | the `nsh-platform-gpui` crate |

So:

- **A Swift or Java/Kotlin host loads TSX.** Write the embedded part in TSX, build it with `nsh build` and load the
  bundle into `NshAppView` or `NshView`; a signed package (`nsh publish`) can update it without an app release.
- **A host with Rust code can mount a Rust root**, the root component of your crate, with no JavaScript VM, and can load
  TSX bundles into the same `AppView`.
- The desktop `AppView`s are Rust APIs. A desktop app written in Swift, C# or C++ has no host view of its own yet.

## Mobile

### iOS with Swift

1. Get `NativeShell.xcframework` (release) and `NativeShellDev.xcframework` (connects to `nsh dev`) from
   `dist/nsh/embed/ios`, or build them from a checkout with `cargo xtask ios-embed`
   ([Get the framework](./ios.md#get-the-framework)).
2. Add the framework to the app target, `Do Not Embed` for the default static build; link the Dev framework in Debug
   only ([Add it to an Xcode project](./ios.md#add-it-to-an-xcode-project)).
3. Build the NSH app into a folder reference of the app:

   ```sh
   nsh build App.tsx --release --out MyApp/nsh
   ```

4. Add an `NshAppView` where the NSH part goes and load the bundle:

   ```swift
   import NativeShell
   import UIKit

   final class EmbedController: UIViewController {
       private let app = NshAppView()

       override func viewDidLoad() {
           super.viewDidLoad()
           app.translatesAutoresizingMaskIntoConstraints = false
           app.onError = { message in print("nsh error: \(message)") }
           view.addSubview(app)
           NSLayoutConstraint.activate([
               app.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
               app.leadingAnchor.constraint(equalTo: view.leadingAnchor),
               app.trailingAnchor.constraint(equalTo: view.trailingAnchor),
               app.bottomAnchor.constraint(equalTo: view.bottomAnchor),
           ])
           guard let url = Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh") else { return }
           try? app.loadBundle(at: url)
       }
   }
   ```

The constraints decide the area: pin the view to part of the screen and the NSH app fills only that part. The complete
sample is `examples/embed-ios`; [iOS](./ios.md#nshappview) lists the view's members.

### iOS with Rust

An iOS app that already links Rust shows your crate's root in `nsh_platform_ios::AppView`:

```rust
use nsh_platform_ios::{set_ui_sets, AppView, Root, SurfaceOptions};
use objc2::MainThreadMarker;
use objc2_ui_kit::UIView;

fn show(container: &UIView) -> AppView {
    set_ui_sets(vec![nsh_base::registry(), my_app::registry()]);
    let mtm = MainThreadMarker::new().expect("main thread");
    let app = AppView::new(mtm, container.bounds(), SurfaceOptions::default());
    container.addSubview(app.view());
    app.run(Root::of::<my_app::App>());
    app // keep it: dropping it stops the app
}
```

The view fills `container` and resizes with it, so the container decides the area. Swift calls this through a C
function your crate exports. `AppView::load` runs a TSX bundle in the same view instead
([Embedding a Rust app](./ios.md#embedding-a-rust-app)).

### Android

1. Add `nsh.aar` (release) and `nsh-dev.aar` (connects to `nsh dev`) from `dist/nsh/embed/android` to the app module,
   or build them from a checkout with `cargo xtask android-embed`
   ([Get the library](./android.md#get-the-library)):

   ```kotlin
   dependencies {
       debugImplementation(files("libs/nsh-dev.aar"))
       releaseImplementation(files("libs/nsh.aar"))
   }
   ```

2. Build the NSH app into the app's assets:

   ```sh
   nsh build App.tsx --release --out app/src/main/assets/nsh
   ```

3. Put an `NshView` in any layout and load the bundle:

   ```kotlin
   class MainActivity : Activity() {
       private lateinit var nsh: NshView

       override fun onCreate(state: Bundle?) {
           super.onCreate(state)
           nsh = NshView(this)
           nsh.setErrorListener { message -> Log.e("nsh", message) }
           val column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
           column.addView(toolbar)
           column.addView(nsh, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
           setContentView(column)
           nsh.loadAssetBundle("nsh")
       }

       override fun onDestroy() {
           nsh.destroy()
           super.onDestroy()
       }
   }
   ```

The layout parameters decide the area. The complete sample is `examples/embed-android`; [Android](./android.md#nshview)
lists the view's methods. The AAR runs TSX; a Rust app ships on Android as the APK `nsh package --target android`
builds.

## Desktop

On macOS, Windows and Linux the host is a Rust app that depends on the platform crate from the NSH repository. In each,
call `set_ui_sets` once, create an `AppView`, put its native view where the NSH part goes and load a root or a bundle.

### macOS (AppKit)

```rust
use nsh_platform_macos::{objc2::MainThreadMarker, set_ui_sets, AppOptions, AppView, Root};

set_ui_sets(vec![nsh_base::registry(), my_app::registry()]);
let view = AppView::new(MainThreadMarker::new().unwrap(), AppOptions::default());
view.load(Root::of::<my_app::App>().into());
split_view.addArrangedSubview(&view.view()); // any NSView container
```

`view.view()` is an `NSView`: add it to any container or set it as a window's content view
([Embedding in a Mac app](./macos.md#embedding-in-a-mac-app)).

### Windows (Win32)

```rust
use nsh_platform_windows::{set_ui_sets, AppOptions, AppView, Root};

unsafe { OleInitialize(None)? }; // once per UI thread
set_ui_sets(vec![nsh_base::registry(), my_app::registry()]);
let view = AppView::new(Some(parent_hwnd), AppOptions::default())?;
view.load(Root::of::<my_app::App>().into());
// On WM_SIZE of the parent, place it: MoveWindow(view.hwnd(), x, y, width, height, true)
```

The view is a child window of `parent_hwnd`; its position and size are the area
([Embedding in a Win32 app](./windows.md#embedding-in-a-win32-app)).

### Linux (GTK 4)

```rust
use nsh_platform_linux::{set_ui_sets, AppOptions, AppView, Root};

set_ui_sets(vec![nsh_base::registry(), my_app::registry()]);
let view = AppView::new(AppOptions::default());
view.load(Root::of::<my_app::App>().into());
paned.set_end_child(Some(&view.widget())); // any GTK container
```

`view.widget()` is a GTK widget; stop the view when its window closes
([Embedding in a GTK app](./linux.md#embedding-in-a-gtk-app)).

### GPUI

A GPUI or GPUI Kit app adds `nsh-platform-gpui`'s `AppView` as a GPUI view, and can also load signed packages
([Embedding in a GPUI app](./gpui.md#embedding-in-a-gpui-app)).

### TSX on the desktop

Every desktop `AppView` also loads a TSX bundle that `nsh build` wrote, with `asset_base` pointing at its `assets`
directory:

```rust
let view = AppView::new(/* … */ AppOptions {
    asset_base: Some(AssetBase::Directory("app/assets".into())),
    ..AppOptions::default()
});
view.load(Bundle::source(std::fs::read_to_string("app/bundle.js")?).into());
```

## Working with the host

The same features are on every host view:

- **Talk to the app**: launch parameters, calls and events between host and app through `nsh/host`
  ([iOS](./ios.md#talking-to-the-app), [Android](./android.md#talking-to-the-app)).
- **Native components**: the host registers its own views (a map, a chart) for the app to use
  ([Native components](./native-components.md)).
- **Theme**: the host gives its brand tokens over the app's theme ([iOS](./ios.md#theme-overrides),
  [Android](./android.md#theme-overrides)); locale and font scale follow the host's settings
  ([Device and environment](./device-and-environment.md#in-an-embedding-app)).
- **Limits and capabilities**: what each view's app may use ([Sandbox and capabilities](./sandbox-and-capabilities.md)).
- **Updates**: Swift, Java/Kotlin and GPUI hosts load [signed packages](./signed-packages.md) they download.
- **Development**: the Dev framework and AAR connect to `nsh dev` for hot updates ([iOS](./ios.md#development),
  [Android](./android.md#development)).

## See also

- [Platform overview](./platforms.md#embed-in-a-native-app)
- [iOS](./ios.md), [Android](./android.md), [macOS](./macos.md), [Windows](./windows.md), [Linux](./linux.md),
  [GPUI](./gpui.md)

---
title: Platform-specific code
description: Writing one app for phones, desktops and browsers - platform-only props in ios={{}} / android={{}} / desktop={{}} / web={{}}, the nsh/ios and nsh/android modules, platform.os and platform.select, and platform Tailwind variants.
order: 17
group: platforms
---

# Platform-specific code

One NSH bundle runs on iOS, Android, macOS, Windows and Linux (and in Mac Catalyst), and in browsers through the [web runtime](./web.md). Most of an app needs no platform checks at all: elements, styles, layout and modules behave the same everywhere, and the components you draw from them look the same everywhere. When something really is specific to one platform, NSH gives it a clear place, so platform code stays visible and contained:

| Rust | TSX | For |
|---|---|---|
| [Builder methods (`.ripple(..)`, `.input_accessory(..)`)](#platform-only-props) | [`ios={{…}}`, `android={{…}}`, `desktop={{…}}`, `web={{…}}`](#platform-only-props) | Props only one platform has. |
| [`toast`, `on_back_press`, `nsh_core::ui::desktop`](#platform-modules) | [`nsh/ios`, `nsh/android`, `nsh/desktop`](#platform-modules) | APIs only one platform has. |
| [`os()`, `idiom()`, `is_desktop()`](#platformos-and-platformselect) | [`platform.os`, `platform.select`](#platformos-and-platformselect) | Choosing values or code per platform. |
| [`.when(os() == Os::Ios, ..)`](#platform-variants-in-tailwind) | [`ios:` / `android:` / `web:` classes](#platform-variants-in-tailwind) | Styles per platform. |

## Platform-only props

In Rust, a prop one platform has is a builder method like any other (`.ripple(..)`, `.elevation(..)` for Android, `.input_accessory(..)` for iOS, `.window_drag(..)` for the desktops); the other platforms leave it aside. In TSX, props that exist on one platform only are grouped in an object named after it. Each element accepts `ios`, `android`, `desktop` (macOS, Windows, Linux, and browsers in the desktop idiom) and `web` (browsers); on other platforms the object is ignored, and on its own platform only its keys are applied. A desktop browser applies both `desktop` and `web`.

```rust tabs
use nsh_base::dialog;
use nsh_core::{
    Ripple,
    ui::{AutoFill, Orientation, prelude::*},
};

view()
    .on_press(open)
    .active(|s| s.opacity(0.6))
    .ripple(Ripple {
        color: Some(rgba(0x0000001f).into()),
        ..Ripple::default()
    })
    .elevation(px(4.0))
    .p_4()
    .rounded(px(12.0))
    .bg(white())
    .child(text("Open"))

input().placeholder("Code").auto_fill(AutoFill::OneTimeCode)

when(shown, || {
    dialog()
        .supported_orientations([Orientation::Portrait])
        .status_bar_translucent(true)
        .child(…)
})
```

```tsx tabs
<View
  onPress={open}
  activeStyle={{ opacity: 0.6 }}
  android={{ ripple: { color: "rgba(0,0,0,0.12)" }, elevation: 4 }}
  style={{ padding: 16, borderRadius: 12, backgroundColor: "#ffffff" }}
>
  <Text>Open</Text>
</View>

<Input
  placeholder="Code"
  ios={{ textContentType: "oneTimeCode" }}
/>

<Dialog open={open()} ios={{ supportedOrientations: ["portrait"] }} android={{ statusBarTranslucent: true }}>
  …
</Dialog>
```

The TSX objects are reactive like any prop; a key removed from the object is cleared.

What exists today:

| Rust | TSX | On | Description |
|---|---|---|---|
| `.ripple(Ripple { .. })` | `android={{ ripple }}` | every element | The material ripple while pressed: color, borderless, radius, foreground. |
| `.elevation(..)` | `android={{ elevation }}` | every element | The material shadow, in points, from the view's shape. |
| | `android={{ accessibilityLiveRegion }}` | every element | `"none"`, `"polite"` or `"assertive"`: TalkBack announces the view's changes. |
| `.status_bar_translucent(..)` | `android={{ statusBarTranslucent }}` | `Dialog` | The dialog's content reaches under the status bar. |
| `.input_accessory(..)` | `ios={{ inputAccessoryViewID }}` | `Input` | The `InputAccessoryView` shown over the keyboard. |
| `.auto_fill(..)` | `ios={{ textContentType }}` | `Input` | iOS's names for autofill types (Rust's `AutoFill` covers both platforms). |
| `.supported_orientations(..)` | `ios={{ supportedOrientations }}` | `Dialog` | The orientations it allows. |
| `.back_forward_gestures(..)` | `ios={{ allowsBackForwardNavigationGestures }}` | `WebView` | Swipe back and forward in the page history. |
| `.header_right_system_item(..)` | `ios={{ headerRightSystemItem }}` | `NavPage` | UIKit's own bar button at the end of the header, pressing `headerRight`. |
| `.back_forward_gestures(..)` | `desktop={{ allowsBackForwardNavigationGestures }}` | `WebView` | macOS: two-finger trackpad swipes go back and forward in the page history; Windows: touchscreen swipes; Linux: touchpad swipes. |
| `.window_drag(..)` | `desktop={{ windowDrag }}` | every element | Pressing it drags the window, as the system's title bar would (see [nsh/desktop](../modules/nsh-desktop.md#a-title-bar-of-your-own)). |

In TSX, `desktop={{…}}` and `web={{…}}` are accepted everywhere. The types (`IOSProps`, `AndroidProps`, `DesktopProps` and their per-element forms) tell your editor what each element takes.

Something two or more platforms do is a top-level prop (in Rust a method of the same name), applied where it means something: `NavPage`'s `title`, `headerStyle`, `headerLargeTitle` and `headerBackTitle` set up the system header of iOS and Android, its `header` slot is the header of the desktops and the web, and `Dialog`'s `presentation` picks iOS's sheets. `AlertDialog.show`'s `closeOnBackdropPress`, `pagingEnabled`, `refreshing`, `hitSlop` and the rest work on every platform.

## Platform modules

In Rust, the APIs only one platform has are functions of `nsh_core::ui::prelude` (`toast`, `on_back_press`, `input_accessory_view`) and of `nsh_core::ui::desktop` (`set_title_bar`, `title_bar`, `close_window`); elsewhere they do nothing. In TSX, `nsh/ios` and `nsh/android` hold the APIs only one platform has, `nsh/desktop` those only desktops have. All can be imported on every platform, so one bundle runs everywhere: elsewhere their functions do nothing and their components render nothing. Each exports `isAvailable`, which is `true` only on its own platforms.

### nsh/android

| Rust | TSX | Description |
|---|---|---|
| `toast(message, ToastDuration::Short)` | `Toast.show(message, duration?)` | A toast at the bottom of the screen; `"short"` (default) or `"long"`. |
| `on_back_press(listener)` | `BackHandler.onBackPress(listener)` | Listens to the back button after dialogs, before stacks; return `true` when handled. The listener goes with the component (or effect) that added it; in TSX the call also returns a function that stops it earlier. |
| | `BackHandler.exitApp()` | Leaves the app. |
| `os() == Os::Android` | `isAvailable` | `true` on Android. |

```rust tabs
use nsh_base::alert_dialog;
use nsh_core::ui::{Os, prelude::*};

fn saved() {
    if os() == Os::Android {
        toast("Saved", ToastDuration::Short);
    } else {
        spawn(alert_dialog().title("Saved").action("OK").show());
    }
}

fn player() -> impl IntoElement {
    let full_screen = signal(false);
    // Back leaves full screen before it leaves the page. The listener goes
    // with the view.
    on_back_press(move || {
        if !full_screen.get_untracked() {
            return false;
        }
        full_screen.set(false);
        true
    });
    // …
}
```

```tsx tabs
import { BackHandler, Toast } from "nsh/android";
import { platform } from "nsh/device";
import { AlertDialog } from "nsh/base";

function saved() {
  if (platform.os === "android") Toast.show("Saved");
  else AlertDialog.show({ title: "Saved", actions: [{ label: "OK" }] });
}

function Player() {
  // Back leaves full screen before it leaves the page. The listener goes
  // with the component.
  BackHandler.onBackPress(() => {
    if (!fullScreen()) return false;
    fullScreen.set(false);
    return true;
  });
  // …
}
```

The back button is handled by the top dialog first, then the back listeners (most recent first), then the top navigation stack, and the app exits when nothing handled it. See [Navigation](./navigation.md#the-android-back-button).

### nsh/ios

| Rust | TSX | Description |
|---|---|---|
| `input_accessory_view(native_id)` | `InputAccessoryView` | A bar over the keyboard of the inputs naming its native id (`.input_accessory(..)`, `ios={{ inputAccessoryViewID }}`). |
| `os() == Os::Ios` | `isAvailable` | `true` on iOS and Mac Catalyst. |

See [Forms and the keyboard](./forms-and-keyboard.md#a-bar-over-the-keyboard-ios-inputaccessoryview).

### nsh/desktop

Rust apps draw their own title bars with `nsh_core::ui::desktop` ([Building with Rust](./rust.md#desktop-title-bars)). TSX's module:

| Export | Description |
|---|---|
| `Window` | The window: `setTitle`, `setTitleBar("hidden")` for a title bar of the app's own, `minimize`, `toggleMaximize`, `toggleFullScreen`, `close`. |
| `titleBar` | The hidden title bar's height and the room the system's window controls take (reactive). |
| `Menu` | `setApplicationMenu(items)` (the menu bar, with shortcuts) and `popup(items, at?)` (context menus). |
| `isAvailable` | `true` on macOS, Windows and Linux. |

See [nsh/desktop](../modules/nsh-desktop.md).

### The status bar

On both platforms the status bar belongs to the page or dialog on top, as in UIKit, where the topmost view controller decides it: [`NavPage` and `Dialog` take `statusBar`](../modules/nsh-base.md#status-bar) (in Rust `.status_bar(StatusBarStyle::Light)`, or a `StatusBarSetting` for the other fields) with `foreground` (`"auto"`, `"light"` for dark backgrounds, `"dark"` for light ones), `hidden` and `animated`. The page or dialog shown most recently wins, field by field, and the one below it applies again when it goes away. `nsh.json`'s `"statusBar"` is the app's default under them.

```rust tabs
use nsh_base::nav_page;
use nsh_core::ui::prelude::*;

fn photo_viewer() -> impl IntoElement {
    nav_page()
        .header_visible(false)
        .status_bar(StatusBarStyle::Light)
        .child(view().flex_1().bg(black()))
}
```

```tsx tabs
import { View } from "nsh";
import { NavPage } from "nsh/base";

function PhotoViewer() {
  return (
    <NavPage headerVisible={false} statusBar={{ foreground: "light" }}>
      <View style={{ flex: 1, backgroundColor: "#000000" }}>…</View>
    </NavPage>
  );
}
```

In an app embedded in a native one, the host app's view controller decides the status bar on iOS. An app that declares `"capabilities"` in `nsh.json` needs `"statusBar": true` to change it.

## platform.os and platform.select

`os()` in Rust and the `platform` constant from `nsh/device` in TSX tell you where the app runs: `Os::Ios`, `Os::Android`, `Os::MacOs`, `Os::Windows`, `Os::Linux` or `Os::Web`, and `platform.os` `"ios"`, `"android"`, `"macos"`, `"windows"`, `"linux"` or `"web"` (Mac Catalyst is `"ios"`, with `platform.catalyst`; the [macOS backend](./macos.md) is `"macos"`, the [Linux backend](./linux.md) `"linux"` and the [Windows backend](./windows.md) `"windows"`, and their elements apply their `desktop` props; [browsers](./web.md) are `"web"`, and apply `desktop` props too when the idiom is `"desktop"`). See [Device and environment](./device-and-environment.md#the-platform) for the version, the idiom and the rest.

```rust tabs
use nsh_core::ui::{Os, prelude::*};

if os() == Os::Android {
    // …
}
```

```tsx tabs
import { platform } from "nsh/device";

if (platform.os === "android") {
  // …
}
```

### platform.select

In Rust a `match os()` chooses the value, with `is_desktop()` for the desktops. In TSX, `platform.select(spec)` returns the value for this platform. It looks for the OS's own key, then `mobile` (iOS, Android, phone and tablet browsers) or `desktop` (macOS, Windows, Linux, desktop browsers), then `native` (every platform but the web), then `default`:

Terminal surfaces report `platform.renderer === "terminal"` and `platform.isTerminal === true`, with the host OS in `platform.os`. They select `terminal`, then the host OS, then `native`, then `default`. Graphical desktop surfaces apply `desktop={{…}}` props.

```rust tabs
use nsh_core::ui::{Os, prelude::*};

fn card() -> View {
    let card = view().rounded(px(12.0)).bg(white());
    match os() {
        Os::Ios => card.shadow_md(),
        Os::Android => card.border_1().border_color(rgb(0xe5e7eb)),
        _ => card,
    }
}

let hint = match os() {
    Os::Ios => "Swipe down to close",
    Os::Android => "Press back to close",
    _ => "Close",
};
```

```tsx tabs
const styles = {
  card: {
    borderRadius: 12,
    backgroundColor: "#ffffff",
    ...platform.select({
      ios: { shadowColor: "#000000", shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
      android: { borderWidth: 1, borderColor: "#e5e7eb" },
    }),
  },
};

const hint = platform.select({ ios: "Swipe down to close", android: "Press back to close", default: "Close" });
```

It returns `undefined` when nothing matches and there is no `default`.

### Rendering different components

Choose components the same way, at module level (TSX) when the choice never changes:

```rust tabs
fn spinner() -> AnyElement {
    if os() == Os::Ios {
        ios_spinner().into_element()
    } else {
        material_spinner().into_element()
    }
}
```

```tsx tabs
const Spinner = platform.select({ ios: IosSpinner, default: MaterialSpinner })!;
```

or inline with [`when` / `<If>`](../elements/control-flow.md):

```rust tabs
when(os() == Os::Ios, || input_accessory_view("bar").child(…))
    .otherwise(|| text("Android has no input accessories."))
```

```tsx tabs
<If when={platform.os === "ios"} else={<Text>Android has no input accessories.</Text>}>
  <InputAccessoryView nativeID="bar">…</InputAccessoryView>
</If>
```

## Platform variants in Tailwind

Rust styles per platform with `.when(os() == Os::Ios, |v| ..)`; in TSX, the `ios:`, `android:` and `web:` variants apply classes on one platform:

```rust tabs
view()
    .rounded_xl()
    .bg(white())
    .p_4()
    .when(os() == Os::Ios, |v| v.shadow_md())
    .when(os() == Os::Android, |v| v.border_1().border_color(rgb(0xe4e4e7)))
```

```tsx tabs
<View class="rounded-xl bg-white p-4 ios:shadow-md android:border android:border-zinc-200">…</View>
<Text class="text-base android:font-medium">Title</Text>
```

## Prefer shared behavior

Before reaching for a platform check, consider whether the difference matters to your users. Elements and styles already map to each platform's native behavior where it should differ (scroll physics, text rendering, keyboards, accessibility), while staying the same where users expect consistency (your app's own look). Platform checks are best kept for platform conventions users rely on: Android's back button and toasts, iOS's sheets and large titles, autofill names, Android's ripple.

## Related

- [`nsh/ios`](../modules/nsh-ios.md) and [`nsh/android`](../modules/nsh-android.md): the references.
- [`nsh/device`](../modules/nsh-device.md): `platform`.
- [Native components](./native-components.md): using views your host app provides on each platform.
- [Tailwind](./tailwind.md): every variant.

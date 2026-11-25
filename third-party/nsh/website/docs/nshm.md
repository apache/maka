---
title: nshm
description: "nshm (NSH modules): packages of components, modules and classes that any Native Shell app installs with nsh add, as Rust crates or pure TSX; versions, the lock file, the shared installation, platform nshm, and how to write and publish one."
order: 5.7
group: start
---

# nshm

An **nshm** (NSH module) is a package that gives Native Shell apps components, modules and classes, as a crate gives Rust programs code. It comes in two kinds:

- A **Rust nshm** is a Rust crate, published on crates.io or Git. An app uses it from Rust and from TSX: the same implementation, native on every platform.
- A **TSX nshm** is TSX published as a Git repository with version tags. The app's bundle includes it, so an app that uses only TSX nshm needs no Rust, and the nshm ships with the app's packages and over-the-air updates.

[nsh-omarchy](https://github.com/huacnlee/nsh-omarchy), for example, gives an app [Omarchy](https://omarchy.org)'s look: buttons, fields, menus, dialogs, tables and charts that follow the system's Omarchy theme as it changes.

```sh
nsh add nsh-omarchy                  # from crates.io
nsh add github:huacnlee/nsh-omarchy  # or from GitHub
```

Then use it from the language the app is written in. **In a TSX app**, an nshm that exports components, modules or classes to TSX is ready to use once `nsh add` installs it: import them by its specifier, here `nsh-omarchy`. The app needs no newer NSH and no Rust code of its own, since `nsh` builds the app's hosts with the crate.

```tsx
// App.tsx
import { mount, signal, View } from "nsh";
import { Body, Button, Omarchy, Panel, Switch, Toaster, toast } from "nsh-omarchy";

function App() {
  // Draw with the system's Omarchy theme, and follow it as it changes.
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

**In a Rust app**, its components are functions of the crate:

```rust
// src/lib.rs: the app's root component
use nsh_core::prelude::*;
use nsh_omarchy::tokens;

#[component]
pub fn App() -> impl IntoElement {
    // Draw with the system's Omarchy theme, and follow it as it changes.
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

An nshm is how a feature reaches the apps that need it without being part of NSH: it ships on its own schedule, and only the apps that install it pay its size, build time and dependencies.

## Using an nshm

`nsh add` installs an nshm from crates.io, GitHub, any Git URL or a local directory:

```sh
nsh add nsh-omarchy                                             # crates.io: the newest version
nsh add github:huacnlee/nsh-omarchy                             # GitHub: the default branch, or @<tag>
nsh add https://github.com/huacnlee/nsh-omarchy.git --rev main  # any Git URL
nsh add --path ../nsh-omarchy                                   # a local directory, as it is
```

It lists the nshm in `nsh.json` `"dependencies"` by its package name, as `Cargo.toml` does: a version requirement for one from crates.io (`nsh add nsh-omarchy` writes `"^<the version it resolved to>"`, `nsh add nsh-omarchy@0.3` keeps `"0.3"`), and an object with `"github"`, `"git"` or `"path"` for one from elsewhere. A Git nshm's versions are its tags (`v1.4.0` or `1.4.0`), so it takes a version requirement too; `--tag` or `--rev` pins one tag or commit instead.

```json
{
  "dependencies": {
    "nsh-omarchy": "^0.3.2",
    "acme-ui": { "github": "acme/ui", "version": "^1.4" },
    "my-gauge": { "path": "../my-gauge" }
  }
}
```

NSH resolves one version of each nshm the app reaches, including the nshm its nshm depend on: the newest version every requirement accepts. It pins them in `nsh.lock` beside `nsh.json` (commit both with the app), and every command builds with the locked versions, so the app builds the same on every machine until you change them:

```sh
nsh upgrade                # every nshm to the newest version its requirement accepts
nsh upgrade nsh-omarchy    # only this one
nsh remove nsh-omarchy     # out of nsh.json, nsh.lock and the app's crate
```

Each version is installed once per machine, in `~/.nsh/nshms` (`NSH_HOME` moves `~/.nsh`), and every app that uses it shares that copy: `nsh-omarchy/0.3.2/` from crates.io, `github.com/acme/ui/1.4.0/` from a tag, `github.com/acme/ui/<commit>/` from a commit. A directory added with `--path` is read where it is. An app whose Rust comes from nshm only builds them once, optimized, in `~/.nsh/builds`, shared by every app with the same nshm: after the first `nsh run`, the next start skips compiling until an nshm or nsh changes. Builds no app used for 30 days are removed.

A Rust nshm is also added to the `[dependencies]` of the app's own crate when it has one, so the app's Rust uses it directly. An app whose nshm include a Rust one gets hosts built with it, as an app with a crate of its own does, so its development machine and CI need the Rust toolchain ([Building with Rust](./rust.md)). An app whose nshm are all TSX builds with `nsh` alone.

The hosts of an app whose Rust comes from nshm only are built with the nsh that runs the app: a release with its crates from crates.io, a nightly with those of its own commit, an `nsh` built in a checkout with the checkout's. `nsh-extra` is released together with nsh, so an app that asks for it by version gets the `nsh-extra` of that same nsh (an app with a crate of its own, the one of the nsh its crate uses), and `nsh.lock` records which. A version requirement that nsh's version does not meet is an error that names both. A `"path"`, `"github"` or `"git"` entry for it is used as written.

An app with a crate of its own can also depend on a Rust nshm in its `Cargo.toml` alone, as on any other crate, from crates.io, Git (a crate in a subdirectory of the repository too) or a path. `nsh` finds the Rust nshm among the crate's dependencies, direct or not, and links them as it links those of `"dependencies"`: their `#[native_module]` entries run when the app starts, with the features the crate turns on, in `nsh run`, `nsh test` and the packages alike, and TSX imports them by their specifiers. One listed in `"dependencies"` too is linked once.

A crate that holds several modules keeps each behind a Cargo feature, so an app turns on only those it uses and pays
only their size, permissions and store declarations. `--features` turns them on, and the entry takes the object form:

```sh
nsh add nsh-extra --features camera
```

```json
{
  "dependencies": { "nsh-extra": { "version": "^0.6.0", "features": ["camera"] } }
}
```

An app listing them in the older `"modules"` array still builds; the next `nsh add` rewrites it as `"dependencies"`, keeping each requirement (a bare name becomes `"*"`) and what `nsh.lock` pinned.

[CLI: nsh add](./cli.md#nsh-add) covers every source form; [nsh upgrade](./cli.md#nsh-upgrade) and [nsh remove](./cli.md#nsh-remove) the others.

## nsh-extra

`nsh-extra` holds Native Shell's official modules: features that only some apps need, each a Cargo feature of the
crate, imported from `nsh-extra` in TSX and called as `nsh_extra::<module>` in Rust.

| Feature | TSX | What it does |
|---|---|---|
| `camera` | `Camera` | Takes a photo with the system's camera on iOS and Android |
| `location` | `Location` | Reads the device's position once the user allows it, on macOS, iOS and the web |
| `photos` | `Photos` | Reads the user's recent photos on iOS, once the user allows it |
| `push` | `Push` | Receives remote notifications from any push service on iOS, and on Android through the service's binding |
| `speech` | `Speech` | Turns what the user says into text as they speak, on macOS, iOS, Android, Windows and the web |

```tsx
import { Camera } from "nsh-extra";

if (await Camera.available()) {
  // The photo comes as `Picker.pickImages` gives an image: a JPEG, upright, scaled natively.
  const photo = await Camera.takePhoto({ maxDimension: 2048 });
  if (photo) upload(photo.file);
}
```

`takePhoto` resolves with `null` when the user cancels and rejects with the code `EACCES` when the user does not let
the app use the camera. An app can close a sheet and ask for the photo in the same press: the camera shows once the
sheet has closed. `available()` is `false` where there is no camera to show (the desktops, the web, a simulator),
and there `takePhoto` rejects with `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`. The feature adds what the packaged app needs:
the camera's usage description on iOS (an app sets its own wording with `ios.infoPlist`'s
`NSCameraUsageDescription`) and the query of camera apps on Android.

### Location

`Location` reads the device's position once the user allows it: once with `current`, or each time it changes with
`watch`, shaped as the browser's `navigator.geolocation`. macOS and iOS read it with CoreLocation, the web with the
browser's `navigator.geolocation`; the system or the browser asks the user the first time the app reads it. Only while
the app is in use: there is no background location.

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
  // Later: stop(). The watch also stops when the component that started it goes.
}
```

- `available()` resolves `true` on macOS and iOS apps packaged with the feature, and in browsers with
  `navigator.geolocation`; `false` on Android, Windows, Linux, in a terminal, in headless runs, and in an Apple app
  run as a bare binary (`nsh run --target macos`), whose missing `Info.plist` the system never asks for.
- `authorization()` resolves with what the user allows now, without asking: `"notDetermined"`, `"whenInUse"`,
  `"always"`, `"denied"` or `"restricted"`. The web knows only `"whenInUse"` (granted), `"denied"` and
  `"notDetermined"` (it will ask). `requestAuthorization()` asks the user and resolves with the answer; reading asks by
  itself, so ask first only to choose the moment.
- `current({ accuracy, timeout })` resolves with a `Position` (`coords.latitude`, `longitude`, `accuracy` in metres,
  `altitude`, `altitudeAccuracy`, `heading`, `speed`, each `null` when the device does not know it, and `timestamp`
  in milliseconds since the epoch). `accuracy` is `"best"`, `"high"`, `"balanced"` (the default) or `"low"`.
- `watch(listener, onError?, { accuracy, distanceFilter })` calls `listener` with each new position and returns a
  function that stops it. `onError` gets the failure that ends the watch.
- A read fails with an `Error` whose `code` is `"EACCES"` (the user does not allow it), `"ETIMEDOUT"` (nothing came
  within `timeout`), `"ERR_POSITION_UNAVAILABLE"` (the device found no position) or
  `"ERR_FEATURE_UNAVAILABLE_ON_PLATFORM"` (no position here); options out of range throw a `RangeError`.

The feature adds `NSLocationWhenInUseUsageDescription` to the app's `Info.plist` on iOS and macOS, and the location
entitlement of a sandboxed macOS app. Rust code uses `nsh_extra::location`: `available()`, `authorization().await`,
`request_authorization().await`, `current(LocationRequest).await`, and `watch(LocationRequest)`, whose `next().await`
gives each position (dropping it stops it).

### Photos

`Photos` reads the user's photo library once the user allows it: the most recent photos, a thumbnail of each to show,
and the photo the user chooses, which arrives as `Picker.pickImages` gives an image. It serves a strip of recent photos
the user adds with one press; `Picker.pickImages` needs no permission and stays the way to choose from the whole
library.

```sh
nsh add nsh-extra --features photos
```

```tsx
import { Photos } from "nsh-extra";

if (Photos.access() === "notDetermined") await Photos.requestAccess();
const access = Photos.access();
if (access === "full" || access === "limited") {
  const recent = await Photos.recent({ limit: 20 });
  // Thumbnails are small JPEGs whose bytes stay native.
  const thumbs = await Promise.all(recent.map((photo) => Photos.thumbnail(photo.id, { maxDimension: 240 })));
  const urls = thumbs.map((thumb) => URL.createObjectURL(thumb.file));
  // On a press: the photo, prepared as a picked one.
  const photo = await Photos.load(recent[0].id, { maxDimension: 2048 });
  upload(photo.file);
}

// A photo taken, removed, or a selection changed: read the strip again.
Photos.on("change", () => refreshStrip());
```

- `access()` tells what the user allows, without asking: `"full"`, `"limited"` (the photos the user selected),
  `"notDetermined"`, `"denied"` or `"unavailable"`. `requestAccess()` asks the user the first time and resolves with
  the answer; after that only the system's settings change it.
- `recent({ limit })` resolves with the newest images first (30 when not given, at most 1000), without the hidden
  ones, each with its `id` and its `size`. `thumbnail(id, { maxDimension })` resolves with an upright JPEG of at most
  `maxDimension` pixels (256 by default), `load(id, { maxDimension, quality })` with the photo as `Picker.pickImages`
  prepares a picked one. A photo stored only in iCloud is downloaded. They reject with `EACCES` without access and
  with `ENOENT` for a photo that is not there.
- With limited access, `presentLimitedPicker()` shows the system's sheet where the user changes the selection, and
  resolves with the `id`s the user selected.
- `on("change")` reports that the library changed, once the user allows reading it.
- On Android, the desktops and the web `access()` is `"unavailable"` and the reads reject with
  `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`. Android lets only apps whose core purpose is photos read the whole library
  (Google Play's policy on `READ_MEDIA_IMAGES`); other apps use the system's Photo Picker, which `Picker.pickImages`
  shows.
- An app that declares `"capabilities"` grants `Photos` with [`"picker": true`](./sandbox-and-capabilities.md#picker),
  the capability `Picker` uses: every function but `access()` asks for it first.

The feature adds the library's usage description to the packaged iOS app (an app sets its own wording with
`ios.infoPlist`'s `NSPhotoLibraryUsageDescription`). Rust code uses `nsh_extra::photos`, and a `PhotosBackend` set with
`set_backend` answers in place of the system's library (an embedding app's own, or a test's).

#### The embedded picker

`PhotosPicker` puts the system's photo picker in the app's layout: on iOS 17 and later, a row of the library the user
selects photos in and deselects them again, as mainstream chat apps show above their attachment options. The system runs
it outside the app, so it needs no access to the library: the app gets only what the user selects.

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
  <Button onPress={() => Picker.pickImages({ multiple: true, limit: 10 })}>Photos</Button>
)}

// When the message is sent: each photo, prepared as a picked one.
const photos = await Promise.all(selected().map((id) => Photos.loadPicked(id, { maxDimension: 2048 })));
// The attachment's remove button deselects it in the picker too.
picker?.deselect(id);
```

- `onChange` hands over the ids of every photo selected now, each time the user selects or deselects one, in the order the
  user selected them; the picker shows each photo's number in that order. The ids are opaque; the photos' bytes stay native until `loadPicked(id, options)` reads one, with `load`'s options. An id reads
  while its photo is selected and its picker shown; after that it rejects with `ENOENT`.
- `selectionLimit` caps the selection (100 by default, as `Picker.pickImages`; 0 lets the user select as many as the
  system allows), and `filter` shows `"images"` (default), `"livePhotos"` or `"screenshots"`.
- The style sizes it: give it a height, and round it with `borderRadius` and `overflow: "hidden"`.
- Where `pickerViewAvailable()` is `false` (iOS 16 and earlier, Android, the desktops, the web) it takes no room and
  shows nothing; the app lets the user choose with `Picker.pickImages`. Android's photo picker embeds only with a
  system extension recent devices have, which Native Shell does not use yet.
- `loadPicked` needs the `picker` capability, as the rest of `Photos` does.

Rust code makes it with `photos_picker()` (`.selection_limit(10).on_change(..)`), deselects through a
`component_ref::<PhotosPicker>()`'s `PhotosPickerApi`, and reads with `nsh_extra::photos::load_picked`.

### Push

`Push` registers the device with a push service and hands the app its token, which the app sends to its server.
Notifications then arrive as events. On iOS the service is the system's; Android has none that every device has, so
there the app links a push service's binding, a crate built on `nsh_extra::push` that wraps the service's SDK:

```sh
nsh add nsh-extra --features push
```

```tsx
import { Notifications } from "nsh";
import { Push } from "nsh-extra";

if (await Push.available()) {
  // Showing notifications needs the user's permission; background deliveries do not.
  await Notifications.requestPermission();
  // The token can come later than this call (offline): hear it as an event, don't wait on it.
  Push.on("token", ({ token }) => sendTokenToServer(token));
  Push.register().catch((error) => console.warn("not registered", error));
}

Push.on("press", ({ payload }) => openChat(payload));
Push.on("notification", ({ threadId }) => refreshInbox(threadId));
Push.on("background", async ({ payload }) => {
  const changed = await syncInbox(payload);
  return changed ? "newData" : "noData";
});

// While a conversation is open, its notifications show no banner and play no sound.
function openConversation(threadId: string) {
  Push.setForegroundPresentation({ banner: false, sound: false }, { threadId });
}
function closeConversation(threadId: string) {
  Push.setForegroundPresentation(null, { threadId });
}
```

- `register()` resolves with `{ token }`, the string the push service takes (hexadecimal on iOS), and rejects with the
  service's reason when the device is not registered. The service answers once it can be reached, so offline the
  promise stays pending: `on("token")` is the dependable path, and it reports a token that changed. Register at every
  launch. `token()` reads the last one.
- `press` reports the notification the user pressed, including the one that launched the app, which waits for the
  first listener. `notification` reports one that arrived while the app is in front. Both carry its `id`, its
  `threadId` and the `payload` the push service sent. A payload is untrusted input.
- `background` reports a delivery that woke the app or reached it in front (on iOS one with `content-available`; a
  visible one with `content-available` arriving in front is reported to `notification` too; on Android one the
  binding hands over). The system waits for its listeners: return a promise for the work and what it gave, within 25
  seconds of the delivery. One that came while nothing listened waits for a listener until 5 seconds after it came.
- `setForegroundPresentation(presentation)` decides how notifications show while the app is in front, and
  `setForegroundPresentation(presentation, { threadId })` how one thread's show; `null` takes either back. They are
  decided ahead of the arrival, as the system asks at once, and hold for every surface of the app. On Android the
  binding posts a notification as they say.
- `closeThread(threadId)` removes the delivered notifications of a thread (on Android a notification group), but those
  `Notifications.show` showed; `Notifications.close(id)` removes one.
- `available()` is `true` in a standalone iOS app and wherever the app links a push service's binding. Elsewhere it is
  `false`, and `register` rejects with `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`; so does `closeThread`, except on Android.
- An app that declares `"capabilities"` grants `Push` with
  [`"notifications": true`](./sandbox-and-capabilities.md#notifications), the capability `Notifications` uses. The
  token, the deliveries and how they show belong to the whole app, so every function but `available()` asks for it
  first.

The feature adds the `remote-notification` background mode to the packaged iOS app. The `aps-environment` entitlement
comes from the provisioning profile the app is signed with ([iOS devices](./packaging.md#ios-devices)). On Android it
adds nothing: the push service's SDK brings what its manifest needs. Rust code, such as a push service's SDK binding,
uses `nsh_extra::push`: `on_event` hears the same events with the token's raw bytes,
`set_foreground_presentation_decider` decides each notification's presentation natively, and the launch options on iOS
come from `nsh_platform_ios::on_application_event` ([Application events](./ios.md#application-events)). A binding
implements `PushProvider` (it registers the device with its service), sets it with `set_provider` from its
`#[native_module]` entry, and reports what the service delivers with `provide_token`,
`provide_registration_failure`, `provide_notification` and `provide_background`. A press of a notification the binding
posted opens the app with the payload as the intent's extras, and reaches `press` with them as its `payload` (Android
does not say which notification it was, so it has no `id` or `threadId`).

### Speech

`Speech` turns what the user says into text (dictation): the app starts a session, the system listens to the
microphone, and the transcript arrives as it grows. macOS and iOS recognize with the system's Speech framework,
Android with the device's recognition service (`SpeechRecognizer`), Windows with its dictation
(`Windows.Media.SpeechRecognition`), the web with the browser's Web Speech API; the system or the browser asks the
user for the microphone (and on Apple platforms for speech recognition) once. Windows dictates with the user's online
speech recognition, which they turn on in Settings > Privacy & security > Speech; while it is off, a session ends with
`"not-allowed"`. Linux has no recognizer, nor have terminal apps (the TUI host, on every OS); an app embedded with
GPUI recognizes with the platform's recognizer on macOS and Windows. Check `Speech.available()` before showing a
microphone button: where nothing recognizes speech, a session ends at once with `"unavailable"`.

```sh
nsh add nsh-extra --features speech
```

```ts
const Speech: {
  available(): Promise<boolean>;
  start(options?: SpeechOptions): SpeechSession;
};

interface SpeechOptions {
  /** The language spoken, a BCP 47 tag ("en-US", "zh-CN"); the user's when left out. */
  lang?: string;
  /** Results while the user speaks (true, the default), or only the final one. */
  interim?: boolean;
}

interface SpeechSession {
  on(event: "start", listener: () => void): () => void;
  on(event: "result", listener: (result: SpeechResult) => void): () => void;
  on(event: "end", listener: (end: SpeechEnd) => void): () => void;
  /** The whole transcript so far. */
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

- `start` returns the session at once. It reports, in this order: `start` when the microphone is on and the recognizer
  listens, `result` each time the transcript changes (`text` is always the whole transcript so far, so the app shows
  it as it is), and one `end`, after which nothing comes. `stop()` stops listening and lets the recognizer finish
  what it heard: a last result with `isFinal: true`, then `end`. `abort()` ends the session at once, without an
  error. One session runs at a time, as there is one microphone: starting another ends the one running. A new
  session of the same app in the same view ends it as `abort()` does, without an error; one that another app or
  view of the process starts (an embedding app's other `AppView`) ends it with `"audio-capture"`, as the microphone
  was taken from it.
- `end` carries the last transcript and, when the session failed, `error`, named as in the Web Speech API:
  `"not-allowed"` (the user or the system does not allow the microphone or speech recognition, or the app is in the
  background), `"no-speech"` (nothing was said), `"audio-capture"` (the microphone could not be used), `"network"`
  (the recognizer needs the network), `"language-not-supported"` (the recognizer does not know `lang`),
  `"unavailable"` (nothing recognizes speech here, or not now) and `"failed"`.
- `start` throws a `TypeError` for options of the wrong types and a `RangeError` for a `lang` that is no language tag.
- `available()` is `true` on macOS and iOS, on Android devices with a recognition service, on Windows with a
  dictation language and a microphone, in browsers with the Web Speech API (Chromium-based browsers such as Chrome
  and Edge, and Safari), and wherever the app gave the module a recognizer of its own. It is `false` on Linux and in
  terminal apps.
- On the web the page needs a secure context (HTTPS, or `localhost` while developing) for the microphone, and a page
  that embeds the app in an iframe allows it (`allow="microphone"`). Chrome recognizes with its online service, so
  `"network"` reports a lost connection.
- An app that declares `"capabilities"` grants `Speech` with
  [`"speech": true`](./sandbox-and-capabilities.md#speech). Without it `start` throws an `Error` whose `code` is
  `"ERR_ACCESS_DENIED"`, `permission` `"speech"`.

The feature adds what the packaged app needs: the microphone's and speech recognition's usage descriptions on iOS
and macOS (an app sets its own wording with `ios.infoPlist` / `macos.infoPlist`), the audio input entitlement on
macOS, and on Android the `RECORD_AUDIO` permission and the query of recognition services. On the web the module
calls the browser through wasm-bindgen, so `nsh` builds the app's web runtime with the `wasm-bindgen` CLI
([browser APIs from Rust](./web.md#browser-apis-from-rust)); the site itself needs no declaration.

Rust code uses `nsh_extra::speech`: `available().await`, and `recognize(SpeechRequest)`, a session whose
`next().await` gives each `SpeechEvent` (`stop()`, `abort()`; dropping it aborts). An app that recognizes speech its
own way (its own engine or service, an embedding app's) gives the module a `SpeechBackend` with `set_backend`: every
session then reaches it instead of the system's recognizer.

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

In `nsh test` (and `nsh_testing::Headless`), sessions run on the module's fake recognizer, named
`"nsh-extra/speech"`: a session starts listening at once, as if the user allowed the microphone, and the test speaks
for the user through the fake with [`app.fake`](./testing-and-trace.md) (`Headless::call_fake` in Rust):

| Method | `args` | What it does, and its answer |
|---|---|---|
| `hear` | `[text]` | The user says `text`, the whole transcript so far: the running session reports it as a `result` that is not final (with `interim: false`, it keeps it for the end). Resolves with `null`; rejects with `no speech session listens` when none runs. |
| `end` | `[]` or `[error]` | Ends the running session: with `error` (one of the codes above), or as when the user stops: the transcript as the final `result`, then `end` (`"no-speech"` when nothing was heard). Resolves with `null`; rejects when no session runs or `error` is no code. |
| `requests` | `[]` | Resolves with the sessions the app started, in order: `[{ lang, interim }]`, `lang` `null` for the user's language. |

```tsx
await app.press("label:Dictate");
await app.fake("nsh-extra/speech", "hear", ["hello"]);
await app.waitFor("text:hello");
await app.fake("nsh-extra/speech", "end");
```

## An app's own Rust: `ext/`

A TSX app that needs Rust of its own (a scanner, a parser, a database, a native view) keeps it in `ext/`, beside `src/`: `src/` holds the app's TSX, `ext/` its Rust, one nshm crate per directory. The app lists each in `nsh.json` `"dependencies"` by path and imports it from TSX like any other nshm. `nsh init --template mixed` starts an app this way.

```text
my-app/
├── App.tsx                    the entry
├── src/                       the app's TSX modules
├── ext/                       the app's Rust
│   └── my-app-native/
│       ├── Cargo.toml         nsh-core and the crate's own dependencies
│       └── src/lib.rs         #[native_module("my-app-native")]
├── nsh.json                   "dependencies": { "my-app-native": { "path": "ext/my-app-native" } }
└── nsh.lock
```

[Disktree](https://github.com/huacnlee/disktree), a disk usage analyzer, is built this way: its UI is TSX in `App.tsx` and `src/`, and its file system scanner, an SQLite index and file removal are Rust in `ext/disktree-native`:

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
// ext/disktree-native/src/lib.rs (abridged)
mod scanner;

use nsh_core::prelude::*;

/// Scans, browses and removes entries using the native disk index.
#[module]
pub struct DiskTree;

#[module]
impl DiskTree {
    /// Runs a filesystem operation with a JSON payload and returns its JSON result.
    pub async fn request(route: String, body: String) -> Result<String, String> {
        // An `async fn` returns a Promise to TSX; `blocking` keeps the
        // file system work off the UI thread.
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

Why `ext/` rather than a crate at the app's root (`"rust": "."`):

- **The same way as every other nshm.** The app's own Rust and the nshm it installs are listed, locked and built the same way, and moving a crate from `ext/` to crates.io or its own repository later only changes its `nsh.json` entry.
- **Each crate on its own.** It has its own `Cargo.toml`, dependencies and tests (`cargo test` in its directory), and builds once, optimized, in `~/.nsh/builds` until it changes. The app's root stays a TSX project.
- **Small interfaces.** TSX reaches the Rust only through what `#[native_module]` registers, with declarations generated from the Rust signatures (`.nsh/types/<crate>.d.ts`), so the boundary is typed and easy to see in review.

Add another crate with `cargo new --lib ext/<name>`, give it a `#[native_module("<name>")]`, and run `nsh add --path ext/<name>`. Keep UI in TSX and put in Rust what needs native speed, the platform, or the crates.io ecosystem; a crate exports components too when a view must be native ([A Rust nshm](#a-rust-nshm)).

## Writing an nshm

### A Rust nshm

A Rust nshm is an ordinary Cargo library with a `#[native_module("<specifier>")]` entry at its root, the same as an app's own crate: the specifier is what TSX imports, and the function registers what it exports ([Extending a Rust app with TSX](./rust.md#extending-a-rust-app-with-tsx)). A small one:

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

The NSH versions an nshm builds with are its own `nsh-core` requirement (`nsh-core = "0.6"`), which `nsh add` checks against the running `nsh` before anything compiles. Its TypeScript declarations are generated from its Rust types, so apps check their TSX against it as they do against their own crate.

[nsh-omarchy's `src/lib.rs`](https://github.com/huacnlee/nsh-omarchy/blob/main/src/lib.rs) is a complete one: its components, exported to TSX by `#[native_module("nsh-omarchy")]`, with the `Omarchy` theme module.

### What the packaged app needs

An nshm that uses a system feature declares what the packaged app needs in its `Cargo.toml`, under
`[package.metadata.nsh]`, or under a feature's `[package.metadata.nsh.features.<feature>]` when only that feature
needs it. `nsh` adds the entries of every crate the app links, with the features Cargo turns on, to the packages it builds,
and the iOS `Info.plist` keys and Android entries to its development hosts:

```toml
[package.metadata.nsh.features.scanner.ios.infoPlist]
NSCameraUsageDescription = "Scans the codes you point the camera at."

[package.metadata.nsh.features.scanner.android]
permissions = ["CAMERA"]
queries = ['<intent><action android:name="android.media.action.IMAGE_CAPTURE"/></intent>']
application = ['<service android:name="com.example.scanner.Sync" android:exported="false"/>']
libraries = ["android/libs/scanner-glue.jar"]
```

| Key | Adds |
|---|---|
| `ios.infoPlist` | Keys of the iOS app's `Info.plist`, as `nsh.json`'s `ios.infoPlist` |
| `ios.infoPlistStrings` | The text of those keys in other languages, by language, as `nsh.json`'s `ios.infoPlistStrings` ([Packaging](./packaging.md#infoplist-text-in-other-languages)) |
| `ios.entitlements` | The iOS app's entitlements |
| `macos.infoPlist` | Keys of the macOS app's `Info.plist`, as `nsh.json`'s `macos.infoPlist` |
| `macos.infoPlistStrings` | The text of those keys in other languages, as `ios.infoPlistStrings` |
| `macos.entitlements` | The macOS app's entitlements |
| `android.permissions` | `<uses-permission>` elements, named as in `nsh.json` (`CAMERA` is `android.permission.CAMERA`) |
| `android.queries` | `<intent>`, `<package>` and `<provider>` elements of the manifest's `<queries>` |
| `android.application` | `<service>`, `<receiver>`, `<provider>`, `<activity>` and `<meta-data>` elements of `<application>`; `${applicationId}` is the app's package, other placeholders the app's `android.manifestPlaceholders` |
| `android.libraries` | Java libraries, jar, Android library (`.aar`) and dex files relative to the crate's `Cargo.toml`, packaged as `nsh.json`'s `android.libraries` are ([Java code](./packaging.md#java-code)) |

A crate does not set `android.manifestPlaceholders`, which is an error: the values of placeholders (a service's key) are
the app's, set in its `nsh.json`. The version of an Android library two crates carry in different versions is the one
the app lists in its own `android.libraries`. When two libraries define a resource of one name, a library the app
lists wins, then the crate whose name sorts first ([Java code](./packaging.md#java-code)).

The app's own `nsh.json` wins: a key it sets keeps its value, and arrays (such as `UIBackgroundModes`) are joined. When
two crates set one key to different values (two usage descriptions of the camera), the app chooses by setting the key
in `ios.infoPlist`, `ios.entitlements`, `macos.infoPlist` or `macos.entitlements`; until it does, packaging for that
platform stops with an error naming both crates. Keys NSH sets itself (the bundle's identifier, version and the like)
are not the crates'.

A crate translates the keys the crates set in `ios.infoPlist` (`macos.infoPlist` in `macos.infoPlistStrings`), as
they word them; a translation of a key no crate sets with the app's features (one of a feature that is off) is left out
with a warning. The app takes the crates' translations for the languages it has only, those of its `locales` or its own
`ios.infoPlistStrings` (`macos.infoPlistStrings`; an empty `{}` names a language without text of its own), so a crate
may carry many languages without adding any to the app. A key the app sets itself takes none of the crates'
translations, which would say something else than the app's text. Two crates translating a key differently are settled
by the app as above, in `ios.infoPlistStrings` (`macos.infoPlistStrings`).

Develop it beside an app with `nsh add --path ../my-gauge`, which reads the directory as it is. Publish it as any crate (`cargo publish`), with the keyword `nshm` so that it can be found on [crates.io](https://crates.io/keywords/nshm), or push it to Git and tag its versions.

### Wrapping a native SDK

An nshm that wraps an Apple SDK calls it from Rust under `#[cfg(target_os = "ios")]` or `#[cfg(target_os = "macos")]`. System frameworks used through the `objc2` crates need nothing more. A vendor's prebuilt library (an `.xcframework` or `.a`) is linked from the nshm's own `build.rs`: Cargo passes the `rustc-link-lib` and `rustc-link-search` of every dependency to the app's executable, so the app lists nothing and NSH has no per-platform SDK settings.

```rust
// build.rs
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("ios") {
        return;
    }
    // The simulator's and Mac Catalyst's (`nsh run --target catalyst`) are iOS too.
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

- Use `rustc-link-lib`, not `rustc-link-arg`: link arguments only apply to the crate's own targets.
- Put a static library's privacy manifest entries in the app's `ios.privacyManifest`.
- NSH does not embed dynamic frameworks; prefer the SDK's static build.
- A library whose licence asks that users can replace it (LGPL, such as libmpv) stays dynamic, and the app carries it itself; NSH's packages have no setting for it. Link it from the nshm's `build.rs` as above (`rustc-link-lib=framework=…`, `rustc-link-search=framework=…`). Give the executables their run path in the app's `.cargo/config.toml` (`rustflags = ["-C", "link-arg=-Wl,-rpath,@executable_path/../Frameworks", "-C", "link-arg=-Wl,-rpath,<the framework's directory>"]` under `[target.aarch64-apple-darwin]`), since a crate's `rustc-link-arg` does not reach `nsh run`, `nsh check` or `nsh test`. After `nsh package --target macos`, copy the framework into the app's `Contents/Frameworks/`, remove the development run path with `install_name_tool -delete_rpath`, then sign again, the framework first and the app last, with the identity the package used (`codesign --force --sign <identity> --options runtime --entitlements <the app's entitlements>`, or `--sign -` for an ad hoc package), and check it with `codesign --verify --deep --strict`.
- On Linux and Windows the same `build.rs` links the SDK (`.a` and `.so` on Linux, `.lib` on Windows). NSH does not carry shared libraries (`.so`, `.dll`) into the package either; prefer the SDK's static build.

### A TSX nshm

A TSX nshm is a Git repository whose `nsh.json` describes it: its package name and version, the NSH versions it works with, and what it exports, each specifier with its TSX entry file:

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

Its exports are its specifier or start with it (`acme-badge`, `acme-badge/icons`), and its files stay inside it. Apps import it as they import their own modules, and `nsh check` checks their TSX against its source. Publish a version by tagging it (`git tag v0.1.0 && git push --tags`); the tag's version must be the one its `nsh.json` says.

A Rust nshm can export TSX as well, by the same `"exports"` in an `nsh.json` beside its `Cargo.toml`: TSX helpers written on top of its native module. Its name and version are then its crate's.

### Dependencies

An nshm lists the nshm it needs in its `nsh.json` `"dependencies"`, in the app's form: from crates.io or Git, with a version requirement as wide as it works with, so that apps and the other nshm they use can agree on one version. A published nshm cannot depend on a directory. The app's own entry for a package decides where it comes from: an app can take an nshm its nshm depend on from a fork or a local directory while their version requirements still apply.

## Platform nshm

An nshm can provide a target of its own, such as a platform NSH does not build for, with `"platform"` in its `nsh.json` and a binary named `nsh-platform-<name>` in its crate. The crate needs no `#[native_module]` when it gives the app nothing but the target; without one, the app is not linked with it and does not become a Rust app:

```json
{ "name": "nsh-harmony", "version": "0.1.0", "platform": "harmony" }
```

After `nsh add nsh-harmony`, the app's `nsh run`, `nsh dev`, `nsh test` and `nsh package` with `--target harmony` build that binary (in the app's `.nsh/platforms/harmony`, leaving the shared installation as it is) and run it as an [external target](./cli.md#external-targets). A platform installed on `PATH` as `nsh-platform-<name>` serves every app without being an nshm; the app's nshm comes first. [Building a platform](./platform-extensions.md) covers what a platform implements.

## Security

An nshm's build scripts and procedural macros run when the app builds, and its code, TSX or Rust, runs with the app's permissions. Any crate in the app's dependency graph can also add system permissions, manifest components, Java and Android libraries (with their native code) and entitlements to the packaged app through `[package.metadata.nsh]`. Review its source and the changes to `nsh.lock` as you review the app's own code.

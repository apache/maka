# Audio playback: design

Status: approved and implemented. Run: the core, `nsh test`'s fake speaker,
macOS (`nsh test --target macos`), Windows (`--target windows` on a test
machine), the web (`--target web`, headless Chrome) and Android (a phone).
Built, not run: iOS (shares the macOS file; Catalyst clippy). Linux:
type-checked on macOS against the gtk4 and gstreamer crates, built and its
sound tests run by CI (no Linux machine with sound at hand). The GPUI backend reports `Environment::audio` off: sounds and
players fail there with `unavailable`. Covers `Sound` (short sound
effects) and `AudioPlayer` (long audio) of `nsh`, their Rust faces, the
platforms' engines and what `nsh.json` grants.

## Intent

Apps need to make sound: a trade confirmation, a price alert, a message
arriving, a voice message, a recording played back. NSH has no way to do that
today except `<Video>`, which is a view that takes a frame on the screen.
`Speech` is the other direction only (the microphone to a transcript) and
synthesizes nothing.

Two capabilities are added to `nsh`, as two separate primitives, because they
are two different things on every platform (the browser has the Web Audio API
and `<audio>`, Apple `AVAudioEngine` and `AVPlayer`, Android `SoundPool` and
`MediaPlayer`):

- **`Sound`**: a short clip decoded once into memory and played any number of
  times, overlapping, with the lowest latency the platform gives. Fire and
  forget: no progress, no seeking.
- **`AudioPlayer`**: a long recording or stream, decoded as it plays, with the
  state a player has: position, duration, pause, seek, rate, loop, buffering.
  It is `<Video>` without a picture, on the same engines.

## What others do

Read before settling the shape (2026-11-05): Zed's `audio` crate (GPUI, the
reference NSH is layered as), kira, firewheel (Bevy's coming engine), rodio,
awedio, oddio and bevy_audio.

- **Zed** (`crates/audio/src/audio_pipeline.rs`): one `Audio` global on the
  `App`; a `Sound` enum of the editor's own clips, loaded from assets and
  decoded once into a `source_cache` (`HashMap<Sound, Buffered<Decoder<..>>>`),
  cloned per play; the output stream opened lazily by the first sound
  (`ensure_output_exists`) and dropped at `end_call`; a `Mixer` fed a `Zero`
  source so it never ends; `play_sound` logs and skips on any failure,
  nothing reaches the caller; device errors watched by a task that tears the
  stream down. Rodio over cpal, so decode and mix are Rust.
- **kira**: the same split as here. `StaticSoundData` ("loaded into memory
  all at once": short sounds, sounds played many times, "consistent start
  times") against `StreamingSoundData` ("decode gradually from a file": long
  sounds played one at a time, less memory; not on wasm). A gameplay thread
  sends commands to the audio thread; `Capacities` bound every resource and
  `ResourceLimitReached` is the error; parameter changes take a `Tween`.
- **firewheel**: a realtime-safe message channel ("no mutexes"), a backend
  that falls back to the default device and then a dummy one, "fault
  tolerance for audio streams" (a disconnected device never crashes the
  game), silence flags that skip idle nodes, decoded samples shared behind
  `SampleResource`.
- **rodio** / **awedio** / **oddio**: iterator- or trait-shaped sources
  with combinators (`amplify`, `speed`, `pausable`), all mixing in Rust over
  cpal (oddio sans-I/O); rodio's README says its core engine is being
  rewritten. awedio keeps i16 samples; oddio is wait-free.
- **bevy_audio**: an `AudioPlayer` component with `PlaybackSettings`
  (`Once` / `Loop` / `Despawn` / `Remove`), an `AudioSink` to control it,
  a `GlobalVolume`; rodio underneath.

Taken: the static / streaming split as two primitives (kira); load once,
play from memory, the stream opened by the first sound and closed with its
owner (Zed, kira); a `play` that never fails to the caller (Zed); bounded
capacities with one quota error (kira); a device that goes away makes
silence, never an exception (firewheel); loads of one source shared (Zed's
cache, the image loader's dedup); the name `AudioPlayer` (bevy_audio) for the
long side. Not taken: decoding and mixing in Rust over cpal (every one of
them does), tweens, spatial audio, graphs; "Decisions" says why.

## Goals

1. A tap's feedback sound starts within one frame of the call on every
   platform: nothing is opened, fetched or decoded at `play` time.
2. A voice message or a podcast plays from a URL as `<Video>` does: streamed,
   buffered, seekable, reporting progress, surviving the view that started it.
3. One API on the six platforms (iOS, Android, macOS, Windows, Linux, web) and
   in headless tests; a platform that cannot play says so instead of failing.
4. Every limit and every grant checked in Rust (`sandbox.md`), nothing trusted
   from the bundle.
5. Rust components get the same two primitives through `nsh_core::prelude`.

## Non-goals

- Text to speech (the reverse of `Speech`): a later `Speech.speak`, not this.
- Recording, audio input, effects, mixing graphs, spatial audio, MIDI.
- Lock-screen / "Now Playing" controls, background playback, remote commands.
  `AudioPlayer` pauses when the app leaves the foreground on mobile; apps that
  need more wait for a later design (the shape below leaves room: a `session`
  option).
- System sounds and haptics (`AudioServicesPlaySystemSound`, vibration).
- Tweens (kira's smoothed parameter changes), fades, spatial audio, effects,
  audio graphs. `volume` and `rate` change at once. A `fadeIn` / `fadeOut`
  option may come later; the names are reserved, as `session` is.
- An `<Audio>` element. Sound has no frame; an element would cost a node and a
  mount item for nothing.

## Anti-goals

- A `play(url)` that opens, fetches and decodes on the spot: the latency makes
  it useless as feedback and it hides a network request in a tap handler.
- Different semantics per platform: an option one platform ignores silently.
  What a platform cannot do is reported (an `error`, `available()` false).
- A React Native `react-native-sound` compatibility shape (`api-naming.md`).

## Where it goes

Both are **runtime modules of `nsh`** (`docs/dev/js-modules.md` "Where new
things go": a capability that only asks the platform is a Rust `#[module]` in
`crates/nsh-core/src/runtime/`, registered in `runtime::registries()`). Not
`nsh/mobile` or `nsh/desktop` (every platform has it), not a `nsh/audio`
submodule (the per-primitive submodules are the deprecated past).

| | File |
|---|---|
| The requests, events, errors and the `AudioBackend` trait | `crates/nsh-core/src/audio.rs` (as `speech.rs`) |
| The JS face: `Sound`, `AudioPlayer` (`#[module]`, `#[class]`) | `crates/nsh-core/src/runtime/audio.rs` (as `runtime/speech.rs`) |
| The Rust face for components | `nsh_core::prelude`: `sound()`, `audio_player()` (as `speech_available()`), through `element::ambient` |
| Root commands and events | `ops.rs`: `Command::Audio(AudioCommand)`, `EventKind::Audio` → `EventPayload::Audio { id, event }` |
| The platform's say | `Environment::audio: bool` (`platform.rs`, `element/env.rs`) |
| The platforms | `nsh-platform-apple` `audio.rs` (macOS and iOS, as `speech.rs` is), `nsh-platform-android` `Audio.java` + JNI, `nsh-platform-windows` `native/audio.rs`, `nsh-platform-linux` and `nsh-platform-gpui` on GStreamer, `nsh-platform-web/web/nsh.js` |
| Tests | `nsh-testing`'s headless driver gets an `AudioBackend` fake (as speech's); `tests/compat/cases/audio/` |

## The API

```ts
import { Sound, AudioPlayer } from "nsh";

// Short sound effects
const click = await Sound.load("sounds/click.wav");   // decoded now, in memory
click.play();                                          // fire and forget
click.play({ volume: 0.5, rate: 1.2 });                // overlaps the one above
click.stop();                                          // every playback of this sound
click.duration;                                        // seconds, known after load
click.dispose();                                       // frees the PCM; also when its owner goes

// Long audio
const player = new AudioPlayer("https://example.com/voice.m4a", { loop: false });
player.on("load", ({ duration }) => …);
player.on("progress", ({ currentTime, duration }) => …);   // ~4 per second while playing
player.on("buffer", ({ buffering }) => …);
player.on("end", () => …);
player.on("error", ({ code, message }) => …);
await player.play();      // resolves once playing (or rejects: see errors)
player.pause();
player.seek(12.5);
player.volume = 0.8; player.rate = 1.5; player.loop = true;
player.currentTime; player.duration; player.state;   // "idle" | "loading" | "playing" | "paused" | "ended" | "error"
player.dispose();
```

### `Sound` (a `#[module]` with a `#[class]` instance)

- `Sound.available(): Promise<boolean>`: whether this platform plays sounds
  (`Environment::audio`, or the core has an `AudioBackend`).
- `Sound.load(src: string | Uint8Array): Promise<Sound>`: fetches the bytes and has the
  platform decode them to PCM. `src` is what `Image` takes: a bundled asset
  (relative path or `asset:`; TSX imports `.wav`, `.m4a`, `.aac` and `.mp3`
  files, and any file with `?url`, as their `asset:/` URL and ships them,
  `nsh-bundler`'s `plugin.rs`), a `file:` URL, `data:` / `blob:`, or `http(s)`;
  or a sound file's bytes (`SoundSource::Bytes` in Rust, which also takes
  `include_bytes!`), sent to the platform as a `data:` source's are, named
  by the format their first bytes say and a digest of them.
  The bytes come through the image loader's L1–L3 (`image-loading-design.md`:
  assets, files, the remote loader with its disk cache, dedup and limits) so
  `Sound.load` never writes a second loader; the platform only decodes.
  Rejects with `ERR_ACCESS_DENIED` for a URL `network` does not grant
  (`access.allows_media`, checked in the call), `ERR_NSH_QUOTA_EXCEEDED` past
  the limits below, `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` where
  `available()` is false, and an `Error` with the platform's message when the
  bytes do not decode.
- `sound.play(options?: { volume?: number; rate?: number }): void`: starts a
  playback; several may run at once (polyphony). It is a root command queued
  in the commit of the JS turn that called it, so it reaches the platform in
  the same batch as the view change it accompanies and starts within a frame.
  `volume` 0–1 (default 1), `rate` 0.5–2 (default 1); out of range throws a
  `RangeError`. Never rejects for a sound that cannot be heard (the device is
  muted, the platform dropped a voice past its polyphony).
- `sound.stop(): void`: stops every playback of this sound.
- `sound.duration: number`: seconds.
- `sound.dispose(): void`: frees the decoded PCM on the platform. A sound is
  disposed when the JS owner that loaded it goes (a component unmounts, a
  module re-runs under hot module replacement) and with the engine.

### `AudioPlayer` (a `#[class]`)

- `new AudioPlayer(src: string, options?: { loop?: boolean; volume?: number; rate?: number })`.
  `src` as `Sound.load`'s; an `http(s)` URL `network` does not grant throws
  `ERR_ACCESS_DENIED` in the constructor. Nothing loads until `play()` (or
  `preload()` below), so constructing is free.
- `play(): Promise<void>`: loads if needed and plays; resolves once the
  platform reports playing. Rejects with `error`'s payload when the source
  fails, with `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` where `available()` is
  false, and with `not-allowed` on the web before a user gesture (the
  browser's autoplay policy; the same code `Video` warns with).
- `pause(): void`, `seek(seconds: number): void` (clamped to the duration;
  negative or non-finite throws a `RangeError`), `preload(): void` (starts
  loading without playing: the first `play()` is then immediate).
- `volume`, `rate`, `loop`: read / write properties, the setters a root
  command each; the same ranges as `Sound`.
- `currentTime`, `duration` (`NaN` until `load`), `state`: read-only, kept by
  the core from the platform's events (`currentTime` is the last progress
  event's; apps that draw a scrubber read it from `progress`).
- `on(event, listener) => () => void` as everywhere (`api-naming.md`
  "Listening"): `load` `{ duration }`, `progress` `{ currentTime, duration }`,
  `buffer` `{ buffering }`, `end` (once per play through; with `loop` never),
  `error` `{ code, message }`. A listener goes with its owner and with
  `dispose`.
- `dispose(): void`: stops and releases the engine. Also with the owner and
  the engine. A player is **not** tied to a view: a component may create one
  and hand it up through context; it stops when the owner that created it
  goes.
- `AudioPlayer.available(): Promise<boolean>` as `Sound.available`.

Errors' `code`s name the Web's `MediaError` and the Speech module's words:
`not-allowed`, `network`, `decode`, `not-supported`, `quota-exceeded`,
`unavailable`, `failed`.

### Rust components

`nsh_core::prelude` gets `load_sound(src).await -> Result<Sound, AudioFailure>`,
`audio_player(src, settings) -> AudioPlayer` and `audio_available()`
(`nsh_core::element::audio`), the same objects without the JS wrapping. A
player's events come from `player.next().await`, as a speech recognition's
do. A Rust handle releases its sound (with the last `Sound` over its source)
or player on `Drop`;
the JS classes queue `Command::Audio` from their methods as `SpeechSession`'s
do, and `play`'s range checks throw synchronously before anything is queued.
The rest of the Rust face is the builder's, patterned on `speech.rs`'s.

## How it works

### The core (`nsh_core::audio`)

- `AudioCommand`: `Load { id, bytes, hint, max_duration }` (a sound; `hint`
  the file name, URL or `data:` URI for decoders that go by the extension,
  `max_duration` how much the platform decodes at most), `Play { id, volume,
  rate }`, `Stop { id }`, `Unload { id }`; `Open { id, src, settings }`,
  `Preload`, `Resume`, `Pause`, `Seek { id, position }`, `Set { id, settings }`,
  `Close` for players (`PlayerSettings`: `volume`, `rate`, `looped`).
- `AudioEvent`: `Loaded { duration, bytes, truncated }` (`bytes` the decoded
  audio's size, for the budget) for sounds; `Load { duration }`, `Playing`,
  `Paused`, `Progress { position, duration }`, `Buffer { buffering }`,
  `Ended` for players; `Failed { error, message }` for both.
- Ids: sounds and players are numbered by the core from one counter of the
  process (`u32`), so a late event of a closed object never reaches
  another.
- `AudioBackend` trait: `load`, `play`, `stop`, `unload`, and the player
  methods, each answered through a `Sink` of events; given with
  `Core::set_audio` / `EngineConfig::audio`. When set, no command reaches the
  platform (embedders with their own audio stack, tests). Without it and
  without `Environment::audio`, `available()` is false and `load` / `play`
  reject at once with `unavailable`.
- State kept in the core per player (`state`, `current_time`, `duration`), so
  reads are synchronous and the main thread is never asked (`AGENTS.md`: the
  main thread never waits for JS, and JS never waits for the main thread).
- `Sound.load`'s bytes: the core asks the image loader to `read` the source
  (`image/loader.rs` splits `read` from `decode`, and `Location::{Asset,
  File, Data, Memory, Url}` covers every source `Image` takes: an
  `Arc<[u8]>` of the asset, file, inline data or the remote response with
  the disk cache, redirects checked by `allows_media`) and sends them in
  `Load`. The call runs on the engine thread, where the engine's loader
  `Context` is set (`Core::set_image_context`); the pool's completion comes
  back to the engine thread as an image load's does. A remote `read` needs
  the platform's `Transport` (`Context::transport`): the desktops have one
  (macOS `NSURLSession`, the others ureq); **iOS gets macOS's, Android and
  the web supply one in this change** (Android over its Java networking, the
  web over the browser's `fetch`), so the loader's policy, limits and
  redirect checks stay in Rust on every platform. The loader's response
  limit applies (64 MiB); on top of it a sound's encoded bytes are capped at
  **8 MiB**, whatever the source (`data:` and bundled assets too), checked in
  the core before `Load`. Its decoded length is capped at **5 s**: `Load`
  carries `max_duration`, the platform decodes no more than that and reports
  `truncated` in `Loaded`, and a truncated sound is sent `Unload` and
  rejected with `ERR_NSH_QUOTA_EXCEEDED` (the platform's decoder is trusted
  native code, as the image decoders are; the core checks what it reports).
  At most **64 sounds** loaded per engine (the 65th rejects the same way)
  and **16 MiB of decoded PCM** among them (`Loaded`'s `bytes`, counted by
  the core; a load that would pass it is unloaded and rejected the same
  way: a sound's memory is bounded whatever its sample rate and channels).
  Polyphony: up to **32** playbacks at once per engine; the platform drops
  the oldest beyond that.
- One decode per source: `Sound.load` of a source already loaded in this
  engine (same resolved URL or digest of inline bytes) shares the platform's
  decoded buffer behind a count, as Zed's `source_cache` and the image
  loader's in-flight dedup do; the buffer is unloaded when the last `Sound`
  over it is disposed. Two components playing the same click cost one
  decode and one buffer.
- `AudioPlayer`'s `src` is handed to the platform as `Video`'s is: the
  platform's engine streams it (HTTP ranges, buffering, its own cache). One
  check in the core (`allows_media`, the same as `Prop::Source` for a video).
  The disk cache does not apply to players.
- Threads: every command goes in the commit's batch; every event comes back
  on the root as `EventKind::Audio`, dispatched to the sound's or player's
  listeners in the next JS turn (`Callback::post`).

### The platforms

| Platform | `Sound` | `AudioPlayer` | Notes |
|---|---|---|---|
| iOS, macOS | `AVAudioEngine` with one `AVAudioPlayerNode` per playback over a shared mixer; `AVAudioFile` / `AVAudioPCMBuffer` decoded once at `Load` | `AVPlayer`, the class `Video` uses in `native.rs`, with no layer | one `AVAudioEngine` per NSH engine (`AppView` / `NshAppView`), started lazily, stopped with it; `AVAudioSession` `.ambient` (mixes with others, honours the silent switch) set once on iOS when the first sound or player starts; a player pauses on `UIApplication.didEnterBackground` |
| Android | `SoundPool` (one per NSH engine, max 32 streams), `load` from a temp file or an `AssetFileDescriptor`; the duration read from the container with `MediaExtractor` before `load` (`SoundPool` reports none) — under the 5 s cap its own decoded-size limit (about 1.5 MiB) is never hit | `MediaPlayer`, the class `VideoBox.java` uses, with its `AudioFocusRequest` handling repeated | `Audio.java` next to `VideoBox.java`; events through the same JNI event map (`Native.java`'s key list updated) |
| Windows | `XAudio2` (one engine per NSH engine; `IXAudio2SourceVoice` per playback over a mastering voice), Media Foundation's `IMFSourceReader` decodes to PCM at `Load`, on one decoding thread for the process | `IMFMediaEngine`, the class `native/video.rs` uses, audio-only (no video output) | |
| Linux | GStreamer (`sound.rs`): decoded once off the main thread (`decodebin` into 48 kHz stereo floats, cut at the length allowed), played from memory by one live pipeline per engine, an `appsrc` per voice into an `audiomixer` pad (its volume; another rate resamples the samples once) | `gtk::MediaFile`, as `native.rs`'s video; GTK media streams have no rate, so a player's `rate` is ignored there | the `gstreamer`, `gstreamer-app` and `gstreamer-audio` crates (GTK already plays media through GStreamer; the review of #955 showed a stream per play could not keep `Sound`'s promise of decoding once and starting within a frame); GTK has no buffering signal, so `buffer` is reported only while a play waits for its load |
| GPUI | not yet: `Environment::audio` off | not yet | |
| Web | the core sends `AudioCommand::LoadUrl` (the browser fetches; the image loader has no threads there), checking the source first; `AudioContext` (one per NSH engine) + `decodeAudioData` at `Load`, an `AudioBufferSourceNode` per playback | an `HTMLAudioElement` as the `<video>` path in `nsh.js` | the `AudioContext` is created and resumed on the page's first user gesture the engine observes; `play` before it is `not-allowed` |

The platform's audio objects (`AVAudioEngine`, `SoundPool`, the XAudio2 engine,
the `AudioContext`) are **per NSH engine**, never process-wide (`AGENTS.md`:
one surface is one engine, no global singletons): ids are the engine's, the
64 / 32 limits count per engine, and dropping the engine releases all of it.
They start lazily, with the first `Load` or `Open` (Zed's
`ensure_output_exists`), so an app that never makes a sound never touches
the audio hardware, and they stop with the engine.

An output that fails makes silence, never an error in the app (firewheel's
fault tolerance): a device unplugged or changed while playing, a system that
refuses the engine, an `AVAudioEngine` configuration change, an `AudioContext`
not yet resumed. The platform reopens on the default device when it can and
keeps the sounds loaded; `play` stays `void`, and an `AudioPlayer` that loses
its output reports `error` `failed` once and goes `idle` rather than
throwing. Only `available()` tells an app the platform cannot play at all.

`AudioPlayer` on iOS, macOS, Android and Windows is **new code on the same
engine classes `Video` uses**; `Video`'s view-bound code is not refactored
in this change (one change does one thing). A later change may rebuild
`Video`'s playback on the player; nothing here depends on it.
| Headless (`nsh-testing`) | the `AudioBackend` fake: records the commands, answers `Loaded` with a duration the test sets, `Progress` on the manual clock | the same | tests assert on what was played |

Formats are the platform's decoders'. The documentation recommends WAV or
AAC (`.m4a`) for sounds, AAC or MP3 for players: those decode everywhere.
Opus / OGG do not on iOS and Safari; a sound that does not decode rejects
`load` with the platform's message.

### Capabilities

A new capability, **`audio`** (`nsh.json` `"capabilities": { "audio": true }`;
`Access::allows_audio`, next to `allows_speech` and `allows_notifications`),
checked in the calls: without it `Sound.load`, `new AudioPlayer` and
`AudioPlayer.play` throw / reject `ERR_ACCESS_DENIED` (`permission` `"audio"`,
`resource` the source), and the core refuses Rust components' requests the
same way (`sandbox.md`'s "Enforced in Rust"). `available()` needs no grant:
it answers what the platform can do, not what the app may. Apps that declare
no capabilities keep unrestricted access, as for the clipboard and speech
(`sandbox.md`). A host embedding NSH can thus keep a plugin silent.

What else stays checked:

- `network`: an `http(s)` source needs a grant (`allows_media`), as an
  image's or a video's does. Checked in the call for `Sound.load` and the
  `AudioPlayer` constructor (they throw / reject `ERR_ACCESS_DENIED` with
  `permission` `"network"` and `resource` the URL).
- The limits above, in the core.

### Compatibility

New exports only (`Sound`, `AudioPlayer` of `nsh`), new root commands and
events, one `Environment` flag. Nothing existing changes. `tests/compat/cases/audio/`
loads a bundled sound, plays it, opens a player on a stubbed URL and checks
the events on the headless backend. Whether this lands before or after
0.3.0 (the first recorded release) changes nothing here: the case is what
freezes the API either way, and the shape above is meant to be kept.

### Documentation

`website/docs` (English and `zh-CN`): a page "Audio" under the API reference,
with the two primitives and the formats; `docs/dev/js-modules.md`'s table
rows for `Sound` and `AudioPlayer`; `sandbox.md`'s limits; `elements.md`
"Platform modules" untouched; each platform page's media section.

## Decisions

Taken by the user:

- Two primitives, `Sound` and `AudioPlayer`, in `nsh` (2026-11-05).
- Both in this design; no text to speech.

My calls (change them if wrong):

1. **An `audio` capability** (the user's call, 2026-11-05; my first draft
   had none). Sound reaches outside the app's view as a notification does,
   and a host embedding NSH gets a switch to keep a plugin silent. The
   `network` grant still guards remote sources. An app that declares
   capabilities adds `"audio": true` to make sound; one that declares none
   is unrestricted, as today.
2. **`Sound.load` fetches through the image loader**, not the platform: the
   limits, the disk cache and the redirect checks already exist there, and
   "limits are enforced in Rust" wants the bytes to pass the core.
3. **The limits**: 8 MiB encoded, 5 s decoded, 64 sounds, 32 voices. Round
   numbers that hold a typical sound set (a few dozen clips of under a
   second) and refuse a song loaded as a sound. 5 s, not longer, because
   Android's `SoundPool` keeps about 1.5 MiB of decoded PCM per sound (about
   8 s of 16-bit stereo at 44.1 kHz) and the limit must be the same on every
   platform (goal 3); anything longer is `AudioPlayer`'s job. The decoded
   cap travels to the platform (`max_duration`) so a small file that expands
   to minutes never fills memory before it is refused.
4. **`AudioPlayer` is a class, `Sound` a module with instances** (`load`
   returns one). `new AudioPlayer(src)` reads as `new Audio(src)` does;
   `Sound.load` is asynchronous and a constructor cannot be.
5. **Mobile players pause in the background**; no audio session category
   choice yet. The option slot for it is named `session` and left out.
6. **Progress events at ~4 Hz** while playing, none while paused: enough for
   a scrubber, cheap enough for the batch.
7. **Platform engines**: the ones in the table. On Linux sounds take
   GStreamer's crates (the user's call, after review): a play opens no file
   and decodes nothing.
8. **iOS, Android and the web get a loader `Transport` in this change**, so
   `Sound.load` is core-driven everywhere instead of fetched natively on some
   platforms and handed back. It is work `image-loading-design.md` wants
   anyway, and the alternative weakens "limits in Rust".
9. **No refactor of `Video`.** The players reuse the engine classes, not the
   view code. A second copy of `AVPlayer` / `MediaPlayer` / `IMFMediaEngine`
   handling is the price of not touching working code in the same change.
10. **Per-engine platform objects**, never per-process, even on the web where
    browsers cap the number of `AudioContext`s (a page runs one NSH engine
    in practice).
11. **The platform decodes; no Symphonia in the core.** Every Rust audio
    crate read decodes in Rust (rodio, kira and awedio on Symphonia), which
    would give one format list on six platforms and bound decoding in Rust
    outright. Against it: images set the precedent (WIC, GDK, ImageIO
    decode; the `image` crate only where a platform lacks one), the web's
    brotli budget (`browser-js-size.md`: 4.1 MB for the whole package) has
    no room for a codec set, and WAV, MP3 and AAC-LC decode on every
    platform already. The decoded cap travels to the platform instead
    (`max_duration`), and `Loaded` reports what to count. The trigger to
    revisit: apps needing Opus or Vorbis sounds on iOS and Windows, where
    the system decoders are not guaranteed.
12. **The platform mixes; no cpal, no mixer of NSH's own.** A wait-free
    mixer with resampling for `rate` is real engineering (oddio, firewheel),
    cpal is a platform-binding crate NSH would carry on six targets
    (`ndk_context` on Android, atomics and nightly for the web's
    `AudioWorklet`), and rodio's engine is being rewritten. `AVAudioEngine`,
    `SoundPool`, XAudio2, GStreamer and the Web Audio API mix already, with
    lower latency on iOS than a user-space mixer gets. The platform's sound
    code is therefore "keep this decoded buffer, start a voice of it with
    this volume and rate", nothing else.
13. **Loads deduplicated and a decoded budget** (Zed's cache, kira's
    `Capacities`, the image loader's byte budget): one buffer per source per
    engine, 16 MiB of PCM in all. Apps keep their explicit `load` /
    `dispose` (Zed's implicit cache fits an editor with eight fixed clips,
    not plugins that come and go).

## Left to the builder

- The exact `AudioCommand` / `AudioEvent` fields and the `AudioBackend`
  signatures, patterned on `speech.rs`.
- The `#[class]` declarations (`overload`s of `on` per event, as
  `SpeechSession`'s) and the generated TypeScript.
- The per-platform details: engine start-up, cleanup on engine drop, the JNI
  key list, the web's gesture gate, the shape of the three new `Transport`s.
- The order of platforms. Suggested: core + headless + macOS first (the
  machine this is developed on), then iOS (shares the file), web, Windows,
  Android, Linux / GPUI.

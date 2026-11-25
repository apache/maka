//! NSH's official modules: features apps install with `nsh add` rather
//! than every app carrying them. `nsh-extra` is an nshm (an ordinary crate
//! with a `#[native_module]` entry) whose TSX specifier is `nsh-extra`, and
//! each module is a Cargo feature of it, off by default, so an app pays the
//! size, the system permissions and the store declarations of only the
//! modules it turns on:
//!
//! ```sh
//! nsh add nsh-extra --features camera
//! ```
//!
//! ```tsx
//! import { Camera } from "nsh-extra";
//!
//! if (await Camera.available()) {
//!   const photo = await Camera.takePhoto({ maxDimension: 2048 });
//! }
//! ```
//!
//! A Rust app depends on the crate with the features it uses and calls the
//! module's functions (`nsh_extra::camera::take_photo`).
//!
//! # Modules
//!
//! | Feature | Rust | TS | What it does |
//! |---|---|---|---|
//! | `camera` | [`camera`] | `Camera` | Photos taken with the system's camera (iOS, Android) |
//! | `location` | [`location`] | `Location` | The device's position, read once or watched, once the user allows it (macOS, iOS, the web) |
//! | `photos` | [`photos`] | `Photos`, `PhotosPicker` | The user's recent photos, read once the user allows it, and the system's photo picker embedded in the layout (iOS) |
//! | `push` | [`push`] | `Push` | Remote notifications with any push service (iOS; Android through the service's binding) |
//! | `speech` | [`speech`] | `Speech` | Speech recognized as the user talks, with interim transcripts (macOS, iOS, Android, Windows, the web) |
//!
//! A module is one feature, named as its Rust module (`camera`, `push`);
//! its TS namespace is that name in PascalCase (`Camera`, `Push`); its code
//! is one directory (`src/camera/`: the API in `mod.rs`, each platform's
//! part in its own file, on the platform crates' extension points); what it
//! needs of the packaged app (an `Info.plist` key, a manifest entry) is
//! declared under its feature in `[package.metadata.nsh.features.<name>]`
//! of `Cargo.toml`, which `nsh` merges into the app's when the feature is
//! on.

#[cfg(feature = "camera")]
pub mod camera;
#[cfg(feature = "location")]
pub mod location;
#[cfg(feature = "photos")]
pub mod photos;
#[cfg(feature = "push")]
pub mod push;
#[cfg(feature = "speech")]
pub mod speech;

use nsh_core::prelude::*;

/// The set apps import from `nsh-extra`: the modules of the features on.
/// It runs on the main thread before the app launches, where a module sets
/// up what the launch already needs (`push` observes the app's delegate).
#[native_module("nsh-extra")]
fn native(registry: &mut Registry) {
    #[cfg(feature = "camera")]
    registry.module::<camera::Camera>();
    #[cfg(feature = "location")]
    registry.module::<location::Location>();
    #[cfg(feature = "photos")]
    {
        registry.module::<photos::Photos>();
        registry.register::<photos::PhotosPicker>();
    }
    #[cfg(feature = "push")]
    {
        push::install(registry);
        registry.module::<push::Push>();
    }
    #[cfg(feature = "speech")]
    registry.module::<speech::Speech>().fake(
        speech::fake::NAME,
        std::sync::Arc::new(speech::FakeSpeech::default()),
    );
    let _ = registry;
}

/// The native components of the features on, registered for each view the
/// hosts nsh builds make: the system's photo picker ([`photos::PhotosPicker`]).
#[cfg(feature = "photos")]
#[native_components(ios)]
fn components(components: &nsh_platform_ios::Components) {
    photos::register_components(components);
}

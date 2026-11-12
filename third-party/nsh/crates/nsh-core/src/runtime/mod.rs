//! The runtime's modules written in Rust: `nsh/android`'s `BackHandler`,
//! `nsh/accessibility`'s commands, `nsh/device`'s `openUrl`, `nsh`'s
//! `Image` and `WebView` functions, all of `nsh/clipboard`, `nsh/picker`, `nsh`'s
//! `Speech`, `UrlScheme`, `setFpsEnabled` and `nsh/storage`,
//! `nsh/desktop`'s `Application`, the surface-independent `os` metadata,
//! `net`'s sockets, `websocket`'s connections, `fs/promises`' files and
//! `nsh/host`'s calls. Their JS face is made
//! from their specs like a UI set's (`nsh-js` `components.rs`), and so are
//! their declarations ([`crate::element::declarations`]); `nsh-js` adds what has
//! to run in JS (the app's listeners, reactive accessors).

use std::sync::OnceLock;

use crate::element::Registry;

mod accessibility;
mod android;
mod audio;
mod clipboard;
mod desktop;
mod device;
mod fonts;
mod fps;
pub(crate) mod fs;
mod haptics;
mod host;
mod image;
mod net;
mod notifications;
mod os;
mod picker;
mod process;
mod speech;
mod storage;
mod updater;
mod url_scheme;
mod websocket;
mod webview;

pub use updater::{PackageVersion, UpdaterHost, UpdaterSink};

/// The [`crate::element::Quotas`] kind WebSockets count under: the `websocket`
/// module's connections and the global `WebSocket`'s (`nsh-js`) share
/// [`MAX_WEBSOCKETS`] per VM.
pub const WEBSOCKETS: &str = "websocket.connections";
/// WebSockets open or connecting at once in one VM, of both APIs.
pub const MAX_WEBSOCKETS: usize = 32;

/// The runtime's Rust modules, one registry per JS module (its
/// [`Registry::namespace`]: `nsh/android`).
pub fn registries() -> &'static [Registry] {
    static REGISTRIES: OnceLock<Vec<Registry>> = OnceLock::new();
    REGISTRIES.get_or_init(|| {
        let mut desktop = Registry::runtime("nsh/desktop");
        desktop.module::<desktop::Application>();
        // `nsh`'s modules written in Rust; the rest of `nsh` is `nsh-js`'s.
        let mut nsh = Registry::runtime("nsh");
        nsh.module::<crate::element::Keyboard>()
            .module::<image::Image>()
            .module::<device::Device>()
            .module::<fonts::Fonts>()
            .module::<accessibility::Accessibility>()
            .module::<clipboard::Clipboard>()
            .module::<picker::Picker>()
            .module::<speech::Speech>()
            .class::<audio::Sound>()
            .class::<audio::AudioPlayer>()
            .module::<notifications::Notifications>()
            .module::<url_scheme::UrlScheme>()
            .module::<webview::WebView>()
            .module::<storage::Storage>()
            .module::<host::Host>()
            .module::<fps::Fps>()
            // The environment's accessors and hooks, made by `nsh-js`.
            .reexport(&["safeArea", "safeAreaInsets", "keyboardFrame"], &[]);
        let mut mobile = Registry::runtime("nsh/mobile");
        mobile
            .register::<crate::mobile::TabBar>()
            .module::<android::BackHandler>()
            .module::<haptics::Haptics>();
        let mut os = Registry::runtime("os");
        os.module::<os::Os>();
        let mut process = Registry::runtime("process");
        process
            .module::<process::Process>()
            .native_values(&["nextTick"]);
        let mut net = Registry::runtime("net");
        net.module::<net::Net>();
        let mut fs = Registry::runtime("fs/promises");
        fs.module::<fs::Fs>();
        let websocket = {
            let mut websocket = Registry::runtime("websocket");
            websocket.module::<websocket::WebSocket>();
            websocket
        };
        let mut updater = Registry::runtime("nsh/updater");
        updater.module::<updater::Updater>();
        vec![
            nsh, desktop, mobile, os, net, process, fs, websocket, updater,
        ]
    })
}

#[cfg(test)]
mod tests {
    /// Every export TS sees has a doc comment (the declarations show it).
    #[test]
    fn every_export_is_documented() {
        for registry in super::registries() {
            assert_eq!(
                registry.undocumented(),
                Vec::<String>::new(),
                "{:?}",
                registry.namespace()
            );
        }
    }
}

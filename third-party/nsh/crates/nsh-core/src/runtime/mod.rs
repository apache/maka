//! The runtime's modules written in Rust: `nsh/android`'s `Toast`,
//! `nsh/accessibility`'s commands, `nsh/device`'s `openUrl`, all of
//! `nsh/image`, `nsh/clipboard`, `nsh/picker` and `nsh/storage`,
//! `nsh/desktop`'s `Window`, the surface-independent `os` metadata,
//! `net`'s sockets, `websocket`'s connections, `fs/promises`' files and
//! `nsh/host`'s calls. Their JS face is made
//! from their specs like a UI set's (`nsh-js` `components.rs`), and so are
//! their declarations ([`crate::ui::declarations`]); `nsh-js` adds what has
//! to run in JS (the app's listeners, reactive accessors).

use std::sync::OnceLock;

use crate::ui::Registry;

mod accessibility;
mod android;
mod clipboard;
mod desktop;
mod device;
mod fs;
pub(crate) mod host;
mod image;
mod net;
mod os;
mod picker;
mod process;
mod storage;
mod websocket;

/// The [`crate::ui::Quotas`] kind WebSockets count under: the `websocket`
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
        let mut android = Registry::runtime("nsh/android");
        android
            .module::<android::Toast>()
            .module::<android::BackHandler>();
        let mut accessibility = Registry::runtime("nsh/accessibility");
        accessibility.module::<accessibility::Accessibility>();
        let mut device = Registry::runtime("nsh/device");
        device.module::<device::Device>();
        let mut image = Registry::runtime("nsh/image");
        image.module::<image::Image>();
        let mut clipboard = Registry::runtime("nsh/clipboard");
        clipboard.module::<clipboard::Clipboard>();
        let mut picker = Registry::runtime("nsh/picker");
        picker.module::<picker::Picker>();
        let mut storage = Registry::runtime("nsh/storage");
        storage.module::<storage::Storage>();
        let mut desktop = Registry::runtime("nsh/desktop");
        desktop.module::<desktop::Window>();
        let mut mobile = Registry::runtime("nsh/mobile");
        mobile.register::<crate::mobile::TabBar>();
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
        let mut host = Registry::runtime("nsh/host");
        host.module::<host::Host>();
        vec![
            android,
            accessibility,
            device,
            image,
            clipboard,
            picker,
            storage,
            desktop,
            mobile,
            os,
            net,
            process,
            fs,
            websocket,
            host,
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

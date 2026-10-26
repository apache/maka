//! The embedding API's C ABI (feature `embed`).
//!
//! Apps use the `NativeShell` Swift module (`swift/NativeShell.swift`):
//! `NshAppView`, `NshTrust`, `NshPackage`. It is built over the C ABI here
//! (`include/nsh.h`, the `NativeShellC` module), which is internal: Swift
//! imports it privately and apps never see it. `cargo xtask dist` links both
//! into one static `NativeShell.framework` per platform, in an XCFramework.
//!
//! Errors cross as strings allocated here (`NULL` when there is none), freed
//! with [`nsh_string_free`]; Swift turns them into thrown `NshError`s. App
//! functions must be called on the main thread; trust and package functions
//! on any thread.
use std::{
    ffi::{CStr, CString, c_char, c_void},
    path::{Path, PathBuf},
    sync::Mutex,
};

use nsh_engine::{
    Bundle,
    package::{PublicKey, Revocations, TrustStore},
};
use objc2::MainThreadMarker;
use objc2_core_foundation::CGRect;
use objc2_ui_kit::UIView;

use crate::{AppView, AssetBase, SurfaceOptions};

/// An embedded nsh app (opaque to C).
pub struct NshApp {
    view: AppView,
}

fn main_thread() -> MainThreadMarker {
    MainThreadMarker::new().expect("nsh app functions must be called on the main thread")
}

fn init_logging() {
    #[cfg(feature = "dev")]
    crate::dev::init_logging();
    #[cfg(not(feature = "dev"))]
    {
        struct Stderr;
        impl log::Log for Stderr {
            fn enabled(&self, m: &log::Metadata<'_>) -> bool {
                m.level() <= log::Level::Warn || m.target() == "js"
            }
            fn log(&self, r: &log::Record<'_>) {
                if self.enabled(r.metadata()) {
                    eprintln!("[nsh] {} {}: {}", r.level(), r.target(), r.args());
                }
            }
            fn flush(&self) {}
        }
        static LOGGER: Stderr = Stderr;
        // Keep the host app's logger if it installed one.
        if log::set_logger(&LOGGER).is_ok() {
            log::set_max_level(log::LevelFilter::Info);
        }
    }
}

/// An error for C: an owned string ([`nsh_string_free`]).
fn error(message: impl std::fmt::Display) -> *mut c_char {
    CString::new(message.to_string().replace('\0', " "))
        .unwrap_or_default()
        .into_raw()
}

/// `Ok` as `NULL`, an error as a string.
fn status(result: Result<(), String>) -> *mut c_char {
    match result {
        Ok(()) => std::ptr::null_mut(),
        Err(message) => error(message),
    }
}

/// # Safety
///
/// `s` must be a NUL-terminated string.
unsafe fn utf8<'a>(s: *const c_char, what: &str) -> Result<&'a str, String> {
    // SAFETY: guaranteed by the caller.
    unsafe { CStr::from_ptr(s) }
        .to_str()
        .map_err(|_| format!("{what} is not UTF-8"))
}

/// Frees a string returned by these functions.
///
/// # Safety
///
/// `s` must be `NULL` or a string from this library, not freed before.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_string_free(s: *mut c_char) {
    if !s.is_null() {
        // SAFETY: guaranteed by the caller.
        drop(unsafe { CString::from_raw(s) });
    }
}

/// Creates an app view with `frame` (it then follows its superview's
/// size). `trace` logs per-commit timings. Free with [`nsh_app_destroy`].
#[unsafe(no_mangle)]
pub extern "C" fn nsh_app_create(frame: CGRect, trace: bool) -> *mut NshApp {
    init_logging();
    let options = SurfaceOptions {
        trace,
        ..SurfaceOptions::default()
    };
    let view = AppView::new(main_thread(), frame, options);
    Box::into_raw(Box::new(NshApp { view }))
}

/// The view to add to a hierarchy. Owned by `app`.
///
/// # Safety
///
/// `app` must come from [`nsh_app_create`] and not be destroyed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_app_view(app: *mut NshApp) -> *mut UIView {
    // SAFETY: guaranteed by the caller.
    let app = unsafe { &*app };
    std::ptr::from_ref(app.view.view()).cast_mut()
}

/// Stops the app, removes its view and frees `app`.
///
/// # Safety
///
/// `app` must come from [`nsh_app_create`] and not be used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_app_destroy(app: *mut NshApp) {
    if app.is_null() {
        return;
    }
    // SAFETY: guaranteed by the caller.
    let app = unsafe { Box::from_raw(app) };
    app.view.view().removeFromSuperview();
}

/// Runs a bundle written by `nsh build`, replacing the running app; assets
/// are read from `assets` next to it. Bytecode (`bundle.nshc`) only loads from
/// inside the app's own bundle: elsewhere only JS source does (signed
/// bytecode comes in packages). Returns why it cannot, or `NULL`.
///
/// # Safety
///
/// `app` must come from [`nsh_app_create`]; `path` must be a NUL-terminated
/// string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_app_load_bundle(app: *mut NshApp, path: *const c_char) -> *mut c_char {
    // SAFETY: guaranteed by the caller.
    let (app, path) = unsafe { (&*app, utf8(path, "the bundle path")) };
    status(path.and_then(|path| {
        let path = Path::new(path);
        let read = if crate::in_app_bundle(path) {
            // SAFETY: a resource of the (system-verified, read-only) app bundle.
            unsafe { Bundle::read_trusted(path) }
        } else {
            Bundle::read(path)
        };
        let bundle = read.map_err(|err| format!("cannot read bundle {}: {err}", path.display()))?;
        app.view.set_asset_base(
            path.parent()
                .map(|dir| AssetBase::Directory(dir.join("assets"))),
        );
        app.view.load(bundle);
        Ok(())
    }))
}

/// What the apps `app` loads are granted at most: JSON in the form of
/// `nsh.json`'s `capabilities` (`NULL`: what each app declares). Applies from
/// the next load. Returns why the grant is invalid (nothing changes), or
/// `NULL`.
///
/// # Safety
///
/// `app` must come from [`nsh_app_create`]; `json` must be `NULL` or a
/// NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_app_set_granted_capabilities(
    app: *mut NshApp,
    json: *const c_char,
) -> *mut c_char {
    // SAFETY: guaranteed by the caller.
    let app = unsafe { &*app };
    let granted = if json.is_null() {
        Ok(None)
    } else {
        // SAFETY: guaranteed by the caller.
        unsafe { utf8(json, "the grant") }.and_then(|json| {
            nsh_engine::parse_capabilities(json)
                .map(Some)
                .map_err(|err| format!("invalid grant: {err}"))
        })
    };
    status(granted.map(|granted| app.view.set_granted_capabilities(granted)))
}

/// The VM limits of the apps `app` loads next: heap (MB), stack (KB), the
/// time budgets (ms) of loading and of every other call into JS, and the
/// node quota; 0 keeps a default.
///
/// # Safety
///
/// `app` must come from [`nsh_app_create`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_app_set_limits(
    app: *mut NshApp,
    memory_mb: u32,
    stack_kb: u32,
    load_ms: u32,
    call_ms: u32,
    max_nodes: u32,
) {
    // SAFETY: guaranteed by the caller.
    let app = unsafe { &*app };
    let set = |v: u32| (v > 0).then_some(v as usize);
    let ms = |v: u32| (v > 0).then(|| std::time::Duration::from_millis(v.into()));
    let limits = nsh_engine::HostLimits {
        memory_bytes: set(memory_mb).map(|mb| mb << 20),
        stack_bytes: set(stack_kb).map(|kb| kb << 10),
        load_budget: ms(load_ms),
        call_budget: ms(call_ms),
        max_nodes: set(max_nodes),
    };
    app.view.set_limits(limits.limits());
}

/// The directory the storage (`nsh/storage`) of the apps `app` loads is
/// kept in (`storage.json` in it); `NULL`: each app's own,
/// `nsh/<app id>` in the embedding app's Application Support (the id of
/// `nsh.json`, `nsh/default` without one). Applies from the next load.
/// Returns an error for a path that is not UTF-8, or `NULL`.
///
/// # Safety
///
/// `app` must come from [`nsh_app_create`]; `path` must be `NULL` or a
/// NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_app_set_storage_directory(
    app: *mut NshApp,
    path: *const c_char,
) -> *mut c_char {
    // SAFETY: guaranteed by the caller.
    let app = unsafe { &*app };
    let dir = if path.is_null() {
        Ok(None)
    } else {
        // SAFETY: guaranteed by the caller.
        unsafe { utf8(path, "the storage directory") }.map(|path| Some(PathBuf::from(path)))
    };
    status(dir.map(|dir| app.view.set_storage_directory(dir)))
}

/// [`NshCacheOptions::location`]: the system's cache directory (`nsh` in
/// the app's Caches).
pub const NSH_CACHE_LOCATION_SYSTEM: u32 = 0;
/// [`NshCacheOptions::location`]: [`NshCacheOptions::directory`].
pub const NSH_CACHE_LOCATION_DIRECTORY: u32 = 1;
/// [`NshCacheOptions::location`]: nothing on disk.
pub const NSH_CACHE_LOCATION_OFF: u32 = 2;
/// A cache's policy ([`NshCacheOptions::images`]): its default size.
pub const NSH_CACHE_POLICY_DEFAULT: u32 = 0;
/// A cache's policy: at most its `_max_mb` megabytes.
pub const NSH_CACHE_POLICY_MAX_SIZE: u32 = 1;
/// A cache's policy: not kept on disk.
pub const NSH_CACHE_POLICY_OFF: u32 = 2;

/// Where the apps an `NshApp` loads keep their caches and how much each
/// keeps (`nsh.h`'s `NshCacheOptions`). `size` is the struct's size as the
/// caller knows it: fields past it read as zero (their defaults), so the
/// struct can grow.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct NshCacheOptions {
    /// `sizeof(NshCacheOptions)`.
    pub size: u32,
    /// `NSH_CACHE_LOCATION_*`.
    pub location: u32,
    /// The directory, for `NSH_CACHE_LOCATION_DIRECTORY`: NUL-terminated
    /// UTF-8.
    pub directory: *const c_char,
    /// `NSH_CACHE_POLICY_*` of the images the apps download.
    pub images: u32,
    /// Megabytes (MiB) of images kept, for `NSH_CACHE_POLICY_MAX_SIZE`.
    pub images_max_mb: u32,
}

/// Where the apps `app` loads keep their caches and how much each keeps.
/// Applies from the next load. Returns why `options` are invalid (nothing
/// changes), or `NULL`.
///
/// # Safety
///
/// `app` must come from [`nsh_app_create`]; `options` must point to at
/// least `options->size` readable bytes (and at least its `size` field),
/// its `directory` `NULL` or a NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_app_set_cache(
    app: *mut NshApp,
    options: *const NshCacheOptions,
) -> *mut c_char {
    use nsh_engine::{ByteSize, CacheLocation, CacheOptions, CachePolicy};
    // SAFETY: guaranteed by the caller.
    let app = unsafe { &*app };
    if options.is_null() {
        return status(Err("no cache options".to_owned()));
    }
    // Read what the caller's struct has; the rest stays zero (defaults).
    // SAFETY: `options` points to at least its `size` field.
    let given = unsafe { (*options).size } as usize;
    let mut read = std::mem::MaybeUninit::<NshCacheOptions>::zeroed();
    let len = given.min(std::mem::size_of::<NshCacheOptions>());
    // SAFETY: the caller's struct has `len` readable bytes; `read` is as
    // large; all-zero bytes are a valid `NshCacheOptions`.
    let options = unsafe {
        std::ptr::copy_nonoverlapping(options as *const u8, read.as_mut_ptr() as *mut u8, len);
        read.assume_init()
    };
    let location = match options.location {
        NSH_CACHE_LOCATION_SYSTEM => Ok(CacheLocation::System),
        NSH_CACHE_LOCATION_DIRECTORY if options.directory.is_null() => {
            Err("NSH_CACHE_LOCATION_DIRECTORY without a directory".to_owned())
        }
        // SAFETY: guaranteed by the caller.
        NSH_CACHE_LOCATION_DIRECTORY => unsafe { utf8(options.directory, "the cache directory") }
            .map(|dir| CacheLocation::Dir(PathBuf::from(dir))),
        NSH_CACHE_LOCATION_OFF => Ok(CacheLocation::Off),
        other => Err(format!("unknown cache location {other}")),
    };
    let images = match options.images {
        NSH_CACHE_POLICY_DEFAULT => Ok(CachePolicy::Default),
        NSH_CACHE_POLICY_MAX_SIZE => Ok(CachePolicy::MaxSize(ByteSize::mib(u64::from(
            options.images_max_mb,
        )))),
        NSH_CACHE_POLICY_OFF => Ok(CachePolicy::Off),
        other => Err(format!("unknown cache policy {other}")),
    };
    status(location.and_then(|location| {
        images.map(|images| {
            app.view
                .set_cache(CacheOptions::at(location).with_images(images))
        })
    }))
}

/// The embedding app's locale, which stands in for the user's: a BCP 47
/// tag or a platform identifier (`zh-Hans-CN`, `en_US`); `NULL` follows the
/// system's again. Applies at once and to every app loaded later. Returns
/// why `tag` is no locale (nothing changes), or `NULL`.
///
/// # Safety
///
/// `app` must come from [`nsh_app_create`]; `tag` must be `NULL` or a
/// NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_app_set_locale(app: *mut NshApp, tag: *const c_char) -> *mut c_char {
    // SAFETY: guaranteed by the caller.
    let app = unsafe { &*app };
    let locale = if tag.is_null() {
        Ok(None)
    } else {
        // SAFETY: guaranteed by the caller.
        unsafe { utf8(tag, "the locale") }.and_then(|tag| {
            nsh_engine::Locale::parse(tag)
                .map(Some)
                .ok_or_else(|| format!("not a locale: {tag}"))
        })
    };
    status(locale.map(|locale| app.view.set_locale(locale)))
}

/// The embedding app's text size relative to the default (1.0), which
/// stands in for Dynamic Type's; 0 (or less) follows the system's again.
/// Applies at once and to every app loaded later.
///
/// # Safety
///
/// `app` must come from [`nsh_app_create`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_app_set_font_scale(app: *mut NshApp, scale: f32) {
    // SAFETY: guaranteed by the caller.
    let app = unsafe { &*app };
    app.view
        .set_font_scale((scale.is_finite() && scale > 0.0).then_some(scale));
}

/// The embedding app's theme overrides: a theme file of shadcn/ui's
/// (`{ "cssVars": { "theme": { … }, "light": { … }, "dark": { … } } }`, as
/// `nsh.json`'s `"theme"`), whose tokens win over the app's of the same
/// names, light and dark; `NULL` gives the app its own theme back. Applies
/// at once (classes naming the tokens are resolved again) and to every app
/// loaded later, from its first frame. Returns why the file does not parse
/// (nothing changes), or `NULL`.
///
/// # Safety
///
/// `app` must come from [`nsh_app_create`]; `json` must be `NULL` or a
/// NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_app_set_theme_overrides(
    app: *mut NshApp,
    json: *const c_char,
) -> *mut c_char {
    // SAFETY: guaranteed by the caller.
    let app = unsafe { &*app };
    let json = if json.is_null() {
        Ok(None)
    } else {
        // SAFETY: guaranteed by the caller.
        unsafe { utf8(json, "the theme") }.map(Some)
    };
    status(json.and_then(|json| {
        app.view
            .set_theme_overrides(json)
            .map_err(|err| format!("invalid theme: {err}"))
    }))
}

/// Development: loads from a `nsh dev` server (`ws://host:port/ws`) and
/// reloads on every change, showing errors over the app. Returns an error
/// when the library was built without development support, or `NULL`.
///
/// # Safety
///
/// `app` must come from [`nsh_app_create`]; `url` must be a NUL-terminated
/// string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_app_connect_dev_server(
    app: *mut NshApp,
    url: *const c_char,
) -> *mut c_char {
    // SAFETY: guaranteed by the caller.
    let (app, url) = unsafe { (&*app, utf8(url, "the dev server URL")) };
    #[cfg(feature = "dev")]
    {
        status(url.map(|url| {
            app.view.connect_dev_server(url.to_owned());
        }))
    }
    #[cfg(not(feature = "dev"))]
    {
        let _ = (app, url);
        error("this build of nsh has no development support (link NativeShellDev.xcframework)")
    }
}

/// A C callback and its context; `release` (if any) runs when it is dropped.
struct Callback {
    handler: unsafe extern "C" fn(context: *mut c_void, message: *const c_char),
    context: *mut c_void,
    release: Option<unsafe extern "C" fn(context: *mut c_void)>,
}

impl Drop for Callback {
    fn drop(&mut self) {
        if let Some(release) = self.release {
            // SAFETY: the contract of `nsh_app_set_error_handler`.
            unsafe { release(self.context) };
        }
    }
}

/// Receives fatal app errors (load failures, uncaught JS exceptions) on the
/// main thread, replacing the previous handler. `context` is passed back
/// unchanged; `release` (optional) is called with it when the handler is
/// replaced or the app destroyed.
///
/// # Safety
///
/// `app` must come from [`nsh_app_create`]; `handler` must be safe to call
/// with `context` on the main thread until `release` is called (or, without
/// `release`, until `app` is destroyed).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_app_set_error_handler(
    app: *mut NshApp,
    handler: Option<unsafe extern "C" fn(context: *mut c_void, message: *const c_char)>,
    context: *mut c_void,
    release: Option<unsafe extern "C" fn(context: *mut c_void)>,
) {
    // SAFETY: guaranteed by the caller.
    let app = unsafe { &*app };
    let Some(handler) = handler else {
        app.view.set_error_handler(|_| {});
        if let Some(release) = release {
            // SAFETY: guaranteed by the caller.
            unsafe { release(context) };
        }
        return;
    };
    let callback = Callback {
        handler,
        context,
        release,
    };
    app.view.set_error_handler(move |message| {
        let message = CString::new(message.replace('\0', " ")).unwrap_or_default();
        // SAFETY: guaranteed by the caller of `nsh_app_set_error_handler`.
        unsafe { (callback.handler)(callback.context, message.as_ptr()) };
    });
}

/// The status bar style the app asked for, for a host view controller's
/// `preferredStatusBarStyle`.
#[unsafe(no_mangle)]
pub extern "C" fn nsh_status_bar_style() -> objc2_ui_kit::UIStatusBarStyle {
    main_thread();
    crate::preferred_status_bar_style()
}

/// Whether the app hid the status bar, for `prefersStatusBarHidden`.
#[unsafe(no_mangle)]
pub extern "C" fn nsh_status_bar_hidden() -> bool {
    main_thread();
    crate::prefers_status_bar_hidden()
}

/// How status bar changes animate, for `preferredStatusBarUpdateAnimation`.
#[unsafe(no_mangle)]
pub extern "C" fn nsh_status_bar_animation() -> objc2_ui_kit::UIStatusBarAnimation {
    main_thread();
    crate::status_bar_animation()
}

/// The keys, revocations and accepted builds that signed packages are
/// verified against (opaque to C). Usable from any thread.
pub struct NshTrust {
    store: Mutex<TrustStore>,
    /// Where packages' assets are extracted.
    packages: PathBuf,
}

/// Creates a trust store kept in `state_dir` (created if needed): the
/// newest revocation list and the highest build accepted per app persist
/// there, and packages' assets are extracted under it. Trusts no key until
/// [`nsh_trust_add_root`]. On failure returns `NULL` and sets `*error`.
/// Free with [`nsh_trust_destroy`].
///
/// # Safety
///
/// `state_dir` must be a NUL-terminated string; `error` a valid pointer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_trust_create(
    state_dir: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut NshTrust {
    init_logging();
    // SAFETY: guaranteed by the caller.
    let opened = unsafe { utf8(state_dir, "the state directory") }.and_then(|dir| {
        let dir = PathBuf::from(dir);
        TrustStore::open(&dir)
            .map(|store| NshTrust {
                store: Mutex::new(store),
                packages: dir.join("packages"),
            })
            .map_err(|err| format!("cannot open the trust store in {}: {err}", dir.display()))
    });
    match opened {
        Ok(trust) => Box::into_raw(Box::new(trust)),
        Err(message) => {
            // SAFETY: guaranteed by the caller.
            unsafe { *error_out = error(message) };
            std::ptr::null_mut()
        }
    }
}

/// Trusts a root public key (base64, as `nsh keygen` writes it in
/// `<name>.pub`): packages whose release key it certified load. Returns why
/// the key is invalid, or `NULL`.
///
/// # Safety
///
/// `trust` must come from [`nsh_trust_create`]; `public_key` must be a
/// NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_trust_add_root(
    trust: *const NshTrust,
    public_key: *const c_char,
) -> *mut c_char {
    // SAFETY: guaranteed by the caller.
    let (trust, key) = unsafe { (&*trust, utf8(public_key, "the root key")) };
    status(key.and_then(|key| {
        let key = PublicKey::from_base64(key).map_err(|err| format!("invalid root key: {err}"))?;
        trust.store.lock().expect("trust").add_root(key);
        Ok(())
    }))
}

/// Applies a revocation list (the JSON `nsh revoke` writes) signed by a
/// trusted root and newer than the one the store has. Returns why it is
/// refused, or `NULL`.
///
/// # Safety
///
/// `trust` must come from [`nsh_trust_create`]; `json` must be a
/// NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_trust_update_revocations(
    trust: *const NshTrust,
    json: *const c_char,
) -> *mut c_char {
    // SAFETY: guaranteed by the caller.
    let (trust, json) = unsafe { (&*trust, utf8(json, "the revocation list")) };
    status(json.and_then(|json| {
        let list = Revocations::from_json(json).map_err(|e| e.to_string())?;
        trust
            .store
            .lock()
            .expect("trust")
            .update_revocations(list)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }))
}

/// Frees `trust`.
///
/// # Safety
///
/// `trust` must come from [`nsh_trust_create`] and not be used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_trust_destroy(trust: *mut NshTrust) {
    if !trust.is_null() {
        // SAFETY: guaranteed by the caller.
        drop(unsafe { Box::from_raw(trust) });
    }
}

/// A verified package, ready to run (opaque to C).
pub struct NshPackage {
    bundle: Bundle,
    assets: PathBuf,
    id: CString,
    name: CString,
    version: CString,
    build: u64,
}

/// Verifies the signed package at `path` (`.nshpkg`, written by
/// `nsh publish`): its release key must be certified by a trusted root for
/// the app's id, not revoked, and its build not older than one accepted
/// before. Extracts its assets and accepts it (older builds of the app are
/// refused from now on). Slow for large packages: call it off the main
/// thread. On refusal returns `NULL` and sets `*error`. Run the package with
/// [`nsh_app_run_package`] or free it with [`nsh_package_free`].
///
/// # Safety
///
/// `trust` must come from [`nsh_trust_create`]; `path` must be a
/// NUL-terminated string; `error` a valid pointer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_trust_open_package(
    trust: *const NshTrust,
    path: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut NshPackage {
    // SAFETY: guaranteed by the caller.
    let (trust, path) = unsafe { (&*trust, utf8(path, "the package path")) };
    let opened = path.and_then(|path| {
        let bytes =
            std::fs::read(path).map_err(|err| format!("cannot read package {path}: {err}"))?;
        let mut store = trust.store.lock().expect("trust");
        let loaded = nsh_engine::load_package(&mut store, &bytes, &trust.packages)
            .map_err(|err| format!("refused package: {err}"))?;
        let app = loaded.app;
        let c = |s: String| CString::new(s).unwrap_or_default();
        Ok(NshPackage {
            bundle: loaded.bundle,
            assets: loaded.assets,
            id: c(app.id),
            name: c(app.name),
            version: c(app.version),
            build: app.build,
        })
    });
    match opened {
        Ok(package) => Box::into_raw(Box::new(package)),
        Err(message) => {
            // SAFETY: guaranteed by the caller.
            unsafe { *error_out = error(message) };
            std::ptr::null_mut()
        }
    }
}

/// The package's app id. Owned by `package`.
///
/// # Safety
///
/// `package` must come from [`nsh_trust_open_package`] and not be freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_package_app_id(package: *const NshPackage) -> *const c_char {
    // SAFETY: guaranteed by the caller.
    unsafe { &*package }.id.as_ptr()
}

/// The package's app name. Owned by `package`.
///
/// # Safety
///
/// `package` must come from [`nsh_trust_open_package`] and not be freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_package_app_name(package: *const NshPackage) -> *const c_char {
    // SAFETY: guaranteed by the caller.
    unsafe { &*package }.name.as_ptr()
}

/// The package's version string. Owned by `package`.
///
/// # Safety
///
/// `package` must come from [`nsh_trust_open_package`] and not be freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_package_app_version(package: *const NshPackage) -> *const c_char {
    // SAFETY: guaranteed by the caller.
    unsafe { &*package }.version.as_ptr()
}

/// The package's build number.
///
/// # Safety
///
/// `package` must come from [`nsh_trust_open_package`] and not be freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_package_app_build(package: *const NshPackage) -> u64 {
    // SAFETY: guaranteed by the caller.
    unsafe { &*package }.build
}

/// Runs a verified package, replacing the running app. Takes `package`.
///
/// # Safety
///
/// `app` must come from [`nsh_app_create`], `package` from
/// [`nsh_trust_open_package`] (not used afterwards).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_app_run_package(app: *mut NshApp, package: *mut NshPackage) {
    // SAFETY: guaranteed by the caller.
    let (app, package) = unsafe { (&*app, Box::from_raw(package)) };
    app.view
        .set_asset_base(Some(AssetBase::Directory(package.assets)));
    app.view.load(package.bundle);
}

/// Frees a package that will not run.
///
/// # Safety
///
/// `package` must be `NULL` or come from [`nsh_trust_open_package`] (not
/// used afterwards).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_package_free(package: *mut NshPackage) {
    if !package.is_null() {
        // SAFETY: guaranteed by the caller.
        drop(unsafe { Box::from_raw(package) });
    }
}

/// What nsh calls on a component the embedding app made (Swift
/// `NshComponent`). Every function gets the handle `create` returned.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct NshComponentCallbacks {
    /// Makes a component for an element; takes `context` (free it with
    /// [`nsh_component_context_free`]). Returns its handle.
    pub create: unsafe extern "C" fn(
        factory: *mut c_void,
        context: *mut NshComponentContext,
    ) -> *mut c_void,
    /// The component's view (owned by the component).
    pub view: unsafe extern "C" fn(component: *mut c_void) -> *mut UIView,
    /// Prop `name` changed: its JSON, or `NULL` when removed.
    pub set_prop:
        unsafe extern "C" fn(component: *mut c_void, name: *const c_char, json: *const c_char),
    /// JS called `ref.command(name, args)`; `json` is the arguments.
    pub command:
        unsafe extern "C" fn(component: *mut c_void, name: *const c_char, json: *const c_char),
    /// The element is gone: release the component.
    pub destroy: unsafe extern "C" fn(component: *mut c_void),
    /// The registration is replaced or the app destroyed: release `factory`.
    pub release_factory: Option<unsafe extern "C" fn(factory: *mut c_void)>,
}

/// What a component tells its app (opaque to C): owned by the component.
pub struct NshComponentContext(crate::ComponentContext);

/// A registration: the factory pointer and its callbacks.
struct CFactory {
    factory: *mut c_void,
    callbacks: NshComponentCallbacks,
}

impl Drop for CFactory {
    fn drop(&mut self) {
        if let Some(release) = self.callbacks.release_factory {
            // SAFETY: the contract of `nsh_app_register_component`.
            unsafe { release(self.factory) };
        }
    }
}

/// A component made through C callbacks.
struct CComponent {
    handle: *mut c_void,
    callbacks: NshComponentCallbacks,
    view: objc2::rc::Retained<UIView>,
}

impl crate::NativeComponent for CComponent {
    fn view(&self) -> &UIView {
        &self.view
    }

    fn set_prop(&mut self, name: &str, value: Option<&nsh_core::JsonValue>) {
        let name = CString::new(name).unwrap_or_default();
        let json = value.map(|v| CString::new(v.to_string()).unwrap_or_default());
        // SAFETY: the contract of `nsh_app_register_component`.
        unsafe {
            (self.callbacks.set_prop)(
                self.handle,
                name.as_ptr(),
                json.as_ref().map_or(std::ptr::null(), |j| j.as_ptr()),
            )
        };
    }

    fn command(&mut self, name: &str, args: &nsh_core::JsonValue) {
        let name = CString::new(name).unwrap_or_default();
        let json = CString::new(args.to_string()).unwrap_or_default();
        // SAFETY: the contract of `nsh_app_register_component`.
        unsafe { (self.callbacks.command)(self.handle, name.as_ptr(), json.as_ptr()) };
    }
}

impl Drop for CComponent {
    fn drop(&mut self) {
        // SAFETY: the contract of `nsh_app_register_component`.
        unsafe { (self.callbacks.destroy)(self.handle) };
    }
}

/// Registers native component `name` (`nativeComponent(name, ...)` in JS):
/// `callbacks.create(factory, context)` makes one for every element created
/// from now on.
///
/// # Safety
///
/// `app` must come from [`nsh_app_create`]; `name` must be a NUL-terminated
/// string; the callbacks must be safe to call on the main thread with
/// `factory` (and the handles `create` returns) until `release_factory`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_app_register_component(
    app: *mut NshApp,
    name: *const c_char,
    factory: *mut c_void,
    callbacks: *const NshComponentCallbacks,
) {
    // SAFETY: guaranteed by the caller.
    let (app, name, callbacks) = unsafe { (&*app, CStr::from_ptr(name), *callbacks) };
    let Ok(name) = name.to_str() else {
        return log::error!("component name is not UTF-8");
    };
    let registration = std::rc::Rc::new(CFactory { factory, callbacks });
    app.view.register_component(
        name,
        std::rc::Rc::new(move |context| {
            let context = Box::into_raw(Box::new(NshComponentContext(context)));
            let r = &registration;
            // SAFETY: guaranteed by the caller of `nsh_app_register_component`.
            let handle = unsafe { (r.callbacks.create)(r.factory, context) };
            // SAFETY: as above; the component owns its view.
            let view = unsafe { objc2::rc::Retained::retain((r.callbacks.view)(handle)) }
                .expect("a component's view");
            Box::new(CComponent {
                handle,
                callbacks: r.callbacks,
                view,
            })
        }),
    );
}

/// Emits event `name` with `json` data (`NULL`: no data); the JS handler
/// `on<Name>` gets it. Any thread.
///
/// # Safety
///
/// `context` must be a live context from `create`; the strings
/// NUL-terminated (`json` valid JSON or `NULL`).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_component_emit(
    context: *const NshComponentContext,
    name: *const c_char,
    json: *const c_char,
) {
    // SAFETY: guaranteed by the caller.
    let (context, name) = unsafe { (&*context, CStr::from_ptr(name)) };
    let data = if json.is_null() {
        nsh_core::JsonValue::Null
    } else {
        // SAFETY: guaranteed by the caller.
        let json = unsafe { CStr::from_ptr(json) }.to_string_lossy();
        serde_json::from_str(&json).unwrap_or_else(|err| {
            log::error!("component event data is not JSON: {err}");
            nsh_core::JsonValue::Null
        })
    };
    context.0.emit(&name.to_string_lossy(), data);
}

/// The component's own size (points), used where its style leaves a
/// dimension open. Any thread.
///
/// # Safety
///
/// `context` must be a live context from `create`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_component_set_size(
    context: *const NshComponentContext,
    width: f64,
    height: f64,
) {
    // SAFETY: guaranteed by the caller.
    unsafe { &*context }.0.set_size(width as f32, height as f32);
}

/// Frees a component's context.
///
/// # Safety
///
/// `context` must come from `create` and not be used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_component_context_free(context: *mut NshComponentContext) {
    if !context.is_null() {
        // SAFETY: guaranteed by the caller.
        drop(unsafe { Box::from_raw(context) });
    }
}

/// JSON text from C (`NULL`: `null`), or why it is not JSON.
///
/// # Safety
///
/// `json` must be `NULL` or a NUL-terminated string.
unsafe fn json_arg(json: *const c_char, what: &str) -> Result<nsh_core::JsonValue, String> {
    if json.is_null() {
        return Ok(nsh_core::JsonValue::Null);
    }
    // SAFETY: guaranteed by the caller.
    let text = unsafe { utf8(json, what) }?;
    serde_json::from_str(text).map_err(|err| format!("{what} is not JSON: {err}"))
}

/// The launch parameters of the apps `app` loads from now on (`host.params`
/// in the app, read when it starts): a JSON object, or `NULL` for none.
/// Returns why `json` is not a JSON object (nothing changes), or `NULL`.
///
/// # Safety
///
/// `app` must come from [`nsh_app_create`]; `json` must be `NULL` or a
/// NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_app_set_host_params(
    app: *mut NshApp,
    json: *const c_char,
) -> *mut c_char {
    // SAFETY: guaranteed by the caller.
    let (app, params) = unsafe { (&*app, json_arg(json, "the parameters")) };
    status(
        params
            .and_then(|params| match params {
                nsh_core::JsonValue::Null => Ok(serde_json::Map::new()),
                nsh_core::JsonValue::Object(params) => Ok(params),
                _ => Err("the parameters are a JSON object".to_owned()),
            })
            .map(|params| app.view.host().set_params(params)),
    )
}

/// Sends event `name` with `json` data (`NULL`: `null`) to the running app
/// (`host.on(name, ...)`); kept until it listens to `name`, or for the next
/// app while none runs. Returns why it cannot (an invalid name or data), or
/// `NULL`.
///
/// # Safety
///
/// `app` must come from [`nsh_app_create`]; `name` must be a NUL-terminated
/// string, `json` `NULL` or one.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_app_send_host_event(
    app: *mut NshApp,
    name: *const c_char,
    json: *const c_char,
) -> *mut c_char {
    // SAFETY: guaranteed by the caller.
    let (app, name, data) = unsafe {
        (
            &*app,
            utf8(name, "the event name"),
            json_arg(json, "the event data"),
        )
    };
    status(name.and_then(|name| app.view.host().send(name, data?)))
}

/// A call of the app (`host.call`) its handler answers (opaque to C): once,
/// from any thread, with [`nsh_host_call_resolve`] or
/// [`nsh_host_call_reject`], which free it; [`nsh_host_call_free`] fails it
/// unanswered.
pub struct NshHostCall(nsh_engine::HostCall);

/// The C function a host handler calls.
type HostHandlerFn =
    unsafe extern "C" fn(context: *mut c_void, json: *const c_char, call: *mut NshHostCall);

/// A host handler's C callback and its context; `release` runs when it is
/// dropped (replaced, removed, or the app destroyed).
struct CHostHandler {
    handler: HostHandlerFn,
    context: *mut c_void,
    release: Option<unsafe extern "C" fn(context: *mut c_void)>,
}

// SAFETY: `handler` runs on the main thread only (the engine thread's
// handler hops there) and `release` may run on any thread, as
// `nsh_app_set_host_handler`'s contract says.
unsafe impl Send for CHostHandler {}
// SAFETY: as above; nothing is mutated through a shared reference.
unsafe impl Sync for CHostHandler {}

impl Drop for CHostHandler {
    fn drop(&mut self) {
        if let Some(release) = self.release {
            // SAFETY: the contract of `nsh_app_set_host_handler`.
            unsafe { release(self.context) };
        }
    }
}

/// Handles the app's calls (`host.call(name, data)`) and posts
/// (`host.post(name, data)`) of `name`, replacing the handler it had;
/// `handler` `NULL` removes it (the app's calls of `name` then fail at
/// once). `handler` runs on the main thread with the JSON data and, for a
/// call, the call to answer ([`nsh_host_call_resolve`]; `NULL` for a post).
/// `release` (optional) is called with `context`, on any thread, when the
/// handler is replaced or removed or the app destroyed.
///
/// # Safety
///
/// `app` must come from [`nsh_app_create`]; `name` must be a NUL-terminated
/// string; `handler` must be safe to call with `context` on the main thread,
/// and `release` on any thread, until `release` is called (or, without
/// `release`, until `app` is destroyed).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_app_set_host_handler(
    app: *mut NshApp,
    name: *const c_char,
    handler: Option<HostHandlerFn>,
    context: *mut c_void,
    release: Option<unsafe extern "C" fn(context: *mut c_void)>,
) {
    // SAFETY: guaranteed by the caller.
    let (app, name) = unsafe { (&*app, utf8(name, "the handler name")) };
    let release_now = || {
        if let Some(release) = release {
            // SAFETY: guaranteed by the caller.
            unsafe { release(context) };
        }
    };
    let Ok(name) = name else {
        log::error!("a host handler's name is not UTF-8");
        return release_now();
    };
    let channel = app.view.host();
    let Some(handler) = handler else {
        channel.remove_handler(name);
        return release_now();
    };
    let callback = std::sync::Arc::new(CHostHandler {
        handler,
        context,
        release,
    });
    channel.handle(name, move |mut call| {
        // On the engine thread: the C handler runs on the main thread.
        let callback = callback.clone();
        let json = CString::new(call.take_data().to_string()).unwrap_or_default();
        let call = (!call.is_post()).then(|| NshHostCall(call));
        dispatch2::DispatchQueue::main().exec_async(move || {
            let call = call.map_or(std::ptr::null_mut(), |call| Box::into_raw(Box::new(call)));
            // SAFETY: the contract of `nsh_app_set_host_handler`; the call
            // is the handler's to answer or free.
            unsafe { (callback.handler)(callback.context, json.as_ptr(), call) };
        });
    });
}

/// Answers `call` with `json` (`NULL`: `null`): the app's promise resolves
/// with it (data that is not JSON rejects it). Frees `call`. Any thread.
///
/// # Safety
///
/// `call` must come from a host handler and not be used afterwards; `json`
/// must be `NULL` or a NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_host_call_resolve(call: *mut NshHostCall, json: *const c_char) {
    if call.is_null() {
        return;
    }
    // SAFETY: guaranteed by the caller.
    let (call, value) = unsafe { (Box::from_raw(call), json_arg(json, "the answer")) };
    call.0.reply(value);
}

/// Fails `call` with `message`: the app's promise rejects with an `Error` of
/// it. Frees `call`. Any thread.
///
/// # Safety
///
/// `call` must come from a host handler and not be used afterwards;
/// `message` must be a NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_host_call_reject(call: *mut NshHostCall, message: *const c_char) {
    if call.is_null() {
        return;
    }
    // SAFETY: guaranteed by the caller.
    let call = unsafe { Box::from_raw(call) };
    let message = if message.is_null() {
        String::new()
    } else {
        // SAFETY: guaranteed by the caller.
        unsafe { CStr::from_ptr(message) }
            .to_string_lossy()
            .into_owned()
    };
    call.0.reject(message);
}

/// The C function a URL handler calls: true when the embedding app took
/// the URL.
type UrlHandlerFn = unsafe extern "C" fn(context: *mut c_void, url: *const c_char) -> bool;

/// A URL handler's C callback and its context; `release` runs when it is
/// dropped (replaced, removed, or the app destroyed).
struct CUrlHandler {
    handler: UrlHandlerFn,
    context: *mut c_void,
    release: Option<unsafe extern "C" fn(context: *mut c_void)>,
}

// SAFETY: `handler` runs on the main thread only (the engine thread's
// handler hops there) and `release` may run on any thread, as
// `nsh_app_set_open_url_handler`'s contract says.
unsafe impl Send for CUrlHandler {}
// SAFETY: as above; nothing is mutated through a shared reference.
unsafe impl Sync for CUrlHandler {}

impl Drop for CUrlHandler {
    fn drop(&mut self) {
        if let Some(release) = self.release {
            // SAFETY: the contract of `nsh_app_set_open_url_handler`.
            unsafe { release(self.context) };
        }
    }
}

/// Takes the URLs the app opens (`openUrl` of `nsh/device`) before the
/// system does, replacing the handler it had; `handler` `NULL` removes it.
/// `handler` runs on the main thread with the URL (checked and granted)
/// and returns true when the embedding app took it (its router opened it),
/// false for the system to open it. `release` (optional) is called with
/// `context`, on any thread, when the handler is replaced or removed or the
/// app destroyed.
///
/// # Safety
///
/// `app` must come from [`nsh_app_create`]; `handler` must be safe to call
/// with `context` on the main thread, and `release` on any thread, until
/// `release` is called (or, without `release`, until `app` is destroyed).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_app_set_open_url_handler(
    app: *mut NshApp,
    handler: Option<UrlHandlerFn>,
    context: *mut c_void,
    release: Option<unsafe extern "C" fn(context: *mut c_void)>,
) {
    // SAFETY: guaranteed by the caller.
    let channel = unsafe { &*app }.view.host();
    let Some(handler) = handler else {
        channel.remove_open_url_handler();
        if let Some(release) = release {
            // SAFETY: guaranteed by the caller.
            unsafe { release(context) };
        }
        return;
    };
    let callback = std::sync::Arc::new(CUrlHandler {
        handler,
        context,
        release,
    });
    channel.handle_open_url(move |request| {
        // On the engine thread: the C handler runs on the main thread.
        let callback = callback.clone();
        dispatch2::DispatchQueue::main().exec_async(move || {
            let url = CString::new(request.url()).unwrap_or_default();
            // SAFETY: the contract of `nsh_app_set_open_url_handler`.
            let handled = unsafe { (callback.handler)(callback.context, url.as_ptr()) };
            request.answer(handled);
        });
    });
}

/// Frees `call` unanswered: the app's promise rejects. Any thread.
///
/// # Safety
///
/// `call` must be `NULL` or come from a host handler, not used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_host_call_free(call: *mut NshHostCall) {
    if !call.is_null() {
        // SAFETY: guaranteed by the caller.
        drop(unsafe { Box::from_raw(call) });
    }
}

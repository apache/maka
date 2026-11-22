//! Standard modules share NSH's VM, event loop and native permission boundary.
//!
//! Portable LLRT modules run in the same QuickJS VM on every platform.
//! Browser I/O uses host Web APIs; pure standard modules stay upstream-owned.
use rquickjs::{Ctx, Error, Module, Result, Value, object::Accessor, qjs};

mod bounds;
mod console;
pub(crate) mod declarations;
mod os;
#[cfg(any(target_arch = "wasm32", test))]
mod path;
pub(crate) mod process;
pub(crate) mod scheduler;
mod url;
pub(crate) mod websocket;
#[cfg(feature = "zlib")]
mod zlib;

#[cfg(target_arch = "wasm32")]
mod random;

pub(crate) const NAMES: &[&str] = nsh_core::js::STANDARD_MODULES;

/// Only canonical reference specifiers are accepted; aliases stay denied.
pub(crate) fn normalize(name: &str) -> Option<&str> {
    NAMES.iter().copied().find(|candidate| *candidate == name)
}

pub(crate) fn load<'js>(cx: &Ctx<'js>, name: &str) -> Result<Module<'js>> {
    // LLRT's crypto module expects the classes its global defines.
    // Compiling to bytecode declares modules in a context without NSH's
    // state, and runs none.
    #[cfg(feature = "crypto")]
    if name == "crypto" && !crate::state::state(cx.as_raw().as_ptr()).is_null() {
        init_crypto(cx)?;
    }
    macro_rules! declare {
        ($ty:ty) => {
            Module::declare_def::<$ty, _>(cx.clone(), name)
        };
    }
    match name {
        "buffer" => declare!(quickjs_jit_stdlib::buffer::BufferModule),
        #[cfg(feature = "crypto")]
        "crypto" => declare!(bounds::CryptoModule),
        #[cfg(not(target_arch = "wasm32"))]
        "path" => declare!(quickjs_jit_stdlib::path::PathModule),
        #[cfg(target_arch = "wasm32")]
        "path" => declare!(path::PathModule),
        "url" => declare!(url::UrlModule),
        #[cfg(feature = "zlib")]
        "zlib" => declare!(zlib::ZlibModule),
        "console" => declare!(console::ConsoleModule),
        _ => Err(Error::new_loading(name)),
    }
}

/// Installs one group of [`LAZY`] globals.
type Init = fn(&Ctx<'_>) -> Result<()>;

/// The standard globals made on first use: an app that never touches
/// `process` or `crypto` pays nothing for them when its VM starts. Each
/// name is an accessor until then; reading
/// or assigning any name of a group installs the whole group, which
/// replaces the accessors with plain data properties.
#[cfg(feature = "crypto")]
const LAZY: &[(&[&str], Init)] = &[
    (&["process"], init_process),
    (nsh_core::js::CRYPTO_GLOBALS, init_crypto),
];
/// [`LAZY`] of a runtime without `crypto` (feature `crypto`).
#[cfg(not(feature = "crypto"))]
const LAZY: &[(&[&str], Init)] = &[(&["process"], init_process)];

/// Installs `Buffer` and the lazy standard globals. `Buffer`
/// is made now (about 30 µs): LLRT defines its methods by assignment, and
/// over `%TypedArray%.prototype` members assignments throw once hardening
/// has frozen that prototype, so it must exist before
/// [`crate::sandbox::harden`].
pub(crate) fn install<'js>(cx: &Ctx<'js>) -> Result<()> {
    init_buffer(cx)?;
    let globals = cx.globals();
    for &(names, init) in LAZY {
        for &name in names {
            globals.prop(
                name,
                Accessor::new(
                    move |cx: Ctx<'js>| -> Result<Value<'js>> {
                        init(&cx)?;
                        cx.globals().get(name)
                    },
                    move |cx: Ctx<'js>, value: Value<'js>| -> Result<()> {
                        init(&cx)?;
                        cx.globals().set(name, value)
                    },
                )
                .configurable()
                .enumerable(),
            )?;
        }
    }
    Ok(())
}

/// Removes the accessors of the group of `name`, so the installation's own
/// assignments define plain properties; false when the group was installed
/// already.
pub(crate) fn take_lazy(cx: &Ctx<'_>, name: &str) -> Result<bool> {
    let index = LAZY
        .iter()
        .position(|(names, _)| names.contains(&name))
        .expect("a lazy global");
    let installed = &crate::dom::shared(cx.as_raw().as_ptr()).lazy_globals;
    let bit = 1 << index;
    if installed.get() & bit != 0 {
        return Ok(false);
    }
    installed.set(installed.get() | bit);
    let globals = cx.globals();
    for name in LAZY[index].0 {
        globals.remove(*name)?;
    }
    Ok(true)
}

/// `Buffer` and the LLRT state every standard module returning buffers
/// needs. LLRT's initialization also defines its own `Blob`, `File`, `URL`
/// and `URLSearchParams`; NSH's WHATWG globals stay the objects they were.
fn init_buffer(cx: &Ctx<'_>) -> Result<()> {
    // The globals LLRT's initialization defines over NSH's. Their own
    // properties are kept as they are, not read: NSH's web globals are
    // accessors that make every web class on first read (~60 µs).
    let saved: Vec<_> = ["Blob", "File", "URL", "URLSearchParams"]
        .into_iter()
        .map(|name| own_property(cx, name))
        .collect::<Result<_>>()?;
    quickjs_jit_stdlib::buffer::init(cx)?;
    bounds::guard_buffer(cx)?;
    // LLRT URL helper classes are registered once; public constructors remain NSH's.
    #[cfg(not(target_arch = "wasm32"))]
    quickjs_jit_stdlib::url::init(cx)?;
    for property in saved {
        property.restore(cx)?;
    }
    Ok(())
}

/// A global's own property as it was: its descriptor (or none).
struct OwnProperty {
    atom: qjs::JSAtom,
    descriptor: Option<qjs::JSPropertyDescriptor>,
}

/// Global `name`'s own property, without calling its getter.
fn own_property(cx: &Ctx<'_>, name: &'static str) -> Result<OwnProperty> {
    let raw = cx.as_raw().as_ptr();
    let name = std::ffi::CString::new(name).expect("no NUL in a global's name");
    // SAFETY: a live context; the global and the descriptor's values are
    // owned here (freed by `restore`).
    unsafe {
        let global = qjs::JS_GetGlobalObject(raw);
        let atom = qjs::JS_NewAtom(raw, name.as_ptr());
        let mut descriptor = std::mem::zeroed::<qjs::JSPropertyDescriptor>();
        let found = qjs::JS_GetOwnProperty(raw, &mut descriptor, global, atom);
        qjs::JS_FreeValue(raw, global);
        if found < 0 {
            qjs::JS_FreeAtom(raw, atom);
            return Err(Error::Exception);
        }
        Ok(OwnProperty {
            atom,
            descriptor: (found == 1).then_some(descriptor),
        })
    }
}

impl OwnProperty {
    /// Puts the property back as it was (deleting it when there was none).
    fn restore(self, cx: &Ctx<'_>) -> Result<()> {
        let raw = cx.as_raw().as_ptr();
        // SAFETY: a live context; the descriptor's values and the atom are
        // owned by `self` and freed here, after the definition took its own
        // references.
        unsafe {
            let global = qjs::JS_GetGlobalObject(raw);
            let result = match self.descriptor {
                Some(d) => {
                    let has = (qjs::JS_PROP_HAS_CONFIGURABLE | qjs::JS_PROP_HAS_ENUMERABLE) as i32;
                    let kind = if d.flags & qjs::JS_PROP_GETSET as i32 != 0 {
                        (qjs::JS_PROP_HAS_GET | qjs::JS_PROP_HAS_SET) as i32
                    } else {
                        (qjs::JS_PROP_HAS_VALUE | qjs::JS_PROP_HAS_WRITABLE) as i32
                    };
                    let flags = d.flags
                        & (qjs::JS_PROP_CONFIGURABLE
                            | qjs::JS_PROP_ENUMERABLE
                            | qjs::JS_PROP_WRITABLE) as i32;
                    let r = qjs::JS_DefineProperty(
                        raw,
                        global,
                        self.atom,
                        d.value,
                        d.getter,
                        d.setter,
                        flags | has | kind,
                    );
                    qjs::JS_FreeValue(raw, d.value);
                    qjs::JS_FreeValue(raw, d.getter);
                    qjs::JS_FreeValue(raw, d.setter);
                    r
                }
                None => qjs::JS_DeleteProperty(raw, global, self.atom, 0),
            };
            qjs::JS_FreeAtom(raw, self.atom);
            qjs::JS_FreeValue(raw, global);
            if result < 0 {
                Err(Error::Exception)
            } else {
                Ok(())
            }
        }
    }
}

/// The global `process` (`standard/process.rs`).
fn init_process(cx: &Ctx<'_>) -> Result<()> {
    if take_lazy(cx, "process")? {
        process::install(cx)?;
    }
    Ok(())
}

/// `crypto` and its classes.
#[cfg(feature = "crypto")]
fn init_crypto(cx: &Ctx<'_>) -> Result<()> {
    if take_lazy(cx, "crypto")? {
        quickjs_jit_stdlib::crypto::init(cx)?;
        bounds::guard_crypto(cx)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::{Host, HostOptions};

    fn hardened() -> Host {
        Host::with_options(HostOptions {
            harden: true,
            ..HostOptions::default()
        })
        .unwrap()
    }

    #[test]
    fn standard_globals_are_made_on_first_use() {
        let host = hardened();
        assert!(
            host.eval_script(
                "lazy",
                r#"const lazy = name => typeof Object.getOwnPropertyDescriptor(globalThis, name).get === 'function';
                const names = ['process', 'crypto', 'Crypto', 'SubtleCrypto', 'CryptoKey'];
                const web = [URL, Blob, File, TextEncoder, EventTarget, ReadableStream, AbortController];
                const before = names.every(lazy) && !('__nshWebSocketConnect' in globalThis);
                const buffer = Buffer.from('hi').toString('base64') === 'aGk=';
                const proc = typeof process.nextTick === 'function' && !lazy('process') && lazy('crypto');
                const crypto = globalThis.crypto.randomBytes(4).length === 4
                    && CryptoKey === globalThis.CryptoKey && !lazy('CryptoKey');
                const socket = typeof WebSocket === 'function' && WebSocket.OPEN === 1
                    && Object.getPrototypeOf(WebSocket.prototype) === EventTarget.prototype;
                const same = [URL, Blob, File, TextEncoder, EventTarget, ReadableStream, AbortController]
                    .every((value, i) => value === web[i]);
                before && buffer && proc && crypto && socket && same
                    && !Object.getOwnPropertyNames(globalThis).some(n => n.startsWith('__nsh') && n !== '__nsh_import')"#
            )
            .unwrap()
        );
    }

    #[test]
    fn standard_globals_can_be_assigned_and_their_modules_load() {
        let host = hardened();
        host.eval_source(
            r#"
            import { randomUUID } from 'crypto';
            import standardProcess from 'process';
            globalThis.crypto = 'mine';
            if (globalThis.crypto !== 'mine' || typeof CryptoKey !== 'function') throw Error('assigned');
            if (randomUUID().length !== 36) throw Error('crypto module');
            if (standardProcess.platform !== process.platform) throw Error('process module');
            "#,
        )
        .unwrap();
    }
}

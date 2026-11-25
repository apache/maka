//! Java interfaces implemented in Rust, for Rust code (an app's crate, an
//! nshm) that hands Java a listener or a callback: a `Runnable` posted to
//! the UI thread, a framework's `...Listener`. [`implement`] makes a
//! `java.lang.reflect.Proxy` (`NativeProxy.java`) whose calls reach a Rust
//! function, so the crate ships no Java class of its own.
//!
//! Only interfaces can be implemented so, as `java.lang.reflect.Proxy`
//! implements nothing else: an API that takes an abstract class
//! (`UtteranceProgressListener`) needs a Java subclass, which an nshm ships
//! as a library. A method that returns a primitive must get a value boxed
//! as its type (`java.lang.Boolean` for `boolean`): `None` there, or any
//! call once the proxy is dropped, throws a `NullPointerException` in Java.
//!
//! ```no_run
//! // The library of the `nsh-platform-android` crate is `nsh`.
//! use nsh::{jni::objects::JValue, proxy};
//!
//! # fn post() -> nsh::jni::errors::Result<()> {
//! nsh::with_env(|env| {
//!     let runnable = proxy::implement(env, &["java.lang.Runnable"], |_, method, _| {
//!         log::info!("{method} on the UI thread");
//!         Ok(None)
//!     })?;
//!     let looper = env
//!         .call_static_method(
//!             "android/os/Looper",
//!             "getMainLooper",
//!             "()Landroid/os/Looper;",
//!             &[],
//!         )?
//!         .l()?;
//!     let handler = env.new_object(
//!         "android/os/Handler",
//!         "(Landroid/os/Looper;)V",
//!         &[JValue::Object(&looper)],
//!     )?;
//!     env.call_method(
//!         &handler,
//!         "post",
//!         "(Ljava/lang/Runnable;)Z",
//!         &[JValue::Object(runnable.as_obj())],
//!     )?;
//!     // Keep `runnable` until it ran: dropping it lets its calls do nothing.
//!     # std::mem::forget(runnable);
//!     Ok(())
//! })
//! # }
//! ```

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicI64, Ordering},
};

use jni::{
    JNIEnv,
    objects::{GlobalRef, JClass, JObject, JObjectArray, JString, JValue},
    signature::ReturnType,
    sys::{jlong, jobject},
};
use rustc_hash::FxHashMap;

use crate::java::java;

/// What answers a proxy's calls ([`implement`]'s `handler`).
pub(crate) type Handler = dyn Fn(&mut JNIEnv<'_>, &str, &JObjectArray<'_>) -> jni::errors::Result<Option<GlobalRef>>
    + Send
    + Sync;

/// The handlers of the proxies alive, by handle.
static HANDLERS: Mutex<Option<FxHashMap<i64, Arc<Handler>>>> = Mutex::new(None);
static NEXT: AtomicI64 = AtomicI64::new(1);

/// A Java object implementing interfaces in Rust ([`implement`]). Its
/// handler lives as long as it: once it is dropped, the object's calls do
/// nothing and answer `null`, wherever Java still holds it.
#[must_use = "dropping the proxy makes the Java object's calls do nothing"]
pub struct Proxy {
    object: GlobalRef,
    handle: i64,
}

impl Proxy {
    /// The Java object, to hand to Java.
    pub fn as_obj(&self) -> &JObject<'static> {
        self.object.as_obj()
    }
}

impl std::fmt::Debug for Proxy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Proxy")
            .field("handle", &self.handle)
            .finish_non_exhaustive()
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        if let Some(handlers) = HANDLERS.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            handlers.remove(&self.handle);
        }
    }
}

/// A Java object implementing `interfaces` (binary names of interfaces
/// only: `"android.speech.RecognitionListener"`), whose calls reach
/// `handler` on the thread Java makes them on, with the env of that
/// thread, the method's name and its arguments (a null array for none).
/// `handler` returns the call's value (`None`: `null`), boxed for a method
/// that returns a primitive (`java.lang.Boolean` for `boolean`), which
/// must return one: `null` there throws a `NullPointerException` in Java.
/// `Object`'s own `equals`, `hashCode` and `toString` are the proxy's. A
/// Java exception `handler` leaves pending is logged and cleared, and the
/// call answers `null`. Any thread.
pub fn implement(
    env: &mut JNIEnv<'_>,
    interfaces: &[&str],
    handler: impl Fn(&mut JNIEnv<'_>, &str, &JObjectArray<'_>) -> jni::errors::Result<Option<GlobalRef>>
    + Send
    + Sync
    + 'static,
) -> jni::errors::Result<Proxy> {
    let handle = NEXT.fetch_add(1, Ordering::Relaxed);
    let names =
        env.new_object_array(interfaces.len() as i32, "java/lang/String", JObject::null())?;
    for (i, name) in interfaces.iter().enumerate() {
        let name = env.new_string(name)?;
        env.set_object_array_element(&names, i as i32, name)?;
    }
    HANDLERS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_or_insert_with(FxHashMap::default)
        .insert(handle, Arc::new(handler));
    // Removed again when this fails: dropping the guard does it.
    let guard = Unregister(handle);
    // SAFETY: the signature checked in `java::init`.
    let object = unsafe {
        env.call_static_method_unchecked(
            <&JClass<'_>>::from(java().proxy.as_obj()),
            java().proxy_create,
            ReturnType::Object,
            &[
                JValue::Object(&names).as_jni(),
                JValue::Long(handle).as_jni(),
            ],
        )
    }?
    .l()?;
    let object = env.new_global_ref(object)?;
    std::mem::forget(guard);
    Ok(Proxy { object, handle })
}

/// Unregisters handler `.0` when dropped.
struct Unregister(i64);

impl Drop for Unregister {
    fn drop(&mut self) {
        if let Some(handlers) = HANDLERS.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            handlers.remove(&self.0);
        }
    }
}

/// `NativeProxy.call`: handler `handle`'s answer to `method` with `args`.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_NativeProxy_call(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    method: JString<'_>,
    args: JObjectArray<'_>,
) -> jobject {
    let handler = HANDLERS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .and_then(|handlers| handlers.get(&handle).cloned());
    let Some(handler) = handler else {
        return std::ptr::null_mut();
    };
    let Ok(name) = env.get_string(&method).map(String::from) else {
        let _ = env.exception_clear();
        return std::ptr::null_mut();
    };
    let answer = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        handler(&mut env, &name, &args)
    }));
    match answer {
        Ok(Ok(Some(value))) => env
            .new_local_ref(value.as_obj())
            .map(JObject::into_raw)
            .unwrap_or(std::ptr::null_mut()),
        Ok(Ok(None)) => std::ptr::null_mut(),
        Ok(Err(error)) => {
            if env.exception_check().unwrap_or(false) {
                let _ = env.exception_describe();
                let _ = env.exception_clear();
            }
            log::warn!("nsh: a Java proxy's `{name}` failed: {error}");
            std::ptr::null_mut()
        }
        Err(_) => {
            log::error!("nsh: a Java proxy's `{name}` panicked");
            std::ptr::null_mut()
        }
    }
}

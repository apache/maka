//! Broadcasts received in Rust, for Rust code (an app's crate, an nshm)
//! that hears an `Intent` broadcast: the app chosen in a share sheet (a
//! chooser's `IntentSender`), a finished download, a `PendingIntent` an
//! alarm or a notification sends back. [`register`] registers a receiver
//! (`NativeReceiver.java`) on the application whose broadcasts reach a
//! Rust function, so the crate ships no `BroadcastReceiver` subclass of its
//! own, which [`crate::proxy`] cannot make: `BroadcastReceiver` is a class,
//! not an interface.
//!
//! The receiver is not exported: it hears the app's own broadcasts (those
//! a `PendingIntent` of the app sends, aimed at the app's package) and the
//! system's, never other apps'. On Android 12 and below that takes a
//! signature permission the runtime's manifest declares, so only the app,
//! the system and senders holding it reach the receiver: a broadcast
//! another system app sends as itself (`DOWNLOAD_COMPLETE`, from the
//! download provider) may not arrive there.
//!
//! ```no_run
//! // The library of the `nsh-platform-android` crate is `nsh`.
//! use nsh::{
//!     jni::objects::{JString, JValue},
//!     receiver,
//! };
//!
//! # fn hear() -> nsh::jni::errors::Result<()> {
//! let receiver = nsh::with_env(|env| {
//!     receiver::register(env, "com.example.app.DONE", |env, intent| {
//!         let key = env.new_string("result")?;
//!         let result = env
//!             .call_method(
//!                 intent,
//!                 "getStringExtra",
//!                 "(Ljava/lang/String;)Ljava/lang/String;",
//!                 &[JValue::Object(&key)],
//!             )?
//!             .l()?;
//!         if !result.is_null() {
//!             let result = String::from(env.get_string(&JString::from(result))?);
//!             log::info!("done: {result}");
//!         }
//!         Ok(())
//!     })
//! })?;
//! // Keep `receiver` while the broadcast may come: dropping it unregisters it.
//! # drop(receiver);
//! # Ok(())
//! # }
//! ```

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicI64, Ordering},
};

use jni::{
    JNIEnv,
    objects::{GlobalRef, JClass, JObject, JValue},
    signature::{Primitive, ReturnType},
    sys::jlong,
};
use rustc_hash::FxHashMap;

use crate::java::java;

/// What hears a receiver's broadcasts ([`register`]'s `handler`).
type Handler = dyn Fn(&mut JNIEnv<'_>, &JObject<'_>) -> jni::errors::Result<()> + Send + Sync;

/// The handlers of the receivers registered, by handle.
static HANDLERS: Mutex<Option<FxHashMap<i64, Arc<Handler>>>> = Mutex::new(None);
static NEXT: AtomicI64 = AtomicI64::new(1);

/// A receiver of broadcasts registered in Rust ([`register`]). Dropping it
/// unregisters it: no broadcast reaches its handler after that.
#[must_use = "dropping the receiver unregisters it"]
pub struct Receiver {
    object: GlobalRef,
    handle: i64,
}

impl std::fmt::Debug for Receiver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Receiver")
            .field("handle", &self.handle)
            .finish_non_exhaustive()
    }
}

impl Drop for Receiver {
    fn drop(&mut self) {
        forget(self.handle);
        let unregistered = crate::java::try_with_env(|env| {
            // SAFETY: the signature checked in `java::init`.
            unsafe {
                env.call_static_method_unchecked(
                    <&JClass<'_>>::from(java().receiver.as_obj()),
                    java().receiver_unregister,
                    ReturnType::Primitive(Primitive::Void),
                    &[JValue::Object(self.object.as_obj()).as_jni()],
                )
            }
            .map(drop)
        });
        if let Err(err) = unregistered {
            log::warn!("nsh: cannot unregister a broadcast receiver: {err}");
        }
    }
}

/// Registers a receiver of the broadcasts of `action` (an `Intent`'s action:
/// `"com.example.app.SHARED"`, `"android.intent.action.DOWNLOAD_COMPLETE"`)
/// on the application, not exported, whose broadcasts reach `handler` on
/// the UI thread with the env of that thread and the broadcast `Intent`,
/// until the [`Receiver`] is dropped. A Java exception `handler` leaves
/// pending, or an error it returns, is logged and cleared. Fails before any
/// `NshView` was made, when there is no application to register on, and on
/// Android 12 and below when the app's manifest lacks the runtime's
/// receiver permission (an embedding app removed it). Any thread.
pub fn register(
    env: &mut JNIEnv<'_>,
    action: &str,
    handler: impl Fn(&mut JNIEnv<'_>, &JObject<'_>) -> jni::errors::Result<()> + Send + Sync + 'static,
) -> jni::errors::Result<Receiver> {
    let handle = NEXT.fetch_add(1, Ordering::Relaxed);
    HANDLERS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_or_insert_with(FxHashMap::default)
        .insert(handle, Arc::new(handler));
    // Removed again when this fails.
    let guard = Forget(handle);
    let action = env.new_string(action)?;
    // SAFETY: the signature checked in `java::init`.
    let object = unsafe {
        env.call_static_method_unchecked(
            <&JClass<'_>>::from(java().receiver.as_obj()),
            java().receiver_register,
            ReturnType::Object,
            &[
                JValue::Object(&action).as_jni(),
                JValue::Long(handle).as_jni(),
            ],
        )
    }?
    .l()?;
    if object.is_null() {
        return Err(jni::errors::Error::NullPtr(
            "no NshView was made yet: no application to register on",
        ));
    }
    let object = env.new_global_ref(object)?;
    std::mem::forget(guard);
    Ok(Receiver { object, handle })
}

/// Removes handler `handle`.
fn forget(handle: i64) {
    if let Some(handlers) = HANDLERS.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        handlers.remove(&handle);
    }
}

/// Removes handler `.0` when dropped.
struct Forget(i64);

impl Drop for Forget {
    fn drop(&mut self) {
        forget(self.0);
    }
}

/// `NativeReceiver.receive`: handler `handle` hears `intent`.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_NativeReceiver_receive(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    intent: JObject<'_>,
) {
    let handler = HANDLERS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .and_then(|handlers| handlers.get(&handle).cloned());
    // Dropped: the broadcast came before the receiver was unregistered.
    let Some(handler) = handler else {
        return;
    };
    let heard =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handler(&mut env, &intent)));
    // Whatever the handler returned: a call it mapped to `Ok`, or one a
    // panic cut short, still leaves its exception pending, which would
    // throw out of `onReceive`.
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }
    match heard {
        Ok(Ok(())) => {}
        Ok(Err(error)) => log::warn!("nsh: a broadcast receiver failed: {error}"),
        Err(_) => log::error!("nsh: a broadcast receiver panicked"),
    }
}

//! The process's JavaVM and application `Context` in
//! [`ndk-context`](https://docs.rs/ndk-context), where Rust crates for
//! Android look for them (`ndk_context::android_context()`): audio, sensors,
//! keystores, `robius-*` and an app's own JNI code.
//!
//! `ndk-context` holds one context per process and panics when it is set
//! twice, so one owner must set it before any crate reads it. In an NSH app
//! that owner is NSH: it sets it once, when the first `NshView` is made,
//! before an app's or an extension's Rust code runs. The context is the
//! application's, which outlives every activity.

use std::sync::Once;

use jni::{JNIEnv, objects::JObject};

use crate::java::java;

/// The application `Context` of `view`'s (an `NshView`).
pub(crate) fn application_context<'local>(
    env: &mut JNIEnv<'local>,
    view: &JObject<'_>,
) -> jni::errors::Result<JObject<'local>> {
    let context = env
        .call_method(view, "getContext", "()Landroid/content/Context;", &[])?
        .l()?;
    env.call_method(
        &context,
        "getApplicationContext",
        "()Landroid/content/Context;",
        &[],
    )?
    .l()
}

/// Sets `ndk-context` to the VM and `view`'s application, once per process.
pub(crate) fn init(env: &mut JNIEnv<'_>, view: &JObject<'_>) {
    static DONE: Once = Once::new();
    DONE.call_once(|| {
        let context = application_context(env, view).and_then(|context| {
            // Kept for the life of the process, as `ndk-context` asks.
            let global = env.new_global_ref(context)?;
            let raw = global.as_obj().as_raw();
            std::mem::forget(global);
            Ok(raw)
        });
        match context {
            // SAFETY: the VM lives as long as the process, the context is a
            // global reference that is never deleted, and `DONE` makes this
            // the only call in NSH; it runs before an app's code does.
            Ok(raw) => unsafe {
                ndk_context::initialize_android_context(
                    java().vm.get_java_vm_pointer().cast(),
                    raw.cast(),
                );
            },
            Err(err) => {
                let _ = env.exception_clear();
                log::error!("nsh: no Context for ndk-context: {err}");
            }
        }
    });
}

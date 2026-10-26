//! Cached Java classes and method ids.
//!
//! Classes are looked up once in `JNI_OnLoad`: threads created by Rust (the
//! engine thread) only see the system class loader, which cannot find the
//! app's classes.

use std::sync::OnceLock;

use jni::{
    JNIEnv, JavaVM,
    objects::{GlobalRef, JClass, JMethodID, JStaticMethodID},
};

/// Everything Rust calls in Java.
pub(crate) struct Java {
    pub(crate) vm: JavaVM,
    /// `com.longbridge.nsh.TextLayouts`: text typesetting (engine thread).
    pub(crate) text: GlobalRef,
    pub(crate) text_prepare: JStaticMethodID,
    pub(crate) text_measure: JStaticMethodID,
    pub(crate) text_layout: JStaticMethodID,
    pub(crate) text_lines: JStaticMethodID,
    pub(crate) text_attachments: JStaticMethodID,
    pub(crate) text_hit_test: JStaticMethodID,
    pub(crate) text_caret_rect: JStaticMethodID,
    pub(crate) text_range_rects: JStaticMethodID,
    pub(crate) text_register_font: JStaticMethodID,
    /// `com.longbridge.nsh.Net`: HTTP (any thread).
    pub(crate) net: GlobalRef,
    pub(crate) net_fetch: JStaticMethodID,
    pub(crate) net_send: JStaticMethodID,
    pub(crate) net_finish: JStaticMethodID,
    pub(crate) net_pause: JStaticMethodID,
    pub(crate) net_cancel: JStaticMethodID,
    /// `com.longbridge.nsh.NshView` instance methods.
    pub(crate) view_submit: JMethodID,
    pub(crate) view_report_error: JMethodID,
    pub(crate) view_read_asset: JMethodID,
    pub(crate) view_request_frame: JMethodID,
    pub(crate) view_app_stopped: JMethodID,
    pub(crate) view_host_message: JMethodID,
    pub(crate) view_open_url_message: JMethodID,
    #[cfg_attr(not(feature = "dev"), allow(dead_code))]
    pub(crate) view_dev_status: JMethodID,
    #[cfg_attr(not(feature = "dev"), allow(dead_code))]
    pub(crate) view_dev_error: JMethodID,
    /// `com.longbridge.nsh.TestAgent`: the test agent's platform part
    /// (any thread; it does its work on the UI thread).
    #[cfg(feature = "dev")]
    pub(crate) test_agent: GlobalRef,
}

static JAVA: OnceLock<Java> = OnceLock::new();

/// The cached classes; panics before `JNI_OnLoad`.
pub(crate) fn java() -> &'static Java {
    JAVA.get()
        .expect("libnsh loaded through System.loadLibrary")
}

pub(crate) fn init(vm: JavaVM) -> jni::errors::Result<()> {
    let mut env = vm.get_env()?;
    let class = |env: &mut JNIEnv<'_>, name: &str| -> jni::errors::Result<GlobalRef> {
        let class = env.find_class(name)?;
        env.new_global_ref(class)
    };
    let text = class(&mut env, "com/longbridge/nsh/TextLayouts")?;
    let net = class(&mut env, "com/longbridge/nsh/Net")?;
    let view = class(&mut env, "com/longbridge/nsh/NshView")?;
    let text_class: &JClass<'_> = text.as_obj().into();
    let net_class: &JClass<'_> = net.as_obj().into();
    let view_class: &JClass<'_> = view.as_obj().into();
    let java = Java {
        text_prepare: env.get_static_method_id(
            text_class,
            "prepare",
            "(Ljava/lang/String;[I[F[Ljava/lang/String;IIIFIFFF[F)Ljava/lang/Object;",
        )?,
        text_measure: env.get_static_method_id(text_class, "measure", "(Ljava/lang/Object;F)J")?,
        text_layout: env.get_static_method_id(
            text_class,
            "layout",
            "(Ljava/lang/Object;FF)Ljava/lang/Object;",
        )?,
        text_lines: env.get_static_method_id(text_class, "lines", "(Ljava/lang/Object;F)[F")?,
        text_attachments: env.get_static_method_id(
            text_class,
            "attachments",
            "(Ljava/lang/Object;F)[F",
        )?,
        text_hit_test: env.get_static_method_id(
            text_class,
            "hitTest",
            "(Ljava/lang/Object;FFF)J",
        )?,
        text_caret_rect: env.get_static_method_id(
            text_class,
            "caretRect",
            "(Ljava/lang/Object;IZF)[F",
        )?,
        text_range_rects: env.get_static_method_id(
            text_class,
            "rangeRects",
            "(Ljava/lang/Object;IIF)[F",
        )?,
        text_register_font: env.get_static_method_id(
            text_class,
            "registerFont",
            "(Ljava/lang/String;[BIZ)Ljava/lang/String;",
        )?,
        net_fetch: env.get_static_method_id(
            net_class,
            "fetch",
            "(JLjava/lang/String;Ljava/lang/String;[Ljava/lang/String;[BZZ)V",
        )?,
        net_send: env.get_static_method_id(net_class, "send", "(J[B)V")?,
        net_finish: env.get_static_method_id(net_class, "finish", "(J)V")?,
        net_pause: env.get_static_method_id(net_class, "pause", "(JZ)V")?,
        net_cancel: env.get_static_method_id(net_class, "cancel", "(J)V")?,
        view_submit: env.get_method_id(view_class, "submit", "([B[Ljava/lang/Object;J)V")?,
        view_report_error: env.get_method_id(view_class, "reportError", "(Ljava/lang/String;)V")?,
        view_read_asset: env.get_method_id(view_class, "readAsset", "(Ljava/lang/String;)[B")?,
        view_request_frame: env.get_method_id(view_class, "requestJsFrame", "()V")?,
        view_app_stopped: env.get_method_id(view_class, "appStopped", "()V")?,
        view_host_message: env.get_method_id(
            view_class,
            "hostMessage",
            "(Ljava/lang/String;Ljava/lang/String;J)V",
        )?,
        view_open_url_message: env.get_method_id(
            view_class,
            "openUrlMessage",
            "(Ljava/lang/String;J)V",
        )?,
        view_dev_status: env.get_method_id(view_class, "devStatus", "(Ljava/lang/String;)V")?,
        view_dev_error: env.get_method_id(
            view_class,
            "devError",
            "(Ljava/lang/String;Ljava/lang/String;Z)V",
        )?,
        #[cfg(feature = "dev")]
        test_agent: class(&mut env, "com/longbridge/nsh/TestAgent")?,
        text,
        net,
        vm,
    };
    let _ = JAVA.set(java);
    Ok(())
}

/// Runs `f` with the JNI env of the current thread (attaching it for good:
/// the engine thread calls into Java all the time), inside a local frame so
/// local references never pile up on long-lived native threads.
pub(crate) fn with_env<R: Default>(f: impl FnOnce(&mut JNIEnv<'_>) -> jni::errors::Result<R>) -> R {
    let java = java();
    let mut env = match java.vm.attach_current_thread_permanently() {
        Ok(env) => env,
        Err(err) => {
            log::error!("cannot attach to the JVM: {err}");
            return R::default();
        }
    };
    let result = env.with_local_frame(32, |env| f(env));
    match result {
        Ok(value) => value,
        Err(err) => {
            // A Java exception: log it and clear it so later calls work.
            if env.exception_check().unwrap_or(false) {
                let _ = env.exception_describe();
                let _ = env.exception_clear();
            }
            log::error!("JNI call failed: {err}");
            R::default()
        }
    }
}

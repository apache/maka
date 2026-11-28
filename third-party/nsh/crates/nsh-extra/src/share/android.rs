//! The share sheet on Android: the system's chooser over
//! `Intent.ACTION_SEND` (`ACTION_SEND_MULTIPLE` for several files),
//! started for a result (`nsh::activity::start_for_result`). The text and
//! the link go as `EXTRA_TEXT`, the title as `EXTRA_SUBJECT` and the
//! chooser's title, the files as the `content:` URIs the runtime's file
//! provider serves them at (`nsh::activity::content_uri`: only files of the
//! app's own storage). The chooser tells which app the user chose through
//! an `IntentSender` broadcast, heard in Rust (`nsh::receiver`), which
//! answers the share as shared to that app's package; Android tells
//! nothing of what the app then does. The chooser's result without that
//! broadcast answers dismissed. Android's sheet is no popover: the anchor
//! is not used.

use std::{
    path::Path,
    pin::Pin,
    sync::atomic::{AtomicI32, Ordering},
    time::Duration,
};

use nsh::{
    activity::{self, ActivityError, ActivityResult},
    jni::{
        JNIEnv,
        objects::{JObject, JString, JValue},
    },
    receiver::{self, Receiver},
};

use super::{Reply, ShareError, ShareOutcome, ShareSheet, common_type};

const ACTION_SEND: &str = "android.intent.action.SEND";
const ACTION_SEND_MULTIPLE: &str = "android.intent.action.SEND_MULTIPLE";
const EXTRA_TEXT: &str = "android.intent.extra.TEXT";
const EXTRA_SUBJECT: &str = "android.intent.extra.SUBJECT";
const EXTRA_TITLE: &str = "android.intent.extra.TITLE";
const EXTRA_STREAM: &str = "android.intent.extra.STREAM";
const EXTRA_CHOSEN_COMPONENT: &str = "android.intent.extra.CHOSEN_COMPONENT";
/// `Intent.FLAG_GRANT_READ_URI_PERMISSION`.
const FLAG_GRANT_READ_URI_PERMISSION: i32 = 0x1;
/// `Intent.FLAG_RECEIVER_FOREGROUND`.
const FLAG_RECEIVER_FOREGROUND: i32 = 0x1000_0000;
/// `PendingIntent.FLAG_UPDATE_CURRENT`.
const FLAG_UPDATE_CURRENT: i32 = 0x0800_0000;
/// `PendingIntent.FLAG_MUTABLE` (Android 12 and later).
const FLAG_MUTABLE: i32 = 0x0200_0000;

/// How long a chooser's result waits for the broadcast of the app the
/// user chose, which may still be in the queue, before it answers the
/// share as dismissed.
const CHOICE_GRACE: Duration = Duration::from_millis(100);

/// The application `Context`.
fn context() -> JObject<'static> {
    // SAFETY: NSH sets the process's application context, a global
    // reference it never deletes, when the first `NshView` is made, before
    // an app's or a module's code runs.
    unsafe { JObject::from_raw(ndk_context::android_context().context().cast()) }
}

pub(super) async fn available() -> bool {
    nsh::with_env(|env| {
        // The chooser is the system's, which every app sees (an app sees
        // the targets of `ACTION_SEND` only when its manifest queries them).
        let send = intent(env, ACTION_SEND)?;
        let text = env.new_string("text/plain")?;
        env.call_method(
            &send,
            "setType",
            "(Ljava/lang/String;)Landroid/content/Intent;",
            &[JValue::Object(&text)],
        )?;
        let chooser = env
            .call_static_method(
                "android/content/Intent",
                "createChooser",
                "(Landroid/content/Intent;Ljava/lang/CharSequence;)Landroid/content/Intent;",
                &[JValue::Object(&send), JValue::Object(&JObject::null())],
            )?
            .l()?;
        Ok(activity::can_start(env, &chooser))
    })
    .unwrap_or(false)
}

pub(super) async fn show(sheet: ShareSheet, reply: Reply) {
    let started = nsh::with_env(|env| Ok(start(env, &sheet, &reply)));
    let (receiver, started) = match started {
        Ok(Ok(started)) => started,
        Ok(Err(error)) => {
            reply.send(Err(error));
            return;
        }
        Err(error) => {
            reply.send(Err(ShareError::failed(format!(
                "share: cannot show the share sheet: {error}"
            ))));
            return;
        }
    };
    if let Err(error) = started.await {
        reply.send(Err(match error {
            ActivityError::NotFound => {
                ShareError::unavailable("share: no share sheet is installed")
            }
            error => ShareError::failed(format!("share: cannot show the share sheet: {error}")),
        }));
        return;
    }
    // The result tells only that the chooser closed; a choice answered the
    // share already. Give a broadcast still in the queue its turn before
    // taking the close as a dismissal.
    nsh_core::element::timer(CHOICE_GRACE).await;
    drop(receiver);
    reply.send(Ok(ShareOutcome::dismissed()));
}

/// The chooser's result to come.
type Started = Pin<Box<dyn Future<Output = Result<ActivityResult, ActivityError>> + Send>>;

/// Starts the chooser for `sheet`, hearing the app the user chooses: the
/// receiver to keep until the chooser closed, and the chooser's result
/// to come.
fn start(
    env: &mut JNIEnv<'_>,
    sheet: &ShareSheet,
    reply: &Reply,
) -> Result<(Receiver, Started), ShareError> {
    let failed = |error: nsh::jni::errors::Error| {
        ShareError::failed(format!("share: cannot show the share sheet: {error}"))
    };
    let send = send_intent(env, sheet)?;
    // The chosen app comes back as a broadcast of the app's own package,
    // one action per share.
    static NEXT: AtomicI32 = AtomicI32::new(0x5300);
    let code = NEXT.fetch_add(1, Ordering::Relaxed);
    let app = context();
    let package: JString<'_> = env
        .call_method(&app, "getPackageName", "()Ljava/lang/String;", &[])
        .and_then(|name| name.l())
        .map_err(failed)?
        .into();
    let package_name = String::from(env.get_string(&package).map_err(failed)?);
    let action = format!("{package_name}.nsh.SHARE.{code}");
    let heard = reply.clone();
    let receiver = receiver::register(env, &action, move |env, intent| {
        if let Some(chosen) = chosen_package(env, intent)? {
            // The choice is all Android tells: answer it now.
            heard.send(Ok(ShareOutcome::shared(Some(chosen))));
        }
        Ok(())
    })
    .map_err(failed)?;
    let chooser = (|| -> nsh::jni::errors::Result<JObject<'_>> {
        let broadcast = intent(env, &action)?;
        env.call_method(
            &broadcast,
            "setPackage",
            "(Ljava/lang/String;)Landroid/content/Intent;",
            &[JValue::Object(&package)],
        )?;
        // On the foreground queue: the choice arrives before the chooser's
        // result as a rule, not seconds later.
        env.call_method(
            &broadcast,
            "addFlags",
            "(I)Landroid/content/Intent;",
            &[JValue::Int(FLAG_RECEIVER_FOREGROUND)],
        )?;
        let mut flags = FLAG_UPDATE_CURRENT;
        // The chooser fills in the chosen component.
        if sdk(env)? >= 31 {
            flags |= FLAG_MUTABLE;
        }
        let pending = env
            .call_static_method(
                "android/app/PendingIntent",
                "getBroadcast",
                "(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;",
                &[
                    JValue::Object(&app),
                    JValue::Int(code),
                    JValue::Object(&broadcast),
                    JValue::Int(flags),
                ],
            )?
            .l()?;
        let sender = env
            .call_method(
                &pending,
                "getIntentSender",
                "()Landroid/content/IntentSender;",
                &[],
            )?
            .l()?;
        let title = match &sheet.title {
            Some(title) => JObject::from(env.new_string(title)?),
            None => JObject::null(),
        };
        env.call_static_method(
            "android/content/Intent",
            "createChooser",
            "(Landroid/content/Intent;Ljava/lang/CharSequence;Landroid/content/IntentSender;)Landroid/content/Intent;",
            &[
                JValue::Object(&send),
                JValue::Object(&title),
                JValue::Object(&sender),
            ],
        )?
        .l()
    })()
    .map_err(failed)?;
    let started: Started = Box::pin(activity::start_for_result(env, &chooser));
    Ok((receiver, started))
}

/// The package of the app a chooser's broadcast names, if it names one.
fn chosen_package(
    env: &mut JNIEnv<'_>,
    intent: &JObject<'_>,
) -> nsh::jni::errors::Result<Option<String>> {
    let key = env.new_string(EXTRA_CHOSEN_COMPONENT)?;
    let chosen = env
        .call_method(
            intent,
            "getParcelableExtra",
            "(Ljava/lang/String;)Landroid/os/Parcelable;",
            &[JValue::Object(&key)],
        )?
        .l()?;
    if chosen.is_null() {
        return Ok(None);
    }
    let package: JString<'_> = env
        .call_method(&chosen, "getPackageName", "()Ljava/lang/String;", &[])?
        .l()?
        .into();
    Ok(Some(env.get_string(&package)?.into()))
}

/// `Build.VERSION.SDK_INT`.
fn sdk(env: &mut JNIEnv<'_>) -> nsh::jni::errors::Result<i32> {
    env.get_static_field("android/os/Build$VERSION", "SDK_INT", "I")?
        .i()
}

/// `new Intent(action)`.
fn intent<'local>(
    env: &mut JNIEnv<'local>,
    action: &str,
) -> nsh::jni::errors::Result<JObject<'local>> {
    let action = env.new_string(action)?;
    env.new_object(
        "android/content/Intent",
        "(Ljava/lang/String;)V",
        &[JValue::Object(&action)],
    )
}

/// The `ACTION_SEND` intent of `sheet`, its files served to the app the
/// user chooses; `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` for a file outside
/// the app's own storage.
fn send_intent<'local>(
    env: &mut JNIEnv<'local>,
    sheet: &ShareSheet,
) -> Result<JObject<'local>, ShareError> {
    let failed = |error: nsh::jni::errors::Error| {
        ShareError::failed(format!("share: cannot show the share sheet: {error}"))
    };
    let mut uris = Vec::with_capacity(sheet.files.len());
    let mut mime: Option<String> = None;
    for path in &sheet.files {
        let served = match activity::content_uri(env, Path::new(path)) {
            Ok(Some(served)) => served,
            Ok(None) => {
                return Err(ShareError::unavailable(format!(
                    "share: `{path}` is not in the app's own storage, which Android shares from"
                )));
            }
            Err(error) => {
                return Err(ShareError::failed(format!(
                    "share: cannot show the share sheet: {error}"
                )));
            }
        };
        mime = Some(match mime {
            None => served.mime.clone(),
            Some(mime) => common_type(&mime, &served.mime),
        });
        uris.push(served.uri);
    }
    (|| -> nsh::jni::errors::Result<JObject<'local>> {
        let send = intent(
            env,
            if uris.len() > 1 {
                ACTION_SEND_MULTIPLE
            } else {
                ACTION_SEND
            },
        )?;
        let mime = env.new_string(mime.as_deref().unwrap_or("text/plain"))?;
        env.call_method(
            &send,
            "setType",
            "(Ljava/lang/String;)Landroid/content/Intent;",
            &[JValue::Object(&mime)],
        )?;
        let put_string = |env: &mut JNIEnv<'local>, key: &str, value: &str| {
            let key = env.new_string(key)?;
            let value = env.new_string(value)?;
            env.call_method(
                &send,
                "putExtra",
                "(Ljava/lang/String;Ljava/lang/String;)Landroid/content/Intent;",
                &[JValue::Object(&key), JValue::Object(&value)],
            )
            .map(drop)
        };
        if let Some(text) = sheet.combined_text() {
            put_string(env, EXTRA_TEXT, &text)?;
        }
        if let Some(title) = &sheet.title {
            put_string(env, EXTRA_SUBJECT, title)?;
            put_string(env, EXTRA_TITLE, title)?;
        }
        let stream = env.new_string(EXTRA_STREAM)?;
        match uris.as_slice() {
            [] => {}
            [uri] => {
                env.call_method(
                    &send,
                    "putExtra",
                    "(Ljava/lang/String;Landroid/os/Parcelable;)Landroid/content/Intent;",
                    &[JValue::Object(&stream), JValue::Object(uri.as_obj())],
                )?;
            }
            uris => {
                let list = env.new_object("java/util/ArrayList", "()V", &[])?;
                for uri in uris {
                    env.call_method(
                        &list,
                        "add",
                        "(Ljava/lang/Object;)Z",
                        &[JValue::Object(uri.as_obj())],
                    )?;
                }
                env.call_method(
                    &send,
                    "putParcelableArrayListExtra",
                    "(Ljava/lang/String;Ljava/util/ArrayList;)Landroid/content/Intent;",
                    &[JValue::Object(&stream), JValue::Object(&list)],
                )?;
            }
        }
        if let Some((first, rest)) = uris.split_first() {
            // The grant travels with the clip data through the chooser.
            let clip = env
                .call_static_method(
                    "android/content/ClipData",
                    "newRawUri",
                    "(Ljava/lang/CharSequence;Landroid/net/Uri;)Landroid/content/ClipData;",
                    &[
                        JValue::Object(&JObject::null()),
                        JValue::Object(first.as_obj()),
                    ],
                )?
                .l()?;
            for uri in rest {
                let item = env.new_object(
                    "android/content/ClipData$Item",
                    "(Landroid/net/Uri;)V",
                    &[JValue::Object(uri.as_obj())],
                )?;
                env.call_method(
                    &clip,
                    "addItem",
                    "(Landroid/content/ClipData$Item;)V",
                    &[JValue::Object(&item)],
                )?;
            }
            env.call_method(
                &send,
                "setClipData",
                "(Landroid/content/ClipData;)V",
                &[JValue::Object(&clip)],
            )?;
            env.call_method(
                &send,
                "addFlags",
                "(I)Landroid/content/Intent;",
                &[JValue::Int(FLAG_GRANT_READ_URI_PERMISSION)],
            )?;
        }
        Ok(send)
    })()
    .map_err(failed)
}

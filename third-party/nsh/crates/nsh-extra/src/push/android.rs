//! Remote notifications on Android. Android has no push of its own that
//! every device has: registering the device and delivering notifications
//! are the push service's binding's ([`super::PushProvider`]).
//!
//! The presses of the notifications NSH did not show (the binding's, an
//! SDK's) come from the core's handler of them
//! (`nsh::notifications::set_foreign_handler`), set up by the crate's
//! `#[native_module]` entry: a press opens the app with the notification's
//! payload as the intent's extras, which become the press's payload.
//! Android does not say which notification opened the app, so a press has
//! no id or thread. The core keeps the press that started the app until
//! the handler is set.
//!
//! The module closes a thread's notifications itself. Android has no
//! threads; the closest is a notification group (`Notification.getGroup`),
//! which bundles a conversation's notifications in the shade and which
//! push services' SDKs set from a payload's field. A conversation shortcut
//! (`getShortcutId`) names a conversation too, but only of notifications
//! in the conversation style, and a tag (`getTag`) is how one notification
//! is replaced, not a group of them, so the group is the thread. A group's
//! summary is in the group and closes with it. NSH's own notifications
//! (`Notifications`) stay.

use nsh::{
    jni::{
        JNIEnv,
        errors::Result as JniResult,
        objects::{JObject, JObjectArray, JString, JValue},
    },
    notifications::{ForeignNotification, ForeignNotificationHandler, set_foreign_handler},
};
use nsh_core::prelude::*;

use super::{PushError, RemoteNotification};

/// Why [`super::register`] fails without a push service's binding.
pub(super) const UNAVAILABLE: &str =
    "remote notifications on Android come through a push service's binding, and none is set";

/// The channel of NSH's own notifications (`Notifications.java` of
/// `nsh-platform-android`), and with a `.` the prefix of the channels of
/// those with a sound of their own.
const NSH_CHANNEL: &str = "com.longbridge.nsh.notifications";

/// The id NSH posts each of its own notifications with, the tag being its
/// id in the app.
const NSH_ID: i32 = 1;

/// `Context.NOTIFICATION_SERVICE`.
const NOTIFICATION_SERVICE: &str = "notification";

/// Makes the module the handler of the presses of the notifications NSH
/// did not show. The handler is set on the UI thread, as the core asks:
/// the entry loading the app runs there, and sets it now, before the
/// first engine starts; a development reload runs it again on another
/// thread, where the set it makes asks each engine it starts to set it on
/// the UI thread. Each run sets it again, so the handler is always the
/// module's that runs now (the core warns that it replaced one).
pub(super) fn install(registry: &mut Registry) {
    if on_ui_thread() {
        set_foreign_handler(Foreign);
    } else {
        registry.setup(|| {
            // Dropping the result does not stop it; a panic is logged.
            drop(run_on_main_thread(|| set_foreign_handler(Foreign)));
        });
    }
}

/// The handler of the presses of the notifications NSH did not show.
struct Foreign;

impl ForeignNotificationHandler for Foreign {
    fn pressed(&self, notification: &ForeignNotification) {
        super::pressed(RemoteNotification::new("", "", notification.extras.clone()));
    }
}

/// Whether this is the UI thread (the main looper's).
fn on_ui_thread() -> bool {
    let answer = nsh::with_env(|env| {
        let looper = "android/os/Looper";
        let signature = "()Landroid/os/Looper;";
        let main = env
            .call_static_method(looper, "getMainLooper", signature, &[])?
            .l()?;
        let mine = env
            .call_static_method(looper, "myLooper", signature, &[])?
            .l()?;
        Ok(!mine.is_null() && env.is_same_object(&main, &mine)?)
    });
    answer.unwrap_or_else(|error| {
        log::error!("push: cannot tell the UI thread: {error}");
        false
    })
}

/// Never asked: without a binding [`super::register`] fails first.
pub(super) async fn register() -> Result<(), PushError> {
    Err(PushError::unavailable(UNAVAILABLE))
}

pub(super) use super::expire_later;

/// Cancels the posted notifications grouped in `thread_id`, but NSH's own.
/// Any thread.
pub(super) async fn close_thread(thread_id: String) -> Result<(), PushError> {
    nsh::with_env(|env| close(env, &thread_id)).map_err(|error| {
        PushError::failed(format!("cannot close the thread's notifications: {error}"))
    })
}

fn close(env: &mut JNIEnv<'_>, thread_id: &str) -> JniResult<()> {
    // SAFETY: NSH sets the process's application context, a global
    // reference it never deletes, when the first `NshView` is made, before
    // an app's or a module's code runs.
    let context = unsafe { JObject::from_raw(ndk_context::android_context().context().cast()) };
    let service = env.new_string(NOTIFICATION_SERVICE)?;
    let manager = env
        .call_method(
            &context,
            "getSystemService",
            "(Ljava/lang/String;)Ljava/lang/Object;",
            &[JValue::Object(&service)],
        )?
        .l()?;
    if manager.is_null() {
        return Ok(());
    }
    let active = env
        .call_method(
            &manager,
            "getActiveNotifications",
            "()[Landroid/service/notification/StatusBarNotification;",
            &[],
        )?
        .l()?;
    let active = JObjectArray::from(active);
    let count = env.get_array_length(&active)?;
    let mut posted = Vec::with_capacity(usize::try_from(count).unwrap_or_default());
    for index in 0..count {
        let notification = env.get_object_array_element(&active, index)?;
        posted.push(identify(env, &notification)?);
        env.delete_local_ref(notification)?;
    }
    let closing = super::in_thread(
        posted
            .iter()
            .map(|(key, group, own)| (key, group.as_str(), *own)),
        thread_id,
    );
    for (tag, id) in closing {
        let tag = match tag {
            Some(tag) => JObject::from(env.new_string(tag)?),
            None => JObject::null(),
        };
        env.call_method(
            &manager,
            "cancel",
            "(Ljava/lang/String;I)V",
            &[JValue::Object(&tag), JValue::Int(*id)],
        )?;
        env.delete_local_ref(tag)?;
    }
    Ok(())
}

/// What a posted notification (a `StatusBarNotification`) is cancelled by
/// (its tag and id), its group and whether NSH showed it.
type Posted = ((Option<String>, i32), String, bool);

fn identify(env: &mut JNIEnv<'_>, posted: &JObject<'_>) -> JniResult<Posted> {
    let id = env.call_method(posted, "getId", "()I", &[])?.i()?;
    let tag = env
        .call_method(posted, "getTag", "()Ljava/lang/String;", &[])?
        .l()?;
    let tag = string(env, tag)?;
    let notification = env
        .call_method(
            posted,
            "getNotification",
            "()Landroid/app/Notification;",
            &[],
        )?
        .l()?;
    let group = env
        .call_method(&notification, "getGroup", "()Ljava/lang/String;", &[])?
        .l()?;
    let group = string(env, group)?.unwrap_or_default();
    // API 26, NSH's minimum.
    let channel = env
        .call_method(&notification, "getChannelId", "()Ljava/lang/String;", &[])?
        .l()?;
    let channel = string(env, channel)?.unwrap_or_default();
    env.delete_local_ref(notification)?;
    let own = id == NSH_ID
        && tag.is_some()
        && channel
            .strip_prefix(NSH_CHANNEL)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('.'));
    Ok(((tag, id), group, own))
}

/// The string `object` (a `java.lang.String` or null), its local
/// reference deleted.
fn string(env: &mut JNIEnv<'_>, object: JObject<'_>) -> JniResult<Option<String>> {
    if object.is_null() {
        return Ok(None);
    }
    let object = JString::from(object);
    let value = String::from(env.get_string(&object)?);
    env.delete_local_ref(object)?;
    Ok(Some(value))
}

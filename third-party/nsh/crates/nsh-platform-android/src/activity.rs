//! Starting another app's activity for a result from Rust code (an app's
//! crate, an nshm): a camera, a contact picker, a system settings screen
//! that answers.
//!
//! Android gives a result only to the activity that started it
//! (`onActivityResult`), NSH's `AppActivity` or an embedding app's, so Rust
//! code cannot start one by itself. `Activities.java` starts it from the
//! activity in front, through a headless fragment kept across configuration
//! changes, and answers each [`start_for_result`] here, as
//! [`crate::permissions`] answers prompts.
//!
//! Files cross to the other app through the runtime's `FilesProvider`: a
//! new file it writes its answer to ([`output_file`]), or a file of the
//! app's own storage it reads ([`content_uri`]).
//!
//! ```no_run
//! // The library of the `nsh-platform-android` crate is `nsh`.
//! use nsh::{activity, jni::objects::JValue};
//!
//! # async fn pick_contact() -> Result<(), activity::ActivityError> {
//! let started = nsh::with_env(|env| {
//!     let action = env.new_string("android.intent.action.PICK")?;
//!     let intent = env.new_object(
//!         "android/content/Intent",
//!         "(Ljava/lang/String;)V",
//!         &[JValue::Object(&action)],
//!     )?;
//!     Ok(activity::start_for_result(env, &intent))
//! });
//! if let Ok(started) = started {
//!     let result = started.await?;
//!     if result.code == activity::RESULT_OK {
//!         // Read `result.data`.
//!     }
//! }
//! # Ok(())
//! # }
//! ```

use std::{
    fmt,
    future::Future,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicI64, Ordering},
    },
};

use jni::{
    JNIEnv,
    objects::{GlobalRef, JClass, JObject, JObjectArray, JString, JValue},
    signature::{Primitive, ReturnType},
    sys::{jint, jlong},
};
use rustc_hash::FxHashMap;
use tokio::sync::oneshot;

use crate::java::java;

/// `Activity.RESULT_OK`: the activity did what it was started for.
pub const RESULT_OK: i32 = -1;

/// `Activity.RESULT_CANCELED`: the user went back without an answer.
pub const RESULT_CANCELED: i32 = 0;

/// What an activity answered.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct ActivityResult {
    /// Its result code: [`RESULT_OK`], [`RESULT_CANCELED`] or the
    /// activity's own.
    pub code: i32,
    /// The `Intent` it answered with, if any.
    pub data: Option<GlobalRef>,
}

/// Why an activity could not be started or did not answer.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ActivityError {
    /// No `NshView` was made yet: there is no app to start it from.
    NotStarted,
    /// No activity is in front to start it from (the app is in the
    /// background), or it finished before the result came.
    NoActivity(String),
    /// No installed activity handles the intent.
    NotFound,
    /// Starting it or the call into Java failed (the message, or the log,
    /// says why).
    Failed(String),
}

impl fmt::Display for ActivityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotStarted => f.write_str("no NshView was made yet"),
            Self::NoActivity(why) | Self::Failed(why) => f.write_str(why),
            Self::NotFound => f.write_str("no installed activity handles the intent"),
        }
    }
}

impl std::error::Error for ActivityError {}

type Answer = Result<ActivityResult, ActivityError>;

/// The activities started and not answered yet, by key.
static PENDING: Mutex<Option<FxHashMap<i64, oneshot::Sender<Answer>>>> = Mutex::new(None);
static NEXT: AtomicI64 = AtomicI64::new(1);

/// Starts `intent` from the activity in front and resolves with what it
/// answers, once it does (the user going back answers
/// [`RESULT_CANCELED`]). Any thread; the activity starts on the UI thread.
pub fn start_for_result(
    env: &mut JNIEnv<'_>,
    intent: &JObject<'_>,
) -> impl Future<Output = Answer> + Send + 'static {
    let (sender, receiver) = oneshot::channel();
    let key = NEXT.fetch_add(1, Ordering::Relaxed);
    PENDING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_or_insert_with(FxHashMap::default)
        .insert(key, sender);
    // SAFETY: the signature checked in `java::init`.
    let started = unsafe {
        env.call_static_method_unchecked(
            <&JClass<'_>>::from(java().activities.as_obj()),
            java().activities_start,
            ReturnType::Primitive(Primitive::Void),
            &[JValue::Object(intent).as_jni(), JValue::Long(key).as_jni()],
        )
    };
    if let Err(err) = started {
        clear_exception(env);
        answer(key, Err(ActivityError::Failed(err.to_string())));
    }
    async move {
        receiver
            .await
            .unwrap_or_else(|_| Err(ActivityError::Failed("no answer came".into())))
    }
}

/// Whether an installed activity handles `intent`: false before any
/// `NshView` was made. Any thread.
pub fn can_start(env: &mut JNIEnv<'_>, intent: &JObject<'_>) -> bool {
    // SAFETY: the signature checked in `java::init`.
    let answer = unsafe {
        env.call_static_method_unchecked(
            <&JClass<'_>>::from(java().activities.as_obj()),
            java().activities_can_start,
            ReturnType::Primitive(Primitive::Boolean),
            &[JValue::Object(intent).as_jni()],
        )
    };
    match answer.and_then(|value| value.z()) {
        Ok(handled) => handled,
        Err(err) => {
            clear_exception(env);
            log::error!("cannot ask which activity handles an intent: {err}");
            false
        }
    }
}

/// A new, empty file of the app's cache that another app may write, for
/// an activity's answer (a camera's photo, `EXTRA_OUTPUT`).
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct OutputFile {
    /// Where it is.
    pub path: PathBuf,
    /// The `content:` URI the other app writes it through (`android.net.Uri`),
    /// served by the runtime's `FilesProvider`.
    pub uri: GlobalRef,
}

/// Makes an [`OutputFile`] whose name ends with `name` (`photo.jpg`). The
/// caller deletes it when done; one left behind (the app ended first) is
/// deleted when an output file is made a day later. Any thread.
pub fn output_file(env: &mut JNIEnv<'_>, name: &str) -> Result<OutputFile, ActivityError> {
    let made = (|| -> jni::errors::Result<Option<OutputFile>> {
        let name = env.new_string(name)?;
        // SAFETY: the signature checked in `java::init`.
        let made = unsafe {
            env.call_static_method_unchecked(
                <&JClass<'_>>::from(java().activities.as_obj()),
                java().activities_output_file,
                ReturnType::Array,
                &[JValue::Object(&name).as_jni()],
            )
        }?
        .l()?;
        if made.is_null() {
            return Ok(None);
        }
        let made = JObjectArray::from(made);
        let path: JString<'_> = env.get_object_array_element(&made, 0)?.into();
        let path = PathBuf::from(String::from(env.get_string(&path)?));
        let uri = env.get_object_array_element(&made, 1)?;
        let uri = env.new_global_ref(uri)?;
        Ok(Some(OutputFile { path, uri }))
    })();
    match made {
        Ok(Some(file)) => Ok(file),
        Ok(None) => Err(ActivityError::Failed(
            "no output file can be made (no NshView yet, or the cache is not writable)".into(),
        )),
        Err(err) => {
            clear_exception(env);
            Err(ActivityError::Failed(err.to_string()))
        }
    }
}

/// A file of the app's own storage as another app reads it: the
/// `content:` URI the runtime's `FilesProvider` serves it through and its
/// type ([`content_uri`]).
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct ContentUri {
    /// The `content:` URI (`android.net.Uri`), for an intent's data, its
    /// `EXTRA_STREAM` or its `ClipData`; the intent grants the other app
    /// reading it with `FLAG_GRANT_READ_URI_PERMISSION`.
    pub uri: GlobalRef,
    /// The file's MIME type by its extension (`application/pdf`),
    /// `application/octet-stream` for one Android does not know.
    pub mime: String,
}

/// The `content:` URI another app reads the file at `path` through, for
/// Rust code that hands a file to another app (a share sheet, an "open
/// with" chooser, a mail's attachment): `None` when `path` is not a file
/// of the app's own storage (its files, cache and no-backup directories
/// and their external counterparts, where `${dataDir}` is unless an
/// embedding app chose another), which is all the runtime's
/// `FilesProvider` serves. Check the app may read the file
/// first (`System::readable_file` in a module). Any thread.
pub fn content_uri(env: &mut JNIEnv<'_>, path: &Path) -> Result<Option<ContentUri>, ActivityError> {
    let made = (|| -> jni::errors::Result<Option<Option<ContentUri>>> {
        let path = env.new_string(path.to_string_lossy())?;
        // SAFETY: the signature checked in `java::init`.
        let made = unsafe {
            env.call_static_method_unchecked(
                <&JClass<'_>>::from(java().activities.as_obj()),
                java().activities_content_uri,
                ReturnType::Array,
                &[JValue::Object(&path).as_jni()],
            )
        }?
        .l()?;
        if made.is_null() {
            return Ok(None);
        }
        let made = JObjectArray::from(made);
        if env.get_array_length(&made)? < 2 {
            return Ok(Some(None));
        }
        let uri = env.get_object_array_element(&made, 0)?;
        let uri = env.new_global_ref(uri)?;
        let mime: JString<'_> = env.get_object_array_element(&made, 1)?.into();
        let mime = String::from(env.get_string(&mime)?);
        Ok(Some(Some(ContentUri { uri, mime })))
    })();
    match made {
        Ok(Some(served)) => Ok(served),
        Ok(None) => Err(ActivityError::NotStarted),
        Err(err) => {
            clear_exception(env);
            Err(ActivityError::Failed(err.to_string()))
        }
    }
}

fn clear_exception(env: &mut JNIEnv<'_>) {
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }
}

/// Answers start `key`, once.
fn answer(key: i64, answer: Answer) {
    let sender = PENDING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_mut()
        .and_then(|pending| pending.remove(&key));
    if let Some(sender) = sender {
        // The caller may have stopped waiting.
        let _ = sender.send(answer);
    }
}

/// The error `Activities.java` reports by its `reason`.
fn error(reason: &str, message: String) -> ActivityError {
    match reason {
        "not-started" => ActivityError::NotStarted,
        "no-activity" => ActivityError::NoActivity(message),
        "not-found" => ActivityError::NotFound,
        _ => ActivityError::Failed(message),
    }
}

/// `Activities.nativeResult`: start `key`'s result, or why it has none.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Activities_nativeResult(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    key: jlong,
    code: jint,
    data: JObject<'_>,
    reason: JString<'_>,
    message: JString<'_>,
) {
    let read = |env: &mut JNIEnv<'_>, s: &JString<'_>| {
        if s.is_null() {
            None
        } else {
            env.get_string(s).map(String::from).ok()
        }
    };
    let result = match read(&mut env, &reason) {
        Some(reason) => Err(error(&reason, read(&mut env, &message).unwrap_or_default())),
        None => {
            let data = if data.is_null() {
                None
            } else {
                env.new_global_ref(&data).ok()
            };
            Ok(ActivityResult { code, data })
        }
    };
    answer(key, result);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn java_reasons_are_errors() {
        assert_eq!(
            error("not-started", String::new()),
            ActivityError::NotStarted
        );
        assert_eq!(error("not-found", String::new()), ActivityError::NotFound);
        assert_eq!(
            error("no-activity", "gone".into()),
            ActivityError::NoActivity("gone".into())
        );
        assert_eq!(
            error("failed", "boom".into()),
            ActivityError::Failed("boom".into())
        );
    }

    #[test]
    fn a_start_answers_once() {
        let (sender, mut receiver) = oneshot::channel();
        PENDING
            .lock()
            .unwrap()
            .get_or_insert_with(FxHashMap::default)
            .insert(-7, sender);
        answer(-7, Err(ActivityError::NotFound));
        answer(-7, Err(ActivityError::NotStarted));
        assert_eq!(
            receiver.try_recv().unwrap().unwrap_err(),
            ActivityError::NotFound
        );
    }
}

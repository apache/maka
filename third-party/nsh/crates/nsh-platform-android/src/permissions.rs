//! Android runtime permissions for Rust code (an app's crate, an
//! extension): a permission's state, and the user's answer to the system's
//! prompt for it.
//!
//! Android gives the answer only to the activity that asked
//! (`onRequestPermissionsResult`), which is NSH's `AppActivity` or an
//! embedding app's, so Rust code cannot ask by itself. `Permissions.java`
//! asks through the activity in front, one request at a time and across
//! configuration changes, and answers each [`request`] here. NSH's own
//! prompts (notifications, web pages' camera and microphone) ask through
//! it too.
//!
//! A permission the app's manifest does not declare is never granted and
//! shows no prompt ([`Permission::Undeclared`]).
//!
//! ```no_run
//! // The library of the `nsh-platform-android` crate is `nsh`.
//! use nsh::permissions::{self, Permission};
//!
//! # async fn record() -> Result<(), permissions::PermissionError> {
//! let answers = permissions::request(&["android.permission.RECORD_AUDIO"]).await?;
//! if answers[0] == Permission::Granted {
//!     // Record.
//! }
//! # Ok(())
//! # }
//! ```

use std::{
    fmt,
    sync::{
        Mutex,
        atomic::{AtomicI64, Ordering},
    },
};

use jni::{
    JNIEnv,
    objects::{JClass, JObject, JObjectArray, JString, JValue},
    signature::ReturnType,
    sys::jlong,
};
use rustc_hash::FxHashMap;
use tokio::sync::oneshot;

use crate::java::{java, with_env};

/// A permission's state for the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum Permission {
    /// Not granted, and asking shows the system's prompt.
    Default,
    /// Granted.
    Granted,
    /// The user refused, and Android shows no prompt any more: only the
    /// system's settings grant it now.
    Denied,
    /// The app's manifest does not declare it, so Android never grants it.
    Undeclared,
}

impl Permission {
    /// Its name in `Permissions.java`'s answers.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Granted => "granted",
            Self::Denied => "denied",
            Self::Undeclared => "undeclared",
        }
    }

    /// The state named `name` ([`Self::as_str`]).
    pub fn from_name(name: &str) -> Option<Self> {
        [Self::Default, Self::Granted, Self::Denied, Self::Undeclared]
            .into_iter()
            .find(|p| p.as_str() == name)
    }
}

/// Why a permission could not be read or asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum PermissionError {
    /// No `NshView` was made yet: there is no app to ask about.
    NotStarted,
    /// No activity is in front to show the prompt (the app is in the
    /// background), or it finished before the user answered.
    NoActivity(String),
    /// A name that cannot be a permission's: empty, or with a NUL.
    InvalidName(String),
    /// The call into Java failed (the log says why).
    Java,
}

impl fmt::Display for PermissionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotStarted => f.write_str("no NshView was made yet"),
            Self::NoActivity(why) => f.write_str(why),
            Self::InvalidName(name) => write!(f, "`{name}` is not a permission's name"),
            Self::Java => f.write_str("the call into Java failed"),
        }
    }
}

impl std::error::Error for PermissionError {}

type Answer = Result<Vec<Permission>, PermissionError>;

/// The requests waiting for the user, by key.
static PENDING: Mutex<Option<FxHashMap<i64, oneshot::Sender<Answer>>>> = Mutex::new(None);
static NEXT: AtomicI64 = AtomicI64::new(1);

/// The state of `permission` (`"android.permission.CAMERA"`), without
/// asking. Any thread.
pub fn state(permission: &str) -> Result<Permission, PermissionError> {
    Ok(states(&[permission])?[0])
}

/// The state of each of `permissions`, in their order, without asking. Any
/// thread.
pub fn states(permissions: &[&str]) -> Result<Vec<Permission>, PermissionError> {
    let names = checked(permissions)?;
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let states = with_env(|env| {
        let array = name_array(env, &names)?;
        // SAFETY: the signature checked in `java::init`.
        let states = unsafe {
            env.call_static_method_unchecked(
                <&JClass<'_>>::from(java().permissions.as_obj()),
                java().permissions_states,
                ReturnType::Array,
                &[JValue::Object(&array).as_jni()],
            )
        }?
        .l()?;
        if states.is_null() {
            return Ok(Some(Err(PermissionError::NotStarted)));
        }
        Ok(Some(read_states(env, &JObjectArray::from(states))))
    });
    states.unwrap_or(Err(PermissionError::Java))
}

/// Asks the user for `permissions` (`"android.permission.CAMERA"`) with the
/// system's prompt, through the activity in front, after the requests
/// before it; resolves with the state of each, in their order, once the
/// user answers. Permissions already granted or not declared are answered
/// without a prompt. Any thread.
pub fn request(permissions: &[&str]) -> impl Future<Output = Answer> + Send + 'static {
    let (sender, receiver) = oneshot::channel();
    match checked(permissions) {
        Err(error) => drop(sender.send(Err(error))),
        Ok(names) if names.is_empty() => drop(sender.send(Ok(Vec::new()))),
        Ok(names) => {
            let key = NEXT.fetch_add(1, Ordering::Relaxed);
            PENDING
                .lock()
                .expect("pending")
                .get_or_insert_with(FxHashMap::default)
                .insert(key, sender);
            let asked = with_env(|env| {
                let array = name_array(env, &names)?;
                // SAFETY: the signature checked in `java::init`.
                unsafe {
                    env.call_static_method_unchecked(
                        <&JClass<'_>>::from(java().permissions.as_obj()),
                        java().permissions_request,
                        ReturnType::Primitive(jni::signature::Primitive::Void),
                        &[JValue::Object(&array).as_jni(), JValue::Long(key).as_jni()],
                    )
                }?;
                Ok(true)
            });
            if !asked {
                answer(key, Err(PermissionError::Java));
            }
        }
    }
    async move { receiver.await.unwrap_or(Err(PermissionError::Java)) }
}

/// `permissions` as owned names, each checked.
fn checked(permissions: &[&str]) -> Result<Vec<String>, PermissionError> {
    permissions
        .iter()
        .map(|&name| {
            if name.is_empty() || name.contains('\0') {
                Err(PermissionError::InvalidName(name.to_owned()))
            } else {
                Ok(name.to_owned())
            }
        })
        .collect()
}

fn name_array<'local>(
    env: &mut JNIEnv<'local>,
    names: &[String],
) -> jni::errors::Result<JObjectArray<'local>> {
    let array = env.new_object_array(names.len() as i32, "java/lang/String", JObject::null())?;
    for (i, name) in names.iter().enumerate() {
        let name = env.new_string(name)?;
        env.set_object_array_element(&array, i as i32, name)?;
    }
    Ok(array)
}

fn read_states(env: &mut JNIEnv<'_>, states: &JObjectArray<'_>) -> Answer {
    let read = |env: &mut JNIEnv<'_>| -> jni::errors::Result<Vec<Option<Permission>>> {
        let count = env.get_array_length(states)?;
        let mut read = Vec::with_capacity(count as usize);
        for i in 0..count {
            let name: JString<'_> = env.get_object_array_element(states, i)?.into();
            read.push(Permission::from_name(&String::from(env.get_string(&name)?)));
        }
        Ok(read)
    };
    match read(env) {
        Ok(states) => states
            .into_iter()
            .map(|state| state.ok_or(PermissionError::Java))
            .collect(),
        Err(err) => {
            log::error!("cannot read the permissions' states: {err}");
            Err(PermissionError::Java)
        }
    }
}

/// Answers request `key`, once.
fn answer(key: i64, answer: Answer) {
    let sender = PENDING
        .lock()
        .expect("pending")
        .as_mut()
        .and_then(|pending| pending.remove(&key));
    if let Some(sender) = sender {
        // The caller may have stopped waiting.
        let _ = sender.send(answer);
    }
}

/// `Permissions.nativeAnswer`: request `key`'s states, or why it got none.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Permissions_nativeAnswer(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    key: jlong,
    states: JObjectArray<'_>,
    error: JString<'_>,
) {
    let result = if !error.is_null() {
        let why = env.get_string(&error).map(String::from).unwrap_or_default();
        Err(PermissionError::NoActivity(why))
    } else if states.is_null() {
        Err(PermissionError::NotStarted)
    } else {
        read_states(&mut env, &states)
    };
    answer(key, result);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn states_are_named_as_java_answers_them() {
        for state in [
            Permission::Default,
            Permission::Granted,
            Permission::Denied,
            Permission::Undeclared,
        ] {
            assert_eq!(Permission::from_name(state.as_str()), Some(state));
        }
        assert_eq!(Permission::from_name("prompt"), None);
    }

    #[test]
    fn names_are_checked_before_java_sees_them() {
        assert_eq!(
            checked(&["android.permission.CAMERA", ""]),
            Err(PermissionError::InvalidName(String::new()))
        );
        assert_eq!(
            checked(&["a\0b"]),
            Err(PermissionError::InvalidName("a\0b".into()))
        );
        assert_eq!(
            checked(&["android.permission.CAMERA"]).unwrap(),
            ["android.permission.CAMERA"]
        );
    }
}

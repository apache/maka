//! The camera on Android: the camera app (`ACTION_IMAGE_CAPTURE`) started
//! for a result (`nsh::activity`), writing its photo to an output file of
//! the app's cache through the runtime's file provider. When the app's
//! manifest declares `CAMERA`, Android refuses the intent until the
//! permission is granted, so it is asked first; an app that does not
//! declare it needs none. The photo is prepared off the UI thread as a
//! picked image (`nsh::picker::prepare_image`) and the file deleted, also
//! when the photo fails. One photo is taken at a time.

use std::{
    future::Future,
    pin::Pin,
    sync::atomic::{AtomicBool, Ordering},
};

use nsh::{
    activity::{self, ActivityError, ActivityResult, OutputFile},
    jni::{
        JNIEnv,
        objects::{JObject, JValue},
    },
    permissions::{self, Permission},
};
use nsh_core::{picker::PickedFile, prelude::*};

use super::{PhotoError, PhotoRequest};

const CAMERA: &str = "android.permission.CAMERA";
const IMAGE_CAPTURE: &str = "android.media.action.IMAGE_CAPTURE";
const EXTRA_OUTPUT: &str = "output";
/// `FLAG_GRANT_READ_URI_PERMISSION | FLAG_GRANT_WRITE_URI_PERMISSION`.
const GRANT_READ_WRITE: i32 = 0x1 | 0x2;

type Started = Pin<Box<dyn Future<Output = Result<ActivityResult, ActivityError>> + Send>>;

/// A photo is being taken: another would start a second camera app over it.
static TAKING: AtomicBool = AtomicBool::new(false);

/// The photo being taken, until it is answered or dropped.
struct Taking;

impl Taking {
    fn begin() -> Option<Taking> {
        (!TAKING.swap(true, Ordering::AcqRel)).then_some(Taking)
    }
}

impl Drop for Taking {
    fn drop(&mut self) {
        TAKING.store(false, Ordering::Release);
    }
}

/// Deletes the output file when dropped: the photo was prepared, failed, or
/// the app stopped waiting for it.
struct Output(OutputFile);

impl Drop for Output {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0.path);
    }
}

pub(super) async fn available() -> bool {
    nsh::with_env(|env| {
        let intent = capture_intent(env)?;
        Ok(activity::can_start(env, &intent))
    })
    .unwrap_or(false)
}

pub(super) async fn take_photo(request: PhotoRequest) -> Result<Option<PickedFile>, PhotoError> {
    let Some(_taking) = Taking::begin() else {
        return Err(PhotoError::failed(
            "the camera is already showing for another photo",
        ));
    };
    allow_camera().await?;
    let (output, started) = nsh::with_env(|env| Ok(start(env))).map_err(|error| {
        PhotoError::failed(format!("the camera app cannot be started: {error}"))
    })??;
    match started.await {
        Ok(result) if result.code == activity::RESULT_OK => {
            let path = output.0.path.clone();
            let name = super::photo_name();
            let pick = request.pick_request();
            let prepared = blocking(move || nsh::picker::prepare_image(&path, &name, &pick))
                .await
                .map_err(|error| {
                    PhotoError::failed(format!("cannot prepare the photo: {error}"))
                })?;
            match prepared {
                // A camera app may answer OK without writing the file.
                Some(photo) if !photo.data.is_empty() => Ok(Some(photo)),
                _ => Err(PhotoError::failed("the camera app wrote no photo")),
            }
        }
        Ok(_) => Ok(None),
        Err(ActivityError::NotFound) => Err(PhotoError::unavailable("no camera app is installed")),
        Err(error) => Err(PhotoError::failed(error.to_string())),
    }
}

/// Asks for `CAMERA` when the manifest declares it and the user has not
/// granted it yet.
async fn allow_camera() -> Result<(), PhotoError> {
    let denied = || PhotoError::denied("the user does not let the app use the camera");
    match permissions::state(CAMERA) {
        Ok(Permission::Granted | Permission::Undeclared) => Ok(()),
        Ok(Permission::Denied) => Err(denied()),
        Ok(_) => match permissions::request(&[CAMERA]).await {
            Ok(states) if states.first() == Some(&Permission::Granted) => Ok(()),
            Ok(_) => Err(denied()),
            Err(error) => Err(PhotoError::failed(error.to_string())),
        },
        Err(error) => Err(PhotoError::failed(error.to_string())),
    }
}

/// `new Intent(ACTION_IMAGE_CAPTURE)`.
fn capture_intent<'local>(env: &mut JNIEnv<'local>) -> nsh::jni::errors::Result<JObject<'local>> {
    let action = env.new_string(IMAGE_CAPTURE)?;
    env.new_object(
        "android/content/Intent",
        "(Ljava/lang/String;)V",
        &[JValue::Object(&action)],
    )
}

/// Starts the camera app writing to a new output file: the file, and the
/// camera app's answer to come; or why it cannot start. The file is deleted
/// on every way out but the start.
fn start(env: &mut JNIEnv<'_>) -> Result<(Output, Started), PhotoError> {
    let failed = |error: nsh::jni::errors::Error| {
        PhotoError::failed(format!("the camera app cannot be started: {error}"))
    };
    let intent = capture_intent(env).map_err(failed)?;
    if !activity::can_start(env, &intent) {
        return Err(PhotoError::unavailable("no camera app is installed"));
    }
    let output = activity::output_file(env, "photo.jpg")
        .map(Output)
        .map_err(|error| PhotoError::failed(error.to_string()))?;
    let uri = output.0.uri.as_obj();
    let extra = env.new_string(EXTRA_OUTPUT).map_err(failed)?;
    env.call_method(
        &intent,
        "putExtra",
        "(Ljava/lang/String;Landroid/os/Parcelable;)Landroid/content/Intent;",
        &[JValue::Object(&extra), JValue::Object(uri)],
    )
    .map_err(failed)?;
    // The grant reaches the camera app through the intent's clip data.
    let label = env.new_string("photo").map_err(failed)?;
    let clip = env
        .call_static_method(
            "android/content/ClipData",
            "newRawUri",
            "(Ljava/lang/CharSequence;Landroid/net/Uri;)Landroid/content/ClipData;",
            &[JValue::Object(&label), JValue::Object(uri)],
        )
        .and_then(|clip| clip.l())
        .map_err(failed)?;
    env.call_method(
        &intent,
        "setClipData",
        "(Landroid/content/ClipData;)V",
        &[JValue::Object(&clip)],
    )
    .map_err(failed)?;
    env.call_method(
        &intent,
        "addFlags",
        "(I)Landroid/content/Intent;",
        &[JValue::Int(GRANT_READ_WRITE)],
    )
    .map_err(failed)?;
    let started: Started = Box::pin(activity::start_for_result(env, &intent));
    Ok((output, started))
}

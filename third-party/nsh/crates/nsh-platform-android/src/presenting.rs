//! What a module's UI-thread function shows system UI from: the surface
//! that ran it. Modules outside NSH (nshm) run Android code with
//! `run_on_main_thread`; while such a function runs, its surface is
//! current here, so a dialog a module shows opens over that surface's
//! activity ([`presenting_activity`]) and a popup points at the view of the
//! element it belongs to ([`native_view`]), as the system UI NSH shows
//! itself does.

use std::cell::RefCell;

use jni::{
    JNIEnv,
    objects::{GlobalRef, JObject, JValue},
    signature::ReturnType,
};
use nsh_core::NodeId;

use crate::java::java;

thread_local! {
    /// The `NshView` of the surface whose UI-thread function runs now.
    static CURRENT: RefCell<Option<GlobalRef>> = const { RefCell::new(None) };
}

/// Runs `f` with the surface of `view` (its `NshView`) as the current one.
pub(crate) fn run_for(view: GlobalRef, f: impl FnOnce()) {
    let previous = CURRENT.with_borrow_mut(|current| current.replace(view));
    f();
    CURRENT.with_borrow_mut(|current| *current = previous);
}

/// The `android.view.View` of element `node` (its `ref`'s node, `NodeRef`
/// in a module's arguments) of the surface whose function a module runs on
/// the UI thread (`run_on_main_thread`), in the surface or in one of its
/// modals; [`ROOT_ID`](nsh_core::ROOT_ID) is the surface's root view. For
/// system UI that belongs to an element: a `PopupMenu`'s or a
/// `PopupWindow`'s anchor, the source of a share sheet's transition. Take
/// it while the function runs and keep it as long as the UI needs it.
///
/// For anchoring and presenting system UI only: a module never changes,
/// re-parents, restyles or removes a view NSH owns.
///
/// `Ok(None)` outside such a function and when no view of the surface
/// carries `node` (not rendered, made only near a scroll view's viewport,
/// or removed since). The view may be out of a window (a screen not
/// shown); check `isAttachedToWindow()` before pointing at it.
pub fn native_view(env: &mut JNIEnv<'_>, node: NodeId) -> jni::errors::Result<Option<GlobalRef>> {
    let Some(view) = CURRENT.with_borrow(Clone::clone) else {
        return Ok(None);
    };
    // Node ids cross to Java as `int`, as every batch sends them.
    let id = JValue::Int(node as i32).as_jni();
    // SAFETY: matches the signature checked in `java::init`.
    let found = unsafe {
        env.call_method_unchecked(
            view.as_obj(),
            java().view_native_view,
            ReturnType::Object,
            &[id],
        )
    }?
    .l()?;
    global(env, found)
}

/// The activity to show system UI over when no element anchors it (an
/// `AlertDialog`'s context, the activity to start a chooser from), from a
/// function a module runs on the UI thread (`run_on_main_thread`): the
/// activity the surface's view is in. `Ok(None)` outside such a function
/// and when the view is in no activity that can show anything (not in one,
/// or it is finishing or destroyed).
///
/// For presenting system UI only: a module never changes the activity's
/// content, which NSH owns.
pub fn presenting_activity(env: &mut JNIEnv<'_>) -> jni::errors::Result<Option<GlobalRef>> {
    let Some(view) = CURRENT.with_borrow(Clone::clone) else {
        return Ok(None);
    };
    // SAFETY: matches the signature checked in `java::init`.
    let found = unsafe {
        env.call_method_unchecked(
            view.as_obj(),
            java().view_presenting_activity,
            ReturnType::Object,
            &[],
        )
    }?
    .l()?;
    global(env, found)
}

/// A global reference to `object`, `None` for null.
fn global(env: &mut JNIEnv<'_>, object: JObject<'_>) -> jni::errors::Result<Option<GlobalRef>> {
    if object.is_null() {
        return Ok(None);
    }
    let global = env.new_global_ref(&object)?;
    env.delete_local_ref(object)?;
    Ok(Some(global))
}

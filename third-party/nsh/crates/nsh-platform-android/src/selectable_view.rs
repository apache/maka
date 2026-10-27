//! Selectable views (`ViewProps::selectable_view`) on the UI thread: the
//! shared model ([`nsh_core::selection`]) behind `SelectableView.java`.
//!
//! Java owns the views, the gestures and the drawing; the model (which
//! text, which offset, words, handles, what a copy gives) is Rust's, as on
//! every backend, so it is not written twice. Each area with a selection
//! holds one [`Area`] (a `long` handle in Java, from `nativeCreate` to
//! `nativeDestroy`). Java hands over the texts' content when they change
//! (`nativeSetTexts`) and their frames with every call (they move with
//! scrolling); hit-testing calls back into Java (`SelectableView.offsetAt`
//! turns the point into the text's content box and asks
//! `TextLayouts.hitTest`, which the engine thread's
//! `TextEngine::hit_test` runs too), all on the UI thread within the native
//! call.
//! Coordinates are the area's, in points (dp), origin at its top left.

use std::cell::RefCell;

use jni::{
    JNIEnv,
    objects::{JClass, JFloatArray, JIntArray, JObject, JObjectArray, JString, JValue},
    sys::{jboolean, jfloat, jint, jintArray, jlong, jstring},
};
use nsh_core::{
    Points,
    geometry::{Bounds, Point, bounds, point, px, size},
    selection::{Handle, SelectionModel, SelectionTexts},
};

/// The selection of one area and what it knows of the area's texts.
#[derive(Default)]
struct Area {
    model: SelectionModel,
    contents: Vec<String>,
    /// The texts' view ids: their identity across `texts_changed`.
    keys: Vec<u64>,
    frames: Vec<Bounds<Points>>,
}

/// The texts of an area for one native call: hit-tests ask the Java
/// `SelectableView` (`this`).
struct Texts<'a, 'local> {
    contents: &'a [String],
    keys: &'a [u64],
    frames: &'a [Bounds<Points>],
    env: RefCell<&'a mut JNIEnv<'local>>,
    this: &'a JObject<'local>,
}

impl SelectionTexts for Texts<'_, '_> {
    fn len(&self) -> usize {
        self.contents.len()
    }

    fn content(&self, i: usize) -> &str {
        &self.contents[i]
    }

    fn frame(&self, i: usize) -> Bounds<Points> {
        self.frames.get(i).copied().unwrap_or_default()
    }

    fn key(&self, i: usize) -> u64 {
        self.keys.get(i).copied().unwrap_or(i as u64)
    }

    fn offset_at(&self, i: usize, p: Point<Points>) -> u32 {
        let mut env = self.env.borrow_mut();
        let offset = env
            .call_method(
                self.this,
                "offsetAt",
                "(IFF)I",
                &[
                    JValue::Int(i as jint),
                    JValue::Float(p.x.0),
                    JValue::Float(p.y.0),
                ],
            )
            .and_then(|v| v.i());
        match offset {
            Ok(offset) => offset.max(0) as u32,
            Err(err) => {
                if env.exception_check().unwrap_or(false) {
                    let _ = env.exception_describe();
                    let _ = env.exception_clear();
                }
                log::error!("selection hit test failed: {err}");
                0
            }
        }
    }
}

/// The area behind a handle from `nativeCreate`.
///
/// # Safety
///
/// `handle` is live: created by `nativeCreate`, not yet destroyed, and
/// used only on the UI thread.
unsafe fn area<'a>(handle: jlong) -> &'a mut Area {
    // SAFETY: the caller's contract.
    unsafe { &mut *(handle as *mut Area) }
}

/// Frames as Java sends them: x, y, width, height per text (points).
fn read_frames(env: &JNIEnv<'_>, frames: &JFloatArray<'_>, out: &mut Vec<Bounds<Points>>) {
    out.clear();
    let len = env.get_array_length(frames).unwrap_or(0).max(0) as usize;
    let mut values = vec![0.0f32; len];
    if env.get_float_array_region(frames, 0, &mut values).is_err() {
        return;
    }
    out.extend(
        values
            .as_chunks::<4>()
            .0
            .iter()
            .map(|f| bounds(point(px(f[0]), px(f[1])), size(px(f[2]), px(f[3])))),
    );
}

/// Runs `f` with the area's model and its texts.
fn with_texts<'local, R>(
    env: &mut JNIEnv<'local>,
    this: &JObject<'local>,
    area: &mut Area,
    f: impl FnOnce(&mut SelectionModel, &Texts<'_, 'local>) -> R,
) -> R {
    let Area {
        model,
        contents,
        keys,
        frames,
    } = area;
    let texts = Texts {
        contents,
        keys,
        frames,
        env: RefCell::new(env),
        this,
    };
    f(model, &texts)
}

/// A new area without a selection.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_SelectableView_nativeCreate(
    _: JNIEnv<'_>,
    _: JClass<'_>,
) -> jlong {
    Box::into_raw(Box::<Area>::default()) as jlong
}

/// Frees an area's handle.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_SelectableView_nativeDestroy(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
) {
    if handle != 0 {
        // SAFETY: Java passes a handle it never uses again.
        drop(unsafe { Box::from_raw(handle as *mut Area) });
    }
}

/// The area's texts, in document order, are now these (content, view
/// ids and frames): the selection follows (`texts_changed`). Returns whether it
/// changed.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_SelectableView_nativeSetTexts<'local>(
    mut env: JNIEnv<'local>,
    _: JClass<'local>,
    handle: jlong,
    this: JObject<'local>,
    contents: JObjectArray<'local>,
    keys: JIntArray<'local>,
    frames: JFloatArray<'local>,
) -> jboolean {
    // SAFETY: Java passes its live handle, on the UI thread.
    let area = unsafe { area(handle) };
    let read = (|| -> jni::errors::Result<Vec<String>> {
        let count = env.get_array_length(&contents)?;
        let mut out = Vec::with_capacity(count as usize);
        for i in 0..count {
            let s: JString<'_> = env.get_object_array_element(&contents, i)?.into();
            out.push(String::from(env.get_string(&s)?));
            env.delete_local_ref(s)?;
        }
        Ok(out)
    })();
    match read {
        Ok(contents) => area.contents = contents,
        Err(err) => {
            log::error!("cannot read the selectable view's texts: {err}");
            area.contents.clear();
        }
    }
    let len = env.get_array_length(&keys).unwrap_or(0).max(0) as usize;
    let mut ids = vec![0; len];
    if env.get_int_array_region(&keys, 0, &mut ids).is_err() {
        ids.clear();
    }
    area.keys = ids.into_iter().map(|id| id as u32 as u64).collect();
    read_frames(&env, &frames, &mut area.frames);
    // Frames for every text, even if Java's array falls short.
    area.frames.resize(area.contents.len(), Bounds::default());
    with_texts(&mut env, &this, area, |model, texts| {
        model.texts_changed(texts)
    }) as jboolean
}

/// What `nativeGesture`'s `kind` asks.
const SELECT_WORD: jint = 0;
const DRAG: jint = 1;
const MOVE_START: jint = 2;
const MOVE_END: jint = 3;
const SELECT_ALL: jint = 4;
const CLEAR: jint = 5;

/// A gesture at (`x`, `y`) with the texts' current `frames`: select the
/// word there (a long press), drag the focus there (the long press goes
/// on), move the start or end handle there, select all, clear. Returns
/// whether the selection changed.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
extern "system" fn Java_com_longbridge_nsh_SelectableView_nativeGesture<'local>(
    mut env: JNIEnv<'local>,
    _: JClass<'local>,
    handle: jlong,
    this: JObject<'local>,
    frames: JFloatArray<'local>,
    kind: jint,
    x: jfloat,
    y: jfloat,
) -> jboolean {
    // SAFETY: Java passes its live handle, on the UI thread.
    let area = unsafe { area(handle) };
    read_frames(&env, &frames, &mut area.frames);
    area.frames.resize(area.contents.len(), Bounds::default());
    let at = point(px(x), px(y));
    with_texts(&mut env, &this, area, |model, texts| match kind {
        SELECT_WORD => model.select_word_at(texts, at),
        DRAG => model.drag(texts, at),
        MOVE_START => model.move_handle(texts, Handle::Start, at),
        MOVE_END => model.move_handle(texts, Handle::End, at),
        SELECT_ALL => model.select_all(texts),
        CLEAR => model.clear(),
        _ => false,
    }) as jboolean
}

/// What each text has selected: (text, start, end) triples, UTF-16.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_SelectableView_nativeRanges<'local>(
    mut env: JNIEnv<'local>,
    _: JClass<'local>,
    handle: jlong,
    this: JObject<'local>,
) -> jintArray {
    // SAFETY: Java passes its live handle, on the UI thread.
    let area = unsafe { area(handle) };
    let ranges = with_texts(&mut env, &this, area, |model, texts| model.ranges(texts));
    let ints: Vec<jint> = ranges
        .iter()
        .flat_map(|(i, r)| [*i as jint, r.start as jint, r.end as jint])
        .collect();
    ints_array(&env, &ints)
}

/// The selection's start and end (text, offset, text, offset), or an
/// empty array without one.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_SelectableView_nativeBounds(
    env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
) -> jintArray {
    // SAFETY: Java passes its live handle, on the UI thread.
    let area = unsafe { area(handle) };
    let ints: Vec<jint> = match area.model.bounds() {
        Some((start, end)) if !area.model.is_empty() => vec![
            start.text as jint,
            start.offset as jint,
            end.text as jint,
            end.offset as jint,
        ],
        _ => Vec::new(),
    };
    ints_array(&env, &ints)
}

/// The selected text, as a copy gives it.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_SelectableView_nativeText<'local>(
    mut env: JNIEnv<'local>,
    _: JClass<'local>,
    handle: jlong,
    this: JObject<'local>,
) -> jstring {
    // SAFETY: Java passes its live handle, on the UI thread.
    let area = unsafe { area(handle) };
    let text = with_texts(&mut env, &this, area, |model, texts| model.text(texts));
    env.new_string(text)
        .map_or(std::ptr::null_mut(), |s| s.into_raw())
}

fn ints_array(env: &JNIEnv<'_>, values: &[jint]) -> jintArray {
    let Ok(array) = env.new_int_array(values.len() as i32) else {
        return std::ptr::null_mut();
    };
    if env.set_int_array_region(&array, 0, values).is_err() {
        return std::ptr::null_mut();
    }
    array.into_raw()
}

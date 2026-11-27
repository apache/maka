//! The part of GStreamer [`crate::sound`] uses, loaded at run time
//! (`dlopen`) rather than linked: an app builds without GStreamer's
//! development files and starts without GStreamer installed; only a sound
//! needs it, and its load then fails naming the library missing.
//!
//! [`api`] loads `libgstreamer-1.0.so.0` and `libgstapp-1.0.so.0` once and
//! starts GStreamer. The rest is thin, owning wrappers over the C calls
//! made: [`Object`] (an element, a pad, a bus), [`Caps`], [`Buffer`],
//! [`Sample`], [`Message`]. Properties are set from strings
//! (`gst_util_set_object_arg`), as `gst-launch` does, so no `GValue` is
//! needed; GLib itself comes with GTK.

use std::{
    ffi::{CStr, CString, c_char, c_int, c_uint, c_void},
    ptr::{self, NonNull},
    sync::OnceLock,
};

use gtk4::glib::{
    ffi::{GError, GQuark, g_error_free, g_free},
    gobject_ffi,
};

/// `GstClockTime` none.
pub(crate) const CLOCK_TIME_NONE: u64 = u64::MAX;
/// `GST_MESSAGE_ERROR`.
pub(crate) const MESSAGE_ERROR: c_uint = 1 << 1;
/// `GST_STATE_NULL`, `GST_STATE_PLAYING`.
pub(crate) const STATE_NULL: c_int = 1;
pub(crate) const STATE_PLAYING: c_int = 4;
/// `GST_STREAM_ERROR_CODEC_NOT_FOUND`, `GST_CORE_ERROR_MISSING_PLUGIN`.
const STREAM_ERROR_CODEC_NOT_FOUND: c_int = 6;
const CORE_ERROR_MISSING_PLUGIN: c_int = 12;

/// The libraries loaded, by their soname.
const CORE: &str = "libgstreamer-1.0.so.0";
const APP: &str = "libgstapp-1.0.so.0";

type Ptr = *mut c_void;

/// `GstMiniObject`, the head of a buffer and a message.
#[repr(C)]
struct MiniObject {
    type_: usize,
    refcount: c_int,
    lockstate: c_int,
    flags: c_uint,
    copy: Ptr,
    dispose: Ptr,
    free: Ptr,
    priv_uint: c_uint,
    priv_pointer: Ptr,
}

/// `GstBuffer`'s public fields.
#[repr(C)]
struct RawBuffer {
    mini_object: MiniObject,
    pool: Ptr,
    pts: u64,
    dts: u64,
    duration: u64,
    offset: u64,
    offset_end: u64,
}

/// `GstMessage`'s head.
#[repr(C)]
struct RawMessage {
    mini_object: MiniObject,
    type_: c_uint,
}

macro_rules! api {
    ($($lib:ident { $($name:ident: fn($($arg:ty),*) $(-> $ret:ty)?;)* })*) => {
        /// GStreamer's functions used.
        #[allow(non_snake_case)]
        pub(crate) struct Api {
            $($($name: unsafe extern "C" fn($($arg),*) $(-> $ret)?,)*)*
            _libraries: Vec<libloading::Library>,
        }

        impl Api {
            fn load() -> Result<Api, String> {
                let mut libraries = Vec::new();
                $(
                    let handle = open($lib)?;
                    $(
                        // SAFETY: the signature is the C declaration's.
                        let $name = unsafe {
                            *handle
                                .get(concat!(stringify!($name), "\0").as_bytes())
                                .map_err(|e| format!("{} has no `{}`: {e}", $lib, stringify!($name)))?
                        };
                    )*
                    libraries.push(handle);
                )*
                Ok(Api {
                    $($($name,)*)*
                    _libraries: libraries,
                })
            }
        }
    };
}

api! {
    CORE {
        gst_init_check: fn(*mut c_int, *mut Ptr, *mut *mut GError) -> c_int;
        gst_object_unref: fn(Ptr);
        gst_object_ref: fn(Ptr) -> Ptr;
        gst_object_ref_sink: fn(Ptr) -> Ptr;
        gst_mini_object_unref: fn(Ptr);
        gst_pipeline_new: fn(*const c_char) -> Ptr;
        gst_element_factory_make: fn(*const c_char, *const c_char) -> Ptr;
        gst_element_factory_find: fn(*const c_char) -> Ptr;
        gst_bin_add: fn(Ptr, Ptr) -> c_int;
        gst_bin_remove: fn(Ptr, Ptr) -> c_int;
        gst_element_link: fn(Ptr, Ptr) -> c_int;
        gst_element_set_state: fn(Ptr, c_int) -> c_int;
        gst_element_get_static_pad: fn(Ptr, *const c_char) -> Ptr;
        gst_element_request_pad_simple: fn(Ptr, *const c_char) -> Ptr;
        gst_element_release_request_pad: fn(Ptr, Ptr);
        gst_element_sync_state_with_parent: fn(Ptr) -> c_int;
        gst_element_get_bus: fn(Ptr) -> Ptr;
        gst_element_get_current_running_time: fn(Ptr) -> u64;
        gst_pad_link: fn(Ptr, Ptr) -> c_int;
        gst_pad_unlink: fn(Ptr, Ptr) -> c_int;
        gst_pad_is_linked: fn(Ptr) -> c_int;
        gst_pad_get_current_caps: fn(Ptr) -> Ptr;
        gst_pad_set_offset: fn(Ptr, i64);
        gst_caps_from_string: fn(*const c_char) -> Ptr;
        gst_caps_get_size: fn(Ptr) -> c_uint;
        gst_caps_get_structure: fn(Ptr, c_uint) -> Ptr;
        gst_structure_get_name: fn(Ptr) -> *const c_char;
        gst_buffer_new_wrapped_full: fn(c_int, Ptr, usize, usize, usize, Ptr, Option<unsafe extern "C" fn(Ptr)>) -> Ptr;
        gst_buffer_get_size: fn(Ptr) -> usize;
        gst_buffer_extract: fn(Ptr, usize, Ptr, usize) -> usize;
        gst_sample_get_buffer: fn(Ptr) -> Ptr;
        gst_bus_pop_filtered: fn(Ptr, c_uint) -> Ptr;
        gst_bus_add_watch_full: fn(Ptr, c_int, unsafe extern "C" fn(Ptr, Ptr, Ptr) -> c_int, Ptr, Option<unsafe extern "C" fn(Ptr)>) -> c_uint;
        gst_message_parse_error: fn(Ptr, *mut *mut GError, *mut *mut c_char);
        gst_stream_error_quark: fn() -> GQuark;
        gst_core_error_quark: fn() -> GQuark;
        gst_util_set_object_arg: fn(Ptr, *const c_char, *const c_char);
    }
    APP {
        gst_app_src_push_buffer: fn(Ptr, Ptr) -> c_int;
        gst_app_src_end_of_stream: fn(Ptr) -> c_int;
        gst_app_src_set_caps: fn(Ptr, Ptr);
        gst_app_sink_set_caps: fn(Ptr, Ptr);
        gst_app_sink_try_pull_sample: fn(Ptr, u64) -> Ptr;
        gst_app_sink_is_eos: fn(Ptr) -> c_int;
    }
}

/// Loads the library `soname`; when it is missing, an error naming it.
fn open(soname: &str) -> Result<libloading::Library, String> {
    // SAFETY: GStreamer's libraries run nothing on load that needs
    // anything from us.
    unsafe { libloading::Library::new(soname) }.map_err(|e| {
        format!(
            "GStreamer is not installed: {soname} could not be loaded ({e}); \
             install GStreamer and its base plug-ins to play sounds"
        )
    })
}

/// GStreamer, loaded and started once (GTK's media streams may have
/// started it already: starting again is nothing).
pub(crate) fn api() -> Result<&'static Api, String> {
    static API: OnceLock<Result<Api, String>> = OnceLock::new();
    API.get_or_init(|| {
        let api = Api::load()?;
        let mut error = ptr::null_mut();
        // SAFETY: no arguments; `error` is set on failure only.
        if unsafe { (api.gst_init_check)(ptr::null_mut(), ptr::null_mut(), &mut error) } == 0 {
            return Err(format!("GStreamer did not start: {}", take_error(error).1));
        }
        Ok(api)
    })
    .as_ref()
    .map_err(Clone::clone)
}

/// The API once [`api`] succeeded: every wrapper is made after it.
fn loaded() -> &'static Api {
    api().expect("GStreamer is loaded before its objects are made")
}

fn cstring(s: &str) -> CString {
    CString::new(s).expect("no NUL")
}

/// A `GError`'s domain and code, and its message; frees it.
fn take_error(error: *mut GError) -> ((GQuark, c_int), String) {
    if error.is_null() {
        return ((0, 0), "unknown error".to_owned());
    }
    // SAFETY: a GError GStreamer gave us, freed once here.
    unsafe {
        let e = &*error;
        let message = if e.message.is_null() {
            String::new()
        } else {
            CStr::from_ptr(e.message).to_string_lossy().into_owned()
        };
        let kind = (e.domain, e.code);
        g_error_free(error);
        (kind, message)
    }
}

/// A `GstObject` held: an element, a pad, a bus.
pub(crate) struct Object(NonNull<c_void>);

// SAFETY: GstObjects are reference counted atomically and the calls used
// on them here are thread safe (gstreamer-rs's types are `Send + Sync`).
unsafe impl Send for Object {}
unsafe impl Sync for Object {}

impl Object {
    /// Takes a reference GStreamer gave us, `None` when null.
    fn full(ptr: Ptr) -> Option<Object> {
        NonNull::new(ptr).map(Object)
    }

    /// Takes a new, floating object, `None` when null.
    fn floating(ptr: Ptr) -> Option<Object> {
        let ptr = NonNull::new(ptr)?;
        // SAFETY: a new object: its floating reference becomes ours.
        unsafe { (loaded().gst_object_ref_sink)(ptr.as_ptr()) };
        Some(Object(ptr))
    }

    fn as_ptr(&self) -> Ptr {
        self.0.as_ptr()
    }

    /// Sets `name` from its string form.
    pub(crate) fn set(&self, name: &str, value: &str) {
        let (name, value) = (cstring(name), cstring(value));
        // SAFETY: a live object and NUL-terminated strings.
        unsafe { (loaded().gst_util_set_object_arg)(self.as_ptr(), name.as_ptr(), value.as_ptr()) }
    }

    /// A new pipeline.
    pub(crate) fn pipeline() -> Object {
        // SAFETY: plain constructor.
        Object::floating(unsafe { (loaded().gst_pipeline_new)(ptr::null()) }).expect("a pipeline")
    }

    /// A new element of `factory`.
    pub(crate) fn element(factory: &str) -> Result<Object, String> {
        let name = cstring(factory);
        // SAFETY: a NUL-terminated name.
        Object::floating(unsafe { (loaded().gst_element_factory_make)(name.as_ptr(), ptr::null()) })
            .ok_or_else(|| format!("the GStreamer element `{factory}` is not installed"))
    }

    /// Adds `element` to this bin.
    pub(crate) fn add(&self, element: &Object) -> Result<(), String> {
        // SAFETY: live objects; the bin takes its own reference.
        match unsafe { (loaded().gst_bin_add)(self.as_ptr(), element.as_ptr()) } {
            0 => Err("an element could not be added to the pipeline".to_owned()),
            _ => Ok(()),
        }
    }

    /// Removes `element` from this bin.
    pub(crate) fn remove(&self, element: &Object) {
        // SAFETY: live objects.
        unsafe { (loaded().gst_bin_remove)(self.as_ptr(), element.as_ptr()) };
    }

    /// Links each element to the next.
    pub(crate) fn link_many(elements: &[&Object]) -> Result<(), String> {
        for pair in elements.windows(2) {
            // SAFETY: live elements.
            if unsafe { (loaded().gst_element_link)(pair[0].as_ptr(), pair[1].as_ptr()) } == 0 {
                return Err("the pipeline's elements could not be linked".to_owned());
            }
        }
        Ok(())
    }

    /// Sets the element's state: `Err` when it failed.
    pub(crate) fn set_state(&self, state: c_int) -> Result<(), ()> {
        // SAFETY: a live element. `GST_STATE_CHANGE_FAILURE` is 0.
        match unsafe { (loaded().gst_element_set_state)(self.as_ptr(), state) } {
            0 => Err(()),
            _ => Ok(()),
        }
    }

    pub(crate) fn sync_state_with_parent(&self) -> Result<(), String> {
        // SAFETY: a live element.
        match unsafe { (loaded().gst_element_sync_state_with_parent)(self.as_ptr()) } {
            0 => Err("a voice could not start".to_owned()),
            _ => Ok(()),
        }
    }

    pub(crate) fn static_pad(&self, name: &str) -> Option<Object> {
        let name = cstring(name);
        // SAFETY: returns a new reference.
        Object::full(unsafe { (loaded().gst_element_get_static_pad)(self.as_ptr(), name.as_ptr()) })
    }

    pub(crate) fn request_pad(&self, template: &str) -> Option<Object> {
        let template = cstring(template);
        // SAFETY: returns a new reference.
        Object::full(unsafe {
            (loaded().gst_element_request_pad_simple)(self.as_ptr(), template.as_ptr())
        })
    }

    pub(crate) fn release_request_pad(&self, pad: &Object) {
        // SAFETY: a pad this element gave.
        unsafe { (loaded().gst_element_release_request_pad)(self.as_ptr(), pad.as_ptr()) }
    }

    pub(crate) fn bus(&self) -> Option<Object> {
        // SAFETY: returns a new reference.
        Object::full(unsafe { (loaded().gst_element_get_bus)(self.as_ptr()) })
    }

    /// The pipeline's running time, in nanoseconds.
    pub(crate) fn running_time(&self) -> Option<u64> {
        // SAFETY: a live element.
        let time = unsafe { (loaded().gst_element_get_current_running_time)(self.as_ptr()) };
        (time != CLOCK_TIME_NONE).then_some(time)
    }

    /// Links this source pad to `sink`.
    pub(crate) fn link_pad(&self, sink: &Object) -> Result<(), String> {
        // SAFETY: live pads. `GST_PAD_LINK_OK` is 0.
        match unsafe { (loaded().gst_pad_link)(self.as_ptr(), sink.as_ptr()) } {
            0 => Ok(()),
            code => Err(format!("a pad did not link ({code})")),
        }
    }

    pub(crate) fn unlink_pad(&self, sink: &Object) {
        // SAFETY: live pads.
        unsafe { (loaded().gst_pad_unlink)(self.as_ptr(), sink.as_ptr()) };
    }

    pub(crate) fn is_linked(&self) -> bool {
        // SAFETY: a live pad.
        unsafe { (loaded().gst_pad_is_linked)(self.as_ptr()) != 0 }
    }

    pub(crate) fn current_caps(&self) -> Option<Caps> {
        // SAFETY: returns a new reference.
        Caps::full(unsafe { (loaded().gst_pad_get_current_caps)(self.as_ptr()) })
    }

    pub(crate) fn set_offset(&self, offset: i64) {
        // SAFETY: a live pad.
        unsafe { (loaded().gst_pad_set_offset)(self.as_ptr(), offset) }
    }

    /// Pushes `buffer` into this `appsrc`.
    pub(crate) fn push_buffer(&self, buffer: Buffer) -> Result<(), String> {
        let raw = buffer.0;
        std::mem::forget(buffer);
        // SAFETY: an appsrc; it takes the buffer.
        match unsafe { (loaded().gst_app_src_push_buffer)(self.as_ptr(), raw) } {
            0 => Ok(()),
            flow => Err(format!("the samples were refused ({flow})")),
        }
    }

    pub(crate) fn end_of_stream(&self) {
        // SAFETY: an appsrc.
        unsafe { (loaded().gst_app_src_end_of_stream)(self.as_ptr()) };
    }

    pub(crate) fn set_src_caps(&self, caps: &Caps) {
        // SAFETY: an appsrc; it takes its own reference.
        unsafe { (loaded().gst_app_src_set_caps)(self.as_ptr(), caps.0) }
    }

    pub(crate) fn set_sink_caps(&self, caps: &Caps) {
        // SAFETY: an appsink; it takes its own reference.
        unsafe { (loaded().gst_app_sink_set_caps)(self.as_ptr(), caps.0) }
    }

    /// The next sample of this `appsink`, waiting at most `timeout_ns`.
    pub(crate) fn try_pull_sample(&self, timeout_ns: u64) -> Option<Sample> {
        // SAFETY: an appsink; returns a new reference.
        NonNull::new(unsafe { (loaded().gst_app_sink_try_pull_sample)(self.as_ptr(), timeout_ns) })
            .map(Sample)
    }

    pub(crate) fn is_eos(&self) -> bool {
        // SAFETY: an appsink.
        unsafe { (loaded().gst_app_sink_is_eos)(self.as_ptr()) != 0 }
    }

    /// The bus's next error message, if one is waiting.
    pub(crate) fn pop_error(&self) -> Option<Message> {
        // SAFETY: a bus; returns a new reference.
        NonNull::new(unsafe { (loaded().gst_bus_pop_filtered)(self.as_ptr(), MESSAGE_ERROR) })
            .map(Message)
    }

    /// Calls `f` with each error posted on this bus, on the main loop,
    /// until the returned source is removed.
    pub(crate) fn watch_errors(&self, f: impl Fn(ErrorInfo) + 'static) -> Option<Watch> {
        type F = Box<dyn Fn(ErrorInfo)>;
        unsafe extern "C" fn call(_bus: Ptr, message: Ptr, data: Ptr) -> c_int {
            // SAFETY: the box below, alive until `free`.
            let f = unsafe { &*(data as *const F) };
            // SAFETY: a message GStreamer lends us.
            if unsafe { (*(message as *const RawMessage)).type_ } == MESSAGE_ERROR {
                f(parse_error(message));
            }
            1
        }
        unsafe extern "C" fn free(data: Ptr) {
            // SAFETY: the box below, freed once.
            drop(unsafe { Box::from_raw(data as *mut F) });
        }
        let data = Box::into_raw(Box::new(Box::new(f) as F)) as Ptr;
        // SAFETY: a bus; GLib frees `data` with the source.
        let id =
            unsafe { (loaded().gst_bus_add_watch_full)(self.as_ptr(), 0, call, data, Some(free)) };
        (id != 0).then_some(Watch(id))
    }

    /// Calls `f` with each pad this element adds (`pad-added`).
    pub(crate) fn on_pad_added(&self, f: impl Fn(Object) + Send + Sync + 'static) {
        type F = Box<dyn Fn(Object) + Send + Sync>;
        unsafe extern "C" fn call(_element: Ptr, pad: Ptr, data: Ptr) {
            // SAFETY: the box connected, alive while the element is.
            let f = unsafe { &*(data as *const F) };
            if let Some(pad) = Object::borrowed(pad) {
                f(pad);
            }
        }
        let handler: unsafe extern "C" fn(Ptr, Ptr, Ptr) = call;
        // SAFETY: `pad-added`'s signature is (element, pad, data).
        unsafe {
            self.connect_raw(
                "pad-added",
                handler as *const (),
                Box::new(Box::new(f) as F),
            )
        }
    }

    /// Calls `f` with the caps name of each stream this `decodebin` found
    /// no plug-in for (`unknown-type`).
    pub(crate) fn on_unknown_type(&self, f: impl Fn(Option<String>) + Send + Sync + 'static) {
        type F = Box<dyn Fn(Option<String>) + Send + Sync>;
        unsafe extern "C" fn call(_element: Ptr, _pad: Ptr, caps: Ptr, data: Ptr) {
            // SAFETY: the box connected, alive while the element is.
            let f = unsafe { &*(data as *const F) };
            f(caps_name(caps));
        }
        let handler: unsafe extern "C" fn(Ptr, Ptr, Ptr, Ptr) = call;
        // SAFETY: `unknown-type`'s signature is (element, pad, caps, data).
        unsafe {
            self.connect_raw(
                "unknown-type",
                handler as *const (),
                Box::new(Box::new(f) as F),
            )
        }
    }

    /// Connects `handler` to `signal` with `data`, freed with the handler.
    ///
    /// # Safety
    /// `handler` must take the signal's arguments then a `*const T`.
    unsafe fn connect_raw<T>(&self, signal: &str, handler: *const (), data: Box<T>) {
        unsafe extern "C" fn free<T>(data: Ptr, _closure: *mut gobject_ffi::GClosure) {
            // SAFETY: the box connected, freed once.
            drop(unsafe { Box::from_raw(data as *mut T) });
        }
        let signal = cstring(signal);
        // SAFETY: per the contract; GObject calls `handler` with the
        // signal's arguments, as a C caller would.
        unsafe {
            gobject_ffi::g_signal_connect_data(
                self.as_ptr() as *mut _,
                signal.as_ptr(),
                Some(std::mem::transmute::<*const (), unsafe extern "C" fn()>(
                    handler,
                )),
                Box::into_raw(data) as Ptr,
                Some(free::<T>),
                0,
            );
        }
    }

    /// Wraps a pad a signal lends, taking a reference.
    pub(crate) fn borrowed(ptr: Ptr) -> Option<Object> {
        let ptr = NonNull::new(ptr)?;
        // SAFETY: a live object lent to us.
        unsafe { (loaded().gst_object_ref)(ptr.as_ptr()) };
        Some(Object(ptr))
    }
}

impl Clone for Object {
    fn clone(&self) -> Self {
        // SAFETY: a live object.
        unsafe { (loaded().gst_object_ref)(self.as_ptr()) };
        Object(self.0)
    }
}

impl Drop for Object {
    fn drop(&mut self) {
        // SAFETY: the reference this holds.
        unsafe { (loaded().gst_object_unref)(self.as_ptr()) }
    }
}

/// A bus watch on the main loop; dropping it removes it.
pub(crate) struct Watch(c_uint);

impl Drop for Watch {
    fn drop(&mut self) {
        // SAFETY: the source this watch added.
        unsafe { gtk4::glib::ffi::g_source_remove(self.0) };
    }
}

/// `GstCaps` held.
pub(crate) struct Caps(Ptr);

impl Caps {
    fn full(ptr: Ptr) -> Option<Caps> {
        (!ptr.is_null()).then_some(Caps(ptr))
    }

    pub(crate) fn parse(s: &str) -> Caps {
        let s = cstring(s);
        // SAFETY: a NUL-terminated string; returns a new reference.
        Caps::full(unsafe { (loaded().gst_caps_from_string)(s.as_ptr()) }).expect("valid caps")
    }

    /// The name of the first structure, as `audio/x-raw`.
    pub(crate) fn name(&self) -> Option<String> {
        caps_name(self.0)
    }
}

/// The name of `caps`'s first structure (caps lent or held).
pub(crate) fn caps_name(caps: Ptr) -> Option<String> {
    if caps.is_null() {
        return None;
    }
    // SAFETY: live caps; the structure and its name are borrowed from them.
    unsafe {
        let api = loaded();
        if (api.gst_caps_get_size)(caps) == 0 {
            return None;
        }
        let name = (api.gst_structure_get_name)((api.gst_caps_get_structure)(caps, 0));
        (!name.is_null()).then(|| CStr::from_ptr(name).to_string_lossy().into_owned())
    }
}

impl Drop for Caps {
    fn drop(&mut self) {
        // SAFETY: the reference this holds.
        unsafe { (loaded().gst_mini_object_unref)(self.0) }
    }
}

/// A `GstBuffer` not yet pushed.
pub(crate) struct Buffer(Ptr);

impl Buffer {
    /// A buffer over `data`, not copied: it keeps `data` until GStreamer
    /// frees the buffer.
    pub(crate) fn wrap<T: AsRef<[u8]> + Send + 'static>(data: T) -> Buffer {
        unsafe extern "C" fn free<T>(data: Ptr) {
            // SAFETY: the box below, freed once.
            drop(unsafe { Box::from_raw(data as *mut T) });
        }
        let boxed = Box::new(data);
        let (ptr, len) = {
            let slice = (*boxed).as_ref();
            (slice.as_ptr() as Ptr, slice.len())
        };
        let user = Box::into_raw(boxed) as Ptr;
        // SAFETY: read-only memory (flags 1, `GST_MEMORY_FLAG_READONLY`)
        // alive until `free`.
        let raw = unsafe {
            (loaded().gst_buffer_new_wrapped_full)(1, ptr, len, 0, len, user, Some(free::<T>))
        };
        Buffer(raw)
    }

    /// Sets the presentation time and duration, in nanoseconds.
    pub(crate) fn set_timing(&mut self, pts: u64, duration: u64) {
        // SAFETY: a new buffer, ours alone: writable.
        unsafe {
            let raw = &mut *(self.0 as *mut RawBuffer);
            raw.pts = pts;
            raw.duration = duration;
        }
    }
}

impl Drop for Buffer {
    fn drop(&mut self) {
        // SAFETY: the reference this holds.
        unsafe { (loaded().gst_mini_object_unref)(self.0) }
    }
}

/// A `GstSample` pulled.
pub(crate) struct Sample(NonNull<c_void>);

impl Sample {
    /// Whether its buffer is a gap (`GST_BUFFER_FLAG_GAP`): no data, to be
    /// taken as silence.
    #[cfg(test)]
    pub(crate) fn is_gap(&self) -> bool {
        const BUFFER_FLAG_GAP: c_uint = 1 << 11;
        // SAFETY: the buffer is borrowed from the sample.
        unsafe {
            let buffer = (loaded().gst_sample_get_buffer)(self.0.as_ptr());
            !buffer.is_null()
                && (*(buffer as *const RawBuffer)).mini_object.flags & BUFFER_FLAG_GAP != 0
        }
    }

    /// Appends its buffer's bytes to `out`.
    pub(crate) fn append_to(&self, out: &mut Vec<u8>) {
        // SAFETY: the buffer is borrowed from the sample.
        unsafe {
            let api = loaded();
            let buffer = (api.gst_sample_get_buffer)(self.0.as_ptr());
            if buffer.is_null() {
                return;
            }
            let size = (api.gst_buffer_get_size)(buffer);
            out.reserve(size);
            let start = out.len();
            let copied =
                (api.gst_buffer_extract)(buffer, 0, out.as_mut_ptr().add(start) as Ptr, size);
            out.set_len(start + copied);
        }
    }
}

impl Drop for Sample {
    fn drop(&mut self) {
        // SAFETY: the reference this holds.
        unsafe { (loaded().gst_mini_object_unref)(self.0.as_ptr()) }
    }
}

/// An error message popped from a bus.
pub(crate) struct Message(NonNull<c_void>);

impl Message {
    pub(crate) fn error(&self) -> ErrorInfo {
        parse_error(self.0.as_ptr())
    }
}

impl Drop for Message {
    fn drop(&mut self) {
        // SAFETY: the reference this holds.
        unsafe { (loaded().gst_mini_object_unref)(self.0.as_ptr()) }
    }
}

/// An error a pipeline posted.
pub(crate) struct ErrorInfo {
    pub(crate) message: String,
    /// GStreamer's for a stream it recognized but has no plug-in for.
    pub(crate) missing_plugin: bool,
}

fn parse_error(message: Ptr) -> ErrorInfo {
    let api = loaded();
    let mut error = ptr::null_mut();
    let mut debug = ptr::null_mut();
    // SAFETY: an error message; both out values are ours to free.
    unsafe {
        (api.gst_message_parse_error)(message, &mut error, &mut debug);
        g_free(debug as *mut _);
    }
    let ((domain, code), message) = take_error(error);
    // SAFETY: plain functions.
    let (stream, core) = unsafe { ((api.gst_stream_error_quark)(), (api.gst_core_error_quark)()) };
    ErrorInfo {
        message,
        missing_plugin: (domain == stream && code == STREAM_ERROR_CODEC_NOT_FOUND)
            || (domain == core && code == CORE_ERROR_MISSING_PLUGIN),
    }
}

/// Whether an element of `factory` is installed.
pub(crate) fn has_element(factory: &str) -> bool {
    let name = cstring(factory);
    // SAFETY: returns a new reference or null.
    let found = unsafe { (loaded().gst_element_factory_find)(name.as_ptr()) };
    if found.is_null() {
        return false;
    }
    // SAFETY: the reference just returned.
    unsafe { (loaded().gst_object_unref)(found) };
    true
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_missing_library_is_named() {
        let error = super::open("libgstreamer-missing-1.0.so.0").err().unwrap();
        assert!(error.contains("libgstreamer-missing-1.0.so.0"), "{error}");
        assert!(error.starts_with("GStreamer is not installed"), "{error}");
    }
}

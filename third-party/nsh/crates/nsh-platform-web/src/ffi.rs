//! The functions the JS runtime (`web/nsh.js`) provides, as module `nsh`
//! imports. Strings and bytes cross as pointer and length into this
//! module's memory; JS copies them before returning.

#[link(wasm_import_module = "nsh")]
unsafe extern "C" {
    #[link_name = "measure_text"]
    fn js_measure_text(font: *const u8, font_len: usize, text: *const u8, text_len: usize) -> f64;
    #[link_name = "measure_numeric_text"]
    fn js_measure_numeric_text(
        font: *const u8,
        font_len: usize,
        numeric: *const u8,
        numeric_len: usize,
        text: *const u8,
        text_len: usize,
    ) -> f64;
    #[link_name = "text_cluster_boxes"]
    fn js_text_cluster_boxes(
        font: *const u8,
        font_len: usize,
        numeric: *const u8,
        numeric_len: usize,
        spacing: f32,
        text: *const u8,
        text_len: usize,
        ranges: *const u32,
        out: *mut f32,
        count: usize,
    );
    #[link_name = "font_ascent"]
    fn js_font_ascent(font: *const u8, font_len: usize) -> f64;
    #[link_name = "font_descent"]
    fn js_font_descent(font: *const u8, font_len: usize) -> f64;
    #[link_name = "font_x_height"]
    fn js_font_x_height(font: *const u8, font_len: usize) -> f64;
    #[link_name = "register_font"]
    fn js_register_font(
        family: *const u8,
        family_len: usize,
        data: *const u8,
        data_len: usize,
        weight: u32,
        italic: u32,
    );
    #[link_name = "submit"]
    fn js_submit(json: *const u8, len: usize) -> usize;
    #[link_name = "submit_result"]
    fn js_submit_result(bytes: *mut u8, len: usize);
    #[link_name = "image_bytes"]
    fn js_image_bytes(uri: *const u8, uri_len: usize, data: *const u8, data_len: usize);
    #[link_name = "release_image"]
    fn js_release_image(uri: *const u8, uri_len: usize);
    #[link_name = "request_frame"]
    fn js_request_frame();
    #[link_name = "request_pump"]
    fn js_request_pump();
    #[link_name = "report_error"]
    fn js_report_error(message: *const u8, len: usize);
    /// A message of a test session's app for the dev server (JSON
    /// `nsh_dev::protocol::ClientMessage`: its requests), sent over the
    /// page's socket.
    #[cfg(feature = "dev")]
    #[link_name = "test_send"]
    fn js_test_send(json: *const u8, len: usize);
    #[link_name = "log"]
    fn js_log(level: u32, message: *const u8, len: usize);
    #[link_name = "read_asset"]
    fn js_read_asset(uri: *const u8, uri_len: usize) -> u32;
    #[link_name = "fetch_start"]
    fn js_fetch_start(
        id: u32,
        method: *const u8,
        method_len: usize,
        url: *const u8,
        url_len: usize,
        headers: *const u8,
        headers_len: usize,
        body: *const u8,
        body_len: usize,
        body_kind: u32,
        follow: u32,
    );
    #[link_name = "fetch_send"]
    fn js_fetch_send(id: u32, chunk: *const u8, len: usize);
    #[link_name = "fetch_finish"]
    fn js_fetch_finish(id: u32);
    #[link_name = "fetch_pause"]
    fn js_fetch_pause(id: u32, paused: u32);
    #[link_name = "fetch_cancel"]
    fn js_fetch_cancel(id: u32);
    #[link_name = "filesystem_start"]
    fn js_filesystem_start(id: u32, p: *const u8, l: usize, bp: *const u8, bl: usize);
    #[link_name = "filesystem_cancel"]
    fn js_filesystem_cancel(id: u32);
    #[link_name = "websocket_start"]
    fn js_websocket_start(id: u32, request: *const u8, len: usize) -> u32;
    #[link_name = "websocket_send"]
    fn js_websocket_send(id: u32, data: *const u8, len: usize, binary: u32) -> u32;
    #[link_name = "websocket_close"]
    fn js_websocket_close(id: u32, code: u32, reason: *const u8, len: usize) -> u32;
    #[link_name = "websocket_buffered"]
    fn js_websocket_buffered(id: u32) -> f64;
    #[link_name = "websocket_pause"]
    fn js_websocket_pause(id: u32, paused: u32);
    #[link_name = "websocket_cancel"]
    fn js_websocket_cancel(id: u32);
    #[link_name = "load_data"]
    fn js_load_data(name: *const u8, name_len: usize);
    #[link_name = "storage_load"]
    fn js_storage_load(prefix: *const u8, prefix_len: usize) -> u32;
    #[link_name = "storage_set"]
    fn js_storage_set(
        prefix: *const u8,
        prefix_len: usize,
        key: *const u8,
        key_len: usize,
        value: *const u8,
        value_len: usize,
    ) -> u32;
    #[link_name = "storage_remove"]
    fn js_storage_remove(
        prefix: *const u8,
        prefix_len: usize,
        key: *const u8,
        key_len: usize,
    ) -> u32;
    #[link_name = "storage_clear"]
    fn js_storage_clear(prefix: *const u8, prefix_len: usize) -> u32;
}

/// The width of `text` in CSS `font`, in points.
pub(crate) fn measure_text(font: &str, text: &str) -> f32 {
    // SAFETY: both slices are valid for the call; JS only reads them.
    unsafe { js_measure_text(font.as_ptr(), font.len(), text.as_ptr(), text.len()) as f32 }
}

/// The width of `text` in CSS `font` with `font-variant-numeric:
/// numeric`, in points: canvas has no numeric variants, so the page
/// measures it in the DOM, as the run is drawn.
pub(crate) fn measure_numeric_text(font: &str, numeric: &str, text: &str) -> f32 {
    // SAFETY: the slices are valid for the call; JS only reads them.
    unsafe {
        js_measure_numeric_text(
            font.as_ptr(),
            font.len(),
            numeric.as_ptr(),
            numeric.len(),
            text.as_ptr(),
            text.len(),
        ) as f32
    }
}

/// Visual cluster bounds measured in the full DOM run, in logical order.
pub(crate) fn text_cluster_boxes(
    font: &str,
    numeric: &str,
    spacing: f32,
    text: &str,
    ranges: &[[u32; 2]],
    out: &mut [[f32; 2]],
) {
    assert_eq!(ranges.len(), out.len());
    // SAFETY: strings and flat two-number arrays remain valid for the call;
    // JS reads the input and writes exactly two floats for each range.
    unsafe {
        js_text_cluster_boxes(
            font.as_ptr(),
            font.len(),
            numeric.as_ptr(),
            numeric.len(),
            spacing,
            text.as_ptr(),
            text.len(),
            ranges.as_ptr().cast(),
            out.as_mut_ptr().cast(),
            ranges.len(),
        )
    }
}

/// Ascent and descent of CSS `font` (0 when the browser cannot tell).
pub(crate) fn font_metrics(font: &str) -> (f32, f32) {
    // SAFETY: the slice is valid for the calls; JS only reads it.
    unsafe {
        (
            js_font_ascent(font.as_ptr(), font.len()) as f32,
            js_font_descent(font.as_ptr(), font.len()) as f32,
        )
    }
}

/// The x height of CSS `font` (0 when the browser cannot tell).
pub(crate) fn font_x_height(font: &str) -> f32 {
    // SAFETY: the slice is valid for the call; JS only reads it.
    unsafe { js_font_x_height(font.as_ptr(), font.len()) as f32 }
}

/// Adds a font (`FontFace`) to the document.
pub(crate) fn register_font(family: &str, data: &[u8], weight: u16, italic: bool) {
    // SAFETY: the slices are valid for the call; JS copies them.
    unsafe {
        js_register_font(
            family.as_ptr(),
            family.len(),
            data.as_ptr(),
            data.len(),
            weight as u32,
            italic as u32,
        )
    }
}

/// A native cell retirement, checked against the browser's actual focus.
#[derive(serde::Deserialize)]
pub(crate) struct Retirement {
    pub id: u32,
    // A decimal string keeps the engine's u64 request exact in JavaScript.
    pub request: String,
    pub retired: bool,
    pub focus: Vec<u32>,
    pub cancelled: Vec<u32>,
    pub states: Vec<(u32, u16)>,
}

/// Hands one batch to the DOM mounter without re-entering WebAssembly to
/// return its results. The caller publishes them after releasing the app.
pub(crate) fn submit(json: &str) -> Vec<Retirement> {
    // SAFETY: the slice is valid for the call; JS copies it.
    let len = unsafe { js_submit(json.as_ptr(), json.len()) };
    if len == 0 {
        return Vec::new();
    }
    let mut bytes = vec![0; len];
    // SAFETY: JS only fills this result's exactly sized writable buffer.
    unsafe { js_submit_result(bytes.as_mut_ptr(), bytes.len()) };
    serde_json::from_slice(&bytes).expect("the DOM mounter returned invalid retirement results")
}

/// Gives the page the bytes of the in-memory image `uri` (a `data:` URI's,
/// a blob's): it makes a browser blob URL of them that `<img>` elements
/// showing `uri` load.
pub(crate) fn image_bytes(uri: &str, data: &[u8]) {
    // SAFETY: the slices are valid for the call; JS copies them.
    unsafe { js_image_bytes(uri.as_ptr(), uri.len(), data.as_ptr(), data.len()) }
}

/// The page may forget (revoke) the blob URL of the in-memory image `uri`.
pub(crate) fn release_image(uri: &str) {
    // SAFETY: the slice is valid for the call; JS copies it.
    unsafe { js_release_image(uri.as_ptr(), uri.len()) }
}

/// Asks for a `requestAnimationFrame` callback (`nsh_frame`).
pub(crate) fn request_frame() {
    // SAFETY: no arguments.
    unsafe { js_request_frame() }
}

/// Asks for an `nsh_pump` soon: the engine has work that came outside a
/// call into it (a task woken by a browser callback, through wasm-bindgen's
/// glue) or that a pump left for the next. JS coalesces the requests into
/// one pump per turn and never calls in while a call runs.
pub(crate) fn request_pump() {
    // SAFETY: no arguments.
    unsafe { js_request_pump() }
}

/// Sends a test session's app's message to the dev server (JSON).
#[cfg(feature = "dev")]
pub(crate) fn test_send(json: &str) {
    // SAFETY: the slice is valid for the call; JS copies it.
    unsafe { js_test_send(json.as_ptr(), json.len()) }
}

/// Shows an app error.
pub(crate) fn report_error(message: &str) {
    // SAFETY: the slice is valid for the call; JS copies it.
    unsafe { js_report_error(message.as_ptr(), message.len()) }
}

/// Logs to the browser's console.
pub(crate) fn log(level: log::Level, message: &str) {
    // SAFETY: the slice is valid for the call; JS copies it.
    unsafe { js_log(level as u32, message.as_ptr(), message.len()) }
}

/// The bytes of a bundled file the page preloaded (`asset:/…`), if any.
/// JS hands them back with `nsh_asset_bytes` before returning.
pub(crate) fn read_asset(uri: &str) -> Option<Vec<u8>> {
    crate::ASSET.with(|a| a.borrow_mut().take());
    // SAFETY: the slice is valid for the call; JS only reads it.
    let found = unsafe { js_read_asset(uri.as_ptr(), uri.len()) };
    if found == 0 {
        return None;
    }
    crate::ASSET.with(|a| a.borrow_mut().take())
}

/// [`fetch_start`]'s `body_kind`: no body.
pub(crate) const BODY_EMPTY: u32 = 0;
/// [`fetch_start`]'s `body_kind`: the bytes passed.
pub(crate) const BODY_BYTES: u32 = 1;
/// [`fetch_start`]'s `body_kind`: chunks to come ([`fetch_send`],
/// [`fetch_finish`]).
pub(crate) const BODY_STREAM: u32 = 2;

/// Starts request `id` (`headers`: JSON `[name, value]` pairs); what
/// happens to it comes back through the `nsh_fetch_*` exports.
pub(crate) fn fetch_start(
    id: u32,
    method: &str,
    url: &str,
    headers: &str,
    body: &[u8],
    body_kind: u32,
    follow: bool,
) {
    // SAFETY: the slices are valid for the call; JS copies them.
    unsafe {
        js_fetch_start(
            id,
            method.as_ptr(),
            method.len(),
            url.as_ptr(),
            url.len(),
            headers.as_ptr(),
            headers.len(),
            body.as_ptr(),
            body.len(),
            body_kind,
            follow as u32,
        )
    }
}

/// The next chunk of request `id`'s streamed body.
pub(crate) fn fetch_send(id: u32, chunk: &[u8]) {
    // SAFETY: the slice is valid for the call; JS copies it.
    unsafe { js_fetch_send(id, chunk.as_ptr(), chunk.len()) }
}

/// Request `id`'s streamed body is complete: JS sends the request.
pub(crate) fn fetch_finish(id: u32) {
    // SAFETY: no pointers.
    unsafe { js_fetch_finish(id) }
}

/// Stops (`true`) or resumes reading request `id`'s response body.
pub(crate) fn fetch_pause(id: u32, paused: bool) {
    // SAFETY: no pointers.
    unsafe { js_fetch_pause(id, paused as u32) }
}

/// Aborts request `id` (nothing if it ended).
pub(crate) fn fetch_cancel(id: u32) {
    // SAFETY: no pointers.
    unsafe { js_fetch_cancel(id) }
}

/// Asks the page for the runtime's data `name` (`nsh_core::runtime_data`):
/// it fetches `nsh-<name>.bin` and hands it over with `nsh_data`.
pub(crate) fn load_data(name: &str) {
    // SAFETY: the slice is valid for the call; JS copies it.
    unsafe { js_load_data(name.as_ptr(), name.len()) }
}

/// What a `storage_*` call returned: `done` 1, or 0 with the error, which
/// JS hands over with `nsh_storage_reply` (as the entries `storage_load`
/// read) before returning.
fn storage_result(done: u32) -> Result<String, String> {
    let reply = crate::storage::take_reply().unwrap_or_default();
    if done == 0 { Err(reply) } else { Ok(reply) }
}

/// The `localStorage` entries whose keys start with `prefix`, as a JSON
/// object without the prefix.
pub(crate) fn storage_load(prefix: &str) -> Result<String, String> {
    crate::storage::take_reply();
    // SAFETY: the slice is valid for the call; JS only reads it.
    storage_result(unsafe { js_storage_load(prefix.as_ptr(), prefix.len()) })
}

/// Sets `localStorage` entry `prefix` + `key` to `value`.
pub(crate) fn storage_set(prefix: &str, key: &str, value: &str) -> Result<(), String> {
    crate::storage::take_reply();
    // SAFETY: the slices are valid for the call; JS only reads them.
    let done = unsafe {
        js_storage_set(
            prefix.as_ptr(),
            prefix.len(),
            key.as_ptr(),
            key.len(),
            value.as_ptr(),
            value.len(),
        )
    };
    storage_result(done).map(drop)
}

/// Removes `localStorage` entry `prefix` + `key`.
pub(crate) fn storage_remove(prefix: &str, key: &str) -> Result<(), String> {
    crate::storage::take_reply();
    // SAFETY: the slices are valid for the call; JS only reads them.
    let done = unsafe { js_storage_remove(prefix.as_ptr(), prefix.len(), key.as_ptr(), key.len()) };
    storage_result(done).map(drop)
}

/// Removes the `localStorage` entries whose keys start with `prefix`.
pub(crate) fn storage_clear(prefix: &str) -> Result<(), String> {
    crate::storage::take_reply();
    // SAFETY: the slice is valid for the call; JS only reads it.
    storage_result(unsafe { js_storage_clear(prefix.as_ptr(), prefix.len()) }).map(drop)
}

/// Opens a browser WebSocket with the serialized request.
pub(crate) fn websocket_start(id: u32, request: &str) -> bool {
    // SAFETY: the slice is valid for the call; JS copies it.
    unsafe { js_websocket_start(id, request.as_ptr(), request.len()) != 0 }
}

/// Sends one text or binary message on the browser socket.
pub(crate) fn websocket_send(id: u32, data: &[u8], binary: bool) -> bool {
    // SAFETY: the slice is valid for the call; JS copies it.
    unsafe { js_websocket_send(id, data.as_ptr(), data.len(), binary as u32) != 0 }
}

/// Requests the browser's closing handshake.
pub(crate) fn websocket_close(id: u32, code: u16, reason: &str) -> bool {
    // SAFETY: the slice is valid for the call; JS copies it.
    unsafe { js_websocket_close(id, code as u32, reason.as_ptr(), reason.len()) != 0 }
}

/// Reads the browser's current queued byte count.
pub(crate) fn websocket_buffered(id: u32) -> usize {
    // SAFETY: no pointers.
    unsafe { js_websocket_buffered(id) as usize }
}

/// Holds (`true`) or delivers again (`false`) the browser socket's events.
pub(crate) fn websocket_pause(id: u32, paused: bool) {
    // SAFETY: no pointers.
    unsafe { js_websocket_pause(id, paused as u32) }
}

/// Removes callbacks before closing a discarded browser socket.
pub(crate) fn websocket_cancel(id: u32) {
    // SAFETY: no pointers.
    unsafe { js_websocket_cancel(id) }
}

/// Begins a browser OPFS operation.
pub(crate) fn filesystem_start(id: u32, request: &str, bytes: &[u8]) {
    // SAFETY: JS copies both slices during this call.
    unsafe {
        js_filesystem_start(
            id,
            request.as_ptr(),
            request.len(),
            bytes.as_ptr(),
            bytes.len(),
        )
    }
}
/// Detaches an operation when its engine future is dropped.
pub(crate) fn filesystem_cancel(id: u32) {
    // SAFETY: only an opaque integer crosses the boundary.
    unsafe { js_filesystem_cancel(id) }
}

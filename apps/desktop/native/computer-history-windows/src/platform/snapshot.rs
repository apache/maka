/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Read-only UIA capture, one-shot or within the existing leased worker.
//! The supervisor owns consent, events and the hard worker-process timeout.
//! Nothing in this module writes to stdout.
//!
//! Deliberate coverage gaps: web Document providers without their own ValuePattern
//! URL, cross-process UIA descendants, custom/internal browser URLs, and trees
//! whose complete visible provenance exceeds the budget are not captured. In
//! particular, an address-bar value, hyperlink or window title cannot establish
//! a Document's origin. Missing URL exposure needs a browser-specific integration,
//! not an exception to domain admission. Only explicitly native, childless
//! Documents may use a bounded TextPattern range; a parent's text range can
//! contain password descendants. Unknown native frameworks also fail closed.

use crate::model::private_title;
use std::cell::Cell;
use url::Url;

const MAX_NODES: usize = 256;
#[cfg(windows)]
const MAX_DEPTH: usize = 14;
const MAX_BYTES: usize = 32 * 1024;
const MAX_URL_BYTES: usize = 4096;
#[cfg(windows)]
const MAX_TITLE_BYTES: usize = 4096;

#[derive(Default)]
struct CaptureFailures {
    provider_failed: Cell<bool>,
    timed_out: Cell<bool>,
}

impl CaptureFailures {
    fn finish<T>(&self, snapshot: Option<T>) -> crate::control::Result<Option<T>> {
        if self.timed_out.get() {
            return Err("uia_capture_timeout".into());
        }
        if self.provider_failed.get() {
            return Err("uia_provider_unavailable".into());
        }
        Ok(snapshot)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DocumentSource {
    Remote(Url),
    LocalFile(Url),
    Native,
    NativeAction,
}

impl DocumentSource {
    fn domain(&self) -> Option<&str> {
        match self {
            Self::Remote(url) => url.host_str(),
            Self::LocalFile(_) | Self::Native | Self::NativeAction => None,
        }
    }

    fn public_url(&self) -> Option<String> {
        match self {
            // Never transport credentials, query strings, document paths or fragments.
            Self::Remote(url) => Some(format!("{}/", url.origin().ascii_serialization())),
            Self::LocalFile(_) | Self::Native | Self::NativeAction => None,
        }
    }
}

fn resolve_source(
    value: Option<&str>,
    framework: &str,
    browser: bool,
    web_context: bool,
) -> Option<DocumentSource> {
    match value {
        Some(value) if !value.is_empty() => document_source(value),
        _ if !browser
            && !web_context
            && matches!(
                framework.to_ascii_lowercase().as_str(),
                "win32" | "winform" | "wpf"
            ) =>
        {
            Some(DocumentSource::Native)
        }
        _ => None,
    }
}

fn document_source(value: &str) -> Option<DocumentSource> {
    if value.is_empty()
        || value.len() > MAX_URL_BYTES
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return None;
    }
    let url = Url::parse(value).ok()?;
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let lower = value.to_ascii_lowercase();
    let authority = lower.strip_prefix(&format!("{}://", url.scheme()))?;
    if value.contains('\\') {
        return None;
    }
    match url.scheme() {
        "http" | "https"
            if !authority.is_empty()
                && !authority.starts_with(['/', '?', '#'])
                && url.host_str().is_some_and(|host| !host.is_empty()) =>
        {
            Some(DocumentSource::Remote(url))
        }
        "file"
            if !authority.starts_with("//")
                && (authority.starts_with('/') || authority.starts_with("localhost/"))
                && url.host_str().is_none_or(|host| host == "localhost")
                && url.port().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
                && url
                    .path()
                    .as_bytes()
                    .get(1)
                    .is_some_and(u8::is_ascii_alphabetic)
                && url.path().as_bytes().get(2) == Some(&b':')
                && url.path().as_bytes().get(3) == Some(&b'/')
                && !url.path().starts_with("//")
                && !url.path().to_ascii_lowercase().contains("%2f")
                && !url.path().to_ascii_lowercase().contains("%5c") =>
        {
            Some(DocumentSource::LocalFile(url))
        }
        _ => None,
    }
}

fn excluded_app(stem: &str) -> bool {
    [
        "credential",
        "credui",
        "consent",
        "logonui",
        "winlogon",
        "lockapp",
        "keepass",
        "1password",
        "bitwarden",
        "lastpass",
        "dashlane",
        "nordpass",
        "enpass",
        "roboform",
        "keeper",
        "authenticator",
    ]
    .iter()
    .any(|marker| stem.contains(marker))
}

fn browser_app(stem: &str) -> bool {
    matches!(
        stem,
        "chrome"
            | "chromium"
            | "msedge"
            | "firefox"
            | "brave"
            | "opera"
            | "opera_gx"
            | "vivaldi"
            | "arc"
            | "browser"
            | "waterfox"
            | "librewolf"
            | "floorp"
            | "zen"
            | "thorium"
            | "iexplore"
            | "microsoftedge"
            | "microsoftedgecp"
            | "maxthon"
            | "safari"
    )
}

fn web_framework(framework: &str) -> bool {
    matches!(
        framework.to_ascii_lowercase().as_str(),
        "chrome" | "chromium" | "mozilla" | "gecko" | "webview" | "webview2"
    )
}

fn append_text(output: &mut String, value: &str, limit: usize) -> bool {
    let value = value.trim();
    let separator = usize::from(!output.is_empty() && !output.ends_with('\n'));
    let remaining = limit.saturating_sub(output.len() + separator);
    let mut end = value.len().min(remaining);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    if end > 0 {
        if separator != 0 {
            output.push('\n');
        }
        output.push_str(&value[..end]);
    }
    end < value.len()
}

fn text_prefix(value: &[u16]) -> String {
    let mut end = value.len().min(MAX_BYTES);
    // GetText(maxLength) and our own prefix can stop between a surrogate pair.
    if end > 0 && (0xd800..=0xdbff).contains(&value[end - 1]) {
        end -= 1;
    }
    String::from_utf16_lossy(&value[..end])
}

fn collect_visible_spans(
    count: i32,
    limit: usize,
    mut read: impl FnMut(i32, usize) -> Option<Vec<u16>>,
) -> Option<String> {
    if !(0..=16).contains(&count) {
        return None;
    }
    let mut text = String::new();
    for index in 0..count {
        let value = read(index, limit.saturating_sub(text.len()) + 1)?;
        append_text(&mut text, &text_prefix(&value), limit);
    }
    Some(text)
}

fn rich_range_readable(start: i32, end: i32, extent: i32) -> Option<bool> {
    (start >= 0 && end <= 0 && extent <= 0).then_some(extent < 0)
}

fn read_nonhidden_run(
    mut check: impl FnMut() -> Option<bool>,
    read: impl FnOnce() -> Option<Vec<u16>>,
    expected: Option<&[u16]>,
) -> Option<Option<Vec<u16>>> {
    if !check()? {
        return Some(None);
    }
    let value = read()?;
    if !check()? || expected.is_some_and(|expected| expected != value) {
        return None;
    }
    Some(Some(value))
}

fn edit_selection(
    value: &[u16],
    start: usize,
    end: usize,
    read_clipped_value: impl FnOnce(usize) -> Option<Vec<u16>>,
) -> Option<Option<crate::model::Selection>> {
    if start >= end || end > MAX_BYTES {
        return Some(None);
    }
    let fallback;
    let value = if value.len() < end {
        fallback = read_clipped_value(end + 1)?;
        if fallback.len() > end {
            return None;
        }
        &fallback
    } else {
        value
    };
    let text = String::from_utf16(value.get(start..end)?).ok()?;
    let mut length = text.len().min(crate::model::MAX_SELECTION_BYTES);
    while !text.is_char_boundary(length) {
        length -= 1;
    }
    Some(Some(crate::model::Selection {
        selected_text: Some(text[..length].to_owned()),
        truncated: length < text.len(),
        start: start as u32,
        length: Some((end - start) as u32),
    }))
}

fn numeric_selection(start: u32, end: u32) -> Option<crate::model::Selection> {
    (start <= end && end <= i32::MAX as u32).then_some(crate::model::Selection {
        selected_text: None,
        truncated: false,
        start,
        length: Some(end.checked_sub(start)?),
    })
}

fn native_selection(
    start: u32,
    end: u32,
    capture_text: bool,
    read_text: impl FnOnce() -> Option<Option<crate::model::Selection>>,
) -> Option<Option<crate::model::Selection>> {
    let numeric = numeric_selection(start, end)?;
    if !capture_text || start == end || end as usize > MAX_BYTES {
        return Some(Some(numeric));
    }
    Some(read_text()?.or(Some(numeric)))
}

fn capture_text_policy_current(
    captured_with_text: bool,
    latest_text: bool,
    snapshot: &crate::model::Snapshot,
) -> bool {
    captured_with_text == latest_text
        && (latest_text
            || (snapshot.text.is_none()
                && snapshot
                    .selection
                    .as_ref()
                    .is_none_or(|selection| selection.selected_text.is_none())
                && snapshot.item_selection.as_ref().is_none_or(|selection| {
                    selection.items.iter().all(|item| item.value.is_none())
                })))
}

fn insert_native_scalar(
    output: &mut String,
    offset: usize,
    value: &str,
    limit: usize,
) -> (usize, bool) {
    let suffix = output.split_off(offset);
    let mut truncated = append_text(output, value, limit);
    if !suffix.is_empty() && !suffix.starts_with('\n') && !output.is_empty() {
        if output.len() < limit {
            output.push('\n');
        } else {
            truncated = true;
        }
    }
    let inserted = output.len() - offset;
    let mut end = suffix.len().min(limit.saturating_sub(output.len()));
    while !suffix.is_char_boundary(end) {
        end -= 1;
    }
    output.push_str(&suffix[..end]);
    (inserted, truncated || end < suffix.len())
}

fn checked_input_target<T>(
    read: impl FnOnce() -> Option<Option<T>>,
    final_check: impl FnOnce() -> Option<()>,
) -> Option<Option<T>> {
    let target = read()?;
    // Unsupported input controls still require a fresh privacy fence after
    // provider reads. A failed read must never become ordinary absence.
    final_check()?;
    Some(target)
}

fn prepared_input(needed: bool, observe_items: bool, prepare: impl FnOnce(bool) -> bool) -> bool {
    let ready = prepare(needed || observe_items);
    needed && ready
}

fn prepared_items<T>(
    mut witness: Option<T>,
    prepare: impl FnOnce(bool) -> Option<()>,
    sample: impl FnOnce(&mut T) -> Option<()>,
) -> Option<Option<T>> {
    prepare(witness.is_some())?;
    if let Some(witness) = &mut witness {
        sample(witness)?;
    }
    Some(witness)
}

fn find_observed<T>(
    nodes: &[T],
    mut matches: impl FnMut(&T) -> Option<bool>,
) -> Option<Option<&T>> {
    for node in nodes {
        if matches(node)? {
            return Some(Some(node));
        }
    }
    Some(None)
}

// The existing walk supplies preorder depth and admitted metadata. Never infer
// membership from labels or request a second descendant traversal for selection.
fn selected_subtrees(
    nodes: &[(usize, bool)],
    owner: usize,
    items: &[usize],
) -> Option<Vec<std::ops::Range<usize>>> {
    if nodes.len() > MAX_NODES || items.len() > 32 || !nodes.get(owner)?.1 {
        return None;
    }
    let end = |index: usize| {
        (index + 1..nodes.len())
            .find(|next| nodes[*next].0 <= nodes[index].0)
            .unwrap_or(nodes.len())
    };
    let owner_end = end(owner);
    let mut ranges: Vec<std::ops::Range<usize>> = Vec::with_capacity(items.len());
    let mut total = 0;
    for &item in items {
        if item <= owner || item >= owner_end {
            return None;
        }
        let mut current = item;
        while current != owner {
            if !nodes[current].1 {
                return None;
            }
            let parent = (owner..current)
                .rev()
                .find(|previous| nodes[*previous].0 < nodes[current].0)?;
            if nodes[parent].0 + 1 != nodes[current].0 {
                return None;
            }
            current = parent;
        }
        let range = item..end(item);
        total += range.len();
        if total > 128
            || nodes[range.clone()].iter().any(|(_, admitted)| !admitted)
            || ranges
                .iter()
                .any(|previous| range.start < previous.end && previous.start < range.end)
        {
            return None;
        }
        ranges.push(range);
    }
    Some(ranges)
}

fn selected_item_role(control_type: i32) -> Option<&'static str> {
    match control_type {
        // ListItem, TreeItem and DataItem are selected rows, not their labels.
        50007 | 50024 | 50029 => Some("AXRow"),
        _ => None,
    }
}

fn optional_item_members<T>(
    count: i32,
    mut read: impl FnMut(i32) -> Option<Option<T>>,
) -> Option<Option<Vec<T>>> {
    if !(0..=32).contains(&count) {
        return None;
    }
    let mut items = Vec::with_capacity(count as usize);
    let mut supported = true;
    for position in 0..count {
        match read(position)? {
            Some(item) => items.push(item),
            // Still check later members: absence cannot mask an admission error.
            None => supported = false,
        }
    }
    Some(supported.then_some(items))
}

fn sampled_item_value(role: &str, text: &str, budget: usize) -> Option<String> {
    if text.is_empty() {
        return None;
    }
    let prefix = "Sampled selected-item content:\n";
    let value = format!("{prefix}{text}");
    let fits = |value: &str| {
        serde_json::to_vec(&serde_json::json!({ "role": role, "value": value }))
            .is_ok_and(|bytes| bytes.len() <= budget)
    };
    if fits(&value) {
        return Some(value);
    }
    // Bound JSON-encoded bytes, including escapes, without dropping a member.
    let mut low = 0;
    let mut high = text.len();
    while low < high {
        let middle = low + (high - low).div_ceil(2);
        let mut end = middle;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        if fits(&format!("{prefix}{} [partial]", &text[..end])) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    while !text.is_char_boundary(low) {
        low -= 1;
    }
    (low > 0).then(|| format!("{prefix}{} [partial]", &text[..low]))
}

fn same_item_members(
    original: &crate::model::ItemSelection,
    current: &crate::model::ItemSelection,
) -> bool {
    original.owner_runtime_id == current.owner_runtime_id
        && original.document_runtime_id == current.document_runtime_id
        && original.items.len() == current.items.len()
        && original
            .items
            .iter()
            .zip(&current.items)
            .all(|(a, b)| a.runtime_id == b.runtime_id && a.role == b.role)
}

fn read_selected_label<T>(
    mut current: impl FnMut() -> Option<()>,
    read: impl FnOnce() -> Option<T>,
) -> Option<T> {
    current()?;
    let value = read()?;
    current()?;
    Some(value)
}

#[cfg(windows)]
pub use native::{capture, capture_for_input, capture_prepared};

#[cfg(windows)]
mod native {
    use super::*;
    use crate::{
        control::Result,
        model::{
            InputTarget, ItemSelection, MAX_SELECTION_BYTES, Policy, SelectedItem, Selection,
            Snapshot,
        },
    };
    use std::{
        collections::BTreeSet,
        path::Path,
        time::{Duration, Instant},
    };
    use windows::{
        Win32::{
            Foundation::{
                CloseHandle, E_NOINTERFACE, E_NOTIMPL, GetLastError, HANDLE, HWND, LPARAM,
                SetLastError, WAIT_TIMEOUT, WIN32_ERROR, WPARAM,
            },
            System::{
                Com::{
                    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
                    CoUninitialize,
                },
                Threading::{
                    GetProcessId, OpenProcess, PROCESS_NAME_WIN32,
                    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
                    QueryFullProcessImageNameW, WaitForSingleObject,
                },
                Variant::{VARIANT, VT_BOOL},
            },
            UI::{
                Accessibility::{
                    CUIAutomation8, IUIAutomation2, IUIAutomationCacheRequest,
                    IUIAutomationElement, IUIAutomationSelectionItemPattern,
                    IUIAutomationSelectionPattern, IUIAutomationTextPattern,
                    IUIAutomationTextRange, IUIAutomationTextRangeArray, IUIAutomationTreeWalker,
                    IUIAutomationValuePattern, TextPatternRangeEndpoint_End,
                    TextPatternRangeEndpoint_Start, TreeScope_Element, UIA_CONTROLTYPE_ID,
                    UIA_ControlTypePropertyId, UIA_DocumentControlTypeId, UIA_E_NOTSUPPORTED,
                    UIA_E_TIMEOUT, UIA_EditControlTypeId, UIA_FrameworkIdPropertyId,
                    UIA_IsHiddenAttributeId, UIA_IsOffscreenPropertyId, UIA_IsPasswordPropertyId,
                    UIA_NativeWindowHandlePropertyId, UIA_ProcessIdPropertyId,
                    UIA_SelectionItemPatternId, UIA_SelectionPatternId, UIA_TextControlTypeId,
                    UIA_TextPatternId, UIA_ValuePatternId,
                },
                WindowsAndMessaging::{
                    EnumChildWindows, GA_ROOT, GUITHREADINFO, GWL_STYLE, GetAncestor,
                    GetClassNameW, GetGUIThreadInfo, GetWindowLongPtrW, GetWindowThreadProcessId,
                    IsWindowVisible, SMTO_ABORTIFHUNG, SMTO_BLOCK, SendMessageTimeoutW, WM_GETTEXT,
                },
            },
        },
        core::{BOOL, BSTR, HRESULT, Interface, PWSTR},
    };

    const TIME_LIMIT: Duration = Duration::from_millis(700);
    const PROVIDER_TIMEOUT_MS: u32 = 250;

    // Optional selection and initial focus discovery use this boundary.
    // Metadata, ownership and privacy reads retain fail-closed behavior.
    fn optional_selection<T>(result: windows::core::Result<T>) -> windows::core::Result<Option<T>> {
        match result {
            Ok(value) => Ok(Some(value)),
            Err(error)
                if error.code().0 as u32 == UIA_E_NOTSUPPORTED
                    || matches!(error.code(), E_NOTIMPL | E_NOINTERFACE) =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    fn optional_selection_interface<T: Interface>(
        read: impl FnOnce(*mut *mut std::ffi::c_void) -> HRESULT,
    ) -> windows::core::Result<Option<T>> {
        let mut pointer = std::ptr::null_mut();
        let supported = optional_selection(read(&mut pointer).ok())?;
        if supported.is_none() || pointer.is_null() {
            return Ok(None);
        }
        Ok(Some(unsafe { T::from_raw(pointer) }))
    }

    fn nonhidden_attribute(value: &VARIANT) -> bool {
        value.vt() == VT_BOOL && unsafe { value.Anonymous.Anonymous.Anonymous.boolVal.0 } == 0
    }

    struct ContentWindows {
        pid: u32,
        visited: usize,
        handles: Vec<HWND>,
    }

    unsafe extern "system" fn find_content(hwnd: HWND, data: LPARAM) -> BOOL {
        let state = unsafe { &mut *(data.0 as *mut ContentWindows) };
        state.visited += 1;
        if state.visited > 256 {
            return BOOL(0);
        }
        let mut pid = 0;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        if pid == state.pid && unsafe { IsWindowVisible(hwnd) }.as_bool() {
            let mut class = [0u16; 64];
            let length = unsafe { GetClassNameW(hwnd, &mut class) } as usize;
            if class[..length]
                .iter()
                .copied()
                .eq("Chrome_RenderWidgetHostHWND".encode_utf16())
            {
                state.handles.push(hwnd);
            }
        }
        BOOL(1)
    }

    struct Apartment;

    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    struct Process(HANDLE);

    impl Drop for Process {
        fn drop(&mut self) {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }

    struct Target {
        hwnd: usize,
        pid: u32,
        process: Process,
        deadline: Instant,
        failures: CaptureFailures,
    }

    impl Target {
        fn within_deadline(&self) -> bool {
            let expired = Instant::now() >= self.deadline;
            if expired {
                self.failures.timed_out.set(true);
            }
            !expired
        }

        fn current(&self) -> Option<()> {
            if !self.within_deadline()
                || !super::super::input_desktop()
                || super::super::foreground() != Some((self.hwnd, self.pid))
            {
                return None;
            }
            unsafe {
                let hwnd = HWND(self.hwnd as *mut _);
                let mut pid = 0;
                if GetWindowThreadProcessId(hwnd, Some(&mut pid)) == 0
                    || pid != self.pid
                    || WaitForSingleObject(self.process.0, 0) != WAIT_TIMEOUT
                {
                    return None;
                }
            }
            self.within_deadline().then_some(())
        }

        fn read<T>(&self, read: impl FnOnce() -> windows::core::Result<T>) -> Option<T> {
            self.current()?;
            let result = read();
            self.current()?;
            if let Err(error) = &result
                && error.code().0 as u32 != UIA_E_NOTSUPPORTED
            {
                if error.code().0 as u32 == UIA_E_TIMEOUT {
                    self.failures.timed_out.set(true);
                } else {
                    self.failures.provider_failed.set(true);
                }
            }
            result.ok()
        }
    }

    struct Document {
        element: IUIAutomationElement,
        source: DocumentSource,
        web_context: bool,
    }

    struct Observed {
        element: IUIAutomationElement,
        depth: usize,
        parent: Option<IUIAutomationElement>,
        first_child: Option<IUIAutomationElement>,
        next_sibling: Option<IUIAutomationElement>,
        visible: bool,
        identity: Option<(UIA_CONTROLTYPE_ID, String)>,
        wrapper: bool,
    }

    struct BrowserScope {
        document: IUIAutomationElement,
        ancestors: Vec<IUIAutomationElement>,
        focused: IUIAutomationElement,
    }

    struct VisibleText {
        element: IUIAutomationElement,
        pattern: IUIAutomationTextPattern,
        ranges: Vec<IUIAutomationTextRange>,
        nonhidden: Option<NonhiddenText>,
    }

    struct NonhiddenText {
        hwnd: HWND,
        class: String,
        runs: Vec<NonhiddenRun>,
    }

    struct NonhiddenRun {
        visible_index: usize,
        range: IUIAutomationTextRange,
        text: Vec<u16>,
        maximum: i32,
    }

    struct NativeScalar {
        element: IUIAutomationElement,
        ancestors: Vec<IUIAutomationElement>,
        // None is an admitted WPF TextBox; only standard Edit uses a HWND read.
        native_window: Option<(HWND, String)>,
        text_offset: usize,
    }

    struct SelectedItems {
        focused: IUIAutomationElement,
        owner: usize,
        indexes: Vec<usize>,
        selection: ItemSelection,
    }

    struct Capture<'a> {
        target: &'a Target,
        automation: IUIAutomation2,
        root: IUIAutomationElement,
        identity_cache: IUIAutomationCacheRequest,
        visibility_cache: IUIAutomationCacheRequest,
        state_cache: IUIAutomationCacheRequest,
        rich_state_cache: IUIAutomationCacheRequest,
        walker: IUIAutomationTreeWalker,
        policy: &'a Policy,
        documents: Vec<Document>,
        observed: Vec<Observed>,
        domains: BTreeSet<String>,
        browser: bool,
        web_seen: bool,
        nodes: usize,
        text: String,
        text_truncated: bool,
        text_limit: usize,
        browser_scope: Option<BrowserScope>,
        native_scalars: Vec<NativeScalar>,
        visible_text: Vec<VisibleText>,
    }

    impl Capture<'_> {
        fn root_current(&self) -> Option<()> {
            // Refresh only nonsensitive identity at each fence. Never reuse a
            // prior cache or prefetch names/values before privacy admission.
            let (hwnd, pid) = self.target.read(|| unsafe {
                let root = self.root.BuildUpdatedCache(&self.identity_cache)?;
                Ok((root.CachedNativeWindowHandle()?, root.CachedProcessId()?))
            })?;
            (hwnd.0 as usize == self.target.hwnd && pid as u32 == self.target.pid).then_some(())
        }

        fn read<T>(&self, read: impl FnOnce() -> windows::core::Result<T>) -> Option<T> {
            self.target.read(read)
        }

        // An offscreen subtree contributes nothing. A visible password control
        // suppresses the whole snapshot, including its window title.
        fn visible(&self, element: &IUIAutomationElement) -> Option<bool> {
            let (password, offscreen, pid) = self.read(|| unsafe {
                let current = element.BuildUpdatedCache(&self.visibility_cache)?;
                Ok((
                    current.CachedIsPassword()?.as_bool(),
                    current.CachedIsOffscreen()?.as_bool(),
                    current.CachedProcessId()?,
                ))
            })?;
            if offscreen {
                return Some(false);
            }
            if password || pid as u32 != self.target.pid {
                return None;
            }
            Some(true)
        }

        fn state(
            &self,
            element: &IUIAutomationElement,
        ) -> Option<(bool, UIA_CONTROLTYPE_ID, String)> {
            // Batch only metadata needed together at this boundary. Offscreen
            // nodes do not require framework/type support to be omitted.
            let state = self.read(|| unsafe {
                let current = element.BuildUpdatedCache(&self.state_cache)?;
                if current.CachedIsOffscreen()?.as_bool() {
                    return Ok(None);
                }
                Ok(Some((
                    current.CachedIsPassword()?.as_bool(),
                    current.CachedProcessId()?,
                    current.CachedControlType()?,
                    current.CachedFrameworkId()?,
                )))
            })?;
            let Some((password, pid, kind, framework)) = state else {
                return Some((false, UIA_CONTROLTYPE_ID(0), String::new()));
            };
            if password || pid as u32 != self.target.pid {
                return None;
            }
            Some((true, kind, bounded_string(&framework, 128)?))
        }

        fn sensitive<T>(
            &self,
            element: &IUIAutomationElement,
            read: impl FnOnce() -> windows::core::Result<T>,
        ) -> Option<T> {
            self.root_current()?;
            self.scope_current()?;
            if !self.visible(element)? {
                return None;
            }
            let value = self.read(read)?;
            self.scope_current()?;
            self.root_current()?;
            self.visible(element)?.then_some(value)
        }

        fn scope_current(&self) -> Option<()> {
            let Some(scope) = &self.browser_scope else {
                return Some(());
            };
            self.same_ancestry(&scope.document, &scope.ancestors)
        }

        fn native_edit_current(
            &self,
            element: &IUIAutomationElement,
            ancestors: &[IUIAutomationElement],
        ) -> Option<()> {
            self.same_ancestry(element, ancestors)?;
            let (visible, kind, framework) = self.state(element)?;
            if !visible
                || kind != UIA_EditControlTypeId
                || framework != "WPF"
                || self.read(|| unsafe { element.CurrentClassName() })? != "TextBox"
            {
                return None;
            }
            Some(())
        }

        fn native_edit_window(
            &self,
            element: &IUIAutomationElement,
        ) -> Option<Option<(HWND, String)>> {
            let (visible, kind, framework) = self.state(element)?;
            if !visible
                || kind != UIA_EditControlTypeId
                || !matches!(framework.as_str(), "WinForm" | "Win32")
                || self.browser
                || self.web_seen
            {
                return Some(None);
            }
            let hwnd = self.read(|| unsafe { element.CurrentNativeWindowHandle() })?;
            if hwnd.is_invalid() {
                return Some(None);
            }
            let mut class = [0u16; 128];
            let length = unsafe { GetClassNameW(hwnd, &mut class) } as usize;
            let class = String::from_utf16(&class[..length]).ok()?;
            if crate::input::native_edit_class(&class)
                != Some(crate::input::NativeEditClass::Standard)
            {
                return Some(None);
            }
            Some(Some((hwnd, class)))
        }

        fn native_edit_owned_window(&self, hwnd: HWND, class: &str) -> bool {
            let mut owner = 0;
            let thread = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut owner)) };
            let mut current_class = [0u16; 128];
            let length = unsafe { GetClassNameW(hwnd, &mut current_class) } as usize;
            unsafe { SetLastError(WIN32_ERROR(0)) };
            let style = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) };
            let style_valid = style != 0 || unsafe { GetLastError() }.0 == 0;
            thread != 0
                && owner == self.target.pid
                && unsafe { GetAncestor(hwnd, GA_ROOT) }.0 as usize == self.target.hwnd
                && String::from_utf16(&current_class[..length]).ok().as_deref() == Some(class)
                && style_valid
                && style & 0x20 == 0 // ES_PASSWORD
        }

        fn native_edit_current_window(&self, hwnd: HWND, class: &str, focus: HWND) -> bool {
            let thread = unsafe { GetWindowThreadProcessId(hwnd, None) };
            let mut info = GUITHREADINFO {
                cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
                ..Default::default()
            };
            self.native_edit_owned_window(hwnd, class)
                && thread != 0
                && unsafe { GetGUIThreadInfo(thread, &mut info) }.is_ok()
                && info.hwndFocus == focus
        }

        fn native_edit_value(
            &self,
            element: &IUIAutomationElement,
            hwnd: HWND,
            class: &str,
            focus: HWND,
            capacity: usize,
        ) -> Option<Vec<u16>> {
            if capacity == 0 || capacity > MAX_BYTES + 2 {
                return None;
            }
            if self.read(|| unsafe { element.CurrentNativeWindowHandle() })? != hwnd {
                return None;
            }
            let value = self.sensitive(element, || {
                if !self.native_edit_current_window(hwnd, class, focus) {
                    return Err(windows::core::Error::from_hresult(E_NOINTERFACE));
                }
                let mut text = vec![0u16; capacity];
                let mut copied = 0usize;
                // WM_GETTEXT is below WM_USER: Windows marshals this local
                // buffer, including when the separate provider times out.
                let result = unsafe {
                    SendMessageTimeoutW(
                        hwnd,
                        WM_GETTEXT,
                        WPARAM(text.len()),
                        LPARAM(text.as_mut_ptr() as isize),
                        SMTO_ABORTIFHUNG | SMTO_BLOCK,
                        100,
                        Some(&mut copied),
                    )
                };
                if result.0 == 0
                    || copied >= text.len()
                    || !self.native_edit_current_window(hwnd, class, focus)
                {
                    return Err(windows::core::Error::from_hresult(E_NOINTERFACE));
                }
                text.truncate(copied);
                Ok(text)
            })?;
            (self.read(|| unsafe { element.CurrentNativeWindowHandle() })? == hwnd).then_some(value)
        }

        fn collect_native_scalars(&mut self) -> Option<()> {
            let mut inserted = 0usize;
            for scalar in std::mem::take(&mut self.native_scalars) {
                let offset = scalar.text_offset + inserted;
                if offset >= self.text_limit || offset > self.text.len() {
                    self.text_truncated = true;
                    break;
                }
                let (value, truncated) = if let Some((hwnd, class)) = &scalar.native_window {
                    self.same_ancestry(&scalar.element, &scalar.ancestors)?;
                    let thread = unsafe { GetWindowThreadProcessId(*hwnd, None) };
                    let mut info = GUITHREADINFO {
                        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
                        ..Default::default()
                    };
                    unsafe { GetGUIThreadInfo(thread, &mut info) }.ok()?;
                    let value = self.native_edit_value(
                        &scalar.element,
                        *hwnd,
                        class,
                        info.hwndFocus,
                        MAX_BYTES + 2,
                    )?;
                    self.same_ancestry(&scalar.element, &scalar.ancestors)?;
                    (text_prefix(&value), value.len() > MAX_BYTES)
                } else {
                    self.native_edit_current(&scalar.element, &scalar.ancestors)?;
                    let value = if let Some(value) =
                        self.native_visible_text(&scalar.element, self.text_limit - offset)?
                    {
                        value
                    } else {
                        let pattern = self.value_pattern(&scalar.element)??;
                        let value =
                            self.sensitive(&scalar.element, || unsafe { pattern.CurrentValue() })?;
                        (text_prefix(&value), value.len() > MAX_BYTES)
                    };
                    self.native_edit_current(&scalar.element, &scalar.ancestors)?;
                    value
                };
                self.text_truncated |= truncated;
                // Preserve the original walk order: later labels must not
                // consume the budget before an earlier deferred Edit body.
                let (added, truncated) =
                    insert_native_scalar(&mut self.text, offset, &value, self.text_limit);
                inserted += added;
                self.text_truncated |= truncated;
            }
            Some(())
        }

        fn value_pattern(
            &self,
            element: &IUIAutomationElement,
        ) -> Option<Option<IUIAutomationValuePattern>> {
            if !self.visible(element)? {
                return None;
            }
            self.read(|| unsafe {
                let mut pointer = std::ptr::null_mut();
                let status = (Interface::vtable(element).GetCurrentPatternAs)(
                    element.as_raw(),
                    UIA_ValuePatternId,
                    &IUIAutomationValuePattern::IID,
                    &mut pointer,
                );
                if status.0 as u32 == UIA_E_NOTSUPPORTED {
                    return Ok(None);
                }
                status.ok()?;
                if pointer.is_null() {
                    Ok(None)
                } else {
                    Ok(Some(IUIAutomationValuePattern::from_raw(pointer)))
                }
            })
        }

        fn source(
            &self,
            element: &IUIAutomationElement,
            web_context: bool,
        ) -> Option<DocumentSource> {
            let (visible, kind, framework) = self.state(element)?;
            if !visible || kind != UIA_DocumentControlTypeId {
                return None;
            }
            if !self.browser && !web_context && matches!(framework.as_str(), "WinForm" | "Win32") {
                let hwnd = self.read(|| unsafe { element.CurrentNativeWindowHandle() })?;
                let mut class = [0u16; 128];
                let length = unsafe { GetClassNameW(hwnd, &mut class) } as usize;
                let class = String::from_utf16(&class[..length]).ok()?;
                if crate::input::native_edit_class(&class)
                    == Some(crate::input::NativeEditClass::Rich)
                {
                    // CUIAutomation8 exposes RichEdit own text as Document
                    // ValuePattern, not a URL. This admits metadata/actions;
                    // body reads require the separate nonhidden-run path.
                    return (self.native_edit_owned_window(hwnd, &class)
                        && self.neighbor(element, true)?.is_none())
                    .then_some(DocumentSource::NativeAction);
                }
            }
            let value = match self.value_pattern(element)? {
                Some(pattern) => Some(bounded_string(
                    &self.sensitive(element, || unsafe { pattern.CurrentValue() })?,
                    MAX_URL_BYTES,
                )?),
                None => None,
            };
            resolve_source(value.as_deref(), &framework, self.browser, web_context)
        }

        fn document_wrapper(&self, element: &IUIAutomationElement) -> Option<bool> {
            let (visible, kind, framework) = self.state(element)?;
            if !self.browser
                || !visible
                || kind != UIA_DocumentControlTypeId
                || framework != "Chrome"
                || self.value_pattern(element)?.is_some()
            {
                return Some(false);
            }
            // Chromium exposes a URL-less iframe container around one actual
            // Document. Its exact child owns the source and is visited normally;
            // the wrapper contributes no text or inherited source authority.
            let child = self.neighbor(element, true)??;
            let (visible, kind, framework) = self.state(&child)?;
            if self.neighbor(&child, false)?.is_some()
                || !visible
                || kind != UIA_DocumentControlTypeId
                || framework != "Chrome"
            {
                return Some(false);
            }
            let pattern = self.value_pattern(&child)??;
            let value = self.sensitive(&child, || unsafe { pattern.CurrentValue() })?;
            let source = document_source(&bounded_string(&value, MAX_URL_BYTES)?)?;
            Some(matches!(source, DocumentSource::Remote(_)))
        }

        // The generated methods convert successful null neighbors into an error.
        // Preserve S_OK/null explicitly; a failed provider call is never a leaf.
        fn neighbor(
            &self,
            element: &IUIAutomationElement,
            first_child: bool,
        ) -> Option<Option<IUIAutomationElement>> {
            self.read(|| unsafe {
                let mut pointer = std::ptr::null_mut();
                let vtable = Interface::vtable(&self.walker);
                let method = if first_child {
                    vtable.GetFirstChildElement
                } else {
                    vtable.GetNextSiblingElement
                };
                method(self.walker.as_raw(), element.as_raw(), &mut pointer).ok()?;
                Ok((!pointer.is_null()).then(|| IUIAutomationElement::from_raw(pointer)))
            })
        }

        fn same_ancestry(
            &self,
            element: &IUIAutomationElement,
            ancestors: &[IUIAutomationElement],
        ) -> Option<()> {
            let mut current = element.clone();
            for expected in ancestors.iter().rev() {
                let parent = self.read(|| unsafe { self.walker.GetParentElement(&current) })?;
                if !self
                    .read(|| unsafe { self.automation.CompareElements(&parent, expected) })?
                    .as_bool()
                {
                    return None;
                }
                current = parent;
            }
            Some(())
        }

        fn sources_current(&self, sources: &[usize]) -> Option<()> {
            for index in sources {
                let document = &self.documents[*index];
                if self.source(&document.element, document.web_context)? != document.source {
                    return None;
                }
            }
            Some(())
        }

        fn same_element(
            &self,
            actual: Option<&IUIAutomationElement>,
            expected: Option<&IUIAutomationElement>,
        ) -> Option<()> {
            match (actual, expected) {
                (None, None) => Some(()),
                (Some(actual), Some(expected)) => self
                    .read(|| unsafe { self.automation.CompareElements(actual, expected) })?
                    .as_bool()
                    .then_some(()),
                _ => None,
            }
        }

        fn final_tree_check(&self) -> Option<()> {
            for node in &self.observed {
                let (visible, kind, framework) = self.state(&node.element)?;
                if visible != node.visible {
                    return None;
                }
                if let Some(parent) = &node.parent {
                    let actual =
                        self.read(|| unsafe { self.walker.GetParentElement(&node.element) })?;
                    self.same_element(Some(&actual), Some(parent))?;
                    let sibling = self.neighbor(&node.element, false)?;
                    self.same_element(sibling.as_ref(), node.next_sibling.as_ref())?;
                }
                if node.visible {
                    if node.identity.as_ref() != Some(&(kind, framework)) {
                        return None;
                    }
                    let child = self.neighbor(&node.element, true)?;
                    self.same_element(child.as_ref(), node.first_child.as_ref())?;
                    if node.wrapper && !self.document_wrapper(&node.element)? {
                        return None;
                    }
                }
            }
            for document in &self.documents {
                if self.source(&document.element, document.web_context)? != document.source {
                    return None;
                }
            }
            Some(())
        }

        fn leaf_current(
            &self,
            element: &IUIAutomationElement,
            ancestors: &[IUIAutomationElement],
            sources: &[usize],
        ) -> Option<()> {
            self.same_ancestry(element, ancestors)?;
            self.sources_current(sources)?;
            if !self.visible(element)? || self.neighbor(element, true)?.is_some() {
                return None;
            }
            Some(())
        }

        // Callers admit only childless native text controls or a fully validated
        // WPF TextBox own-value. Never use this for a web/container text range.
        fn native_visible_text(
            &mut self,
            element: &IUIAutomationElement,
            limit: usize,
        ) -> Option<Option<(String, bool)>> {
            let pattern = self.read(|| {
                optional_selection_interface::<IUIAutomationTextPattern>(|pointer| unsafe {
                    (Interface::vtable(element).GetCurrentPatternAs)(
                        element.as_raw(),
                        UIA_TextPatternId,
                        &IUIAutomationTextPattern::IID,
                        pointer,
                    )
                })
            })?;
            let Some(pattern) = pattern else {
                return Some(None);
            };
            let ranges = self.read(|| {
                optional_selection_interface::<IUIAutomationTextRangeArray>(|pointer| unsafe {
                    (Interface::vtable(&pattern).GetVisibleRanges)(pattern.as_raw(), pointer)
                })
            })?;
            let Some(ranges) = ranges else {
                return Some(None);
            };
            // Once the provider supplies ranges, failures cannot switch back to
            // whole-document text and silently change the observation's scope.
            let count = self.read(|| unsafe { ranges.Length() })?;
            let mut witnesses = Vec::new();
            let text = collect_visible_spans(count, limit, |index, maximum| {
                let range = self.read(|| unsafe { ranges.GetElement(index) })?;
                let enclosing = self.read(|| unsafe { range.GetEnclosingElement() })?;
                self.same_element(Some(element), Some(&enclosing))?;
                let value = self.sensitive(element, || unsafe { range.GetText(maximum as i32) })?;
                witnesses.push(range);
                Some(value.to_vec())
            })?;
            self.visible_text.push(VisibleText {
                element: element.clone(),
                pattern,
                ranges: witnesses,
                nonhidden: None,
            });
            // A viewport sample is partial even when it fits the byte budget.
            Some(Some((text, true)))
        }

        fn rich_element_current(
            &self,
            element: &IUIAutomationElement,
            witness: &NonhiddenText,
        ) -> Option<()> {
            if !self.policy.capture_text || self.browser || self.web_seen {
                return None;
            }
            // Refresh state and HWND together at this boundary only. No cache
            // contents are retained across a text read or a later validation.
            let (password, offscreen, pid, kind, framework, hwnd) = self.read(|| unsafe {
                let current = element.BuildUpdatedCache(&self.rich_state_cache)?;
                Ok((
                    current.CachedIsPassword()?.as_bool(),
                    current.CachedIsOffscreen()?.as_bool(),
                    current.CachedProcessId()?,
                    current.CachedControlType()?,
                    current.CachedFrameworkId()?,
                    current.CachedNativeWindowHandle()?,
                ))
            })?;
            let framework = bounded_string(&framework, 128)?;
            if password
                || offscreen
                || pid as u32 != self.target.pid
                || kind != UIA_DocumentControlTypeId
                || !matches!(framework.as_str(), "WinForm" | "Win32")
                || hwnd != witness.hwnd
                || !self.native_edit_owned_window(witness.hwnd, &witness.class)
                || self.neighbor(element, true)?.is_some()
            {
                return None;
            }
            Some(())
        }

        fn rich_range_current(
            &self,
            element: &IUIAutomationElement,
            witness: &NonhiddenText,
            outer: &IUIAutomationTextRange,
            range: &IUIAutomationTextRange,
        ) -> Option<bool> {
            self.rich_element_current(element, witness)?;
            let enclosing = self.read(|| unsafe { range.GetEnclosingElement() })?;
            self.same_element(Some(element), Some(&enclosing))?;
            // Only endpoint metadata shares a target fence. Keep the local
            // deadline between provider calls and all text fences separate.
            let (start, end, extent) = self.read(|| unsafe {
                let start = range.CompareEndpoints(
                    TextPatternRangeEndpoint_Start,
                    outer,
                    TextPatternRangeEndpoint_Start,
                )?;
                if !self.target.within_deadline() {
                    return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                        UIA_E_TIMEOUT as i32,
                    )));
                }
                let end = range.CompareEndpoints(
                    TextPatternRangeEndpoint_End,
                    outer,
                    TextPatternRangeEndpoint_End,
                )?;
                if !self.target.within_deadline() {
                    return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                        UIA_E_TIMEOUT as i32,
                    )));
                }
                let extent = range.CompareEndpoints(
                    TextPatternRangeEndpoint_Start,
                    range,
                    TextPatternRangeEndpoint_End,
                )?;
                Ok((start, end, extent))
            })?;
            rich_range_readable(start, end, extent)
        }

        fn rich_run_current(
            &self,
            element: &IUIAutomationElement,
            witness: &NonhiddenText,
            outer: &IUIAutomationTextRange,
            range: &IUIAutomationTextRange,
        ) -> Option<bool> {
            if !self.rich_range_current(element, witness, outer, range)? {
                return Some(false);
            }
            let hidden =
                self.read(|| unsafe { range.GetAttributeValue(UIA_IsHiddenAttributeId) })?;
            nonhidden_attribute(&hidden).then_some(true)
        }

        fn rich_visible_text(&mut self, element: &IUIAutomationElement) -> Option<Option<String>> {
            if !self.policy.capture_text {
                return None;
            }
            let hwnd = self.read(|| unsafe { element.CurrentNativeWindowHandle() })?;
            let mut class = [0u16; 128];
            let length = unsafe { GetClassNameW(hwnd, &mut class) } as usize;
            let class = String::from_utf16(&class[..length]).ok()?;
            if crate::input::native_edit_class(&class) != Some(crate::input::NativeEditClass::Rich)
            {
                return None;
            }
            let mut nonhidden = NonhiddenText {
                hwnd,
                class,
                runs: Vec::new(),
            };
            self.rich_element_current(element, &nonhidden)?;
            let pattern = self.read(|| {
                optional_selection_interface::<IUIAutomationTextPattern>(|pointer| unsafe {
                    (Interface::vtable(element).GetCurrentPatternAs)(
                        element.as_raw(),
                        UIA_TextPatternId,
                        &IUIAutomationTextPattern::IID,
                        pointer,
                    )
                })
            })?;
            let Some(pattern) = pattern else {
                return Some(None);
            };
            let ranges = self.read(|| {
                optional_selection_interface::<IUIAutomationTextRangeArray>(|pointer| unsafe {
                    (Interface::vtable(&pattern).GetVisibleRanges)(pattern.as_raw(), pointer)
                })
            })?;
            let Some(ranges) = ranges else {
                return Some(None);
            };
            let count = self.read(|| unsafe { ranges.Length() })?;
            if !(0..=8).contains(&count) {
                return None;
            }
            let limit = self.text_limit.saturating_sub(self.text.len()).min(8192);
            // Bound retained raw witnesses too: trimming whitespace must not
            // free the provider-read budget for another full-size run.
            let mut remaining = limit + 1;
            let mut text = String::new();
            let mut witnesses = Vec::new();
            let mut scans = 0;
            for index in 0..count {
                let outer = self.read(|| unsafe { ranges.GetElement(index) })?;
                let enclosing = self.read(|| unsafe { outer.GetEnclosingElement() })?;
                self.same_element(Some(element), Some(&enclosing))?;
                let mut search = self.read(|| unsafe { outer.Clone() })?;
                witnesses.push(outer);
                // Hidden-only skips consume the same bounded search budget.
                while scans < 16 && text.len() < limit && remaining > 0 {
                    let extent = self.read(|| unsafe {
                        search.CompareEndpoints(
                            TextPatternRangeEndpoint_Start,
                            &search,
                            TextPatternRangeEndpoint_End,
                        )
                    })?;
                    if !rich_range_readable(0, 0, extent)? {
                        break;
                    }
                    scans += 1;
                    let hidden = self.read(|| unsafe {
                        // Preserve S_OK/null as no matching run, not a provider failure.
                        let value = VARIANT::from(true);
                        let mut pointer = std::ptr::null_mut();
                        (Interface::vtable(&search).FindAttribute)(
                            search.as_raw(),
                            UIA_IsHiddenAttributeId,
                            std::mem::transmute_copy(&value),
                            false.into(),
                            &mut pointer,
                        )
                        .ok()?;
                        Ok((!pointer.is_null()).then(|| IUIAutomationTextRange::from_raw(pointer)))
                    })?;
                    let found = self.read(|| unsafe { search.Clone() })?;
                    if let Some(hidden) = &hidden {
                        if !self.rich_range_current(element, &nonhidden, &search, hidden)? {
                            // A collapsed delimiter cannot establish progress.
                            // Leave this visible range's remaining tail unchecked.
                            break;
                        }
                        self.read(|| unsafe {
                            found.MoveEndpointByRange(
                                TextPatternRangeEndpoint_End,
                                hidden,
                                TextPatternRangeEndpoint_Start,
                            )
                        })?;
                        // Do not trust a provider move to preserve either boundary.
                        if self.read(|| unsafe {
                            found.CompareEndpoints(
                                TextPatternRangeEndpoint_Start,
                                &search,
                                TextPatternRangeEndpoint_Start,
                            )
                        })? != 0
                            || self.read(|| unsafe {
                                found.CompareEndpoints(
                                    TextPatternRangeEndpoint_End,
                                    hidden,
                                    TextPatternRangeEndpoint_Start,
                                )
                            })? != 0
                        {
                            return None;
                        }
                    }
                    let maximum = remaining.min(limit - text.len() + 1) as i32;
                    let value = read_nonhidden_run(
                        || self.rich_run_current(element, &nonhidden, &search, &found),
                        || {
                            let value =
                                self.sensitive(element, || unsafe { found.GetText(maximum) })?;
                            (value.len() <= maximum as usize).then(|| value.to_vec())
                        },
                        None,
                    )?;
                    // A hidden-leading range has an empty prefix: skip without
                    // reading text, but still validate strict cursor progress.
                    if let Some(value) = value {
                        remaining -= value.len();
                        append_text(&mut text, &text_prefix(&value), limit);
                        nonhidden.runs.push(NonhiddenRun {
                            visible_index: index as usize,
                            range: found,
                            text: value,
                            maximum,
                        });
                    }
                    let Some(hidden) = hidden else {
                        break;
                    };
                    // Text reads can mutate ranges. Revalidate the skip boundary
                    // and advance a separate cursor, never a retained witness.
                    if !self.rich_range_current(element, &nonhidden, &search, &hidden)? {
                        break;
                    }
                    let attribute =
                        self.read(|| unsafe { hidden.GetAttributeValue(UIA_IsHiddenAttributeId) })?;
                    if attribute.vt() != VT_BOOL
                        || unsafe { attribute.Anonymous.Anonymous.Anonymous.boolVal.0 } == 0
                    {
                        return None;
                    }
                    let next = self.read(|| unsafe { search.Clone() })?;
                    self.read(|| unsafe {
                        next.MoveEndpointByRange(
                            TextPatternRangeEndpoint_Start,
                            &hidden,
                            TextPatternRangeEndpoint_End,
                        )
                    })?;
                    if self.read(|| unsafe {
                        next.CompareEndpoints(
                            TextPatternRangeEndpoint_Start,
                            &hidden,
                            TextPatternRangeEndpoint_End,
                        )
                    })? != 0
                        || self.read(|| unsafe {
                            next.CompareEndpoints(
                                TextPatternRangeEndpoint_End,
                                &search,
                                TextPatternRangeEndpoint_End,
                            )
                        })? != 0
                        || self.read(|| unsafe {
                            next.CompareEndpoints(
                                TextPatternRangeEndpoint_Start,
                                &search,
                                TextPatternRangeEndpoint_Start,
                            )
                        })? <= 0
                    {
                        return None;
                    }
                    self.rich_range_current(element, &nonhidden, &search, &next)?;
                    search = next;
                }
            }
            self.visible_text.push(VisibleText {
                element: element.clone(),
                pattern,
                ranges: witnesses,
                nonhidden: Some(nonhidden),
            });
            Some(Some(text))
        }

        fn final_visible_text_check(&self) -> Option<()> {
            for witness in &self.visible_text {
                if !self.visible(&witness.element)? {
                    return None;
                }
                let fresh = self.read(|| unsafe { witness.pattern.GetVisibleRanges() })?;
                if self.read(|| unsafe { fresh.Length() })? as usize != witness.ranges.len() {
                    return None;
                }
                if let Some(nonhidden) = &witness.nonhidden {
                    self.rich_element_current(&witness.element, nonhidden)?;
                    for run in &nonhidden.runs {
                        let outer =
                            self.read(|| unsafe { fresh.GetElement(run.visible_index as i32) })?;
                        read_nonhidden_run(
                            || {
                                self.rich_run_current(
                                    &witness.element,
                                    nonhidden,
                                    &outer,
                                    &run.range,
                                )
                            },
                            || {
                                let value = self.sensitive(&witness.element, || unsafe {
                                    run.range.GetText(run.maximum)
                                })?;
                                (value.len() <= run.maximum as usize).then(|| value.to_vec())
                            },
                            Some(&run.text),
                        )??;
                    }
                }
                // Rich revalidation reads can themselves move the viewport.
                let fresh = if witness.nonhidden.is_some() {
                    let fresh = self.read(|| unsafe { witness.pattern.GetVisibleRanges() })?;
                    if self.read(|| unsafe { fresh.Length() })? as usize != witness.ranges.len() {
                        return None;
                    }
                    fresh
                } else {
                    fresh
                };
                for (index, range) in witness.ranges.iter().enumerate() {
                    let current = self.read(|| unsafe { fresh.GetElement(index as i32) })?;
                    let enclosing = self.read(|| unsafe { current.GetEnclosingElement() })?;
                    self.same_element(Some(&witness.element), Some(&enclosing))?;
                    for endpoint in [TextPatternRangeEndpoint_Start, TextPatternRangeEndpoint_End] {
                        if self.read(|| unsafe {
                            range.CompareEndpoints(endpoint, &current, endpoint)
                        })? != 0
                        {
                            return None;
                        }
                    }
                }
            }
            Some(())
        }

        fn native_text(
            &mut self,
            element: &IUIAutomationElement,
            ancestors: &[IUIAutomationElement],
            sources: &[usize],
        ) -> Option<(String, bool)> {
            let index = *sources.last()?;
            if self.documents[index].source != DocumentSource::Native {
                return None;
            }
            self.leaf_current(element, ancestors, sources)?;
            if let Some(value) =
                self.native_visible_text(element, self.text_limit.saturating_sub(self.text.len()))?
            {
                self.leaf_current(element, ancestors, sources)?;
                return Some(value);
            }
            // Keep a successful null pattern distinct from a failed provider call.
            let pattern = self.read(|| unsafe {
                let mut pointer = std::ptr::null_mut();
                (Interface::vtable(element).GetCurrentPatternAs)(
                    element.as_raw(),
                    UIA_TextPatternId,
                    &IUIAutomationTextPattern::IID,
                    &mut pointer,
                )
                .ok()?;
                Ok((!pointer.is_null()).then(|| IUIAutomationTextPattern::from_raw(pointer)))
            })??;
            self.leaf_current(element, ancestors, sources)?;
            let range = self.read(|| unsafe { pattern.DocumentRange() })?;
            self.leaf_current(element, ancestors, sources)?;
            let remaining = self
                .text_limit
                .saturating_sub(self.text.len())
                .min(MAX_BYTES);
            let value =
                self.sensitive(element, || unsafe { range.GetText(remaining as i32 + 1) })?;
            self.leaf_current(element, ancestors, sources)?;
            let truncated = value.len() > remaining;
            Some((text_prefix(&value), truncated))
        }

        fn selected_text(&self) -> Option<Option<Selection>> {
            macro_rules! selection_read {
                ($read:expr) => {
                    match self.read(|| optional_selection($read))? {
                        Some(value) => value,
                        None => {
                            self.final_tree_check()?;
                            return Some(None);
                        }
                    }
                };
                (interface $interface:ty, $read:expr) => {
                    match self.read(|| optional_selection_interface::<$interface>($read))? {
                        Some(value) => value,
                        None => {
                            self.final_tree_check()?;
                            return Some(None);
                        }
                    }
                };
                (sensitive $element:expr, $read:expr) => {
                    match self.sensitive($element, || optional_selection($read))? {
                        Some(value) => value,
                        None => {
                            self.final_tree_check()?;
                            return Some(None);
                        }
                    }
                };
            }
            let focused = selection_read!(interface IUIAutomationElement, |pointer| unsafe {
                (Interface::vtable(&self.automation).base__.GetFocusedElement)(
                    self.automation.as_raw(), pointer,
                )
            });
            if !self.policy.capture_text {
                return self.native_edit_selection(&focused);
            }
            let pattern = self.read(|| {
                optional_selection_interface::<IUIAutomationTextPattern>(|pointer| unsafe {
                    (Interface::vtable(&focused).GetCurrentPatternAs)(
                        focused.as_raw(),
                        UIA_TextPatternId,
                        &IUIAutomationTextPattern::IID,
                        pointer,
                    )
                })
            })?;
            let Some(pattern) = pattern else {
                return self.native_edit_selection(&focused);
            };
            // A range can aggregate descendants. Only a completely observed,
            // visible subtree may contribute selection text.
            let mut index = None;
            for (position, node) in self.observed.iter().enumerate() {
                if self
                    .read(|| unsafe { self.automation.CompareElements(&focused, &node.element) })?
                    .as_bool()
                {
                    index = Some(position);
                    break;
                }
            }
            let Some(index) = index else {
                return Some(None);
            };
            let node = &self.observed[index];
            if !node.visible || node.wrapper {
                return Some(None);
            }
            let mut ancestors = Vec::new();
            let mut current = focused.clone();
            while !self
                .read(|| unsafe { self.automation.CompareElements(&current, &self.root) })?
                .as_bool()
            {
                if ancestors.len() >= 32 {
                    return Some(None);
                }
                current = self.read(|| unsafe { self.walker.GetParentElement(&current) })?;
                if !self.visible(&current)? {
                    return None;
                }
                ancestors.push(current.clone());
            }
            ancestors.reverse();
            // The walk records preorder depth; final_tree_check verifies the
            // recorded links again before any aggregate range is read.
            let end = self
                .observed
                .iter()
                .enumerate()
                .skip(index + 1)
                .find(|(_, descendant)| descendant.depth <= node.depth)
                .map_or(self.observed.len(), |(position, _)| position);
            let subtree = &self.observed[index..end];
            if subtree
                .iter()
                .any(|descendant| !descendant.visible || descendant.wrapper)
            {
                return Some(None);
            }
            for document in &self.documents {
                if document.source == DocumentSource::NativeAction
                    && (find_observed(subtree, |node| {
                        self.read(|| unsafe {
                            self.automation
                                .CompareElements(&document.element, &node.element)
                        })
                        .map(|same| same.as_bool())
                    })?
                    .is_some()
                        || find_observed(&ancestors, |ancestor| {
                            self.read(|| unsafe {
                                self.automation.CompareElements(&document.element, ancestor)
                            })
                            .map(|same| same.as_bool())
                        })?
                        .is_some())
                {
                    return Some(None);
                }
            }
            let ranges = selection_read!(interface IUIAutomationTextRangeArray, |pointer| unsafe {
                (Interface::vtable(&pattern).GetSelection)(pattern.as_raw(), pointer)
            });
            if selection_read!(unsafe { ranges.Length() }) != 1 {
                return Some(None);
            }
            let range = selection_read!(unsafe { ranges.GetElement(0) });
            if selection_read!(unsafe {
                range.CompareEndpoints(
                    TextPatternRangeEndpoint_Start,
                    &range,
                    TextPatternRangeEndpoint_End,
                )
            }) == 0
            {
                return Some(None);
            }
            self.same_ancestry(&focused, &ancestors)?;
            let enclosing = selection_read!(unsafe { range.GetEnclosingElement() });
            if find_observed(subtree, |candidate| {
                self.read(|| unsafe {
                    self.automation
                        .CompareElements(&enclosing, &candidate.element)
                })
                .map(|equal| equal.as_bool())
            })?
            .is_none()
            {
                return Some(None);
            }
            self.final_tree_check()?;
            let value = selection_read!(sensitive & focused, unsafe {
                range.GetText(MAX_SELECTION_BYTES as i32 + 1)
            });
            let prefix = selection_read!(interface IUIAutomationTextRange, |pointer| unsafe {
                (Interface::vtable(&pattern).DocumentRange)(pattern.as_raw(), pointer)
            });
            selection_read!(unsafe {
                prefix.MoveEndpointByRange(
                    TextPatternRangeEndpoint_End,
                    &range,
                    TextPatternRangeEndpoint_Start,
                )
            });
            let enclosing = selection_read!(unsafe { prefix.GetEnclosingElement() });
            if find_observed(subtree, |candidate| {
                self.read(|| unsafe {
                    self.automation
                        .CompareElements(&enclosing, &candidate.element)
                })
                .map(|equal| equal.as_bool())
            })?
            .is_none()
            {
                return Some(None);
            }
            let before = selection_read!(sensitive & focused, unsafe {
                prefix.GetText(MAX_BYTES as i32 + 1)
            });
            if before.len() > MAX_BYTES {
                return Some(None);
            }
            self.same_ancestry(&focused, &ancestors)?;
            let fresh = selection_read!(interface IUIAutomationTextRangeArray, |pointer| unsafe {
                (Interface::vtable(&pattern).GetSelection)(pattern.as_raw(), pointer)
            });
            if selection_read!(unsafe { fresh.Length() }) != 1 {
                return None;
            }
            let fresh = selection_read!(unsafe { fresh.GetElement(0) });
            for endpoint in [TextPatternRangeEndpoint_Start, TextPatternRangeEndpoint_End] {
                if selection_read!(unsafe { range.CompareEndpoints(endpoint, &fresh, endpoint) })
                    != 0
                {
                    return None;
                }
            }
            let final_focus = selection_read!(interface IUIAutomationElement, |pointer| unsafe {
                (Interface::vtable(&self.automation).base__.GetFocusedElement)(
                    self.automation.as_raw(), pointer,
                )
            });
            self.same_element(Some(&final_focus), Some(&focused))?;
            self.final_tree_check()?;
            let upstream_truncated = value.len() > MAX_SELECTION_BYTES;
            let value = text_prefix(&value);
            let mut end = value.len().min(MAX_SELECTION_BYTES);
            while !value.is_char_boundary(end) {
                end -= 1;
            }
            let selected_text = value[..end].to_owned();
            let truncated = upstream_truncated || end < value.len();
            Some(Some(Selection {
                selected_text: Some(selected_text),
                truncated,
                start: before.len() as u32,
                length: (!upstream_truncated).then_some(value.encode_utf16().count() as u32),
            }))
        }

        fn observed_index(&self, element: &IUIAutomationElement) -> Option<Option<usize>> {
            for (index, node) in self.observed.iter().enumerate() {
                if self
                    .read(|| unsafe { self.automation.CompareElements(element, &node.element) })?
                    .as_bool()
                {
                    return Some(Some(index));
                }
            }
            Some(None)
        }

        fn observed_parent(&self, index: usize) -> Option<Option<usize>> {
            let node = self.observed.get(index)?;
            if node.depth == 0 {
                return Some(None);
            }
            let parent = (0..index)
                .rev()
                .find(|previous| self.observed[*previous].depth < node.depth)?;
            if self.observed[parent].depth + 1 != node.depth {
                return None;
            }
            self.same_element(node.parent.as_ref(), Some(&self.observed[parent].element))?;
            Some(Some(parent))
        }

        fn item_pattern(
            &self,
            element: &IUIAutomationElement,
        ) -> Option<Option<IUIAutomationSelectionPattern>> {
            self.read(|| {
                optional_selection_interface::<IUIAutomationSelectionPattern>(|pointer| unsafe {
                    (Interface::vtable(element).GetCurrentPatternAs)(
                        element.as_raw(),
                        UIA_SelectionPatternId,
                        &IUIAutomationSelectionPattern::IID,
                        pointer,
                    )
                })
            })
        }

        fn item_members(
            &self,
            owner: usize,
            pattern: &IUIAutomationSelectionPattern,
        ) -> Option<Option<(Vec<usize>, Vec<SelectedItem>)>> {
            let array = self.read(|| unsafe { pattern.GetCurrentSelection() })?;
            let count = self.read(|| unsafe { array.Length() })?;
            let mut indexes = Vec::new();
            let mut runtime_ids = Vec::new();
            let items = optional_item_members(count, |position| {
                let element = self.read(|| unsafe { array.GetElement(position) })?;
                let index = self.observed_index(&element)??;
                if indexes.contains(&index) {
                    return None;
                }
                let node = &self.observed[index];
                let (visible, kind, framework) = self.state(&element)?;
                if !visible || node.wrapper || node.identity.as_ref() != Some(&(kind, framework)) {
                    return None;
                }
                let runtime_id = self.runtime_id(&element)?;
                if runtime_ids.contains(&runtime_id) {
                    return None;
                }
                runtime_ids.push(runtime_id.clone());
                indexes.push(index);
                let role = selected_item_role(kind.0);
                let member = self.read(|| {
                    optional_selection_interface::<IUIAutomationSelectionItemPattern>(
                        |pointer| unsafe {
                            (Interface::vtable(&element).GetCurrentPatternAs)(
                                element.as_raw(),
                                UIA_SelectionItemPatternId,
                                &IUIAutomationSelectionItemPattern::IID,
                                pointer,
                            )
                        },
                    )
                })?;
                let Some(member) = member else {
                    return Some(None);
                };
                if !self
                    .read(|| unsafe { member.CurrentIsSelected() })?
                    .as_bool()
                {
                    return None;
                }
                let container = self.read(|| unsafe { member.CurrentSelectionContainer() })?;
                self.same_element(Some(&container), Some(&self.observed[owner].element))?;
                Some(role.map(|role| SelectedItem {
                    runtime_id,
                    role: role.into(),
                    value: None,
                }))
            })?;
            let Some(items) = items else {
                let nodes = self
                    .observed
                    .iter()
                    .map(|node| {
                        (
                            node.depth,
                            node.visible && !node.wrapper && node.identity.is_some(),
                        )
                    })
                    .collect::<Vec<_>>();
                // Capability absence cannot hide a rejected selected subtree.
                selected_subtrees(&nodes, owner, &indexes)?;
                return Some(None);
            };
            Some(Some((indexes, items)))
        }

        fn item_document(&self, owner: usize) -> Option<Vec<i32>> {
            let mut index = Some(owner);
            while let Some(current) = index {
                for document in &self.documents {
                    if self
                        .read(|| unsafe {
                            self.automation
                                .CompareElements(&document.element, &self.observed[current].element)
                        })?
                        .as_bool()
                    {
                        return self.runtime_id(&document.element);
                    }
                }
                index = self.observed_parent(current)?;
            }
            if self.browser || self.web_seen || !self.domains.is_empty() {
                return None;
            }
            Some(Vec::new())
        }

        fn collect_selected_items(&self) -> Option<Option<SelectedItems>> {
            if !self.observed.iter().any(|node| {
                node.identity
                    .as_ref()
                    .is_some_and(|(kind, _)| matches!(kind.0, 50008 | 50023 | 50028 | 50036))
            }) {
                return Some(None);
            }
            let Some(focused) = self.input_focus()? else {
                return Some(None);
            };
            let Some(mut owner) = self.observed_index(&focused)? else {
                return Some(None);
            };
            let pattern = loop {
                let node = &self.observed[owner];
                if !node.visible || node.wrapper {
                    return None;
                }
                if node
                    .identity
                    .as_ref()
                    .is_some_and(|(kind, _)| matches!(kind.0, 50008 | 50023 | 50028 | 50036))
                    && let Some(pattern) = self.item_pattern(&node.element)?
                {
                    break pattern;
                }
                let Some(parent) = self.observed_parent(owner)? else {
                    return Some(None);
                };
                owner = parent;
            };
            let owner_runtime_id = self.runtime_id(&self.observed[owner].element)?;
            let document_runtime_id = self.item_document(owner)?;
            let Some((indexes, items)) = self.item_members(owner, &pattern)? else {
                return Some(None);
            };
            let nodes = self
                .observed
                .iter()
                .map(|node| {
                    (
                        node.depth,
                        node.visible && !node.wrapper && node.identity.is_some(),
                    )
                })
                .collect::<Vec<_>>();
            selected_subtrees(&nodes, owner, &indexes)?;
            if items.iter().any(|item| {
                item.runtime_id == owner_runtime_id || item.runtime_id == document_runtime_id
            }) {
                return None;
            }
            // Whole membership and selected subtrees pass before any item label.
            self.final_tree_check()?;
            let witness = SelectedItems {
                focused,
                owner,
                indexes,
                selection: ItemSelection {
                    owner_runtime_id,
                    document_runtime_id,
                    items,
                },
            };
            self.final_selected_items_check(&witness)?;
            Some(Some(witness))
        }

        fn sample_selected_items(&self, witness: &mut SelectedItems) -> Option<()> {
            self.final_selected_items_check(witness)?;
            self.final_tree_check()?;
            let nodes = self
                .observed
                .iter()
                .map(|node| {
                    (
                        node.depth,
                        node.visible && !node.wrapper && node.identity.is_some(),
                    )
                })
                .collect::<Vec<_>>();
            let subtrees = selected_subtrees(&nodes, witness.owner, &witness.indexes)?;
            let items = &mut witness.selection.items;
            let item_budget = (MAX_SELECTION_BYTES - 2 - items.len()) / items.len().max(1);
            let sources = (0..self.documents.len()).collect::<Vec<_>>();
            for (item, subtree) in items.iter_mut().zip(subtrees) {
                if !self.policy.capture_text {
                    continue;
                }
                let mut sample = String::new();
                for index in subtree {
                    let node = &self.observed[index];
                    if node.first_child.is_some()
                        || !node
                            .identity
                            .as_ref()
                            .is_some_and(|(kind, _)| *kind == UIA_TextControlTypeId)
                    {
                        continue;
                    }
                    let mut ancestors = Vec::new();
                    let mut parent = self.observed_parent(index)?;
                    while let Some(index) = parent {
                        ancestors.push(self.observed[index].element.clone());
                        parent = self.observed_parent(index)?;
                    }
                    ancestors.reverse();
                    let current = || {
                        self.leaf_current(&node.element, &ancestors, &sources)?;
                        let (visible, kind, framework) = self.state(&node.element)?;
                        if !visible
                            || node.identity.as_ref() != Some(&(kind, framework))
                            || self.neighbor(&node.element, true)?.is_some()
                        {
                            return None;
                        }
                        let parent =
                            self.read(|| unsafe { self.walker.GetParentElement(&node.element) })?;
                        self.same_element(Some(&parent), node.parent.as_ref())
                    };
                    let name = read_selected_label(current, || {
                        self.sensitive(&node.element, || unsafe { node.element.CurrentName() })
                    })?;
                    let name = text_prefix(&name);
                    let clipped = append_text(&mut sample, &name, item_budget.min(1024));
                    if clipped || sample.len() >= item_budget.min(1024) {
                        break;
                    }
                }
                item.value = sampled_item_value(&item.role, &sample, item_budget);
            }
            self.final_selected_items_check(witness)
        }

        fn final_selected_items_check(&self, witness: &SelectedItems) -> Option<()> {
            let focused = self.input_focus()??;
            self.same_element(Some(&focused), Some(&witness.focused))?;
            let owner_runtime_id = self.runtime_id(&self.observed[witness.owner].element)?;
            let document_runtime_id = self.item_document(witness.owner)?;
            let pattern = self.item_pattern(&self.observed[witness.owner].element)??;
            let (indexes, items) = self.item_members(witness.owner, &pattern)??;
            if indexes != witness.indexes
                || !same_item_members(
                    &witness.selection,
                    &ItemSelection {
                        owner_runtime_id,
                        document_runtime_id,
                        items,
                    },
                )
            {
                return None;
            }
            self.target.current()
        }

        fn native_edit_selection(
            &self,
            focused: &IUIAutomationElement,
        ) -> Option<Option<Selection>> {
            let (visible, kind, framework) = self.state(focused)?;
            if !visible
                || kind != UIA_EditControlTypeId
                || !matches!(framework.as_str(), "WinForm" | "Win32")
                || self.web_seen
            {
                return Some(None);
            }
            let Some(node) = find_observed(&self.observed, |node| {
                self.read(|| unsafe { self.automation.CompareElements(&node.element, focused) })
                    .map(|same| same.as_bool())
            })?
            else {
                return Some(None);
            };
            if node.first_child.is_some() {
                return Some(None);
            }
            let Some((hwnd, class)) = self.native_edit_window(focused)? else {
                return Some(None);
            };
            if !unsafe { windows::Win32::UI::WindowsAndMessaging::IsWindowUnicode(hwnd) }.as_bool()
            {
                return Some(None);
            }
            let native_current = || self.native_edit_current_window(hwnd, &class, hwnd);
            self.final_tree_check()?;
            let selection = || {
                if !native_current() {
                    return None;
                }
                let mut start = u32::MAX;
                let mut end = u32::MAX;
                // EM_GETSEL is a system-marshalled message. Its DWORD outputs
                // preserve offsets above 65535; the packed return value cannot.
                let result = unsafe {
                    SendMessageTimeoutW(
                        hwnd,
                        0x00b0,
                        WPARAM(&mut start as *mut u32 as usize),
                        LPARAM(&mut end as *mut u32 as isize),
                        SMTO_ABORTIFHUNG | SMTO_BLOCK,
                        100,
                        None,
                    )
                };
                if result.0 == 0 || !native_current() {
                    return None;
                }
                numeric_selection(start, end)?;
                Some((start, end))
            };
            let (start, end) = selection()?;
            let selected = native_selection(start, end, self.policy.capture_text, || {
                // Some Win32 UIA proxies clip ValuePattern to 4096 UTF-16 units.
                // Read its bounded scalar fallback only with text consent.
                if let Some(pattern) = self.value_pattern(focused)? {
                    let value = self.sensitive(focused, || unsafe { pattern.CurrentValue() })?;
                    edit_selection(&value, start as usize, end as usize, |capacity| {
                        self.native_edit_value(focused, hwnd, &class, hwnd, capacity)
                    })
                } else {
                    Some(None)
                }
            })?;
            if selection() != Some((start, end)) || !native_current() {
                return None;
            }
            let current = self.read(|| unsafe { self.automation.GetFocusedElement() })?;
            self.same_element(Some(&current), Some(focused))?;
            self.final_tree_check()?;
            Some(selected)
        }

        fn input_target(&self, allow_uia: bool) -> Option<Option<InputTarget>> {
            match self.native_input_target()? {
                Some(target) => Some(Some(target)),
                None if allow_uia => self.observed_input_target(),
                None => Some(None),
            }
        }

        fn needs_uia_input(&self) -> Option<bool> {
            self.root_current()?;
            if !self.visible(&self.root)? {
                return None;
            }
            let Some(focused) = self.input_focus()? else {
                return Some(false);
            };
            let (visible, role, framework) = self.state(&focused)?;
            Some(
                visible
                    && matches!(framework.as_str(), "WPF" | "Chrome")
                    && (role == UIA_EditControlTypeId || role == UIA_DocumentControlTypeId),
            )
        }

        fn input_focus(&self) -> Option<Option<IUIAutomationElement>> {
            self.read(|| {
                optional_selection_interface::<IUIAutomationElement>(|pointer| unsafe {
                    (Interface::vtable(&self.automation).base__.GetFocusedElement)(
                        self.automation.as_raw(),
                        pointer,
                    )
                })
            })
        }

        fn runtime_id(&self, element: &IUIAutomationElement) -> Option<Vec<i32>> {
            use windows::Win32::System::Ole::{
                SafeArrayDestroy, SafeArrayGetDim, SafeArrayGetElement, SafeArrayGetElemsize,
                SafeArrayGetLBound, SafeArrayGetUBound,
            };
            let array = self.read(|| unsafe { element.GetRuntimeId() })?;
            if array.is_null() {
                return None;
            }
            let value = self.read(|| unsafe {
                if SafeArrayGetDim(array) != 1 || SafeArrayGetElemsize(array) != 4 {
                    return Err(windows::core::Error::from_hresult(E_NOINTERFACE));
                }
                let start = SafeArrayGetLBound(array, 1)?;
                let end = SafeArrayGetUBound(array, 1)?;
                let length = i64::from(end) - i64::from(start) + 1;
                if !(1..=32).contains(&length) {
                    return Err(windows::core::Error::from_hresult(E_NOINTERFACE));
                }
                let mut values = Vec::with_capacity(length as usize);
                for index in start..=end {
                    let mut value = 0i32;
                    SafeArrayGetElement(array, &index, (&mut value as *mut i32).cast())?;
                    values.push(value);
                }
                Ok(values)
            });
            let released = unsafe { SafeArrayDestroy(array) }.is_ok();
            released.then_some(value).flatten()
        }

        fn observed_input_target(&self) -> Option<Option<InputTarget>> {
            let thread =
                unsafe { GetWindowThreadProcessId(HWND(self.target.hwnd as *mut _), None) };
            let host = || {
                let mut info = GUITHREADINFO {
                    cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
                    ..Default::default()
                };
                unsafe { GetGUIThreadInfo(thread, &mut info) }.ok()?;
                if info.hwndFocus.is_invalid()
                    || info.flags.0 & 0x1e != 0
                    || info.hwndActive.0 as usize != self.target.hwnd
                    || unsafe { GetAncestor(info.hwndFocus, GA_ROOT) }.0 as usize
                        != self.target.hwnd
                {
                    return None;
                }
                let mut pid = 0;
                unsafe { GetWindowThreadProcessId(info.hwndFocus, Some(&mut pid)) };
                (pid == self.target.pid).then_some(info.hwndFocus)
            };
            let hwnd = host()?;
            let Some(focused) = self.input_focus()? else {
                return Some(None);
            };
            let (visible, role, framework) = self.state(&focused)?;
            // WinUI/XAML needs an external-provider fixture before admission.
            // A framework label alone does not establish document ownership.
            if !visible || !matches!(framework.as_str(), "WPF" | "Chrome") {
                return Some(None);
            }
            let role = if role == UIA_EditControlTypeId {
                "AXTextField"
            } else if role == UIA_DocumentControlTypeId {
                "AXDocument"
            } else {
                return Some(None);
            };
            if !self
                .read(|| unsafe { focused.CurrentHasKeyboardFocus() })?
                .as_bool()
            {
                return None;
            }
            let Some(node) = find_observed(&self.observed, |node| {
                self.read(|| unsafe { self.automation.CompareElements(&focused, &node.element) })
                    .map(|same| same.as_bool())
            })?
            else {
                return Some(None);
            };
            if !node.visible || node.wrapper {
                return Some(None);
            }
            let runtime_id = self.runtime_id(&focused)?;
            let mut current = focused.clone();
            let mut document = None;
            for depth in 0..=MAX_DEPTH {
                if !self.visible(&current)? {
                    return None;
                }
                if document.is_none()
                    && find_observed(&self.documents, |document| {
                        self.read(|| unsafe {
                            self.automation.CompareElements(&current, &document.element)
                        })
                        .map(|same| same.as_bool())
                    })?
                    .is_some()
                {
                    document = Some(current.clone());
                }
                if self
                    .read(|| unsafe { self.automation.CompareElements(&current, &self.root) })?
                    .as_bool()
                {
                    break;
                }
                if depth == MAX_DEPTH {
                    return None;
                }
                current = self.read(|| unsafe { self.walker.GetParentElement(&current) })?;
            }
            if (self.browser || self.web_seen) && document.is_none() {
                return None;
            }
            let document = document.unwrap_or_else(|| self.root.clone());
            let document_runtime_id = self.runtime_id(&document)?;
            self.final_tree_check()?;
            let final_focus = self.read(|| unsafe { self.automation.GetFocusedElement() })?;
            self.same_element(Some(&focused), Some(&final_focus))?;
            if host() != Some(hwnd)
                || self.runtime_id(&final_focus)? != runtime_id
                || self.runtime_id(&document)? != document_runtime_id
            {
                return None;
            }
            Some(Some(InputTarget {
                hwnd: hwnd.0 as u64,
                role: role.into(),
                uia: Some(crate::model::UiaTarget {
                    runtime_id,
                    document_runtime_id,
                }),
            }))
        }

        fn native_input_target(&self) -> Option<Option<InputTarget>> {
            if self.browser || self.web_seen {
                return Some(None);
            }
            let thread =
                unsafe { GetWindowThreadProcessId(HWND(self.target.hwnd as *mut _), None) };
            let mut info = GUITHREADINFO {
                cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
                ..Default::default()
            };
            unsafe { GetGUIThreadInfo(thread, &mut info) }.ok()?;
            let hwnd = info.hwndFocus;
            if hwnd.is_invalid() || hwnd.0 as usize == self.target.hwnd {
                return Some(None);
            }
            if unsafe { GetAncestor(hwnd, GA_ROOT) }.0 as usize != self.target.hwnd {
                return None;
            }
            let mut pid = 0;
            unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
            if pid != self.target.pid {
                return None;
            }
            let mut class = [0u16; 128];
            let length = unsafe { GetClassNameW(hwnd, &mut class) } as usize;
            if length == 0 {
                return None;
            }
            let class = String::from_utf16(&class[..length]).ok()?;
            let Some(focused) = self.input_focus()? else {
                return Some(None);
            };
            let (visible, role, framework) = self.state(&focused)?;
            if !visible || !matches!(framework.as_str(), "WinForm" | "Win32") {
                return Some(None);
            }
            let Some(role) = crate::input::native_input_role(&class, role.0) else {
                return Some(None);
            };
            if self.read(|| unsafe { focused.CurrentNativeWindowHandle() })? != hwnd
                || !self.native_edit_current_window(hwnd, &class, hwnd)
            {
                return None;
            }
            let Some(node) = find_observed(&self.observed, |node| {
                self.read(|| unsafe { self.automation.CompareElements(&focused, &node.element) })
                    .map(|same| same.as_bool())
            })?
            else {
                return Some(None);
            };
            if !node.visible || node.wrapper || node.first_child.is_some() {
                return Some(None);
            }
            Some(Some(InputTarget {
                hwnd: hwnd.0 as u64,
                role: role.into(),
                uia: None,
            }))
        }

        fn browser_document(&self) -> Option<BrowserScope> {
            let focused = self.read(|| unsafe { self.automation.GetFocusedElement() })?;
            let mut current = focused.clone();
            let mut chain: Vec<IUIAutomationElement> = Vec::new();
            let mut document: Option<usize> = None;
            // Browser chrome can be deeper than the document text tree. This
            // walk reads only the focused element's bounded ownership chain.
            for _ in 0..32 {
                let (visible, kind, _) = self.state(&current)?;
                if !visible {
                    return None;
                }
                if self
                    .read(|| unsafe { self.automation.CompareElements(&current, &self.root) })?
                    .as_bool()
                {
                    let Some(index) = document else {
                        self.prime_browser_document();
                        return None;
                    };
                    let element = chain[index].clone();
                    let ancestors = std::iter::once(self.root.clone())
                        .chain(chain[index + 1..].iter().rev().cloned())
                        .collect::<Vec<_>>();
                    self.same_ancestry(&element, &ancestors)?;
                    // The outermost Document is the admission boundary; an
                    // embedded frame must never hide its parent page's origin.
                    return Some(BrowserScope {
                        document: element,
                        ancestors,
                        focused,
                    });
                }
                if kind == UIA_DocumentControlTypeId {
                    document = Some(chain.len());
                }
                chain.push(current.clone());
                current = self.read(|| unsafe { self.walker.GetParentElement(&current) })?;
            }
            None
        }

        fn prime_browser_document(&self) {
            let mut state = ContentWindows {
                pid: self.target.pid,
                visited: 0,
                handles: Vec::new(),
            };
            unsafe {
                let _ = EnumChildWindows(
                    Some(HWND(self.target.hwnd as *mut _)),
                    Some(find_content),
                    LPARAM(&mut state as *mut ContentWindows as isize),
                );
            }
            if state.visited > 256 || state.handles.len() != 1 {
                return;
            }
            let hwnd = state.handles[0];
            let mut pid = 0;
            unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
            if pid != self.target.pid
                || unsafe { GetAncestor(hwnd, GA_ROOT) }.0 as usize != self.target.hwnd
            {
                return;
            }
            let Some(root) =
                self.read(|| unsafe { self.automation.ElementFromHandle(state.handles[0]) })
            else {
                return;
            };
            // Ordinary property reads initialize Chromium's asynchronous AX
            // tree. They collect no names or values; a later worker must prove
            // focused document ancestry and policy before reading any body.
            if self.visible(&root) != Some(true) {
                return;
            }
            let _ = self.read(|| unsafe { root.CurrentControlType() });
            if let Some(Some(child)) = self.neighbor(&root, true)
                && self.visible(&child) == Some(true)
            {
                let _ = self.read(|| unsafe { child.CurrentControlType() });
            }
        }

        fn walk(
            &mut self,
            element: &IUIAutomationElement,
            ancestors: &mut Vec<IUIAutomationElement>,
            sources: &mut Vec<usize>,
            web_context: bool,
        ) -> Option<()> {
            if self.nodes == MAX_NODES || ancestors.len() > MAX_DEPTH {
                return None;
            }
            self.nodes += 1;
            let (visible, kind, framework) = self.state(element)?;
            let observed = self.observed.len();
            self.observed.push(Observed {
                element: element.clone(),
                depth: ancestors.len(),
                parent: ancestors.last().cloned(),
                first_child: None,
                next_sibling: None,
                visible,
                identity: None,
                wrapper: false,
            });
            if !visible {
                if !ancestors.is_empty() {
                    self.observed[observed].next_sibling = self.neighbor(element, false)?;
                }
                return Some(());
            }
            self.observed[observed].identity = Some((kind, framework.clone()));
            let web_context = web_context || web_framework(&framework);
            self.web_seen |= web_context;
            let wrapper = kind == UIA_DocumentControlTypeId
                && !sources.is_empty()
                && self.document_wrapper(element)?;
            self.observed[observed].wrapper = wrapper;
            let is_document = kind == UIA_DocumentControlTypeId && !wrapper;
            if is_document {
                let source = self.source(element, web_context)?;
                if let Some(domain) = source.domain() {
                    if !self.policy.permits_domain(domain) {
                        return None;
                    }
                    self.domains.insert(domain.to_owned());
                }
                sources.push(self.documents.len());
                self.documents.push(Document {
                    element: element.clone(),
                    source,
                    web_context,
                });
            }
            let web_context = web_context
                || sources.last().is_some_and(|index| {
                    !matches!(
                        self.documents[*index].source,
                        DocumentSource::Native | DocumentSource::NativeAction
                    )
                });
            let first = self.neighbor(element, true)?;
            self.observed[observed].first_child = first.clone();
            if first.is_some()
                && kind == UIA_EditControlTypeId
                && framework == "WPF"
                && !web_context
                && self.policy.capture_text
                && self.read(|| unsafe { element.CurrentClassName() })? == "TextBox"
            {
                // WPF TextBox owns its scalar value despite having ScrollViewer
                // template children. Defer it until the whole window passes
                // provenance/password checks; never aggregate a parent text range.
                self.native_scalars.push(NativeScalar {
                    element: element.clone(),
                    ancestors: ancestors.clone(),
                    native_window: None,
                    text_offset: self.text.len(),
                });
            }
            let permitted_leaf = first.is_none()
                && !wrapper
                && (!web_context || !sources.is_empty())
                && self.policy.capture_text
                && self.text.len() < self.text_limit;
            if first.is_none() && self.policy.capture_text && self.text.len() >= self.text_limit {
                self.text_truncated = true;
            }
            if permitted_leaf {
                self.leaf_current(element, ancestors, sources)?;
                if is_document {
                    if sources.last().is_some_and(|index| {
                        self.documents[*index].source == DocumentSource::Native
                    }) {
                        let (value, truncated) = self.native_text(element, ancestors, sources)?;
                        self.text_truncated |= truncated;
                        self.text_truncated |= append_text(&mut self.text, &value, self.text_limit);
                    } else if sources.last().is_some_and(|index| {
                        self.documents[*index].source == DocumentSource::NativeAction
                    }) {
                        if let Some(value) = self.rich_visible_text(element)? {
                            append_text(&mut self.text, &value, self.text_limit);
                        }
                        // Visible ranges and bounded explicit runs cannot prove
                        // whole RichEdit text coverage, even if the prefix fits.
                        self.text_truncated = true;
                    }
                } else {
                    let name = self.sensitive(element, || unsafe { element.CurrentName() })?;
                    self.text_truncated |= name.len() > MAX_BYTES;
                    self.text_truncated |=
                        append_text(&mut self.text, &text_prefix(&name), self.text_limit);
                    if kind == UIA_EditControlTypeId && self.text.len() < self.text_limit {
                        // Only regular leaf edits use ValuePattern. Never ask a
                        // container, link or Document for a subtree text value.
                        self.leaf_current(element, ancestors, sources)?;
                        if !web_context
                            && let Some((value, truncated)) = self.native_visible_text(
                                element,
                                self.text_limit.saturating_sub(self.text.len()),
                            )?
                        {
                            self.text_truncated |= truncated;
                            self.text_truncated |=
                                append_text(&mut self.text, &value, self.text_limit);
                        } else if !web_context
                            && let Some((hwnd, class)) = self.native_edit_window(element)?
                        {
                            // Standard Edit owns this scalar; its UIA proxy can
                            // clip it. Read only after the complete tree passes.
                            self.native_scalars.push(NativeScalar {
                                element: element.clone(),
                                ancestors: ancestors.clone(),
                                native_window: Some((hwnd, class)),
                                text_offset: self.text.len(),
                            });
                        } else if let Some(pattern) = self.value_pattern(element)? {
                            let value =
                                self.sensitive(element, || unsafe { pattern.CurrentValue() })?;
                            if value != name {
                                self.text_truncated |= value.len() > MAX_BYTES;
                                self.text_truncated |= append_text(
                                    &mut self.text,
                                    &text_prefix(&value),
                                    self.text_limit,
                                );
                            }
                        }
                    }
                }
                self.leaf_current(element, ancestors, sources)?;
            }
            if let Some(mut child) = first {
                if ancestors.len() == MAX_DEPTH {
                    return None;
                }
                ancestors.push(element.clone());
                loop {
                    let child_index = self.observed.len();
                    self.walk(&child, ancestors, sources, web_context)?;
                    let next = self.neighbor(&child, false)?;
                    self.same_element(
                        next.as_ref(),
                        self.observed[child_index].next_sibling.as_ref(),
                    )?;
                    match next {
                        Some(sibling) => child = sibling,
                        None => break,
                    }
                }
                ancestors.pop();
            }
            if is_document {
                self.sources_current(sources)?;
                sources.pop();
            }
            if !ancestors.is_empty() {
                self.observed[observed].next_sibling = self.neighbor(element, false)?;
            }
            Some(())
        }
    }

    fn bounded_string(value: &BSTR, limit: usize) -> Option<String> {
        if value.len() > limit {
            return None;
        }
        let string = String::from_utf16(value).ok()?;
        (string.len() <= limit).then_some(string)
    }

    fn identity(target: &Target) -> Option<(String, String, Option<String>)> {
        let mut path = [0u16; 32768];
        let mut length = path.len() as u32;
        target.current()?;
        let read_application = || {
            super::super::applications::process_application_user_model_id(target.process.0)
                .inspect_err(|_| target.failures.provider_failed.set(true))
                .ok()
        };
        let application = read_application()?;
        let result = unsafe {
            QueryFullProcessImageNameW(
                target.process.0,
                PROCESS_NAME_WIN32,
                PWSTR(path.as_mut_ptr()),
                &mut length,
            )
        };
        target.current()?;
        result.ok()?;
        let full = String::from_utf16(path.get(..length as usize)?).ok()?;
        let filename = full.rsplit(['\\', '/']).next()?.to_lowercase();
        let stem = filename.strip_suffix(".exe")?;
        if stem.is_empty() || stem.len() > 256 || excluded_app(stem) {
            return None;
        }
        if read_application()? != application {
            return None;
        }
        target.current()?;
        Some((format!("win32.{stem}"), stem.to_owned(), application))
    }

    /// Runs UIA on a windowless MTA, retaining no COM objects outside that thread.
    /// Privacy, stale-target and unsupported-pattern suppression returns `Ok(None)`;
    /// provider failures and capture timeouts return static errors without UI details.
    pub fn capture(
        home: &Path,
        hwnd: usize,
        pid: u32,
        source_id: String,
    ) -> Result<Option<Snapshot>> {
        if hwnd == 0
            || pid == 0
            || source_id.len() != 36
            || !uuid::Uuid::parse_str(&source_id).is_ok_and(|id| !id.is_nil())
        {
            return Err("invalid_snapshot_target".into());
        }
        let home = home.to_owned();
        std::thread::Builder::new()
            .name("history-uia-snapshot".into())
            .spawn(move || capture_mta(&home, hwnd, pid, source_id, false, None))?
            .join()
            .map_err(|_| "uia_worker_panicked")?
    }

    /// Lease worker entry: called on its owning MTA with subscriptions alive.
    pub fn capture_for_input(
        home: &Path,
        hwnd: usize,
        pid: u32,
        source_id: String,
    ) -> Result<Option<Snapshot>> {
        if hwnd == 0
            || pid == 0
            || source_id.len() != 36
            || !uuid::Uuid::parse_str(&source_id).is_ok_and(|id| !id.is_nil())
        {
            return Err("invalid_snapshot_target".into());
        }
        capture_mta(home, hwnd, pid, source_id, true, None)
    }

    type PrepareInput<'a> =
        dyn FnMut(&IUIAutomation2, &IUIAutomationElement, bool) -> Result<bool> + 'a;

    /// Initial worker observation. Preparation sees only admitted metadata and
    /// precedes selected-item label sampling within the original capture limit.
    pub fn capture_prepared(
        home: &Path,
        hwnd: usize,
        pid: u32,
        source_id: String,
        prepare: &mut PrepareInput<'_>,
    ) -> Result<Option<Snapshot>> {
        if hwnd == 0
            || pid == 0
            || source_id.len() != 36
            || !uuid::Uuid::parse_str(&source_id).is_ok_and(|id| !id.is_nil())
        {
            return Err("invalid_snapshot_target".into());
        }
        capture_mta(home, hwnd, pid, source_id, false, Some(prepare))
    }

    fn capture_mta(
        home: &Path,
        hwnd: usize,
        pid: u32,
        source_id: String,
        allow_uia_input: bool,
        mut prepare: Option<&mut PrepareInput<'_>>,
    ) -> Result<Option<Snapshot>> {
        let deadline = Instant::now() + TIME_LIMIT;
        let policy = Policy::load(home)?;
        if !super::super::interactive_desktop() || super::super::foreground() != Some((hwnd, pid)) {
            return Ok(None);
        }
        let Ok(process) = (unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                false,
                pid,
            )
        }) else {
            return Ok(None);
        };
        let target = Target {
            hwnd,
            pid,
            process: Process(process),
            deadline,
            failures: CaptureFailures::default(),
        };
        if unsafe { GetProcessId(target.process.0) } != pid {
            return Ok(None);
        }
        let Some((app_id, app_name, application_user_model_id)) = identity(&target) else {
            return target.failures.finish(None);
        };
        if !policy.permits_application(&app_id, application_user_model_id.as_deref()) {
            return Ok(None);
        }
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .map_err(|_| "uia_initialization_failed")?;
        let _apartment = Apartment;
        let automation: IUIAutomation2 =
            unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) }
                .map_err(|_| "uia_automation_unavailable")?;
        unsafe {
            automation
                .SetConnectionTimeout(PROVIDER_TIMEOUT_MS)
                .map_err(|_| "uia_timeout_configuration_failed")?;
            automation
                .SetTransactionTimeout(PROVIDER_TIMEOUT_MS)
                .map_err(|_| "uia_timeout_configuration_failed")?;
        }
        let mut preparation_error = None;
        let snapshot = (|| {
            let root =
                target.read(|| unsafe { automation.ElementFromHandle(HWND(hwnd as *mut _)) })?;
            let walker = target.read(|| unsafe { automation.RawViewWalker() })?;
            let (identity_cache, visibility_cache, state_cache, rich_state_cache) =
                target.read(|| unsafe {
                    let identity = automation.CreateCacheRequest()?;
                    identity.SetTreeScope(TreeScope_Element)?;
                    identity.AddProperty(UIA_NativeWindowHandlePropertyId)?;
                    identity.AddProperty(UIA_ProcessIdPropertyId)?;
                    let visibility = automation.CreateCacheRequest()?;
                    visibility.SetTreeScope(TreeScope_Element)?;
                    visibility.AddProperty(UIA_IsPasswordPropertyId)?;
                    visibility.AddProperty(UIA_IsOffscreenPropertyId)?;
                    visibility.AddProperty(UIA_ProcessIdPropertyId)?;
                    let state = visibility.Clone()?;
                    state.AddProperty(UIA_ControlTypePropertyId)?;
                    state.AddProperty(UIA_FrameworkIdPropertyId)?;
                    let rich_state = state.Clone()?;
                    rich_state.AddProperty(UIA_NativeWindowHandlePropertyId)?;
                    Ok((identity, visibility, state, rich_state))
                })?;
            let browser = browser_app(&app_name);
            let mut capture = Capture {
                target: &target,
                automation,
                root: root.clone(),
                identity_cache,
                visibility_cache,
                state_cache,
                rich_state_cache,
                walker,
                policy: &policy,
                documents: Vec::new(),
                observed: Vec::new(),
                domains: BTreeSet::new(),
                browser,
                web_seen: false,
                nodes: 0,
                text: String::new(),
                text_truncated: false,
                text_limit: MAX_BYTES,
                browser_scope: None,
                native_scalars: Vec::new(),
                visible_text: Vec::new(),
            };
            let mut prepared = false;
            let allow_uia_input = if let Some(prepare) = prepare.as_mut() {
                let needed = capture.needs_uia_input()?;
                if needed {
                    prepared = true;
                    let allowed = prepared_input(needed, false, |subscribe| {
                        match prepare(&capture.automation, &root, subscribe) {
                            Ok(ready) => ready,
                            Err(error) => {
                                preparation_error = Some(error);
                                false
                            }
                        }
                    });
                    if preparation_error.is_some() {
                        return None;
                    }
                    allowed
                } else {
                    false
                }
            } else {
                allow_uia_input
            };
            let title = capture.sensitive(&root, || unsafe { root.CurrentName() })?;
            let title = bounded_string(&title, MAX_TITLE_BYTES)?;
            if private_title(&title) {
                return None;
            }
            capture.text_limit = MAX_BYTES.saturating_sub(
                title.len()
                    + app_id.len()
                    + app_name.len()
                    + source_id.len()
                    + application_user_model_id.as_ref().map_or(0, String::len),
            );
            if browser {
                let scope = capture.browser_document()?;
                let document = scope.document.clone();
                capture.browser_scope = Some(scope);
                capture.scope_current()?;
                capture.walk(&document, &mut Vec::new(), &mut Vec::new(), true)?;
            } else {
                capture.walk(&root, &mut Vec::new(), &mut Vec::new(), false)?;
            }
            if (capture.browser || capture.web_seen)
                && !capture.documents.iter().any(|document| {
                    !matches!(
                        document.source,
                        DocumentSource::Native | DocumentSource::NativeAction
                    )
                })
            {
                return None;
            }
            capture.final_tree_check()?;
            if !capture.native_scalars.is_empty() {
                capture.collect_native_scalars()?;
                capture.final_tree_check()?;
            }
            let selection = capture.selected_text()?;
            let selected_items = prepared_items(
                capture.collect_selected_items()?,
                |observe_items| {
                    if !prepared && let Some(prepare) = prepare.as_mut() {
                        // The validated selection witness establishes root ownership.
                        // Installing observation subscriptions never grants input.
                        let _ = prepared_input(false, observe_items, |subscribe| {
                            match prepare(&capture.automation, &root, subscribe) {
                                Ok(ready) => ready,
                                Err(error) => {
                                    preparation_error = Some(error);
                                    false
                                }
                            }
                        });
                        if preparation_error.is_some() {
                            return None;
                        }
                    }
                    Some(())
                },
                |witness| capture.sample_selected_items(witness),
            )?;
            let input_target = checked_input_target(
                || capture.input_target(allow_uia_input),
                || {
                    if !capture.visible_text.is_empty() {
                        capture.final_visible_text_check()?;
                    }
                    capture.final_tree_check()
                },
            )?;
            if let Some(scope) = &capture.browser_scope {
                capture.scope_current()?;
                let current = capture.read(|| unsafe { capture.automation.GetFocusedElement() })?;
                capture.same_element(Some(&current), Some(&scope.focused))?;
            }
            let final_title = capture.sensitive(&root, || unsafe { root.CurrentName() })?;
            if bounded_string(&final_title, MAX_TITLE_BYTES)? != title {
                return None;
            }
            if let Some(witness) = &selected_items {
                capture.final_selected_items_check(witness)?;
                capture.final_tree_check()?;
            }
            let item_selection = selected_items.map(|witness| witness.selection);
            let url = capture
                .documents
                .first()
                .and_then(|document| document.source.public_url());
            let metadata_bytes = url.as_ref().map_or(0, String::len)
                + capture.domains.iter().map(String::len).sum::<usize>();
            let metadata_bytes = metadata_bytes
                + selection
                    .as_ref()
                    .and_then(|value| value.selected_text.as_ref())
                    .map_or(0, String::len)
                + match &item_selection {
                    Some(selection) => serde_json::to_vec(selection).ok()?.len(),
                    None => 0,
                };
            let text_limit = capture.text_limit.saturating_sub(metadata_bytes);
            let mut text = String::new();
            let text_truncated =
                append_text(&mut text, &capture.text, text_limit) || capture.text_truncated;
            capture.root_current()?;
            Some(Snapshot {
                app_id,
                application_user_model_id,
                app_name,
                pid,
                window_id: hwnd as u64,
                title,
                url,
                text: (policy.capture_text && !text.is_empty()).then_some(text),
                text_truncated,
                selection,
                item_selection,
                input_target,
                action: None,
                source_id,
                domains: capture.domains.into_iter().collect(),
                secure: false,
                private: false,
                source_known: true,
            })
        })();
        if let Some(error) = preparation_error {
            return Err(error);
        }
        // A settings change cannot resurrect content captured under an old policy.
        let latest = Policy::load(home)?;
        let snapshot = snapshot.filter(|snapshot| {
            super::super::interactive_desktop()
                && target.current().is_some()
                && identity(&target).is_some_and(|(id, name, packaged)| {
                    id == snapshot.app_id
                        && name == snapshot.app_name
                        && packaged == snapshot.application_user_model_id
                })
                && latest.permits_application(
                    &snapshot.app_id,
                    snapshot.application_user_model_id.as_deref(),
                )
                && snapshot
                    .domains
                    .iter()
                    .all(|domain| latest.permits_domain(domain))
                && capture_text_policy_current(policy.capture_text, latest.capture_text, snapshot)
        });
        target.failures.finish(snapshot)
    }

    #[cfg(test)]
    mod selection_tests {
        use super::*;

        #[test]
        fn rich_hidden_attribute_requires_explicit_boolean_false() {
            assert!(nonhidden_attribute(&VARIANT::from(false)));
            for attribute in [VARIANT::from(true), VARIANT::from(0i32), VARIANT::default()] {
                assert!(!nonhidden_attribute(&attribute));
            }
        }

        #[test]
        fn unsupported_optional_selection_preserves_body_but_provider_errors_propagate() {
            assert_eq!(optional_selection(Ok(7)).unwrap(), Some(7));
            for code in [HRESULT(UIA_E_NOTSUPPORTED as i32), E_NOTIMPL, E_NOINTERFACE] {
                assert_eq!(optional_selection::<()>(Err(code.into())).unwrap(), None);
            }
            for code in [
                HRESULT(UIA_E_TIMEOUT as i32),
                HRESULT(0x80040201_u32 as i32), // UIA_E_ELEMENTNOTAVAILABLE
                HRESULT(0x80004005_u32 as i32), // E_FAIL
                HRESULT(0x80004003_u32 as i32), // E_POINTER is not generally absence.
            ] {
                assert_eq!(
                    optional_selection::<()>(Err(code.into()))
                        .unwrap_err()
                        .code(),
                    code
                );
            }
            // A successful null interface is genuine absence, unlike E_POINTER.
            assert!(
                optional_selection_interface::<IUIAutomationElement>(|_| HRESULT(0))
                    .unwrap()
                    .is_none()
            );
        }

        #[test]
        fn unsupported_initial_input_focus_keeps_body_after_final_privacy_check() {
            for code in [
                HRESULT(0),
                HRESULT(UIA_E_NOTSUPPORTED as i32),
                E_NOTIMPL,
                E_NOINTERFACE,
            ] {
                let mut body = crate::model::tests::snapshot();
                let original_text = body.text.clone();
                let missing = optional_selection_interface::<IUIAutomationElement>(|_| code)
                    .expect("unsupported or successful null focus is optional absence");
                let checked = checked_input_target(|| Some(missing), || Some(()));
                body.input_target = checked.unwrap().map(|_| unreachable!("null focus"));
                assert_eq!(body.text, original_text);
                assert!(body.input_target.is_none());
                assert!(
                    checked_input_target(
                        || optional_selection_interface::<IUIAutomationElement>(|_| code).ok(),
                        || None,
                    )
                    .is_none(),
                    "optional focus absence cannot bypass the final privacy fence"
                );
            }
            for code in [
                HRESULT(UIA_E_TIMEOUT as i32),
                HRESULT(0x80040201_u32 as i32),
                HRESULT(0x80004005_u32 as i32),
                HRESULT(0x80004003_u32 as i32),
            ] {
                assert_eq!(
                    optional_selection_interface::<IUIAutomationElement>(|_| code)
                        .unwrap_err()
                        .code(),
                    code
                );
            }
        }

        #[test]
        fn initial_item_pattern_absence_retains_body_but_late_absence_and_errors_reject() {
            for code in [
                HRESULT(0),
                HRESULT(UIA_E_NOTSUPPORTED as i32),
                E_NOTIMPL,
                E_NOINTERFACE,
            ] {
                let read = || {
                    optional_item_members(1, |_| {
                        optional_selection_interface::<IUIAutomationSelectionItemPattern>(|_| code)
                            .ok()
                    })
                };
                let snapshot = crate::model::tests::snapshot();
                let original_body = snapshot.text.clone();
                let initial = (|| {
                    let items = read()?;
                    checked_input_target(|| Some(None::<()>), || Some(()))?;
                    assert!(items.is_none());
                    Some(snapshot)
                })()
                .expect("unsupported initial member pattern is optional, not capture failure");
                assert_eq!(initial.text, original_body);
                assert!(initial.item_selection.is_none());
                assert!(
                    (|| {
                        read()??;
                        Some(())
                    })()
                    .is_none(),
                    "a sampled selection cannot survive a missing final member pattern"
                );
            }
            for code in [
                HRESULT(UIA_E_TIMEOUT as i32),
                HRESULT(0x80040201_u32 as i32),
                HRESULT(0x80004005_u32 as i32),
                HRESULT(0x80004003_u32 as i32),
            ] {
                let result = optional_item_members(2, |position| {
                    optional_selection_interface::<IUIAutomationSelectionItemPattern>(|_| {
                        if position == 0 { E_NOINTERFACE } else { code }
                    })
                    .ok()
                });
                assert!(
                    result.is_none(),
                    "a later provider error cannot become optional absence: {code:?}"
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observation_labels_changed_during_install_are_sampled_after_subscription() {
        let label = Cell::new("before installation");
        let subscribed = Cell::new(false);
        let epochs = Cell::new(0);
        let result = prepared_items(
            Some(String::new()),
            |needed| {
                assert!(needed);
                // The provider changes a label before registration completes.
                label.set("after installation");
                subscribed.set(true);
                Some(())
            },
            |value| {
                *value = read_selected_label(|| Some(()), || Some(label.get().to_owned()))?;
                if subscribed.get() {
                    epochs.set(1);
                }
                Some(())
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(result, "after installation");
        assert_eq!(epochs.get(), 1);
        assert_eq!(
            prepared_items::<String>(
                None,
                |needed| {
                    assert!(!needed);
                    Some(())
                },
                |_| panic!("absent optional selection must not read labels"),
            ),
            Some(None)
        );
        assert!(prepared_items(Some(()), |_| None, |_| panic!("failed preparation")).is_none());
    }

    #[test]
    fn prepared_item_observation_never_grants_list_input_or_requires_optional_capability() {
        for selected_owner in [false, true] {
            for ready in [false, true] {
                let mut requested = None;
                let input = prepared_input(false, selected_owner, |subscribe| {
                    requested = Some(subscribe);
                    ready
                });
                assert_eq!(requested, Some(selected_owner));
                assert!(
                    !input,
                    "List subscriptions are not physical-input admission"
                );
                let target =
                    checked_input_target(|| Some(input.then_some(7)), || Some(())).unwrap();
                assert!(
                    target.is_none(),
                    "optional absence retains the body without an input target"
                );
            }
        }
        assert!(prepared_input(true, false, |subscribe| subscribe));
        assert!(!prepared_input(true, false, |_| false));
    }

    #[test]
    fn optional_selected_items_preserve_body_without_claiming_empty_selection() {
        for unsupported in [0, 1] {
            let mut snapshot = crate::model::tests::snapshot();
            let original_body = snapshot.text.clone();
            let mut reads = 0;
            let items = optional_item_members(2, |position| {
                reads += 1;
                let role = selected_item_role(if unsupported == 0 && position == 0 {
                    50025 // An observed Custom control is not a supported selected row.
                } else {
                    50007
                });
                let pattern_available = !(unsupported == 1 && position == 0);
                Some(role.filter(|_| pattern_available))
            });
            let result = (|| {
                let items = items?;
                // Same post-collection fence used by capture_mta, including
                // when the optional selected-items result has no witness.
                checked_input_target(|| Some(None::<()>), || Some(()))?;
                snapshot.item_selection = items.map(|_| unreachable!("unsupported list"));
                Some(snapshot)
            })();
            let retained = result.expect("initial unsupported selection must not drop body");
            assert_eq!(retained.text, original_body);
            assert!(retained.item_selection.is_none());
            assert_eq!(reads, 2, "absence must not hide a later rejected member");
        }
        assert_eq!(
            optional_item_members::<()>(0, |_| panic!("empty")),
            Some(Some(vec![]))
        );
    }

    #[test]
    fn optional_selected_items_do_not_hide_later_errors_or_bounds() {
        let mut reads = 0;
        let result = optional_item_members(2, |position| {
            reads += 1;
            if position == 0 {
                Some(None::<()>)
            } else {
                None // Offscreen, unreadable/private source, or changed membership.
            }
        });
        assert!(result.is_none());
        assert_eq!(reads, 2, "later admission failure must still be evaluated");
        for count in [-1, 33, i32::MAX] {
            assert!(optional_item_members::<()>(count, |_| panic!("out of bounds")).is_none());
        }
        assert_eq!(
            optional_item_members(32, |position| Some(Some(position)))
                .unwrap()
                .unwrap(),
            (0..32).collect::<Vec<_>>()
        );
    }

    #[test]
    fn optional_selected_items_still_require_final_privacy_and_sampled_capability() {
        let private = Cell::new(false);
        let initial = optional_item_members(1, |_| Some(None::<()>));
        assert_eq!(initial, Some(None));
        let rejected = (|| {
            initial?;
            checked_input_target(
                || {
                    private.set(true);
                    Some(None::<()>)
                },
                || (!private.get()).then_some(()),
            )?;
            Some(crate::model::tests::snapshot())
        })();
        assert!(
            rejected.is_none(),
            "optional absence cannot skip the final privacy fence"
        );

        let sampled = read_selected_label(|| Some(()), || Some("admitted sample")).unwrap();
        assert_eq!(sampled, "admitted sample");
        for fresh in [Some(None::<()>), None] {
            let result = (|| {
                // A previously sampled list requires complete membership,
                // exactly as final_selected_items_check's double ? does.
                let members = optional_item_members(1, |_| fresh)??;
                Some((sampled, members))
            })();
            assert!(
                result.is_none(),
                "late missing capability cannot retain sampled content"
            );
        }
    }

    #[test]
    fn selected_label_fences_deny_before_read_and_discard_late_source_or_ancestry_change() {
        for denied_before_read in [true, false] {
            let mut checks = 0;
            let reads = Cell::new(0);
            let sampled = read_selected_label(
                || {
                    checks += 1;
                    (!denied_before_read && checks == 1).then_some(())
                },
                || {
                    reads.set(reads.get() + 1);
                    Some("sensitive leaf")
                },
            );
            assert!(sampled.is_none());
            assert_eq!(reads.get(), usize::from(!denied_before_read));
        }
        assert_eq!(
            read_selected_label(|| Some(()), || Some("admitted leaf")),
            Some("admitted leaf")
        );
        assert!(read_selected_label(|| Some(()), || None::<String>).is_none());
    }

    #[test]
    fn selected_items_reuse_complete_preorder_subtrees_and_reject_outside_or_overlap() {
        // Root, list, row/leaf, row/leaf, unrelated sibling.
        let nodes = [
            (0, true),
            (1, true),
            (2, true),
            (3, true),
            (2, true),
            (3, true),
            (1, true),
        ];
        assert_eq!(
            selected_subtrees(&nodes, 1, &[2, 4]),
            Some(vec![2..4, 4..6])
        );
        assert_eq!(selected_subtrees(&nodes, 1, &[]), Some(vec![]));
        for members in [vec![1], vec![6], vec![7], vec![2, 2], vec![2, 3]] {
            assert!(
                selected_subtrees(&nodes, 1, &members).is_none(),
                "{members:?}"
            );
        }
        for denied in [1, 2, 3, 4, 5] {
            let mut changed = nodes;
            changed[denied].1 = false;
            assert!(selected_subtrees(&changed, 1, &[2, 4]).is_none());
        }
        // A selected grandchild cannot bypass a rejected intermediate container.
        let blocked_path = [(0, true), (1, true), (2, false), (3, true)];
        assert!(selected_subtrees(&blocked_path, 1, &[3]).is_none());
        assert!(selected_subtrees(&[(0, true), (1, true), (3, true)], 1, &[2]).is_none());
    }

    #[test]
    fn selected_items_bound_membership_and_total_subtree_work_without_prefix_acceptance() {
        let mut nodes = vec![(0, true)];
        nodes.extend(std::iter::repeat_n((1, true), 33));
        assert_eq!(
            selected_subtrees(&nodes, 0, &(1..=32).collect::<Vec<_>>())
                .unwrap()
                .len(),
            32
        );
        assert!(selected_subtrees(&nodes, 0, &(1..=33).collect::<Vec<_>>()).is_none());
        let mut subtree = vec![(0, true), (1, true)];
        subtree.extend(std::iter::repeat_n((2, true), 127));
        let ranges = selected_subtrees(&subtree, 0, &[1]).unwrap();
        assert_eq!(ranges.len(), 1);
        assert_eq!(ranges[0], 1..129);
        subtree.push((2, true));
        assert!(selected_subtrees(&subtree, 0, &[1]).is_none());
        assert!(selected_subtrees(&vec![(0, true); MAX_NODES + 1], 0, &[]).is_none());
    }

    #[test]
    fn selected_item_roles_use_observed_types_without_custom_or_document_mapping() {
        for kind in [50007, 50024, 50029] {
            assert_eq!(selected_item_role(kind), Some("AXRow"));
        }
        for kind in [0, 50004, 50020, 50025, 50026, 50030, 50032, 50033] {
            assert_eq!(selected_item_role(kind), None);
        }
    }

    #[test]
    fn selected_item_samples_bound_encoded_json_for_every_member() {
        let count = 32;
        let budget = (8192 - 2 - count) / count;
        let sample = "\u{4e2d}\u{1f4bb}\"\\\n".repeat(400);
        let value = sampled_item_value("AXRow", &sample, budget).unwrap();
        assert!(value.starts_with("Sampled selected-item content:\n"));
        assert!(value.ends_with(" [partial]"));
        let items = (0..count)
            .map(|_| {
                serde_json::json!({
                    "role": "AXRow", "value": value,
                })
            })
            .collect::<Vec<_>>();
        assert_eq!(items.len(), 32);
        assert!(serde_json::to_vec(&items).unwrap().len() <= 8192);
        assert_eq!(sampled_item_value("AXRow", "", budget), None);
        assert_eq!(sampled_item_value("AXRow", &sample, 1), None);
        assert_eq!(
            sampled_item_value("AXRow", "leaf", budget).as_deref(),
            Some("Sampled selected-item content:\nleaf")
        );
    }

    #[test]
    fn selected_item_revalidation_detects_clear_reselect_and_same_label_replacement() {
        use crate::model::{ItemSelection, SelectedItem};
        let original = ItemSelection {
            owner_runtime_id: vec![1, 20],
            document_runtime_id: vec![1, 10],
            items: vec![SelectedItem {
                runtime_id: vec![1, 21],
                role: "AXRow".into(),
                value: Some("same label".into()),
            }],
        };
        let mut fresh = original.clone();
        fresh.items[0].value = None;
        assert!(
            same_item_members(&original, &fresh),
            "private membership ignores label samples"
        );
        fresh.items[0].runtime_id[1] += 1;
        assert!(!same_item_members(&original, &fresh));
        fresh = original.clone();
        fresh.items.clear();
        assert!(!same_item_members(&original, &fresh));
        assert!(same_item_members(&fresh, &fresh));
        assert!(!same_item_members(&fresh, &original));
        for case in 0..3 {
            let mut changed = original.clone();
            match case {
                0 => changed.owner_runtime_id[1] += 1,
                1 => changed.document_runtime_id[1] += 1,
                _ => changed.items[0].role = "AXGroup".into(),
            }
            assert!(!same_item_members(&original, &changed));
        }
    }

    #[test]
    fn metadata_selection_recheck_rejects_item_values_without_discarding_roles() {
        let mut snapshot = crate::model::tests::snapshot().without_content();
        snapshot.item_selection = Some(crate::model::ItemSelection {
            owner_runtime_id: vec![1],
            document_runtime_id: vec![2],
            items: vec![crate::model::SelectedItem {
                runtime_id: vec![3],
                role: "AXRow".into(),
                value: None,
            }],
        });
        assert!(capture_text_policy_current(false, false, &snapshot));
        snapshot.item_selection.as_mut().unwrap().items[0].value = Some("not admitted".into());
        assert!(!capture_text_policy_current(false, false, &snapshot));
        assert!(!capture_text_policy_current(true, false, &snapshot));
        assert!(!capture_text_policy_current(false, true, &snapshot));
        assert!(capture_text_policy_current(true, true, &snapshot));
    }

    #[test]
    fn rich_collapsed_match_omits_unchecked_tail_without_a_text_read() {
        let mut output = String::new();
        for (extent, value) in [(-49, "visible prefix"), (0, "unchecked hidden tail")] {
            let text = read_nonhidden_run(
                || rich_range_readable(0, -59, extent),
                || {
                    assert_ne!(extent, 0, "collapsed match must not call GetText");
                    Some(value.encode_utf16().collect())
                },
                None,
            )
            .unwrap();
            let Some(text) = text else {
                break;
            };
            append_text(&mut output, &text_prefix(&text), 8192);
        }
        assert_eq!(output, "visible prefix");
        for (start, end, extent) in [(-1, 0, -4), (0, 1, -4), (0, 0, 1), (-1, 0, 0)] {
            assert!(
                read_nonhidden_run(
                    || rich_range_readable(start, end, extent),
                    || panic!("invalid range must not read text"),
                    None,
                )
                .is_none()
            );
        }
    }

    #[test]
    fn rich_attribute_or_source_denial_never_reads_and_late_denial_discards_text() {
        assert!(
            read_nonhidden_run(|| None, || panic!("unknown or hidden attribute"), None).is_none()
        );
        for after in [None, Some(false)] {
            let current = Cell::new(Some(true));
            assert!(
                read_nonhidden_run(
                    || current.get(),
                    || {
                        // Attribute/source loss or collapse during the provider read.
                        current.set(after);
                        Some("must discard".encode_utf16().collect())
                    },
                    None,
                )
                .is_none()
            );
        }
    }

    #[test]
    fn rich_final_witness_rejects_changed_text_provider_failure_and_collapse() {
        let original: Vec<u16> = "visible text".encode_utf16().collect();
        assert_eq!(
            read_nonhidden_run(|| Some(true), || Some(original.clone()), Some(&original)),
            Some(Some(original.clone()))
        );
        for changed in [None, Some("different text".encode_utf16().collect())] {
            assert!(read_nonhidden_run(|| Some(true), || changed, Some(&original)).is_none());
        }
        assert!(
            read_nonhidden_run(
                || Some(false),
                || panic!("final collapsed range must not read"),
                Some(&original),
            )
            .flatten()
            .is_none()
        );
    }

    #[test]
    fn final_policy_keeps_numeric_selection_without_reading_or_requiring_text() {
        let mut snapshot = crate::model::tests::snapshot();
        snapshot.text = None;
        for (start, end) in [(0, 0), (70_000, 70_003)] {
            snapshot.selection =
                native_selection(start, end, false, || panic!("text read")).unwrap();
            assert!(
                capture_text_policy_current(false, false, &snapshot),
                "unchanged metadata policy must retain an independently observed numeric range"
            );
            snapshot.selection.as_mut().unwrap().selected_text = Some("unexpected body".into());
            assert!(!capture_text_policy_current(false, false, &snapshot));
        }
        snapshot.selection = None;
        snapshot.text = Some(String::new());
        assert!(!capture_text_policy_current(false, false, &snapshot));
    }

    #[test]
    fn final_policy_rejects_both_text_transitions_even_with_no_body() {
        let mut snapshot = crate::model::tests::snapshot();
        snapshot.text = None;
        snapshot.selection = None;
        for (before, after) in [(true, false), (false, true)] {
            assert!(
                !capture_text_policy_current(before, after, &snapshot),
                "an empty body cannot hide a policy transition"
            );
        }
        assert!(capture_text_policy_current(false, false, &snapshot));
        assert!(capture_text_policy_current(true, true, &snapshot));
    }

    #[test]
    fn optional_input_cannot_hide_provider_failure_or_late_privacy_rejection() {
        let privacy_valid = Cell::new(true);
        for input in [None, Some(42)] {
            let snapshot = crate::model::tests::snapshot();
            let original_body = snapshot.text.clone();
            let retained = checked_input_target(|| Some(input), || Some(()))
                .map(|_| snapshot)
                .unwrap();
            assert_eq!(retained.text, original_body);
            assert_eq!(
                checked_input_target(|| Some(input), || Some(())),
                Some(input)
            );
            privacy_valid.set(true);
            let result = checked_input_target(
                || {
                    // Model a provider read that changes a sibling's password
                    // state after body/selection were already collected.
                    privacy_valid.set(false);
                    Some(input)
                },
                || privacy_valid.get().then_some(()),
            );
            assert_eq!(result, None);
        }
        let failures = CaptureFailures::default();
        let result = checked_input_target::<u32>(
            || {
                failures.provider_failed.set(true);
                None
            },
            || Some(()),
        );
        assert_eq!(
            failures.finish(result).unwrap_err().to_string(),
            "uia_provider_unavailable"
        );
    }

    #[test]
    fn observed_identity_comparison_failure_is_not_an_absent_input_target() {
        let nodes = [10, 20, 30];
        assert_eq!(
            find_observed(&nodes, |node| Some(*node == 20)),
            Some(Some(&20))
        );
        assert_eq!(find_observed(&nodes, |_| Some(false)), Some(None));
        assert_eq!(
            find_observed(&nodes, |node| (*node != 10).then_some(*node == 20)),
            None
        );
        assert_eq!(
            checked_input_target(|| find_observed(&nodes, |_| None), || Some(())),
            None
        );
    }

    #[test]
    fn deferred_native_body_keeps_walk_order_when_later_labels_fill_budget() {
        let mut text = String::from("Edit\nlater-labels-fill-the-budget");
        let (added, truncated) = insert_native_scalar(&mut text, 4, "BODY_TAIL", 20);
        assert_eq!(text, "Edit\nBODY_TAIL\nlater");
        assert_eq!(added, 10);
        assert!(truncated);
        let mut text = String::from("first\nsecond");
        let (added, _) = insert_native_scalar(&mut text, 5, "one", 100);
        let offset = 12 + added;
        let (_, truncated) = insert_native_scalar(&mut text, offset, "two", 100);
        assert_eq!(text, "first\none\nsecond\ntwo");
        assert!(!truncated);
        let mut text = String::from("second");
        let (added, _) = insert_native_scalar(&mut text, 0, "one", 100);
        insert_native_scalar(&mut text, 6 + added, "two", 100);
        assert_eq!(text, "one\nsecond\ntwo");
    }

    #[test]
    fn deferred_visible_body_uses_its_walk_position_budget_and_preserves_utf8() {
        let mut text = String::from("before\nlater-labels-fill-the-budget");
        let offset = "before".len();
        let limit = 24;
        let body = collect_visible_spans(2, limit - offset, |index, maximum| {
            let value = if index == 0 {
                "\u{4e2d}\u{1f4bb}"
            } else {
                "BODY"
            };
            Some(value.encode_utf16().take(maximum).collect())
        })
        .unwrap();
        let (added, truncated) = insert_native_scalar(&mut text, offset, &body, limit);
        assert_eq!(text, "before\n\u{4e2d}\u{1f4bb}\nBODY\nlate");
        assert!(truncated);
        assert!(text.len() <= limit);
        // Consecutive unnamed controls share an offset before deferred insertion.
        insert_native_scalar(&mut text, offset + added, "NEXT", limit);
        assert_eq!(text, "before\n\u{4e2d}\u{1f4bb}\nBODY\nNEXT");
        assert!(!text.contains('\u{fffd}'));
    }

    #[test]
    fn edit_selection_recovers_clipped_scalar_but_never_reuses_partial_failure() {
        let text = format!("HEAD{}tail\u{4e2d}\u{1f4bb}", "a".repeat(5000));
        let value: Vec<u16> = text.encode_utf16().collect();
        let selection = edit_selection(&value[..4096], 4, value.len(), |capacity| {
            assert_eq!(capacity, value.len() + 1);
            Some(value.clone())
        })
        .unwrap()
        .unwrap();
        assert_eq!(selection.selected_text.as_deref(), Some(&text[4..]));
        assert_eq!(selection.start, 4);
        assert!(!selection.truncated);
        for fallback in [
            None,
            Some(value[..4096].to_vec()),
            Some(vec![0; value.len() + 1]),
        ] {
            assert!(edit_selection(&value[..4096], 4, value.len(), |_| fallback).is_none());
        }
        let short = edit_selection(&value, 0, 4, |_| panic!("complete scalar must not reread"))
            .unwrap()
            .unwrap();
        assert_eq!(short.selected_text.as_deref(), Some("HEAD"));
    }

    #[test]
    fn edit_selection_caps_utf8_without_splitting_utf16_or_reading_unbounded_offsets() {
        let text = format!(
            "{}\u{1f4bb}tail",
            "a".repeat(crate::model::MAX_SELECTION_BYTES - 2)
        );
        let value: Vec<u16> = text.encode_utf16().collect();
        let selection = edit_selection(&value, 0, value.len(), |_| panic!("complete scalar"))
            .unwrap()
            .unwrap();
        assert_eq!(
            selection.selected_text.as_deref(),
            Some("a".repeat(crate::model::MAX_SELECTION_BYTES - 2).as_str())
        );
        assert!(selection.truncated);
        assert!(edit_selection(&[0xd83d, 0xdcbb], 0, 1, |_| panic!("complete scalar")).is_none());
        for (start, end) in [(0, MAX_BYTES + 1), (MAX_BYTES + 1, MAX_BYTES + 4), (4, 4)] {
            assert!(
                edit_selection(&[], start, end, |_| panic!("out of budget"))
                    .unwrap()
                    .is_none()
            );
        }
    }

    #[test]
    fn numeric_selection_keeps_full_dword_caret_and_range_without_text() {
        for (start, end) in [(0, 0), (70_000, 70_000), (70_001, 70_010)] {
            let selected = numeric_selection(start, end).unwrap();
            assert_eq!(selected.start, start);
            assert_eq!(selected.length, Some(end - start));
            assert_eq!(selected.selected_text, None);
            assert!(!selected.truncated);
        }
        assert!(numeric_selection(4, 3).is_none());
        assert!(numeric_selection(0, u32::MAX).is_none());
        assert!(numeric_selection(u32::MAX, u32::MAX).is_none());
    }

    #[test]
    fn native_selection_keeps_numeric_ranges_without_reading_absent_or_unbounded_text() {
        for capture_text in [false, true] {
            for (start, end) in [(70_000, 70_000), (70_001, 70_010), (3, 3)] {
                let selection = native_selection(start, end, capture_text, || {
                    panic!("numeric range must not require a body read")
                })
                .unwrap()
                .unwrap();
                assert_eq!(selection.start, start);
                assert_eq!(selection.length, Some(end - start));
                assert_eq!(selection.selected_text, None);
            }
        }
        assert_eq!(
            native_selection(3, 5, false, || panic!("text consent is off"))
                .unwrap()
                .unwrap()
                .length,
            Some(2)
        );
        assert_eq!(
            native_selection(3, 5, true, || Some(None))
                .unwrap()
                .unwrap()
                .selected_text,
            None
        );
        assert!(native_selection(3, 5, true, || None).is_none());
        assert!(native_selection(5, 3, true, || panic!("invalid range")).is_none());
    }

    #[test]
    fn visible_spans_preserve_disjoint_empty_and_failure_contracts() {
        let spans = ["first visible", "", "last \u{4e2d}\u{1f4bb}"];
        let text = collect_visible_spans(3, 200, |index, _| {
            Some(spans[index as usize].encode_utf16().collect())
        });
        assert_eq!(
            text.as_deref(),
            Some("first visible\nlast \u{4e2d}\u{1f4bb}")
        );
        assert_eq!(
            collect_visible_spans(0, 20, |_, _| panic!("no ranges")),
            Some(String::new())
        );
        assert_eq!(
            collect_visible_spans(1, 20, |_, _| Some(Vec::new())),
            Some(String::new())
        );
        assert!(
            collect_visible_spans(2, 20, |index, _| {
                (index == 0).then(|| "prefix".encode_utf16().collect())
            })
            .is_none()
        );
        for count in [-1, 17] {
            assert!(collect_visible_spans(count, 20, |_, _| panic!("invalid count")).is_none());
        }
    }

    #[test]
    fn visible_span_utf16_and_utf8_budgets_do_not_invent_replacement_characters() {
        let value: Vec<u16> = "abc\u{1f4bb}tail".encode_utf16().collect();
        assert_eq!(text_prefix(&value[..4]), "abc");
        assert_eq!(text_prefix(&value), "abc\u{1f4bb}tail");
        let text = collect_visible_spans(2, 7, |index, maximum| {
            let value: Vec<u16> = if index == 0 { "abc" } else { "\u{1f4bb}tail" }
                .encode_utf16()
                .collect();
            Some(value.into_iter().take(maximum).collect())
        })
        .unwrap();
        assert_eq!(text, "abc");
        assert!(!text.contains('\u{fffd}'));
        let mut long = vec![b'a' as u16; MAX_BYTES - 1];
        long.extend("\u{1f4bb}".encode_utf16());
        assert_eq!(text_prefix(&long), "a".repeat(MAX_BYTES - 1));
    }

    #[test]
    fn capture_failure_classification_keeps_clean_suppression_and_success() {
        let failures = CaptureFailures::default();
        assert_eq!(failures.finish::<()>(None).unwrap(), None);
        assert_eq!(failures.finish(Some(())).unwrap(), Some(()));
        failures.provider_failed.set(true);
        for snapshot in [None, Some(())] {
            assert_eq!(
                failures.finish(snapshot).unwrap_err().to_string(),
                "uia_provider_unavailable"
            );
        }
        assert_eq!(CaptureFailures::default().finish::<()>(None).unwrap(), None);
    }

    #[test]
    fn capture_timeout_takes_precedence_over_provider_failure() {
        let failures = CaptureFailures::default();
        failures.timed_out.set(true);
        for provider_failed in [false, true] {
            failures.provider_failed.set(provider_failed);
            for snapshot in [None, Some(())] {
                assert_eq!(
                    failures.finish(snapshot).unwrap_err().to_string(),
                    "uia_capture_timeout"
                );
            }
        }
    }

    #[test]
    fn private_titles_are_conservative_and_case_insensitive() {
        for title in [
            "Budget - InPrivate - Microsoft Edge",
            "New Incognito Tab",
            "Mozilla Firefox (Private Browsing)",
            "Private repository - Chrome",
            "Fen\u{ea}tre priv\u{e9}e",
            "\u{65b0}\u{5efa}\u{65e0}\u{75d5}\u{7a97}\u{53e3}",
            "\u{30b7}\u{30fc}\u{30af}\u{30ec}\u{30c3}\u{30c8} Chrome",
        ] {
            assert!(private_title(title), "{title}");
        }
        for title in [
            "Quarterly report - Word",
            "Rust documentation - Firefox",
            "",
        ] {
            assert!(!private_title(title), "{title}");
        }
    }

    #[test]
    fn remote_sources_require_absolute_credential_free_web_urls() {
        let source =
            document_source("https://EXAMPLE.com:8443/private/report?secret=yes#token").unwrap();
        assert_eq!(source.domain(), Some("example.com"));
        assert_eq!(
            source.public_url().as_deref(),
            Some("https://example.com:8443/")
        );
        for value in [
            "",
            "example.com",
            "/report",
            "//example.com",
            "about:blank",
            "chrome://settings",
            "edge://newtab",
            "data:text/html,secret",
            "blob:https://example.com/id",
            "javascript:void(0)",
            "https://user:secret@example.com",
            "https://user@example.com",
            "https://",
            " https://example.com",
            "https://example.com\n",
            "https:example.com",
            "https:///example.com",
            "https:\\\\example.com",
        ] {
            assert!(document_source(value).is_none(), "{value}");
        }
    }

    #[test]
    fn local_files_never_expose_paths_or_admit_remote_file_hosts() {
        for value in [
            "file:///C:/Documents/report.txt",
            "file://localhost/C:/note.txt",
        ] {
            let source = document_source(value).unwrap();
            assert!(matches!(source, DocumentSource::LocalFile(_)));
            assert_eq!(source.domain(), None);
            assert_eq!(source.public_url(), None);
        }
        for value in [
            "file://server/share/secrets",
            "file:////server/share/secret",
            "file:///C:/report?token=secret",
            "file:///C:/report#secret",
            "file://localhost.evil/C:/report",
            "file://127.0.0.1/share/report",
            "file:///%2f%2fserver/share",
            "file:///%5c%5cserver/share",
            "file:///../server/share",
            "file:///notes",
        ] {
            assert!(document_source(value).is_none(), "{value}");
        }
    }

    #[test]
    fn source_identity_detects_navigation_even_when_public_origin_is_unchanged() {
        let first = document_source("https://example.com/one").unwrap();
        let second = document_source("https://example.com/two").unwrap();
        assert_ne!(first, second);
        assert_eq!(first.public_url(), second.public_url());
    }

    #[test]
    fn native_document_admission_requires_an_explicit_native_framework() {
        let action = DocumentSource::NativeAction;
        assert_eq!(action.public_url(), None);
        assert_eq!(action.domain(), None);
        assert_ne!(action, DocumentSource::Native);
        for framework in ["Win32", "WinForm", "WPF"] {
            for value in [None, Some("")] {
                assert_eq!(
                    resolve_source(value, framework, false, false),
                    Some(DocumentSource::Native)
                );
                assert_eq!(resolve_source(value, framework, true, false), None);
                assert_eq!(resolve_source(value, framework, false, true), None);
            }
        }
        for framework in [
            "",
            "unknown",
            "Chrome",
            "Mozilla",
            "WebView2",
            "Win32WebView",
        ] {
            assert_eq!(resolve_source(None, framework, false, false), None);
        }
        for value in [
            "about:blank",
            "app://document",
            "https://",
            "a document title",
        ] {
            assert_eq!(resolve_source(Some(value), "Win32", false, false), None);
        }
        let remote =
            resolve_source(Some("https://example.com/document"), "Win32", false, false).unwrap();
        assert!(matches!(remote, DocumentSource::Remote(_)));
        assert_eq!(remote.domain(), Some("example.com"));
    }

    #[test]
    fn text_budget_preserves_utf8_and_never_adds_an_unbudgeted_separator() {
        let mut text = String::new();
        append_text(&mut text, "\u{754c}\u{9762}", 4);
        assert_eq!(text, "\u{754c}");
        append_text(&mut text, "a", 4);
        assert_eq!(text, "\u{754c}");
        append_text(&mut text, "a", 5);
        assert_eq!(text, "\u{754c}\na");
        let mut full = String::new();
        append_text(&mut full, &"x".repeat(MAX_BYTES + 1), MAX_BYTES);
        assert_eq!(full.len(), MAX_BYTES);
    }

    #[test]
    fn credential_processes_and_browser_hosts_are_recognized() {
        for stem in [
            "credentialmanager",
            "credentialuibroker",
            "consent",
            "1password",
            "keepassxc",
        ] {
            assert!(excluded_app(stem), "{stem}");
        }
        assert!(!excluded_app("notepad"));
        for stem in ["chrome", "msedge", "firefox", "brave", "zen"] {
            assert!(browser_app(stem), "{stem}");
        }
        assert!(!browser_app("winword"));
        assert!(web_framework("Chrome"));
        assert!(web_framework("WebView2"));
        assert!(!web_framework("Win32"));
    }
}

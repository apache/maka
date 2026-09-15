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

//! One-shot, read-only UIA capture. The supervisor owns consent, events and the
//! hard worker-process timeout. Nothing in this module writes to stdout.
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

#[cfg(windows)]
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
        if snapshot.is_none() {
            if self.timed_out.get() {
                return Err("uia_capture_timeout".into());
            }
            if self.provider_failed.get() {
                return Err("uia_provider_unavailable".into());
            }
        }
        Ok(snapshot)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DocumentSource {
    Remote(Url),
    LocalFile(Url),
    Native,
}

impl DocumentSource {
    fn domain(&self) -> Option<&str> {
        match self {
            Self::Remote(url) => url.host_str(),
            Self::LocalFile(_) | Self::Native => None,
        }
    }

    fn public_url(&self) -> Option<String> {
        match self {
            // Never transport credentials, query strings, document paths or fragments.
            Self::Remote(url) => Some(format!("{}/", url.origin().ascii_serialization())),
            Self::LocalFile(_) | Self::Native => None,
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
    let separator = usize::from(!output.is_empty());
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

#[cfg(windows)]
pub use native::capture;

#[cfg(windows)]
mod native {
    use super::*;
    use crate::{
        control::Result,
        model::{Policy, Selection, Snapshot},
    };
    use std::{
        collections::BTreeSet,
        path::Path,
        time::{Duration, Instant},
    };
    use windows::{
        Win32::{
            Foundation::{
                CloseHandle, E_NOINTERFACE, E_NOTIMPL, HANDLE, HWND, LPARAM, WAIT_TIMEOUT, WPARAM,
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
            },
            UI::{
                Accessibility::{
                    CUIAutomation8, IUIAutomation2, IUIAutomationCacheRequest,
                    IUIAutomationElement, IUIAutomationTextPattern, IUIAutomationTextRange,
                    IUIAutomationTextRangeArray, IUIAutomationTreeWalker,
                    IUIAutomationValuePattern, TextPatternRangeEndpoint_End,
                    TextPatternRangeEndpoint_Start, TreeScope_Element, UIA_CONTROLTYPE_ID,
                    UIA_ControlTypePropertyId, UIA_DocumentControlTypeId, UIA_E_NOTSUPPORTED,
                    UIA_E_TIMEOUT, UIA_EditControlTypeId, UIA_FrameworkIdPropertyId,
                    UIA_IsOffscreenPropertyId, UIA_IsPasswordPropertyId,
                    UIA_NativeWindowHandlePropertyId, UIA_ProcessIdPropertyId, UIA_TextPatternId,
                    UIA_ValuePatternId,
                },
                WindowsAndMessaging::{
                    EnumChildWindows, GA_ROOT, GetAncestor, GetClassNameW,
                    GetWindowThreadProcessId, IsWindowVisible, SMTO_ABORTIFHUNG, SMTO_BLOCK,
                    SendMessageTimeoutW,
                },
            },
        },
        core::{BOOL, BSTR, HRESULT, Interface, PWSTR},
    };

    const TIME_LIMIT: Duration = Duration::from_millis(700);
    const PROVIDER_TIMEOUT_MS: u32 = 250;

    // Only optional selection operations use this boundary. Metadata, ownership
    // and privacy reads must retain their ordinary fail-closed behavior.
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

    struct Capture<'a> {
        target: &'a Target,
        automation: IUIAutomation2,
        root: IUIAutomationElement,
        identity_cache: IUIAutomationCacheRequest,
        visibility_cache: IUIAutomationCacheRequest,
        state_cache: IUIAutomationCacheRequest,
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
        native_edits: Vec<(IUIAutomationElement, Vec<IUIAutomationElement>)>,
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

        fn collect_native_edits(&mut self) -> Option<()> {
            for (element, ancestors) in &self.native_edits {
                if self.text.len() >= self.text_limit {
                    self.text_truncated = true;
                    break;
                }
                self.native_edit_current(element, ancestors)?;
                let pattern = self.value_pattern(element)??;
                let value = self.sensitive(element, || unsafe { pattern.CurrentValue() })?;
                self.native_edit_current(element, ancestors)?;
                self.text_truncated |= value.len() > MAX_BYTES;
                self.text_truncated |=
                    append_text(&mut self.text, &text_prefix(&value), self.text_limit);
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
            let value = match self.value_pattern(element)? {
                Some(pattern) => {
                    let value = self.sensitive(element, || unsafe { pattern.CurrentValue() })?;
                    Some(bounded_string(&value, MAX_URL_BYTES)?)
                }
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

        fn native_text(
            &self,
            element: &IUIAutomationElement,
            ancestors: &[IUIAutomationElement],
            sources: &[usize],
        ) -> Option<(BSTR, bool)> {
            let index = *sources.last()?;
            if self.documents[index].source != DocumentSource::Native {
                return None;
            }
            self.leaf_current(element, ancestors, sources)?;
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
            Some((value, truncated))
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
            if !self.policy.capture_text {
                return Some(None);
            }
            let focused = selection_read!(interface IUIAutomationElement, |pointer| unsafe {
                (Interface::vtable(&self.automation).base__.GetFocusedElement)(
                    self.automation.as_raw(), pointer,
                )
            });
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
            self.same_ancestry(&focused, &ancestors)?;
            let enclosing = selection_read!(unsafe { range.GetEnclosingElement() });
            if !subtree.iter().any(|candidate| {
                self.read(|| unsafe {
                    self.automation
                        .CompareElements(&enclosing, &candidate.element)
                })
                .is_some_and(|equal| equal.as_bool())
            }) {
                return Some(None);
            }
            self.final_tree_check()?;
            let value = selection_read!(sensitive & focused, unsafe { range.GetText(4097) });
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
            if !subtree.iter().any(|candidate| {
                self.read(|| unsafe {
                    self.automation
                        .CompareElements(&enclosing, &candidate.element)
                })
                .is_some_and(|equal| equal.as_bool())
            }) {
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
            let value = String::from_utf16_lossy(&value);
            let mut end = value.len().min(4096);
            while !value.is_char_boundary(end) {
                end -= 1;
            }
            let selected_text = value[..end].to_owned();
            let truncated = end < value.len();
            Some(Some(Selection {
                selected_text,
                truncated,
                start: before.len() as u32,
            }))
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
            let Some(node) = self.observed.iter().find(|node| {
                self.read(|| unsafe { self.automation.CompareElements(&node.element, focused) })
                    .is_some_and(|same| same.as_bool())
            }) else {
                return Some(None);
            };
            if node.first_child.is_some() {
                return Some(None);
            }
            let hwnd = self.read(|| unsafe { focused.CurrentNativeWindowHandle() })?;
            if hwnd.is_invalid() {
                return Some(None);
            }
            let mut pid = 0;
            unsafe {
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
            }
            if pid != self.target.pid
                || unsafe { GetAncestor(hwnd, GA_ROOT) }.0 as usize != self.target.hwnd
            {
                return None;
            }
            let mut class = [0u16; 128];
            let length = unsafe { GetClassNameW(hwnd, &mut class) } as usize;
            let class = String::from_utf16_lossy(&class[..length]);
            if class != "Edit" && !class.starts_with("WindowsForms10.EDIT.") {
                return Some(None);
            }
            let selection = || {
                let mut packed = 0usize;
                let result = unsafe {
                    SendMessageTimeoutW(
                        hwnd,
                        0x00b0,
                        WPARAM(0),
                        LPARAM(0),
                        SMTO_ABORTIFHUNG | SMTO_BLOCK,
                        100,
                        Some(&mut packed),
                    )
                };
                if result.0 == 0 || packed as u32 == u32::MAX {
                    return None;
                }
                let start = packed as u16 as usize;
                let end = ((packed >> 16) as u16) as usize;
                (start < end && end <= MAX_BYTES).then_some((start, end))
            };
            let Some((start, end)) = selection() else {
                return Some(None);
            };
            // Standard edit selection offsets refer only to its own scalar value.
            // No WM_GETTEXT, cross-process pointers, clipboard, or parent range.
            self.final_tree_check()?;
            let Some(pattern) = self.value_pattern(focused)? else {
                return Some(None);
            };
            let value = self.sensitive(focused, || unsafe { pattern.CurrentValue() })?;
            if selection() != Some((start, end)) {
                return None;
            }
            let current = self.read(|| unsafe { self.automation.GetFocusedElement() })?;
            self.same_element(Some(&current), Some(focused))?;
            self.final_tree_check()?;
            let text = String::from_utf16(value.get(start..end)?).ok()?;
            let mut end = text.len().min(4096);
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            Some(Some(Selection {
                selected_text: text[..end].to_owned(),
                truncated: end < text.len(),
                start: start as u32,
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
                    !matches!(self.documents[*index].source, DocumentSource::Native)
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
                self.native_edits.push((element.clone(), ancestors.clone()));
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
                        self.text_truncated |=
                            append_text(&mut self.text, &text_prefix(&value), self.text_limit);
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
                        if let Some(pattern) = self.value_pattern(element)? {
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

    fn text_prefix(value: &BSTR) -> String {
        String::from_utf16_lossy(&value[..value.len().min(MAX_BYTES)])
    }

    fn identity(target: &Target) -> Option<(String, String)> {
        let mut path = [0u16; 32768];
        let mut length = path.len() as u32;
        target.current()?;
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
        Some((format!("win32.{stem}"), stem.to_owned()))
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
            .spawn(move || capture_mta(&home, hwnd, pid, source_id))?
            .join()
            .map_err(|_| "uia_worker_panicked")?
    }

    fn capture_mta(
        home: &Path,
        hwnd: usize,
        pid: u32,
        source_id: String,
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
        let Some((app_id, app_name)) = identity(&target) else {
            return target.failures.finish(None);
        };
        if !policy.permits_app(&app_id) {
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
        let snapshot = (|| {
            let root =
                target.read(|| unsafe { automation.ElementFromHandle(HWND(hwnd as *mut _)) })?;
            let walker = target.read(|| unsafe { automation.RawViewWalker() })?;
            let (identity_cache, visibility_cache, state_cache) = target.read(|| unsafe {
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
                Ok((identity, visibility, state))
            })?;
            let browser = browser_app(&app_name);
            let mut capture = Capture {
                target: &target,
                automation,
                root: root.clone(),
                identity_cache,
                visibility_cache,
                state_cache,
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
                native_edits: Vec::new(),
            };
            let title = capture.sensitive(&root, || unsafe { root.CurrentName() })?;
            let title = bounded_string(&title, MAX_TITLE_BYTES)?;
            if private_title(&title) {
                return None;
            }
            capture.text_limit = MAX_BYTES
                .saturating_sub(title.len() + app_id.len() + app_name.len() + source_id.len());
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
                && !capture
                    .documents
                    .iter()
                    .any(|document| document.source != DocumentSource::Native)
            {
                return None;
            }
            capture.final_tree_check()?;
            if !capture.native_edits.is_empty() {
                capture.collect_native_edits()?;
                capture.final_tree_check()?;
            }
            let selection = capture.selected_text()?;
            if let Some(scope) = &capture.browser_scope {
                capture.scope_current()?;
                let current = capture.read(|| unsafe { capture.automation.GetFocusedElement() })?;
                capture.same_element(Some(&current), Some(&scope.focused))?;
            }
            let final_title = capture.sensitive(&root, || unsafe { root.CurrentName() })?;
            if bounded_string(&final_title, MAX_TITLE_BYTES)? != title {
                return None;
            }
            let url = capture
                .documents
                .first()
                .and_then(|document| document.source.public_url());
            let metadata_bytes = url.as_ref().map_or(0, String::len)
                + capture.domains.iter().map(String::len).sum::<usize>();
            let metadata_bytes = metadata_bytes
                + selection
                    .as_ref()
                    .map_or(0, |value| value.selected_text.len());
            let text_limit = capture.text_limit.saturating_sub(metadata_bytes);
            let mut text = String::new();
            let text_truncated =
                append_text(&mut text, &capture.text, text_limit) || capture.text_truncated;
            capture.root_current()?;
            Some(Snapshot {
                app_id,
                app_name,
                pid,
                window_id: hwnd as u64,
                title,
                url,
                text: (policy.capture_text && !text.is_empty()).then_some(text),
                text_truncated,
                selection,
                source_id,
                domains: capture.domains.into_iter().collect(),
                secure: false,
                private: false,
                source_known: true,
            })
        })();
        // A settings change cannot resurrect content captured under an old policy.
        let latest = Policy::load(home)?;
        let snapshot = snapshot.filter(|snapshot| {
            super::super::interactive_desktop()
                && target.current().is_some()
                && latest.permits_app(&snapshot.app_id)
                && snapshot
                    .domains
                    .iter()
                    .all(|domain| latest.permits_domain(domain))
                && (latest.capture_text
                    || (snapshot.text.is_none() && snapshot.selection.is_none()))
        });
        target.failures.finish(snapshot)
    }

    #[cfg(test)]
    mod selection_tests {
        use super::*;

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
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_failure_classification_keeps_clean_suppression_and_success() {
        let failures = CaptureFailures::default();
        assert_eq!(failures.finish::<()>(None).unwrap(), None);
        assert_eq!(failures.finish(Some(())).unwrap(), Some(()));
        failures.provider_failed.set(true);
        assert_eq!(
            failures.finish::<()>(None).unwrap_err().to_string(),
            "uia_provider_unavailable"
        );
        assert_eq!(failures.finish(Some(())).unwrap(), Some(()));
        assert_eq!(CaptureFailures::default().finish::<()>(None).unwrap(), None);
    }

    #[test]
    fn capture_timeout_takes_precedence_over_provider_failure() {
        let failures = CaptureFailures::default();
        failures.timed_out.set(true);
        for provider_failed in [false, true] {
            failures.provider_failed.set(provider_failed);
            assert_eq!(
                failures.finish::<()>(None).unwrap_err().to_string(),
                "uia_capture_timeout"
            );
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

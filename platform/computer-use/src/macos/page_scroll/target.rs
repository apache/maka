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

use core_foundation::{
    array::CFArray,
    base::{CFGetTypeID, CFRelease, CFTypeRef, TCFType},
    string::CFString,
};
use cua_driver_contract::WindowBounds;
use maka_agent_facts::tools::ToolError;
use platform_macos::ax::{
    bindings::{self, *},
    snapshot::RetainedElement,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::OnceLock};

use super::windows::WindowVariant;

// The native parent iterator's observed default, shared by both searches.
const MAX_PARENT_DEPTH: usize = 300;
const AX_ERROR_ILLEGAL_ARGUMENT: AXError = -25201;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct PointMetadata {
    pub(crate) on_screen_window_ids: Vec<u32>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub(crate) enum ProcessState {
    Absent,
    Running {
        finished_launching: bool,
        activation_policy: i64,
    },
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub(crate) enum GlobalWindowObservation {
    Unqueried,
    Observed(Option<u32>),
}

pub(crate) struct EventTarget {
    pub(crate) pid: i32,
    pub(crate) window_id: u32,
    pub(crate) bounds: WindowBounds,
    pub(crate) flipped: bool,
    // Keep native owners alive through event dispatch.
    pub(crate) _retained_element: Option<RetainedElement>,
    pub(crate) _retained_accessibility_window: WindowVariant,
}

pub(crate) enum Resolution {
    NeedsProcess(i32),
    NeedsGlobalWindow,
    Ready(EventTarget),
}

#[derive(Clone, Copy)]
struct ProcessWindow {
    pid: i32,
    window_id: u32,
}

enum SearchPurpose {
    ApplicationHit,
    SystemWideHit,
}

struct ProcessSearch {
    current: Option<RetainedElement>,
    depth: usize,
    pid_read: bool,
    pid: Option<i32>,
}

enum SearchResult {
    NeedsProcess(i32),
    Complete(Option<ProcessWindow>),
}

enum Phase {
    Search(ProcessSearch, SearchPurpose),
    GlobalWindow,
    SystemWideHit,
    Ax,
    Cg,
    Complete,
}

/// One target selection, paused only to obtain exact AppKit metadata.
/// Awaiting metadata never repeats an already completed AX hit or selection.
pub(crate) struct TargetResolver {
    app_pid: i32,
    point: [f64; 2],
    selected_window: WindowVariant,
    element: Option<RetainedElement>,
    out_of_process: Option<ProcessWindow>,
    phase: Phase,
}

impl TargetResolver {
    pub(crate) fn new(
        app_pid: i32,
        app_bundle_id: Option<&str>,
        ax_windows: &HashMap<u32, WindowVariant>,
        point: [f64; 2],
        metadata: &PointMetadata,
    ) -> Result<Self, ToolError> {
        let mut ordered = metadata
            .on_screen_window_ids
            .iter()
            .filter_map(|id| ax_windows.get(id))
            .peekable();
        if ordered.peek().is_none() {
            return Err(failed(
                "the application has no ordered on-screen AX windows",
            ));
        }
        let mut selected = None;
        for window in ordered {
            if let Some(frame) = element_frame(window.element())?
                && contains(&frame, point)
            {
                selected = Some(window.clone());
                break;
            }
        }
        let selected_window = selected
            .ok_or_else(|| failed("no ordered AX window contains the retained screen point"))?;
        let application = copied_element(unsafe { AXUIElementCreateApplication(app_pid) })
            .ok_or_else(|| failed("AX application unavailable"))?;
        let actual_app_pid = required_pid(&application)?;
        let selected_pid = actual_pid(selected_window.element())?;
        let element = hit_test(&application, point)?;
        Self::from_selection(
            actual_app_pid,
            selected_pid,
            app_bundle_id,
            selected_window,
            element,
            point,
        )
    }

    pub(crate) fn from_known(
        app_pid: i32,
        app_bundle_id: Option<&str>,
        selected_window: WindowVariant,
        element: RetainedElement,
        point: [f64; 2],
    ) -> Result<Self, ToolError> {
        let application = copied_element(unsafe { AXUIElementCreateApplication(app_pid) })
            .ok_or_else(|| failed("AX application unavailable"))?;
        let actual_app_pid = required_pid(&application)?;
        let selected_pid = actual_pid(selected_window.element())?;
        Self::from_selection(
            actual_app_pid,
            selected_pid,
            app_bundle_id,
            selected_window,
            Some(element),
            point,
        )
    }

    fn from_selection(
        actual_app_pid: i32,
        selected_pid: i32,
        app_bundle_id: Option<&str>,
        selected_window: WindowVariant,
        element: Option<RetainedElement>,
        point: [f64; 2],
    ) -> Result<Self, ToolError> {
        let out_of_process = if selected_pid != actual_app_pid {
            Some(ProcessWindow {
                pid: selected_pid,
                window_id: selected_window.window_id()?,
            })
        } else {
            None
        };
        let phase = if out_of_process.is_some() {
            Phase::GlobalWindow
        } else if let Some(hit) = element.as_ref() {
            let candidate = first_child(hit)?.unwrap_or_else(|| hit.clone());
            Phase::Search(ProcessSearch::new(candidate), SearchPurpose::ApplicationHit)
        } else if app_bundle_id.is_some_and(|bundle| bundle.starts_with("com.openai.atlas")) {
            Phase::Ax
        } else {
            Phase::GlobalWindow
        };
        Ok(Self {
            app_pid: actual_app_pid,
            point,
            selected_window,
            element,
            out_of_process,
            phase,
        })
    }

    pub(crate) fn advance(
        &mut self,
        processes: &HashMap<i32, ProcessState>,
        global_window: &GlobalWindowObservation,
    ) -> Result<Resolution, ToolError> {
        loop {
            match std::mem::replace(&mut self.phase, Phase::Complete) {
                Phase::Search(mut search, purpose) => {
                    match search.advance(self.app_pid, processes)? {
                        SearchResult::NeedsProcess(pid) => {
                            self.phase = Phase::Search(search, purpose);
                            return Ok(Resolution::NeedsProcess(pid));
                        }
                        SearchResult::Complete(target) => {
                            self.out_of_process = target;
                            self.phase = match (purpose, target) {
                                (SearchPurpose::ApplicationHit, Some(_)) => Phase::GlobalWindow,
                                (SearchPurpose::SystemWideHit, Some(_)) => Phase::Cg,
                                (_, None) => Phase::Ax,
                            };
                        }
                    }
                }
                Phase::GlobalWindow => match global_window {
                    GlobalWindowObservation::Unqueried => {
                        self.phase = Phase::GlobalWindow;
                        return Ok(Resolution::NeedsGlobalWindow);
                    }
                    GlobalWindowObservation::Observed(id) => {
                        let current_id = self.selected_window.window_id()?;
                        if *id == Some(current_id) {
                            self.phase = Phase::SystemWideHit;
                        } else {
                            if self.out_of_process.is_none() {
                                return Err(failed(
                                    "the retained point has no matching event target",
                                ));
                            }
                            self.phase = Phase::Cg;
                        }
                    }
                },
                Phase::SystemWideHit => {
                    let system = copied_element(unsafe { AXUIElementCreateSystemWide() })
                        .ok_or_else(|| failed("system-wide AX element unavailable"))?;
                    if let Some(hit) = hit_test(&system, self.point)? {
                        self.element = Some(hit.clone());
                        self.phase =
                            Phase::Search(ProcessSearch::new(hit), SearchPurpose::SystemWideHit);
                    } else if self.out_of_process.is_some() {
                        self.phase = Phase::Cg;
                    } else {
                        return Err(failed("the retained point has no system-wide AX target"));
                    }
                }
                Phase::Ax => {
                    let window_id = match self.element.as_ref() {
                        Some(element) => match application_window_id(element, self.app_pid)? {
                            Some(id) => id,
                            None => self.selected_window.window_id()?,
                        },
                        None => self.selected_window.window_id()?,
                    };
                    let bounds =
                        element_frame(self.selected_window.element())?.unwrap_or(WindowBounds {
                            x: 0.0,
                            y: 0.0,
                            width: 0.0,
                            height: 0.0,
                        });
                    return Ok(Resolution::Ready(self.ready(
                        ProcessWindow {
                            pid: self.app_pid,
                            window_id,
                        },
                        bounds,
                        false,
                    )));
                }
                Phase::Cg => {
                    let target = self
                        .out_of_process
                        .ok_or_else(|| failed("out-of-process event target unavailable"))?;
                    let window = platform_macos::windows::window_info_by_id(target.window_id)
                        .ok_or_else(|| failed("out-of-process WindowServer window unavailable"))?;
                    let bounds = WindowBounds {
                        x: window.bounds.x,
                        y: window.bounds.y,
                        width: window.bounds.width,
                        height: window.bounds.height,
                    };
                    return Ok(Resolution::Ready(self.ready(target, bounds, true)));
                }
                Phase::Complete => {
                    return Err(failed("native page target selection has completed"));
                }
            }
        }
    }

    fn ready(&mut self, target: ProcessWindow, bounds: WindowBounds, flipped: bool) -> EventTarget {
        EventTarget {
            pid: target.pid,
            window_id: target.window_id,
            bounds,
            flipped,
            _retained_element: self.element.take(),
            _retained_accessibility_window: self.selected_window.clone(),
        }
    }
}

impl ProcessSearch {
    fn new(element: RetainedElement) -> Self {
        Self {
            current: Some(element),
            depth: 0,
            pid_read: false,
            pid: None,
        }
    }

    fn advance(
        &mut self,
        app_pid: i32,
        processes: &HashMap<i32, ProcessState>,
    ) -> Result<SearchResult, ToolError> {
        while self.depth < MAX_PARENT_DEPTH {
            let Some(element) = self.current.as_ref() else {
                break;
            };
            if !self.pid_read {
                self.pid = optional_actual_pid(element)?;
                self.pid_read = true;
            }
            if let Some(pid) = self.pid {
                let Some(process) = processes.get(&pid) else {
                    return Ok(SearchResult::NeedsProcess(pid));
                };
                match process_kind(process) {
                    ProcessKind::RegularApp => return Ok(SearchResult::Complete(None)),
                    ProcessKind::ViewService => {
                        return Ok(SearchResult::Complete(if pid == app_pid {
                            None
                        } else {
                            Some(ProcessWindow {
                                pid,
                                window_id: out_of_process_window_id(element)?,
                            })
                        }));
                    }
                    ProcessKind::NonEventHandling => {}
                }
            }
            self.current = element_attribute(element, "AXParent")?;
            self.depth += 1;
            self.pid_read = false;
        }
        Ok(SearchResult::Complete(None))
    }
}

#[derive(Debug, PartialEq, Eq)]
enum ProcessKind {
    RegularApp,
    ViewService,
    NonEventHandling,
}

fn process_kind(state: &ProcessState) -> ProcessKind {
    match state {
        ProcessState::Absent
        | ProcessState::Running {
            finished_launching: false,
            ..
        } => ProcessKind::NonEventHandling,
        ProcessState::Running {
            activation_policy: 2,
            ..
        } => ProcessKind::ViewService,
        ProcessState::Running { .. } => ProcessKind::RegularApp,
    }
}

fn out_of_process_window_id(element: &RetainedElement) -> Result<u32, ToolError> {
    let mut current = Some(element.clone());
    for _ in 0..MAX_PARENT_DEPTH {
        let Some(element) = current else {
            break;
        };
        if let Some(id) = window_id(&element) {
            return Ok(id);
        }
        if matches!(
            string_attribute(&element, "AXRole")?.as_deref(),
            Some("AXWindow" | "AXSheet")
        ) {
            return Err(failed("out-of-process AX window has no WindowServer ID"));
        }
        current = element_attribute(&element, "AXParent")?;
    }
    Err(failed(
        "out-of-process AX ancestry has no WindowServer window",
    ))
}

fn application_window_id(
    element: &RetainedElement,
    app_pid: i32,
) -> Result<Option<u32>, ToolError> {
    let mut current = Some(element.clone());
    for _ in 0..MAX_PARENT_DEPTH {
        let Some(element) = current else {
            break;
        };
        if optional_actual_pid(&element)? == Some(app_pid) {
            return Ok(window_id(&element));
        }
        current = element_attribute(&element, "AXParent")?;
    }
    Ok(None)
}

fn window_id(element: &RetainedElement) -> Option<u32> {
    ax_window_id(element).ok().filter(|id| *id != 0)
}

pub(super) fn ax_window_id(element: &RetainedElement) -> Result<u32, ToolError> {
    let mut id = 0;
    // SAFETY: the retained AX element and writable ID live through this call.
    let status = unsafe { _AXUIElementGetWindow(element.as_ptr() as AXUIElementRef, &mut id) };
    if status == kAXErrorSuccess {
        Ok(id)
    } else {
        Err(ax_failure("read WindowServer ID", status))
    }
}

fn required_pid(element: &RetainedElement) -> Result<i32, ToolError> {
    let mut pid = 0;
    // SAFETY: `element` is retained, and pid is writable for this synchronous call.
    let status = unsafe { AXUIElementGetPid(element.as_ptr() as AXUIElementRef, &mut pid) };
    if status == kAXErrorSuccess {
        Ok(pid)
    } else {
        Err(ax_failure("read process ID", status))
    }
}

type ActualPidFn = unsafe extern "C" fn(AXUIElementRef, *mut i32) -> AXError;

fn actual_pid_function() -> Result<ActualPidFn, ToolError> {
    static FUNCTION: OnceLock<Option<ActualPidFn>> = OnceLock::new();
    FUNCTION
        .get_or_init(|| {
            // SAFETY: ApplicationServices is linked by this module. The SPI's
            // source-derived C name and AXError/AXUIElementRef/pid_t ABI are exact.
            let symbol =
                unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"_AXUIElementGetActualPid".as_ptr()) };
            if symbol.is_null() {
                None
            } else {
                // SAFETY: the non-null symbol has the exact function ABI above;
                // the linked framework remains loaded for the process lifetime.
                Some(unsafe { std::mem::transmute::<*mut libc::c_void, ActualPidFn>(symbol) })
            }
        })
        .ok_or_else(|| failed("unsupported: native actual process identity SPI is unavailable"))
}

pub(super) fn ensure_actual_pid_available() -> Result<(), ToolError> {
    actual_pid_function().map(|_| ())
}

fn actual_pid_query(element: &RetainedElement) -> Result<(AXError, i32), ToolError> {
    let function = actual_pid_function()?;
    let mut pid = 0;
    // SAFETY: the retained AX element and writable pid live through this call.
    let status = unsafe { function(element.as_ptr() as AXUIElementRef, &mut pid) };
    Ok((status, pid))
}

pub(super) fn actual_pid(element: &RetainedElement) -> Result<i32, ToolError> {
    let (status, pid) = actual_pid_query(element)?;
    if status == kAXErrorSuccess {
        Ok(pid)
    } else {
        Err(ax_failure("read actual process ID", status))
    }
}

fn optional_actual_pid(element: &RetainedElement) -> Result<Option<i32>, ToolError> {
    let (status, pid) = actual_pid_query(element)?;
    Ok((status == kAXErrorSuccess).then_some(pid))
}

pub(super) fn hit_test(
    application: &RetainedElement,
    point: [f64; 2],
) -> Result<Option<RetainedElement>, ToolError> {
    let mut element = std::ptr::null_mut();
    // SAFETY: AX uses float point coordinates and returns a copied AX reference.
    let status = unsafe {
        AXUIElementCopyElementAtPosition(
            application.as_ptr() as AXUIElementRef,
            point[0] as f32,
            point[1] as f32,
            &mut element,
        )
    };
    let element = copied_element(element);
    match status {
        bindings::kAXErrorSuccess => Ok(element),
        AX_ERROR_ILLEGAL_ARGUMENT => Ok(None),
        _ => Err(ax_failure("hit-test screen point", status)),
    }
}

fn first_child(element: &RetainedElement) -> Result<Option<RetainedElement>, ToolError> {
    let Some(value) = attribute(element, "AXChildren")? else {
        return Ok(None);
    };
    if unsafe { CFGetTypeID(value.0) } != CFArray::<CFTypeRef>::type_id() {
        return Err(type_failure("AXChildren"));
    }
    // SAFETY: the native type was checked and `value` owns the array reference.
    let array = unsafe { CFArray::<CFTypeRef>::wrap_under_get_rule(value.0 as _) };
    let Some(item) = array.get(0) else {
        return Ok(None);
    };
    if unsafe { CFGetTypeID(*item) } != unsafe { AXUIElementGetTypeID() } {
        return Err(type_failure("AXChildren[0]"));
    }
    // SAFETY: the array retains this checked AX element until we retain it.
    Ok(Some(unsafe { RetainedElement::retain(*item as usize) }))
}

pub(super) fn string_attribute(
    element: &RetainedElement,
    name: &str,
) -> Result<Option<String>, ToolError> {
    let Some(value) = attribute(element, name)? else {
        return Ok(None);
    };
    if unsafe { CFGetTypeID(value.0) } != CFString::type_id() {
        return Err(type_failure(name));
    }
    // SAFETY: the native type was checked and `value` retains the string.
    Ok(Some(
        unsafe { CFString::wrap_under_get_rule(value.0 as _) }.to_string(),
    ))
}

pub(super) fn element_attribute(
    element: &RetainedElement,
    name: &str,
) -> Result<Option<RetainedElement>, ToolError> {
    let Some(value) = attribute(element, name)? else {
        return Ok(None);
    };
    if unsafe { CFGetTypeID(value.0) } != unsafe { AXUIElementGetTypeID() } {
        return Err(type_failure(name));
    }
    // SAFETY: checked native AX type; transfer ownership through one retain.
    Ok(Some(unsafe { RetainedElement::retain(value.0 as usize) }))
}

pub(super) fn children(element: &RetainedElement) -> Result<Vec<RetainedElement>, ToolError> {
    let Some(value) = attribute(element, "AXChildren")? else {
        return Ok(Vec::new());
    };
    if unsafe { CFGetTypeID(value.0) } != CFArray::<CFTypeRef>::type_id() {
        return Err(type_failure("AXChildren"));
    }
    // SAFETY: the checked copied array remains retained during each item check.
    let array = unsafe { CFArray::<CFTypeRef>::wrap_under_get_rule(value.0 as _) };
    array
        .iter()
        .map(|item| {
            if unsafe { CFGetTypeID(*item) } != unsafe { AXUIElementGetTypeID() } {
                return Err(type_failure("AXChildren item"));
            }
            // SAFETY: retain the checked AX object before the array is released.
            Ok(unsafe { RetainedElement::retain(*item as usize) })
        })
        .collect()
}

pub(super) fn action_names(element: &RetainedElement) -> Result<Vec<String>, ToolError> {
    let mut names = std::ptr::null();
    // SAFETY: the retained AX element is live; `names` receives a copied CFArray.
    let status =
        unsafe { AXUIElementCopyActionNames(element.as_ptr() as AXUIElementRef, &mut names) };
    let value = NativeValue::new(names.cast());
    if missing_attribute(status) {
        return Ok(Vec::new());
    }
    if status != kAXErrorSuccess {
        return Err(ax_failure("read action names", status));
    }
    let value = value.ok_or_else(|| type_failure("AXActions"))?;
    if unsafe { CFGetTypeID(value.0) } != CFArray::<CFTypeRef>::type_id() {
        return Err(type_failure("AXActions"));
    }
    // SAFETY: checked CFArray type and `value` keeps it retained.
    let array = unsafe { CFArray::<CFTypeRef>::wrap_under_get_rule(value.0 as _) };
    array
        .iter()
        .map(|item| {
            if unsafe { CFGetTypeID(*item) } != CFString::type_id() {
                return Err(type_failure("AXActions item"));
            }
            // SAFETY: checked CFString type; the array retains the item.
            Ok(unsafe { CFString::wrap_under_get_rule(*item as _) }.to_string())
        })
        .collect()
}

pub(super) fn frame_attribute(
    element: &RetainedElement,
) -> Result<Option<WindowBounds>, ToolError> {
    let Some(value) = attribute(element, "AXFrame")? else {
        return Ok(None);
    };
    let mut frame = NativeRect::default();
    read_ax_value(&value, "AXFrame", kAXValueCGRectType, &mut frame)?;
    Ok(Some(WindowBounds {
        x: frame.origin.x,
        y: frame.origin.y,
        width: frame.size.width,
        height: frame.size.height,
    }))
}

pub(super) fn element_frame(element: &RetainedElement) -> Result<Option<WindowBounds>, ToolError> {
    if let Some(frame) = frame_attribute(element)? {
        return Ok(Some(frame));
    }
    let Some(position) = attribute(element, "AXPosition")? else {
        return Ok(None);
    };
    let Some(size) = attribute(element, "AXSize")? else {
        return Ok(None);
    };
    let mut position_value = NativePoint::default();
    let mut size_value = NativeSize::default();
    read_ax_value(
        &position,
        "AXPosition",
        kAXValueCGPointType,
        &mut position_value,
    )?;
    read_ax_value(&size, "AXSize", kAXValueCGSizeType, &mut size_value)?;
    Ok(Some(WindowBounds {
        x: position_value.x,
        y: position_value.y,
        width: size_value.width,
        height: size_value.height,
    }))
}

struct NativeValue(CFTypeRef);

impl NativeValue {
    fn new(value: CFTypeRef) -> Option<Self> {
        if value.is_null() {
            None
        } else {
            Some(Self(value))
        }
    }
}

impl Drop for NativeValue {
    fn drop(&mut self) {
        // SAFETY: this wrapper owns exactly the copied native reference.
        unsafe { CFRelease(self.0) };
    }
}

fn attribute(element: &RetainedElement, name: &str) -> Result<Option<NativeValue>, ToolError> {
    let key = CFString::new(name);
    let mut value = std::ptr::null();
    // SAFETY: retained element, valid CFString key and writable output pointer.
    let status = unsafe {
        AXUIElementCopyAttributeValue(
            element.as_ptr() as AXUIElementRef,
            key.as_concrete_TypeRef(),
            &mut value,
        )
    };
    let value = NativeValue::new(value);
    if missing_attribute(status) {
        return Ok(None);
    }
    if status != kAXErrorSuccess {
        return Err(ax_failure(name, status));
    }
    Ok(value)
}

fn missing_attribute(status: AXError) -> bool {
    matches!(
        status,
        bindings::kAXErrorAttributeUnsupported | bindings::kAXErrorNoValue
    )
}

fn copied_element(element: AXUIElementRef) -> Option<RetainedElement> {
    if element.is_null() {
        return None;
    }
    // SAFETY: the caller supplied a copied AX reference; retain into the shared
    // owner, then release the copied reference exactly once.
    Some(unsafe {
        let retained = RetainedElement::retain(element as usize);
        CFRelease(element.cast());
        retained
    })
}

fn read_ax_value<T>(
    value: &NativeValue,
    name: &str,
    expected_type: AXValueType,
    output: &mut T,
) -> Result<(), ToolError> {
    // SAFETY: both functions inspect a retained CF object after its type check.
    if unsafe { CFGetTypeID(value.0) } != unsafe { AXValueGetTypeID() }
        || unsafe { AXValueGetType(value.0 as AXValueRef) } != expected_type
    {
        return Err(type_failure(name));
    }
    // SAFETY: each caller pairs the checked AXValue kind with its C-layout type.
    if !unsafe {
        AXValueGetValue(
            value.0 as AXValueRef,
            expected_type,
            (output as *mut T).cast(),
        )
    } {
        return Err(type_failure(name));
    }
    Ok(())
}

#[repr(C)]
#[derive(Default)]
struct NativePoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Default)]
struct NativeSize {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Default)]
struct NativeRect {
    origin: NativePoint,
    size: NativeSize,
}

fn contains(bounds: &WindowBounds, point: [f64; 2]) -> bool {
    // SAFETY: both values have the public CGRect/CGPoint CGFloat layout.
    unsafe {
        CGRectContainsPoint(
            NativeRect {
                origin: NativePoint {
                    x: bounds.x,
                    y: bounds.y,
                },
                size: NativeSize {
                    width: bounds.width,
                    height: bounds.height,
                },
            },
            NativePoint {
                x: point[0],
                y: point[1],
            },
        )
    }
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXUIElementGetPid(element: AXUIElementRef, pid: *mut i32) -> AXError;
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXValueGetTypeID() -> core_foundation::base::CFTypeID;
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGRectContainsPoint(rectangle: NativeRect, point: NativePoint) -> bool;
}

fn ax_failure(operation: &str, status: AXError) -> ToolError {
    failed(format!(
        "native page target {operation} failed with AX error {status}"
    ))
}

fn type_failure(attribute: &str) -> ToolError {
    failed(format!(
        "native page target {attribute} returned an unexpected native type"
    ))
}

fn failed(message: impl Into<String>) -> ToolError {
    ToolError::Failed(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_classification_keeps_missing_and_launching_out_of_event_types() {
        assert_eq!(
            process_kind(&ProcessState::Absent),
            ProcessKind::NonEventHandling
        );
        for activation_policy in [0, 1, 2] {
            assert_eq!(
                process_kind(&ProcessState::Running {
                    finished_launching: false,
                    activation_policy,
                }),
                ProcessKind::NonEventHandling,
            );
        }
        assert_eq!(
            process_kind(&ProcessState::Running {
                finished_launching: true,
                activation_policy: 2,
            }),
            ProcessKind::ViewService,
        );
        assert_eq!(
            process_kind(&ProcessState::Running {
                finished_launching: true,
                activation_policy: 1,
            }),
            ProcessKind::RegularApp,
        );
    }
}

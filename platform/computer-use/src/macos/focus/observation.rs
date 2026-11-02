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

//! Native focus metadata. Observed PIDs never confer input authority.

use core_foundation::{
    array::{CFArrayCreate, CFArrayGetCount, CFArrayGetValueAtIndex, CFArrayRef},
    base::{CFGetTypeID, CFType, CFTypeRef, TCFType},
    dictionary::{CFDictionaryGetTypeID, CFDictionaryGetValue},
    number::{CFNumberGetTypeID, CFNumberGetValue, kCFNumberSInt32Type},
    string::{CFString, CFStringRef},
};
use maka_agent_facts::tools::ToolError;
use objc2::{
    msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, Bool},
};
use objc2_foundation::{NSArray, NSString};
use platform_macos::{
    ax::{
        bindings::{
            AXUIElementCopyAttributeValue, AXUIElementCreateApplication, AXUIElementGetTypeID,
            AXUIElementRef, kAXErrorSuccess,
        },
        snapshot::RetainedElement,
    },
    input::skylight::NativeFocusApis,
};
use std::{ffi::c_void, mem::size_of, ptr};
use unicode_segmentation::UnicodeSegmentation;

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXUIElementGetPid(element: AXUIElementRef, pid: *mut i32) -> i32;
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGWindowListCreateDescriptionFromArray(windows: CFArrayRef) -> CFArrayRef;
    #[link_name = "kCGWindowOwnerPID"]
    static WINDOW_OWNER_PID: CFStringRef;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Focus {
    Regular(i32),
    ViewService {
        host: i32,
        service: Option<i32>,
        auxiliary: bool,
    },
}

impl Focus {
    pub(super) fn host(self) -> i32 {
        match self {
            Self::Regular(pid) | Self::ViewService { host: pid, .. } => pid,
        }
    }

    pub(super) fn auxiliary(self) -> bool {
        matches!(
            self,
            Self::ViewService {
                auxiliary: true,
                ..
            }
        )
    }
}

/// One resolver belongs to the shared monitor, including across registrations.
#[derive(Debug, Default)]
pub(super) struct Resolver {
    last_synthesized: Option<(f64, i32)>,
}

impl Resolver {
    pub(super) fn new() -> Self {
        Self::default()
    }

    pub(super) fn observed_focus(&self) -> Result<Focus, ToolError> {
        let apis = NativeFocusApis::resolve().map_err(failed)?;
        let query = apis.key_focus();
        let pid = if query.query_status == 0 && query.process_pid_status == 0 {
            Some(query.pid)
        } else if query.query_status == 0
            && query.process_pid_status == -600
            && query.secondary == 0
        {
            first_auxiliary_pid().filter(|pid| running_application(*pid).is_none())
        } else {
            None
        };
        match pid {
            Some(pid) => self.map_focus(pid),
            // Original initialization does not remap this Workspace fallback.
            None => Ok(Focus::Regular(actual_foreground_pid().unwrap_or(0))),
        }
    }

    pub(super) fn map_focus(&self, pid: i32) -> Result<Focus, ToolError> {
        if first_auxiliary_pid() == Some(pid) {
            let application = application_element(pid);
            let host = self.auxiliary_host(application.as_ref())?;
            let service = match application.as_ref() {
                Some(application) => auxiliary_service(application)?,
                None => None,
            };
            return Ok(Focus::ViewService {
                host,
                service,
                auxiliary: true,
            });
        }
        if activation_policy(pid) != Some(2) {
            return Ok(Focus::Regular(pid));
        }
        Ok(Focus::ViewService {
            host: resolve_host(
                application_element(pid).as_ref(),
                None,
                NamedFallback::ApplicationName,
            ),
            service: Some(pid),
            auxiliary: false,
        })
    }

    fn auxiliary_host(&self, application: Option<&RetainedElement>) -> Result<i32, ToolError> {
        let focused = application.and_then(|app| element_attribute(app, "AXFocusedUIElement"));
        if let Some(focused) = focused {
            return Ok(resolve_host(
                application,
                Some(&focused),
                NamedFallback::ForegroundOnly,
            ));
        }
        let last_uptime = self.last_synthesized.map_or(0.0, |(at, _)| at);
        if system_uptime()? - last_uptime >= 1.0 {
            return Ok(resolve_host(
                application,
                None,
                NamedFallback::ForegroundOnly,
            ));
        }
        for _ in 0..12 {
            // The source waits before every retry, including the first.
            // SAFETY: usleep receives the exact nonzero microsecond interval.
            unsafe { libc::usleep(15_000) };
            if let Some(focused) =
                application.and_then(|app| element_attribute(app, "AXFocusedUIElement"))
            {
                return Ok(resolve_host(
                    application,
                    Some(&focused),
                    NamedFallback::ForegroundOnly,
                ));
            }
        }
        Ok(self.last_synthesized.map_or_else(
            || resolve_host(application, None, NamedFallback::ForegroundOnly),
            |(_, pid)| pid,
        ))
    }
}

pub(super) fn application_active(pid: i32) -> bool {
    running_application(pid).is_some_and(|application| {
        // SAFETY: this receiver is an NSRunningApplication; isActive returns BOOL.
        let active: Bool = unsafe { msg_send![&*application, isActive] };
        active.as_bool()
    })
}

pub(super) fn activation_policy(pid: i32) -> Option<i64> {
    running_application(pid).map(|application| policy(&application))
}

pub(super) fn actual_foreground_pid() -> Option<i32> {
    let workspace = workspace()?;
    // SAFETY: NSWorkspace.frontmostApplication returns an optional retained app.
    let application: Option<Retained<AnyObject>> =
        unsafe { msg_send![&*workspace, frontmostApplication] };
    application.map(|application| process_identifier(&application))
}

pub(super) fn menu_bar_owner_pid() -> Option<i32> {
    let workspace = workspace()?;
    // SAFETY: this is the distinct initial value used by the activation source.
    let application: Option<Retained<AnyObject>> =
        unsafe { msg_send![&*workspace, menuBarOwningApplication] };
    application.map(|application| process_identifier(&application))
}

pub(super) fn activate(pid: i32) -> bool {
    running_application(pid).is_some_and(|application| {
        // SAFETY: the source sends this exact selector/options; the bool only
        // reports the request, not observed foreground or semantic completion.
        let requested: Bool = unsafe { msg_send![&*application, activateWithOptions: 0_usize] };
        requested.as_bool()
    })
}

pub(super) fn first_auxiliary_pid() -> Option<i32> {
    const UID_PROCESSES: u32 = 4;
    // SAFETY: query mode requires no buffer, and getuid has no preconditions.
    let uid = unsafe { libc::getuid() };
    let bytes = unsafe { libc::proc_listpids(UID_PROCESSES, uid, ptr::null_mut(), 0) };
    let capacity = usize::try_from(bytes).ok()? / size_of::<i32>();
    if capacity == 0 {
        return None;
    }
    // Unlike the source's raw allocation, every PID slot is initialized.
    let mut pids = vec![0_i32; capacity];
    let buffer_bytes = i32::try_from(capacity.checked_mul(size_of::<i32>())?).ok()?;
    // SAFETY: the initialized allocation contains buffer_bytes writable bytes.
    let written =
        unsafe { libc::proc_listpids(UID_PROCESSES, uid, pids.as_mut_ptr().cast(), buffer_bytes) };
    let count = usize::try_from(written).ok()? / size_of::<i32>();
    pids.truncate(count.min(capacity));
    pids.into_iter().find(|pid| {
        // SAFETY: all proc_bsdinfo fields admit zero; the output is initialized
        // even if a process disappears between enumeration and this query.
        let mut information: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let expected = size_of::<libc::proc_bsdinfo>();
        // SAFETY: this typed136-byte Darwin buffer is writable for the full
        // requested structure; only a complete successful result is inspected.
        let count = unsafe {
            libc::proc_pidinfo(
                *pid,
                libc::PROC_PIDTBSDINFO,
                0,
                ptr::from_mut(&mut information).cast(),
                expected as i32,
            )
        };
        if usize::try_from(count).ok() != Some(expected) {
            return false;
        }
        // SAFETY: pbi_name is an initialized fixed-size byte array. No tail
        // outside its returned structure or NUL terminator is inspected.
        let bytes = unsafe {
            std::slice::from_raw_parts(
                information.pbi_name.as_ptr().cast::<u8>(),
                information.pbi_name.len(),
            )
        };
        let end = bytes
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(bytes.len());
        &bytes[..end] == b"ViewBridgeAuxiliary"
    })
}

pub(super) fn owner_pid(window_id: u32) -> Option<i32> {
    if window_id == 0 {
        return None;
    }
    let encoded = window_id as usize as *const c_void;
    // SAFETY: WindowServer's input is an array of raw WindowIDs, not CFNumbers.
    // NULL callbacks prevent CF from retaining or dereferencing those values.
    let identifiers =
        unsafe { CFArrayCreate(ptr::null(), ptr::from_ref(&encoded), 1, ptr::null()) };
    if identifiers.is_null() {
        return None;
    }
    // SAFETY: this nonnull create-rule result transfers one owned reference.
    let identifiers = unsafe { CFType::wrap_under_create_rule(identifiers.cast()) };
    // SAFETY: the retained raw-WindowID array has the exact native input shape.
    let descriptions =
        unsafe { CGWindowListCreateDescriptionFromArray(identifiers.as_CFTypeRef().cast()) };
    if descriptions.is_null() {
        return None;
    }
    // SAFETY: WindowServer's nonnull create-rule result transfers ownership.
    let descriptions = unsafe { CFType::wrap_under_create_rule(descriptions.cast()) };
    // SAFETY: the returned array stays retained while its borrowed dictionary
    // and number are checked and read below.
    unsafe {
        let array = descriptions.as_CFTypeRef().cast();
        if CFArrayGetCount(array) == 0 {
            return None;
        }
        let dictionary = CFArrayGetValueAtIndex(array, 0);
        if dictionary.is_null() || CFGetTypeID(dictionary) != CFDictionaryGetTypeID() {
            return None;
        }
        let number = CFDictionaryGetValue(dictionary.cast(), WINDOW_OWNER_PID.cast());
        if number.is_null() || CFGetTypeID(number) != CFNumberGetTypeID() {
            return None;
        }
        let mut pid = 0_i32;
        CFNumberGetValue(
            number.cast(),
            kCFNumberSInt32Type,
            ptr::from_mut(&mut pid).cast(),
        )
        .then_some(pid)
    }
}

/// The source searches the OLD host's current focused element and its parents.
pub(super) fn foreign_owner_classification(old_host: i32, allowed: &[u8]) -> Option<u8> {
    let application = application_element(old_host)?;
    let mut element = element_attribute(&application, "AXFocusedUIElement")?;
    // includingSelf=true permits self plus up to300 parent traversals.
    for depth in 0..=300 {
        if let Some(pid) = ordinary_pid(&element) {
            let classification = process_classification(pid);
            if allowed.contains(&classification) {
                return Some(classification);
            }
        }
        if depth == 300 {
            break;
        }
        element = element_attribute(&element, "AXParent")?;
    }
    None
}

fn process_classification(pid: i32) -> u8 {
    let Some(application) = running_application(pid) else {
        return 2;
    };
    // SAFETY: isFinishedLaunching returns BOOL on NSRunningApplication.
    let finished: Bool = unsafe { msg_send![&*application, isFinishedLaunching] };
    if !finished.as_bool() {
        2
    } else {
        u8::from(policy(&application) == 2)
    }
}

#[derive(Clone, Copy, Debug)]
enum NamedFallback {
    ApplicationName,
    ForegroundOnly,
}

fn resolve_host(
    application: Option<&RetainedElement>,
    provided: Option<&RetainedElement>,
    named_fallback: NamedFallback,
) -> i32 {
    let queried = if provided.is_none() {
        application.and_then(|app| element_attribute(app, "AXFocusedUIElement"))
    } else {
        None
    };
    if let Some(focused) = provided.or(queried.as_ref())
        && let Some(pid) = ordinary_pid(focused)
    {
        if regular_application(pid) {
            return pid;
        }
        if let Some(app) = application_element(pid) {
            if let Some(nested) = element_attribute(&app, "AXFocusedUIElement")
                && let Some(pid) = ordinary_pid(&nested).filter(|pid| regular_application(*pid))
            {
                return pid;
            }
            let window = element_attribute(&app, "AXFocusedWindow")
                .or_else(|| element_attribute(&app, "AXMainWindow"));
            if let Some(pid) = window
                .as_ref()
                .and_then(ordinary_pid)
                .filter(|pid| regular_application(*pid))
            {
                return pid;
            }
        }
    }
    // The source's saved w4==0 enables this branch. Auxiliary calls pass1
    // and skip it; nonauxiliary view services pass0 and may use it.
    if matches!(named_fallback, NamedFallback::ApplicationName)
        && let Some(app) = application
            .and_then(ordinary_pid)
            .and_then(running_application)
        && let Some(pid) = named_host(&app)
    {
        return pid;
    }
    actual_foreground_pid().unwrap_or(0)
}

fn auxiliary_service(application: &RetainedElement) -> Result<Option<i32>, ToolError> {
    let Some(focused) = element_attribute(application, "AXFocusedUIElement") else {
        return Ok(None);
    };
    let apis = NativeFocusApis::resolve().map_err(failed)?;
    // SAFETY: the retained AX element stays alive and on its owner thread.
    let pid = unsafe { apis.actual_pid(focused.as_ptr() as AXUIElementRef) }.ok();
    Ok(pid.filter(|pid| activation_policy(*pid) == Some(2)))
}

fn regular_application(pid: i32) -> bool {
    activation_policy(pid).is_some_and(|policy| policy != 2)
}

fn named_host(application: &AnyObject) -> Option<i32> {
    // SAFETY: localizedName is optional NSString on NSRunningApplication.
    let name: Option<Retained<NSString>> = unsafe { msg_send![application, localizedName] };
    let name = name?.to_string();
    let host_name = parenthesized_host_name(&name)?;
    let workspace = workspace()?;
    // SAFETY: NSWorkspace returns an NSArray of NSRunningApplication objects.
    let applications: Retained<NSArray<AnyObject>> =
        unsafe { msg_send![&*workspace, runningApplications] };
    let mut matching = None;
    // Indexed NSArray access is available with the existing NSArray feature;
    // its iterator would additionally require the disabled NSEnumerator feature.
    for index in 0..applications.count() {
        let application = applications.objectAtIndex(index);
        if policy(&application) == 2 {
            continue;
        }
        // SAFETY: each retained array member is an NSRunningApplication.
        let name: Option<Retained<NSString>> = unsafe { msg_send![&*application, localizedName] };
        if name.is_some_and(|name| name.to_string() == host_name) {
            if matching.is_some() {
                return None;
            }
            matching = Some(process_identifier(&application));
        }
    }
    matching
}

fn parenthesized_host_name(name: &str) -> Option<&str> {
    if !name.contains('(') || !name.contains(')') {
        return None;
    }
    let mut backwards = name.grapheme_indices(true).rev();
    let (last, character) = backwards.find(|(_, character)| *character != ")")?;
    let end = last + character.len();
    let (opening, _) = backwards.find(|(_, character)| *character == "(")?;
    Some(&name[opening + 1..end])
}

fn running_application(pid: i32) -> Option<Retained<AnyObject>> {
    let class = AnyClass::get(c"NSRunningApplication")?;
    // SAFETY: the exact class/selector is declared by AppKit, whose framework
    // is already linked. Raw messages avoid adding optional AppKit features.
    unsafe { msg_send![class, runningApplicationWithProcessIdentifier: pid] }
}

fn workspace() -> Option<Retained<AnyObject>> {
    let class = AnyClass::get(c"NSWorkspace")?;
    // SAFETY: sharedWorkspace is an NSWorkspace class method.
    Some(unsafe { msg_send![class, sharedWorkspace] })
}

fn system_uptime() -> Result<f64, ToolError> {
    let class = AnyClass::get(c"NSProcessInfo")
        .ok_or_else(|| failed("NSProcessInfo is unavailable for native focus history"))?;
    // SAFETY: Foundation declares processInfo and systemUptime on these exact
    // classes; NSTimeInterval is f64 on both supported Mac architectures.
    let process: Retained<AnyObject> = unsafe { msg_send![class, processInfo] };
    Ok(unsafe { msg_send![&*process, systemUptime] })
}

fn process_identifier(application: &AnyObject) -> i32 {
    // SAFETY: processIdentifier returns pid_t, an i32 on both supported Macs.
    unsafe { msg_send![application, processIdentifier] }
}

fn policy(application: &AnyObject) -> i64 {
    // SAFETY: activationPolicy returns NSInteger on supported64-bit Macs.
    let value: isize = unsafe { msg_send![application, activationPolicy] };
    value as i64
}

fn application_element(pid: i32) -> Option<RetainedElement> {
    // SAFETY: a create-rule AX reference is consumed by the CF owner below.
    let pointer = unsafe { AXUIElementCreateApplication(pid) };
    if pointer.is_null() {
        return None;
    }
    // SAFETY: consume the create reference after taking the existing AX
    // wrapper's retain; the returned wrapper survives this local CF owner.
    Some(unsafe {
        let owner = CFType::wrap_under_create_rule(pointer.cast());
        RetainedElement::retain(owner.as_CFTypeRef() as usize)
    })
}

fn element_attribute(element: &RetainedElement, name: &str) -> Option<RetainedElement> {
    let key = CFString::new(name);
    let mut value: CFTypeRef = ptr::null();
    // SAFETY: the element is retained, the key lives for the call, and the
    // initialized out-pointer is owned only when the native call returns it.
    let status = unsafe {
        AXUIElementCopyAttributeValue(
            element.as_ptr() as AXUIElementRef,
            key.as_concrete_TypeRef(),
            &mut value,
        )
    };
    if value.is_null() {
        return None;
    }
    // SAFETY: any nonnull returned CF value is copy-rule owned, including one
    // accompanying an error. The local owner also handles early returns.
    let value = unsafe { CFType::wrap_under_create_rule(value) };
    if status != kAXErrorSuccess {
        return None;
    }
    // SAFETY: CF type checks accept the retained generic value; only the exact
    // AX element type can be passed to the existing AX retaining wrapper.
    if unsafe { CFGetTypeID(value.as_CFTypeRef()) != AXUIElementGetTypeID() } {
        return None;
    }
    // SAFETY: the checked AX value is retained before the local copy is dropped.
    Some(unsafe { RetainedElement::retain(value.as_CFTypeRef() as usize) })
}

fn ordinary_pid(element: &RetainedElement) -> Option<i32> {
    let mut pid = 0_i32;
    // SAFETY: the retained AX reference and initialized PID output remain live.
    let status = unsafe { AXUIElementGetPid(element.as_ptr() as AXUIElementRef, &mut pid) };
    (status == kAXErrorSuccess).then_some(pid)
}

fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}

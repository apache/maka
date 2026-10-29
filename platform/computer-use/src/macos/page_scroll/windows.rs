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

//! The controller thread's retained window table and AX notifications.
//!
//! No application input or AppKit operations run in this component.

use super::target::{
    actual_pid, ax_window_id, element_attribute, ensure_actual_pid_available, string_attribute,
};
use core_foundation::{
    array::{CFArray, CFArrayRef},
    base::{CFEqual, CFGetTypeID, CFRelease, CFTypeRef, TCFType},
    dictionary::{CFDictionaryGetTypeID, CFDictionaryGetValue, CFDictionaryRef},
    number::CFNumber,
    runloop::{CFRunLoop, CFRunLoopSource, CFRunLoopSourceRef, kCFRunLoopDefaultMode},
    string::{CFString, CFStringRef},
};
use maka_agent_facts::tools::ToolError;
use platform_macos::ax::{
    bindings::{self, *},
    snapshot::RetainedElement,
};
use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, VecDeque},
    ffi::c_void,
    marker::PhantomData,
    panic::{AssertUnwindSafe, catch_unwind},
    rc::Rc,
    time::{Duration, SystemTime},
};

// AXError.h and the source observer's unconditional success branch.
const NOTIFICATION_ALREADY_REGISTERED: AXError = -25209;

/// This owner cannot be moved out of the controller's CFRunLoop thread.
#[derive(Clone)]
pub(crate) struct LocalElement {
    element: RetainedElement,
    _thread: PhantomData<Rc<()>>,
}

impl LocalElement {
    fn new(element: RetainedElement) -> Self {
        Self {
            element,
            _thread: PhantomData,
        }
    }
}

#[derive(Clone)]
pub(crate) enum WindowVariant {
    Window(LocalElement),
    Sheet(LocalElement),
    Menu(LocalElement),
}

impl WindowVariant {
    pub(crate) fn retained_window(element: RetainedElement) -> Self {
        Self::Window(LocalElement::new(element))
    }

    pub(crate) fn element(&self) -> &RetainedElement {
        match self {
            Self::Window(owner) | Self::Sheet(owner) | Self::Menu(owner) => &owner.element,
        }
    }

    pub(crate) fn window_id(&self) -> Result<u32, ToolError> {
        match self {
            Self::Window(_) | Self::Sheet(_) => ax_window_id(self.element()),
            Self::Menu(_) => menu_window_id(self.element()),
        }
    }
}

#[derive(Clone, Copy)]
enum EventKind {
    WindowCreated,
    SheetCreated,
    MenuOpened,
    MenuClosed,
    ElementDestroyed,
    WindowMoved,
    WindowResized,
}

impl EventKind {
    fn from_name(name: &str) -> Option<Self> {
        match name {
            "AXWindowCreated" => Some(Self::WindowCreated),
            "AXSheetCreated" => Some(Self::SheetCreated),
            "AXMenuOpened" => Some(Self::MenuOpened),
            "AXMenuClosed" => Some(Self::MenuClosed),
            "AXUIElementDestroyed" => Some(Self::ElementDestroyed),
            "AXWindowMoved" => Some(Self::WindowMoved),
            "AXWindowResized" => Some(Self::WindowResized),
            _ => None,
        }
    }
}

struct Notification {
    kind: EventKind,
    element: RetainedElement,
}

#[derive(Default)]
struct CallbackQueue {
    pending: RefCell<Vec<Notification>>,
    panicked: Cell<bool>,
}

struct Registration {
    element: RetainedElement,
    name: CFString,
}

/// All fields, including observer callbacks and retained snapshots, remain on
/// the controller thread. The controller owns RunLoop pumping and thread join.
pub(crate) struct Windows {
    application: RetainedElement,
    entries: HashMap<u32, WindowVariant>,
    observer: Option<Observer>,
    source: Option<CFRunLoopSource>,
    run_loop: CFRunLoop,
    queue: Box<CallbackQueue>,
    registrations: Vec<Registration>,
    control_center: bool,
    _thread: PhantomData<Rc<()>>,
}

impl Windows {
    pub(crate) fn new(pid: i32, bundle: Option<&str>) -> Result<Self, ToolError> {
        ensure_actual_pid_available()?;
        let application = super::application(pid)?;
        let mut windows = Self {
            application,
            entries: HashMap::new(),
            observer: None,
            source: None,
            run_loop: CFRunLoop::get_current(),
            queue: Box::default(),
            registrations: Vec::new(),
            control_center: bundle == Some("com.apple.controlcenter"),
            _thread: PhantomData,
        };
        windows.collect_initial()?;
        let mut observer = std::ptr::null_mut();
        // SAFETY: the callback has the AXObserver ABI, and observer is writable.
        let status = unsafe { AXObserverCreate(pid, observer_callback, &mut observer) };
        windows.observer = (!observer.is_null()).then(|| Observer(observer));
        if status != kAXErrorSuccess {
            return Err(ax_failure("create observer", status));
        }
        let observer = windows
            .observer
            .as_ref()
            .ok_or_else(|| failed("native window observer was not returned"))?;
        // SAFETY: the observer is retained by Windows, and the returned source
        // is retained separately before being attached to this thread's loop.
        let source = unsafe { AXObserverGetRunLoopSource(observer.0) };
        if source.is_null() {
            return Err(failed("native window observer has no RunLoop source"));
        }
        let source = unsafe { CFRunLoopSource::wrap_under_get_rule(source) };
        windows
            .run_loop
            .add_source(&source, unsafe { kCFRunLoopDefaultMode });
        windows.source = Some(source);
        for name in [
            "AXWindowCreated",
            "AXMenuOpened",
            "AXMenuClosed",
            "AXSheetCreated",
            "AXWindowMoved",
            "AXWindowResized",
        ] {
            windows.register(windows.application.clone(), name)?;
        }
        Ok(windows)
    }

    pub(crate) fn apply_pending_notifications(&mut self) -> Result<(), ToolError> {
        self.require_open()?;
        if self.queue.panicked.get() {
            return Err(failed("native window notification callback failed"));
        }
        loop {
            let events = std::mem::take(&mut *self.queue.pending.borrow_mut());
            if events.is_empty() {
                break;
            }
            for event in events {
                match event.kind {
                    EventKind::WindowCreated => {
                        self.insert(WindowVariant::Window(LocalElement::new(
                            event.element.clone(),
                        )));
                        self.monitor_control_center_destruction(event.element);
                    }
                    EventKind::SheetCreated => {
                        self.insert(WindowVariant::Sheet(LocalElement::new(
                            event.element.clone(),
                        )));
                        self.monitor_control_center_destruction(event.element);
                    }
                    EventKind::MenuOpened => {
                        let menu = WindowVariant::Menu(LocalElement::new(event.element));
                        wait_for_menu(&menu);
                        self.insert(menu);
                    }
                    EventKind::MenuClosed => {
                        self.entries
                            .retain(|_, window| !same_element(window.element(), &event.element));
                    }
                    EventKind::ElementDestroyed => {
                        self.remove_destroyed_registration(&event.element);
                    }
                    EventKind::WindowMoved | EventKind::WindowResized => {
                        // The original refreshes WindowOrderingObserver here.
                        // Its window map stays intact; callers query current
                        // WindowServer order through the AppKit metadata lane.
                    }
                }
            }
        }
        Ok(())
    }

    pub(crate) fn entries(&mut self) -> Result<&HashMap<u32, WindowVariant>, ToolError> {
        self.apply_pending_notifications()?;
        // Getter failures prune that stored entry. Do not replace its key with
        // a later dynamic Menu window ID or repopulate from AXWindows here.
        self.entries
            .retain(|_, window| window.window_id().is_ok_and(|id| id != 0));
        Ok(&self.entries)
    }

    pub(crate) fn close(&mut self) -> Result<(), ToolError> {
        if let Some(source) = self.source.take() {
            // SAFETY: this is the mode on which new attached the source.
            self.run_loop
                .remove_source(&source, unsafe { kCFRunLoopDefaultMode });
        }
        // AXObserver's documented release contract removes its registrations
        // and RunLoop source, including registrations on destroyed elements.
        // Unlike per-element RemoveNotification, this teardown has no AXError.
        drop(self.observer.take());
        self.registrations.clear();
        self.queue.pending.borrow_mut().clear();
        self.entries.clear();
        Ok(())
    }

    fn require_open(&self) -> Result<(), ToolError> {
        if self.observer.is_some() {
            Ok(())
        } else {
            Err(failed("native window observer is closed"))
        }
    }

    pub(crate) fn primary_window_id(&self) -> Result<Option<u32>, ToolError> {
        self.require_open()?;
        self.primary_window()?
            .as_ref()
            .map(ax_window_id)
            .transpose()
    }

    fn primary_window(&self) -> Result<Option<RetainedElement>, ToolError> {
        if let Some(window) = element_attribute(&self.application, "AXFocusedWindow")? {
            Ok(Some(window))
        } else if let Some(window) = element_attribute(&self.application, "AXMainWindow")? {
            Ok(Some(window))
        } else {
            Ok(element_list(&self.application, "AXWindows")?.pop())
        }
    }

    fn collect_initial(&mut self) -> Result<(), ToolError> {
        let Some(primary) = self.primary_window()? else {
            return Ok(());
        };
        self.insert(WindowVariant::Window(LocalElement::new(primary.clone())));
        let mut pending = VecDeque::from(element_list(&primary, "AXChildren")?);
        while let Some(element) = pending.pop_front() {
            if string_attribute(&element, "AXRole")?.as_deref() == Some("AXSheet") {
                self.insert(WindowVariant::Sheet(LocalElement::new(element.clone())));
            }
            pending.extend(element_list(&element, "AXChildren")?);
        }
        Ok(())
    }

    fn insert(&mut self, window: WindowVariant) {
        // The original insertion helpers release getter errors and continue.
        // A successful zero is inserted and is pruned by the ordinary getter.
        if let Ok(id) = window.window_id() {
            self.entries.insert(id, window);
        }
    }

    fn register(&mut self, element: RetainedElement, name: &str) -> Result<(), ToolError> {
        let observer = self
            .observer
            .as_ref()
            .ok_or_else(|| failed("native window observer is closed"))?;
        let name = CFString::new(name);
        // SAFETY: the observer and element are retained. CallbackQueue's Box
        // has a stable address until the source is detached and observer freed.
        let status = unsafe {
            AXObserverAddNotification(
                observer.0,
                element.as_ptr() as AXUIElementRef,
                name.as_concrete_TypeRef(),
                (&raw mut *self.queue).cast(),
            )
        };
        if status != kAXErrorSuccess && status != NOTIFICATION_ALREADY_REGISTERED {
            return Err(ax_failure("register notification", status));
        }
        if !self.registrations.iter().any(|registration| {
            registration.name == name && same_element(&registration.element, &element)
        }) {
            self.registrations.push(Registration { element, name });
        }
        Ok(())
    }

    fn monitor_control_center_destruction(&mut self, element: RetainedElement) {
        if self.control_center {
            // This optional registration's errors are also released by the
            // source notification handler, after the window was inserted.
            let _ = self.register(element, "AXUIElementDestroyed");
        }
    }

    fn remove_destroyed_registration(&mut self, element: &RetainedElement) {
        let Some(observer) = self.observer.as_ref() else {
            return;
        };
        let name = CFString::new("AXUIElementDestroyed");
        // SAFETY: both owned references remain live throughout unregistration.
        unsafe {
            AXObserverRemoveNotification(
                observer.0,
                element.as_ptr() as _,
                name.as_concrete_TypeRef(),
            );
        }
        self.registrations.retain(|registration| {
            registration.name != name || !same_element(&registration.element, element)
        });
    }
}

impl Drop for Windows {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

#[repr(C)]
struct NativeObserver(c_void);
type ObserverRef = *mut NativeObserver;

struct Observer(ObserverRef);

impl Drop for Observer {
    fn drop(&mut self) {
        // SAFETY: this owner releases the copied AXObserver reference once.
        unsafe { CFRelease(self.0.cast()) };
    }
}

unsafe extern "C" fn observer_callback(
    _observer: ObserverRef,
    element: AXUIElementRef,
    name: CFStringRef,
    context: *mut c_void,
) {
    if element.is_null() || name.is_null() || context.is_null() {
        return;
    }
    // SAFETY: registration passed this queue's stable Box address. Its observer
    // and source are removed before the queue can be released, on this thread.
    let queue = unsafe { &*context.cast::<CallbackQueue>() };
    let result = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: AX supplies borrowed CFString and AX element references valid
        // throughout this callback. Only the owned copy survives its return.
        let name = unsafe { CFString::wrap_under_get_rule(name) }.to_string();
        if let Some(kind) = EventKind::from_name(&name) {
            let element = unsafe { RetainedElement::retain(element as usize) };
            queue
                .pending
                .borrow_mut()
                .push(Notification { kind, element });
        }
    }));
    if result.is_err() {
        queue.panicked.set(true);
    }
}

fn wait_for_menu(menu: &WindowVariant) {
    // These wall-clock timeout and sleep values belong to the source menu
    // notification recipe; they are not a new window-enumeration budget.
    let started = SystemTime::now();
    loop {
        let elapsed = match SystemTime::now().duration_since(started) {
            Ok(elapsed) => elapsed.as_secs_f64(),
            Err(backwards) => -backwards.duration().as_secs_f64(),
        };
        if elapsed > 0.25 || menu.window_id().is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn menu_window_id(menu: &RetainedElement) -> Result<u32, ToolError> {
    let owner = actual_pid(menu)?;
    let anchor = ax_window_id(menu)?;
    // OnScreenAboveWindow | ExcludeDesktopElements, in native list order.
    // SAFETY: CGWindowListCopyWindowInfo returns a copied nullable CFArray.
    let list = unsafe { CGWindowListCopyWindowInfo(0x12, anchor) };
    if list.is_null() {
        return Err(failed("native menu WindowServer list is unavailable"));
    }
    let list = unsafe { CFArray::<CFTypeRef>::wrap_under_create_rule(list) };
    let candidates = list.iter().filter_map(|value| {
        // SAFETY: the list owns every borrowed dictionary for this iteration.
        let value = *value;
        if unsafe { CFGetTypeID(value) } != unsafe { CFDictionaryGetTypeID() } {
            return None;
        }
        let dictionary = value as CFDictionaryRef;
        let pid = i32::try_from(dictionary_number(dictionary, "kCGWindowOwnerPID")?).ok()?;
        let layer = i32::try_from(dictionary_number(dictionary, "kCGWindowLayer")?).ok()?;
        let id = u32::try_from(dictionary_number(dictionary, "kCGWindowNumber")?).ok()?;
        Some((id, pid, layer))
    });
    select_menu_window(candidates, owner)
        .ok_or_else(|| failed("native menu has no matching WindowServer window"))
}

fn select_menu_window(
    candidates: impl IntoIterator<Item = (u32, i32, i32)>,
    owner: i32,
) -> Option<u32> {
    candidates
        .into_iter()
        .find_map(|(id, pid, layer)| (pid == owner && matches!(layer, 101 | 24)).then_some(id))
}

fn dictionary_number(dictionary: CFDictionaryRef, key: &str) -> Option<i64> {
    let key = CFString::new(key);
    // SAFETY: dictionary's type was checked; the borrowed value remains owned
    // by its array until its CFNumber wrapper has released its extra retain.
    let value = unsafe { CFDictionaryGetValue(dictionary, key.as_concrete_TypeRef().cast()) };
    if value.is_null() || unsafe { CFGetTypeID(value) } != CFNumber::type_id() {
        return None;
    }
    unsafe { CFNumber::wrap_under_get_rule(value as _) }.to_i64()
}

fn element_list(element: &RetainedElement, name: &str) -> Result<Vec<RetainedElement>, ToolError> {
    let name = CFString::new(name);
    let mut value = std::ptr::null();
    // SAFETY: the input is retained; the output is a copied nullable CF value.
    let status = unsafe {
        AXUIElementCopyAttributeValue(
            element.as_ptr() as _,
            name.as_concrete_TypeRef(),
            &mut value,
        )
    };
    let value = (!value.is_null()).then(|| NativeValue(value));
    if matches!(
        status,
        bindings::kAXErrorAttributeUnsupported | bindings::kAXErrorNoValue
    ) {
        return Ok(Vec::new());
    }
    if status != kAXErrorSuccess {
        return Err(ax_failure("read element list", status));
    }
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    if unsafe { CFGetTypeID(value.0) } != CFArray::<CFTypeRef>::type_id() {
        return Err(failed(
            "native window element list returned an unexpected type",
        ));
    }
    let array = unsafe { CFArray::<CFTypeRef>::wrap_under_get_rule(value.0.cast()) };
    array
        .iter()
        .map(|value| {
            if unsafe { CFGetTypeID(*value) } != unsafe { AXUIElementGetTypeID() } {
                return Err(failed("native window child returned an unexpected type"));
            }
            // SAFETY: the checked array owns this AX element until it is retained.
            Ok(unsafe { RetainedElement::retain(*value as usize) })
        })
        .collect()
}

struct NativeValue(CFTypeRef);

impl Drop for NativeValue {
    fn drop(&mut self) {
        // SAFETY: this wrapper owns the copied non-null native value.
        unsafe { CFRelease(self.0) };
    }
}

fn same_element(first: &RetainedElement, second: &RetainedElement) -> bool {
    // SAFETY: both owners keep their AX objects retained during comparison.
    unsafe {
        CFEqual(
            (first.as_ptr() as AXUIElementRef).cast(),
            (second.as_ptr() as AXUIElementRef).cast(),
        ) != 0
    }
}

fn ax_failure(operation: &str, error: AXError) -> ToolError {
    failed(format!(
        "native window table {operation} failed with AX error {error}"
    ))
}

fn failed(message: impl Into<String>) -> ToolError {
    ToolError::Failed(message.into())
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXObserverCreate(
        pid: i32,
        callback: unsafe extern "C" fn(ObserverRef, AXUIElementRef, CFStringRef, *mut c_void),
        observer: *mut ObserverRef,
    ) -> AXError;
    fn AXObserverAddNotification(
        observer: ObserverRef,
        element: AXUIElementRef,
        name: CFStringRef,
        context: *mut c_void,
    ) -> AXError;
    fn AXObserverRemoveNotification(
        observer: ObserverRef,
        element: AXUIElementRef,
        name: CFStringRef,
    ) -> AXError;
    fn AXObserverGetRunLoopSource(observer: ObserverRef) -> CFRunLoopSourceRef;
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGWindowListCopyWindowInfo(options: u32, relative_window: u32) -> CFArrayRef;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_window_selection_keeps_source_order_and_requires_owner_and_menu_layer() {
        let windows = [(90, 8, 24), (91, 7, 0), (92, 7, 101), (93, 7, 24)];
        assert_eq!(select_menu_window(windows, 7), Some(92));
        assert_eq!(select_menu_window(windows.into_iter().rev(), 7), Some(93));
        assert_eq!(select_menu_window(windows, 9), None);
    }
}

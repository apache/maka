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

//! Reveal a retained AX element without changing its identity or input target.

use super::{
    clickable_point::center_is_visible,
    target::{action_names, element_attribute, frame_attribute, string_attribute},
};
use core_foundation::{
    array::CFArray,
    base::{CFEqual, CFGetTypeID, CFHash, CFRelease, CFTypeRef, TCFType},
    boolean::CFBoolean,
    number::CFNumber,
    string::CFString,
};
use cua_driver_contract::WindowBounds;
use maka_agent_facts::tools::ToolError;
use objc2::{msg_send, runtime::AnyObject};
use platform_macos::ax::{
    bindings::{self, AXError, AXUIElementRef, AXValueRef, AXValueType},
    snapshot::RetainedElement,
};
use std::{
    cell::Cell,
    collections::HashSet,
    hash::{Hash, Hasher},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

const VISIBILITY_TIMEOUT: Duration = Duration::from_millis(500);
const VISIBILITY_INTERVAL: Duration = Duration::from_millis(100);
const SCROLL_ACTION: &str = "AXScrollToVisible";
const SCROLL_ATTRIBUTE: &str = "AXScrollToVisible";
const RECT_ATTRIBUTE: &str = "AXMakeScreenRectVisible";

enum Step {
    Action(RetainedElement),
    Cell(RetainedElement),
    ScrollArea(RetainedElement),
}

/// Run on the caller's retained CF owner while its input permit remains alive.
/// The guard must reject retired epochs and released application slots.
pub(in crate::macos) fn reveal(
    element: &RetainedElement,
    rectangle: WindowBounds,
    cancellation: &CancellationToken,
    guard: &mut impl FnMut() -> Result<(), ToolError>,
    effects: &Cell<bool>,
) -> Result<bool, ToolError> {
    let mut context = Context {
        cancellation,
        guard,
        effects,
    };
    let plan = plan(element, &mut context)?;
    let rectangle = Rect::from(rectangle);
    let mut changed = false;
    for step in plan {
        match step {
            Step::Action(element) => {
                context.effect(|| {
                    // SAFETY: the plan retains this AX element on the CF owner.
                    ax_result(SCROLL_ACTION, unsafe {
                        bindings::perform_action(element.as_ptr() as AXUIElementRef, SCROLL_ACTION)
                    })
                })?;
                changed = true;
            }
            Step::Cell(element) => {
                context.effect(|| {
                    // SAFETY: the plan retains this AX element through the write.
                    ax_result(SCROLL_ATTRIBUTE, unsafe {
                        bindings::set_bool_attr_true(
                            element.as_ptr() as AXUIElementRef,
                            SCROLL_ATTRIBUTE,
                        )
                    })
                })?;
                changed = true;
            }
            Step::ScrollArea(element) => {
                changed |= scroll_area(&element, rectangle, &mut context)?;
            }
        }
    }
    if changed {
        poll_visibility(element, &mut context)?;
    }
    Ok(changed)
}

fn plan(
    element: &RetainedElement,
    context: &mut Context<'_, impl FnMut() -> Result<(), ToolError>>,
) -> Result<Vec<Step>, ToolError> {
    let mut steps = Vec::new();
    let mut current = Some(element.clone());
    let mut selected = false;
    while let Some(element) = current.take() {
        let role = context
            .observe(|| string_attribute(&element, "AXRole"))?
            .flatten();
        if matches!(
            role.as_deref(),
            Some("AXWindow" | "AXSheet" | "AXMenu" | "AXPopover")
        ) {
            break;
        }
        if !selected {
            let actions = context
                .observe(|| action_names(&element))?
                .unwrap_or_default();
            if actions.iter().any(|action| action == SCROLL_ACTION) {
                steps.push(Step::Action(element.clone()));
                selected = true;
            } else if role.as_deref() == Some("AXCell")
                && is_settable(&element, SCROLL_ATTRIBUTE, context)?
            {
                steps.push(Step::Cell(element.clone()));
                selected = true;
            }
        }
        if !selected && role.as_deref() == Some("AXScrollArea") {
            steps.push(Step::ScrollArea(element.clone()));
        }
        let scroll_container = is_scroll_container(&element, role.as_deref(), context)?;
        current = context
            .observe(|| element_attribute(&element, "AXParent"))?
            .flatten();
        selected &= !scroll_container;
    }
    Ok(steps)
}

fn is_scroll_container(
    element: &RetainedElement,
    role: Option<&str>,
    context: &mut Context<'_, impl FnMut() -> Result<(), ToolError>>,
) -> Result<bool, ToolError> {
    if role == Some("AXScrollArea") {
        return Ok(true);
    }
    if role != Some("AXGroup") {
        return Ok(false);
    }
    Ok(context
        .observe(|| action_names(element))?
        .unwrap_or_default()
        .iter()
        .any(|action| {
            matches!(
                action.as_str(),
                "AXScrollLeftByPage"
                    | "AXScrollRightByPage"
                    | "AXScrollUpByPage"
                    | "AXScrollDownByPage"
            )
        }))
}

fn scroll_area(
    element: &RetainedElement,
    requested: Rect,
    context: &mut Context<'_, impl FnMut() -> Result<(), ToolError>>,
) -> Result<bool, ToolError> {
    // SAFETY: the rectangle is a by-value CGRect with its native dimensions.
    if unsafe { CGRectIsInfinite(requested) || CGRectIsEmpty(requested) } {
        return Ok(false);
    }
    let Some(view) = native_frame(element, context)? else {
        return Ok(false);
    };
    // SAFETY: both rectangles have the public CGRect layout.
    if unsafe { CGRectContainsRect(view, requested) } {
        return Ok(false);
    }
    let mut handled = false;
    let mut changed = false;
    for axis in [Axis::Vertical, Axis::Horizontal] {
        let Some(bar) = context
            .observe(|| element_attribute(element, axis.attribute()))?
            .flatten()
        else {
            continue;
        };
        if context
            .observe(|| boolean_attribute(&bar, "AXEnabled"))?
            .flatten()
            == Some(false)
        {
            continue;
        }
        let (target_min, target_max) = axis.edges(requested);
        let (view_min, view_max) = axis.edges(view);
        if !(target_min < view_min || view_max < target_max) {
            handled = true;
            continue;
        }
        let content = content_frame(element, context)?;
        let content_length = axis.length(content);
        let view_length = axis.length(view);
        let content_min = axis.edges(content).0;
        let value = context
            .observe(|| number_attribute(&bar, "AXValue"))?
            .flatten();
        let range = content_length - view_length;
        if range.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
            handled = true;
            continue;
        }
        let target_length = target_max - target_min;
        let delta = if target_length <= view_length {
            (target_min + target_max - view_min - view_max) * 0.5
        } else if target_min < view_min {
            target_min - view_min
        } else if view_max < target_max {
            target_max - view_max
        } else {
            handled = true;
            continue;
        };
        let offset = match value {
            Some(value) => {
                let capped = if value > 1.0 { 1.0 } else { value };
                let capped = if value <= 0.0 { 0.0 } else { capped };
                capped * range
            }
            None => nonnegative_offset(view_min - content_min, range),
        };
        let offset = nonnegative_offset(delta + offset, range);
        let value = ordered_clamp(offset / range, 0.0, 1.0);
        context.effect(|| {
            // SAFETY: the retained scrollbar remains owned through this write.
            ax_result("AXValue", unsafe {
                bindings::set_number_attr(bar.as_ptr() as AXUIElementRef, "AXValue", value)
            })
        })?;
        handled = true;
        changed = true;
    }
    if handled || changed || !supported_and_settable(element, RECT_ATTRIBUTE, context)? {
        return Ok(changed);
    }
    set_rectangle(element, RECT_ATTRIBUTE, requested, context)?;
    Ok(true)
}

fn nonnegative_offset(value: f64, upper: f64) -> f64 {
    if value > 0.0 {
        if upper < value { upper } else { value }
    } else {
        0.0
    }
}

fn ordered_clamp(value: f64, lower: f64, upper: f64) -> f64 {
    let value = if value < lower { lower } else { value };
    if upper < value { upper } else { value }
}

fn content_frame(
    element: &RetainedElement,
    context: &mut Context<'_, impl FnMut() -> Result<(), ToolError>>,
) -> Result<Rect, ToolError> {
    let mut pending = context.observe(|| children(element))?.unwrap_or_default();
    let mut seen = HashSet::new();
    // SAFETY: CoreGraphics exports this immutable CGRect constant.
    let mut frame = unsafe { CGRectNull };
    while let Some(element) = pending.pop() {
        context.check()?;
        let role = context
            .observe(|| string_attribute(&element, "AXRole"))?
            .flatten();
        if role.as_deref() == Some("AXScrollBar") || !seen.insert(ElementIdentity(element.clone()))
        {
            continue;
        }
        if let Some(child_frame) = native_frame(&element, context)? {
            // SAFETY: preserve native empty/null and union semantics.
            if !unsafe { CGRectIsEmpty(child_frame) } {
                frame = unsafe { CGRectUnion(frame, child_frame) };
            }
        }
        if !is_scroll_container(&element, role.as_deref(), context)? {
            pending.extend(context.observe(|| children(&element))?.unwrap_or_default());
        }
    }
    Ok(frame)
}

struct ElementIdentity(RetainedElement);

impl PartialEq for ElementIdentity {
    fn eq(&self, other: &Self) -> bool {
        // SAFETY: both retained values are live CF AX objects.
        unsafe { CFEqual(self.0.as_ptr() as CFTypeRef, other.0.as_ptr() as CFTypeRef) != 0 }
    }
}

impl Eq for ElementIdentity {}

impl Hash for ElementIdentity {
    fn hash<H: Hasher>(&self, state: &mut H) {
        // SAFETY: CFHash and CFEqual use the same live AX object identity.
        unsafe { CFHash(self.0.as_ptr() as CFTypeRef) }.hash(state);
    }
}

fn native_frame(
    element: &RetainedElement,
    context: &mut Context<'_, impl FnMut() -> Result<(), ToolError>>,
) -> Result<Option<Rect>, ToolError> {
    if let Some(frame) = context.observe(|| frame_attribute(element))?.flatten() {
        return Ok(Some(frame.into()));
    }
    context
        .observe(|| {
            let Some(position) = attribute(element, "AXPosition")? else {
                return Ok(None);
            };
            let mut point = Point::default();
            read_ax_value(
                &position,
                "AXPosition",
                bindings::kAXValueCGPointType,
                &mut point,
            )?;
            let Some(size) = attribute(element, "AXSize")? else {
                return Ok(None);
            };
            let mut size_value = Size::default();
            read_ax_value(
                &size,
                "AXSize",
                bindings::kAXValueCGSizeType,
                &mut size_value,
            )?;
            Ok(Some(Rect {
                origin: point,
                size: size_value,
            }))
        })
        .map(Option::flatten)
}

fn poll_visibility(
    element: &RetainedElement,
    context: &mut Context<'_, impl FnMut() -> Result<(), ToolError>>,
) -> Result<(), ToolError> {
    let started = Instant::now();
    loop {
        context.check()?;
        let visible = center_is_visible(element, context.cancellation).unwrap_or(false);
        context.check()?;
        if visible || started.elapsed() >= VISIBILITY_TIMEOUT {
            return Ok(());
        }
        std::thread::sleep(VISIBILITY_INTERVAL);
        context.check()?;
    }
}

struct Context<'a, F> {
    cancellation: &'a CancellationToken,
    guard: &'a mut F,
    effects: &'a Cell<bool>,
}

impl<F: FnMut() -> Result<(), ToolError>> Context<'_, F> {
    fn check(&mut self) -> Result<(), ToolError> {
        (self.guard)()?;
        if self.cancellation.is_cancelled() {
            return Err(failed("native element reveal was cancelled"));
        }
        Ok(())
    }

    fn run<T>(&mut self, operation: impl FnOnce() -> Result<T, ToolError>) -> Result<T, ToolError> {
        self.check()?;
        let result = operation();
        let guard = self.check();
        let value = result?;
        guard?;
        Ok(value)
    }

    fn effect<T>(
        &mut self,
        operation: impl FnOnce() -> Result<T, ToolError>,
    ) -> Result<T, ToolError> {
        self.check()?;
        self.effects.set(true);
        let result = operation();
        let guard = self.check();
        let value = result?;
        guard?;
        Ok(value)
    }

    fn observe<T>(
        &mut self,
        operation: impl FnOnce() -> Result<T, ToolError>,
    ) -> Result<Option<T>, ToolError> {
        self.check()?;
        let result = operation();
        self.check()?;
        Ok(result.ok())
    }
}

#[derive(Clone, Copy)]
enum Axis {
    Vertical,
    Horizontal,
}

impl Axis {
    fn attribute(self) -> &'static str {
        match self {
            Self::Vertical => "AXVerticalScrollBar",
            Self::Horizontal => "AXHorizontalScrollBar",
        }
    }

    fn edges(self, rect: Rect) -> (f64, f64) {
        // SAFETY: each accessor consumes the native by-value CGRect layout.
        unsafe {
            match self {
                Self::Vertical => (CGRectGetMinY(rect), CGRectGetMaxY(rect)),
                Self::Horizontal => (CGRectGetMinX(rect), CGRectGetMaxX(rect)),
            }
        }
    }

    fn length(self, rect: Rect) -> f64 {
        // SAFETY: retain native CGFloat projection behavior for negative sizes.
        unsafe {
            match self {
                Self::Vertical => CGRectGetHeight(rect),
                Self::Horizontal => CGRectGetWidth(rect),
            }
        }
    }
}

fn is_settable(
    element: &RetainedElement,
    name: &str,
    context: &mut Context<'_, impl FnMut() -> Result<(), ToolError>>,
) -> Result<bool, ToolError> {
    context.run(|| {
        // SAFETY: the retained AX element stays live during the query.
        Ok(unsafe { bindings::is_attribute_settable(element.as_ptr() as AXUIElementRef, name) })
    })
}

fn supported_and_settable(
    element: &RetainedElement,
    name: &str,
    context: &mut Context<'_, impl FnMut() -> Result<(), ToolError>>,
) -> Result<bool, ToolError> {
    let names = context
        .observe(|| attribute_names(element))?
        .unwrap_or_default();
    if !names.iter().any(|candidate| candidate == name) {
        return Ok(false);
    }
    is_settable(element, name, context)
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
        // SAFETY: every instance owns exactly one copied CF reference.
        unsafe { CFRelease(self.0) };
    }
}

fn attribute(element: &RetainedElement, name: &str) -> Result<Option<NativeValue>, ToolError> {
    let key = CFString::new(name);
    let mut value = std::ptr::null();
    // SAFETY: live AX element, owned key and writable copied-value output.
    let status = unsafe {
        bindings::AXUIElementCopyAttributeValue(
            element.as_ptr() as AXUIElementRef,
            key.as_concrete_TypeRef(),
            &mut value,
        )
    };
    let value = NativeValue::new(value);
    if matches!(
        status,
        bindings::kAXErrorAttributeUnsupported | bindings::kAXErrorNoValue
    ) {
        return Ok(None);
    }
    ax_result(name, status)?;
    Ok(value)
}

fn children(element: &RetainedElement) -> Result<Vec<RetainedElement>, ToolError> {
    let Some(value) = attribute(element, "AXChildren")? else {
        return Ok(Vec::new());
    };
    // SAFETY: this only queries the copied CF object's type identifier.
    if unsafe { CFGetTypeID(value.0) } != CFArray::<CFTypeRef>::type_id() {
        return Err(type_failure("AXChildren"));
    }
    // SAFETY: the checked CFArray stays owned through item retention.
    let array = unsafe { CFArray::<CFTypeRef>::wrap_under_get_rule(value.0 as _) };
    array
        .iter()
        .map(|item| {
            // SAFETY: each array item is retained by the array while checked.
            if unsafe { CFGetTypeID(*item) } != unsafe { AXUIElementGetTypeID() } {
                return Err(type_failure("AXChildren item"));
            }
            // SAFETY: the checked AX item is retained before the array is released.
            Ok(unsafe { RetainedElement::retain(*item as usize) })
        })
        .collect()
}

fn attribute_names(element: &RetainedElement) -> Result<Vec<String>, ToolError> {
    let mut names = std::ptr::null();
    // SAFETY: the output receives one copied CFArray from a live AX element.
    let status = unsafe {
        bindings::AXUIElementCopyAttributeNames(element.as_ptr() as AXUIElementRef, &mut names)
    };
    let names = NativeValue::new(names.cast());
    ax_result("attribute names", status)?;
    let Some(names) = names else {
        return Ok(Vec::new());
    };
    // SAFETY: only inspect the retained CF type identifier here.
    if unsafe { CFGetTypeID(names.0) } != CFArray::<CFTypeRef>::type_id() {
        return Err(type_failure("attribute names"));
    }
    // SAFETY: the checked copied CFArray remains retained during iteration.
    let array = unsafe { CFArray::<CFTypeRef>::wrap_under_get_rule(names.0 as _) };
    array
        .iter()
        .map(|item| {
            // SAFETY: the array keeps each CF value live during its type check.
            if unsafe { CFGetTypeID(*item) } != CFString::type_id() {
                return Err(type_failure("attribute name"));
            }
            // SAFETY: the checked string remains retained by the array.
            Ok(unsafe { CFString::wrap_under_get_rule(*item as _) }.to_string())
        })
        .collect()
}

fn boolean_attribute(element: &RetainedElement, name: &str) -> Result<Option<bool>, ToolError> {
    let Some(value) = attribute(element, name)? else {
        return Ok(None);
    };
    // SAFETY: the copied native object is retained through its CF type query.
    if unsafe { CFGetTypeID(value.0) } != CFBoolean::type_id() {
        return Err(type_failure(name));
    }
    // SAFETY: the type was checked and the copied value stays retained.
    Ok(Some(bool::from(unsafe {
        CFBoolean::wrap_under_get_rule(value.0 as _)
    })))
}

fn number_attribute(element: &RetainedElement, name: &str) -> Result<Option<f64>, ToolError> {
    let Some(value) = attribute(element, name)? else {
        return Ok(None);
    };
    // SAFETY: inspect the copied CF value before relying on NSNumber bridging.
    let kind = unsafe { CFGetTypeID(value.0) };
    if kind != CFNumber::type_id() && kind != CFBoolean::type_id() {
        return Err(type_failure(name));
    }
    // SAFETY: CFNumber and CFBoolean have NSNumber Objective-C counterparts;
    // the checked value stays retained through the numeric accessor.
    let object = unsafe { &*(value.0.cast::<AnyObject>()) };
    // SAFETY: the object is an NSNumber and remains retained by `value`.
    Ok(Some(unsafe { msg_send![object, doubleValue] }))
}

fn read_ax_value<T>(
    value: &NativeValue,
    name: &str,
    kind: AXValueType,
    output: &mut T,
) -> Result<(), ToolError> {
    // SAFETY: check both CF and AXValue kinds before writing a C-layout output.
    if unsafe { CFGetTypeID(value.0) } != unsafe { AXValueGetTypeID() }
        || unsafe { bindings::AXValueGetType(value.0 as AXValueRef) } != kind
    {
        return Err(type_failure(name));
    }
    // SAFETY: each private caller pairs its output layout with the checked kind.
    if !unsafe { bindings::AXValueGetValue(value.0 as AXValueRef, kind, (output as *mut T).cast()) }
    {
        return Err(type_failure(name));
    }
    Ok(())
}

fn set_rectangle(
    element: &RetainedElement,
    name: &str,
    rectangle: Rect,
    context: &mut Context<'_, impl FnMut() -> Result<(), ToolError>>,
) -> Result<(), ToolError> {
    // SAFETY: the pointed-to local has the exact CGRect layout and lives through
    // AXValueCreate, which copies the rectangle.
    let value = NativeValue::new(unsafe {
        bindings::AXValueCreate(
            bindings::kAXValueCGRectType,
            (&rectangle as *const Rect).cast(),
        )
        .cast()
    })
    .ok_or_else(|| failed("native element reveal could not create an AX rectangle"))?;
    let key = CFString::new(name);
    // SAFETY: the element, key and AXValue stay retained through the setter.
    context.effect(|| {
        ax_result(name, unsafe {
            bindings::AXUIElementSetAttributeValue(
                element.as_ptr() as AXUIElementRef,
                key.as_concrete_TypeRef(),
                value.0,
            )
        })
    })
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Point {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Size {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Rect {
    origin: Point,
    size: Size,
}

impl From<WindowBounds> for Rect {
    fn from(value: WindowBounds) -> Self {
        Self {
            origin: Point {
                x: value.x,
                y: value.y,
            },
            size: Size {
                width: value.width,
                height: value.height,
            },
        }
    }
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    static CGRectNull: Rect;
    fn CGRectIsInfinite(rectangle: Rect) -> bool;
    fn CGRectIsEmpty(rectangle: Rect) -> bool;
    fn CGRectContainsRect(first: Rect, second: Rect) -> bool;
    fn CGRectUnion(first: Rect, second: Rect) -> Rect;
    fn CGRectGetMinX(rectangle: Rect) -> f64;
    fn CGRectGetMaxX(rectangle: Rect) -> f64;
    fn CGRectGetMinY(rectangle: Rect) -> f64;
    fn CGRectGetMaxY(rectangle: Rect) -> f64;
    fn CGRectGetHeight(rectangle: Rect) -> f64;
    fn CGRectGetWidth(rectangle: Rect) -> f64;
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXValueGetTypeID() -> core_foundation::base::CFTypeID;
    fn AXUIElementGetTypeID() -> core_foundation::base::CFTypeID;
}

fn ax_result(operation: &str, status: AXError) -> Result<(), ToolError> {
    if status == bindings::kAXErrorSuccess {
        Ok(())
    } else {
        Err(failed(format!(
            "native element reveal {operation} failed with AX error {status}"
        )))
    }
}

fn type_failure(attribute: &str) -> ToolError {
    failed(format!(
        "native element reveal {attribute} returned an unexpected native type"
    ))
}

fn failed(message: impl Into<String>) -> ToolError {
    ToolError::Failed(message.into())
}

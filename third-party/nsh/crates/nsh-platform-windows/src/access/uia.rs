//! The UI Automation providers: [`Root`] for the window's content (the
//! fragment root, hosted by the window's own provider) and [`Element`] for
//! each exposed view, with the control patterns.
//!
//! Providers are made whenever UI Automation asks for one and hold only
//! the surface's key and the node id: each call finds the surface and the
//! view again ([`target`]), and answers `UIA_E_ELEMENTNOTAVAILABLE` when
//! either is gone or the view is no longer exposed. Two providers of one
//! node are the same element to UIA (same runtime id).
//!
//! The providers are server-side and use COM threading: calls from other
//! processes are marshalled to the window's (main) thread, which owns the
//! surfaces ([`Surface::by_key`] is per thread, so a call that arrived
//! elsewhere would find no surface rather than touch one).

// UIA's constants (`UIA_NamePropertyId`, ...) are matched as patterns.
#![allow(non_upper_case_globals)]

use std::{mem::ManuallyDrop, rc::Rc};

use nsh_core::{Checked, Command, NodeId, Points, ROOT_ID, ViewKind};
use windows::{
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, POINT, VARIANT_FALSE, VARIANT_TRUE, WPARAM},
        Graphics::Gdi::{ClientToScreen, ScreenToClient},
        System::{
            Com::SAFEARRAY,
            Ole::{SafeArrayCreateVector, SafeArrayPutElement},
            Variant::{VARIANT, VT_BOOL, VT_BSTR, VT_I4, VT_R8, VariantClear},
        },
        UI::Accessibility::*,
    },
    core::{BOOL, BSTR, Error, HRESULT, IUnknown, IUnknownImpl, PCWSTR, Result, implement},
};

use super::{Control, Exposed, Part, part};
use crate::{geom::Mat4, surface::Surface, view::NshView};

// --- VARIANTs --------------------------------------------------------------

/// A VARIANT this module made; cleared when dropped (event values), or
/// handed over to UIA with [`Var::into_raw`] (property values).
struct Var(VARIANT);

impl Var {
    fn empty() -> Var {
        Var(VARIANT::default())
    }

    fn i32(v: i32) -> Var {
        let mut var = VARIANT::default();
        // SAFETY: setting the type and the member it names of an empty
        // VARIANT.
        unsafe {
            let inner = &mut *var.Anonymous.Anonymous;
            inner.vt = VT_I4;
            inner.Anonymous.lVal = v;
        }
        Var(var)
    }

    fn f64(v: f64) -> Var {
        let mut var = VARIANT::default();
        // SAFETY: as in `Var::i32`.
        unsafe {
            let inner = &mut *var.Anonymous.Anonymous;
            inner.vt = VT_R8;
            inner.Anonymous.dblVal = v;
        }
        Var(var)
    }

    fn bool(v: bool) -> Var {
        let mut var = VARIANT::default();
        // SAFETY: as in `Var::i32`.
        unsafe {
            let inner = &mut *var.Anonymous.Anonymous;
            inner.vt = VT_BOOL;
            inner.Anonymous.boolVal = if v { VARIANT_TRUE } else { VARIANT_FALSE };
        }
        Var(var)
    }

    fn str(v: &str) -> Var {
        let mut var = VARIANT::default();
        // SAFETY: as in `Var::i32`; the VARIANT owns the string from now
        // on (`VariantClear` frees it).
        unsafe {
            let inner = &mut *var.Anonymous.Anonymous;
            inner.vt = VT_BSTR;
            inner.Anonymous.bstrVal = ManuallyDrop::new(BSTR::from(v));
        }
        Var(var)
    }

    fn opt_str(v: Option<&str>) -> Var {
        v.map_or_else(Var::empty, Var::str)
    }

    /// Hands the value over (UIA frees it).
    fn into_raw(self) -> VARIANT {
        let this = ManuallyDrop::new(self);
        // SAFETY: `this` is never used or dropped again.
        unsafe { std::ptr::read(&this.0) }
    }
}

impl Drop for Var {
    fn drop(&mut self) {
        // SAFETY: a VARIANT this module initialized.
        let _ = unsafe { VariantClear(&mut self.0) };
    }
}

fn not_available() -> Error {
    Error::from_hresult(HRESULT(UIA_E_ELEMENTNOTAVAILABLE as i32))
}

fn not_enabled() -> Error {
    Error::from_hresult(HRESULT(UIA_E_ELEMENTNOTENABLED as i32))
}

fn not_supported() -> Error {
    Error::from_hresult(HRESULT(UIA_E_NOTSUPPORTED as i32))
}

/// A null result (COM's "no such element" for out parameters).
fn none<T>() -> Result<T> {
    Err(Error::empty())
}

// --- Finding views ---------------------------------------------------------

/// The surface and the exposed view a provider stands for.
struct Target {
    surface: Rc<Surface>,
    view: NshView,
}

fn surface_of(key: u64) -> Result<Rc<Surface>> {
    Surface::by_key(key).ok_or_else(not_available)
}

fn target(key: u64, id: NodeId) -> Result<Target> {
    let surface = surface_of(key)?;
    let view = surface
        .mounter
        .try_borrow()
        .ok()
        .and_then(|m| m.views.get(id))
        .ok_or_else(not_available)?;
    match super::exposed(&view) {
        Ok(Some(e)) if e == view => Ok(Target { surface, view }),
        _ => Err(not_available()),
    }
}

fn control_of(view: &NshView) -> Option<Control> {
    match view.try_state().map(|s| part(&s)) {
        Some(Part::Element(c)) => Some(c),
        _ => None,
    }
}

fn element(key: u64, view: &NshView) -> IRawElementProviderFragment {
    Element { key, id: view.id() }.into()
}

fn simple(key: u64, view: Option<&NshView>) -> IRawElementProviderSimple {
    match view {
        Some(v) => Element { key, id: v.id() }.into(),
        None => Root { key }.into(),
    }
}

fn runtime_id(id: NodeId) -> [i32; 2] {
    [UiaAppendRuntimeId as i32, id as i32]
}

// --- Geometry --------------------------------------------------------------

/// Where `child` goes in `parent`'s coordinates.
fn local(parent: &NshView, child: &NshView) -> Option<Mat4> {
    let p = parent.try_state()?;
    let s = child.try_state()?;
    let (x, y) = p.child_origin(s.frame, s.shift);
    let m = Mat4::new().translate(x, y);
    Some(match s.transform() {
        Some(t) => Mat4::mul(&t, &m),
        None => m,
    })
}

/// A rectangle (x, y, width, height).
type Area = (f32, f32, f32, f32);

fn intersect(a: Area, b: Area) -> Area {
    let x = a.0.max(b.0);
    let y = a.1.max(b.1);
    let r = (a.0 + a.2).min(b.0 + b.2);
    let bottom = (a.1 + a.3).min(b.1 + b.3);
    (x, y, (r - x).max(0.0), (bottom - y).max(0.0))
}

/// The view's bounds in root points, and whether any of it shows (inside
/// the window and the views that clip it).
fn placement(view: &NshView) -> Option<(Area, bool)> {
    let mut chain = vec![view.clone()];
    while let Some(p) = chain.last().and_then(NshView::parent_view) {
        chain.push(p);
    }
    chain.reverse();
    let root = chain.first()?;
    let (w, h) = {
        let s = root.try_state()?;
        (s.frame.size.width.0, s.frame.size.height.0)
    };
    let mut clip = (0.0, 0.0, w, h);
    let mut m = Mat4::new();
    for pair in chain.windows(2) {
        m = Mat4::mul(&local(&pair[0], &pair[1])?, &m);
        let s = pair[1].try_state()?;
        if pair[1] != *view && s.clips() {
            let b = m.bounds(0.0, 0.0, s.frame.size.width.0, s.frame.size.height.0)?;
            clip = intersect(clip, b);
        }
    }
    let s = view.try_state()?;
    let bounds = m.bounds(0.0, 0.0, s.frame.size.width.0, s.frame.size.height.0)?;
    let shown = intersect(bounds, clip);
    Some((bounds, shown.2 > 0.0 && shown.3 > 0.0 && s.opacity() > 0.0))
}

/// The client area's origin on the screen (pixels).
fn client_origin(hwnd: HWND) -> (f64, f64) {
    let mut p = POINT::default();
    // SAFETY: a point to fill; a stale window handle fails harmlessly.
    let _ = unsafe { ClientToScreen(hwnd, &mut p) };
    (p.x as f64, p.y as f64)
}

/// The deepest view under `(x, y)` (root points), topmost first.
fn hit(view: &NshView, m: &Mat4, x: f32, y: f32) -> Option<NshView> {
    let (w, h, clips) = {
        let s = view.try_state()?;
        if s.concealed || s.style.hidden || s.props.accessibility.hidden {
            return None;
        }
        (s.frame.size.width.0, s.frame.size.height.0, s.clips())
    };
    let inside = m
        .unproject(x, y)
        .is_some_and(|(lx, ly)| lx >= 0.0 && ly >= 0.0 && lx < w && ly < h);
    if clips && !inside {
        return None;
    }
    for child in view.child_views().iter().rev() {
        let Some(l) = local(view, child) else {
            continue;
        };
        if let Some(found) = hit(child, &Mat4::mul(&l, m), x, y) {
            return Some(found);
        }
    }
    inside.then(|| view.clone())
}

// --- Events ----------------------------------------------------------------

/// Views came or went: the tree under the root is read again.
pub(super) fn structure_changed(surface: &Rc<Surface>) {
    let root = simple(surface.key(), None);
    let mut id = runtime_id(ROOT_ID);
    // SAFETY: the runtime id outlives the call.
    let _ = unsafe {
        UiaRaiseStructureChangedEvent(
            &root,
            StructureChangeType_ChildrenInvalidated,
            id.as_mut_ptr(),
            id.len() as i32,
        )
    };
}

fn property_changed(provider: &IRawElementProviderSimple, id: UIA_PROPERTY_ID, old: Var, new: Var) {
    // SAFETY: the values live through the call.
    let _ = unsafe { UiaRaiseAutomationPropertyChangedEvent(provider, id, &old.0, &new.0) };
}

fn toggle_state(c: Option<Checked>) -> ToggleState {
    match c {
        Some(Checked::True) => ToggleState_On,
        Some(Checked::Mixed) => ToggleState_Indeterminate,
        _ => ToggleState_Off,
    }
}

fn expand_state(e: Option<bool>) -> ExpandCollapseState {
    match e {
        Some(true) => ExpandCollapseState_Expanded,
        Some(false) => ExpandCollapseState_Collapsed,
        None => ExpandCollapseState_LeafNode,
    }
}

/// The element `view` exposes other states than before.
pub(super) fn changed(surface: &Rc<Surface>, view: &NshView, old: &Exposed, new: &Exposed) {
    let p = simple(surface.key(), Some(view));
    if old.name != new.name {
        // A grouping element without a label is named by its content.
        let name = super::name_of(view);
        property_changed(
            &p,
            UIA_NamePropertyId,
            Var::opt_str(old.name.as_deref()),
            Var::opt_str(name.as_deref()),
        );
    }
    if old.help != new.help {
        property_changed(
            &p,
            UIA_HelpTextPropertyId,
            Var::opt_str(old.help.as_deref()),
            Var::opt_str(new.help.as_deref()),
        );
    }
    if old.enabled != new.enabled {
        property_changed(
            &p,
            UIA_IsEnabledPropertyId,
            Var::bool(old.enabled),
            Var::bool(new.enabled),
        );
    }
    if old.checked != new.checked {
        property_changed(
            &p,
            UIA_ToggleToggleStatePropertyId,
            Var::i32(toggle_state(old.checked).0),
            Var::i32(toggle_state(new.checked).0),
        );
    }
    if old.expanded != new.expanded {
        property_changed(
            &p,
            UIA_ExpandCollapseExpandCollapseStatePropertyId,
            Var::i32(expand_state(old.expanded).0),
            Var::i32(expand_state(new.expanded).0),
        );
    }
    if old.selected != new.selected {
        property_changed(
            &p,
            UIA_SelectionItemIsSelectedPropertyId,
            Var::bool(old.selected),
            Var::bool(new.selected),
        );
        if new.selected {
            // SAFETY: plain call.
            let _ =
                unsafe { UiaRaiseAutomationEvent(&p, UIA_SelectionItem_ElementSelectedEventId) };
        }
    }
    if old.busy != new.busy {
        property_changed(
            &p,
            UIA_ItemStatusPropertyId,
            Var::str(if old.busy { "busy" } else { "" }),
            Var::str(if new.busy { "busy" } else { "" }),
        );
    }
    if old.now != new.now
        && let Some(now) = new.now
    {
        property_changed(
            &p,
            UIA_RangeValueValuePropertyId,
            old.now.map_or_else(Var::empty, |v| Var::f64(v as f64)),
            Var::f64(now as f64),
        );
    }
}

/// The name of `view` (an element that groups its content) changed with
/// its content.
pub(super) fn name_changed(surface: &Rc<Surface>, view: &NshView) {
    let p = simple(surface.key(), Some(view));
    let name = super::name_of(view);
    property_changed(
        &p,
        UIA_NamePropertyId,
        Var::empty(),
        Var::opt_str(name.as_deref()),
    );
}

/// Has `text` read (a live region's change, an announcement).
pub(super) fn notify(surface: &Rc<Surface>, view: Option<&NshView>, text: &str, assertive: bool) {
    let p = simple(surface.key(), view);
    let processing = if assertive {
        NotificationProcessing_ImportantMostRecent
    } else {
        NotificationProcessing_MostRecent
    };
    let activity = BSTR::from(if view.is_some() {
        "nsh.live"
    } else {
        "nsh.announce"
    });
    // SAFETY: the strings live through the call.
    let _ = unsafe {
        UiaRaiseNotificationEvent(
            &p,
            NotificationKind_Other,
            processing,
            &BSTR::from(text),
            &activity,
        )
    };
}

/// The focus moved to `view`.
pub(super) fn focus_changed(surface: &Rc<Surface>, view: &NshView) {
    let p = simple(surface.key(), Some(view));
    // SAFETY: plain call.
    let _ = unsafe { UiaRaiseAutomationEvent(&p, UIA_AutomationFocusChangedEventId) };
}

/// `WM_GETOBJECT`: answers UI Automation's request with the root provider.
pub(super) fn get_object(
    surface: &Rc<Surface>,
    hwnd: HWND,
    wparam: WPARAM,
    lparam: LPARAM,
) -> Option<LRESULT> {
    if lparam.0 as i32 != UiaRootObjectId {
        return None;
    }
    let root = simple(surface.key(), None);
    // SAFETY: the window's own message, answered with a live provider.
    Some(unsafe { UiaReturnRawElementProvider(hwnd, wparam, lparam, &root) })
}

// --- The root --------------------------------------------------------------

/// The window's content: the fragment root.
#[implement(
    IRawElementProviderSimple,
    IRawElementProviderFragment,
    IRawElementProviderFragmentRoot
)]
struct Root {
    key: u64,
}

impl IRawElementProviderSimple_Impl for Root_Impl {
    fn ProviderOptions(&self) -> Result<ProviderOptions> {
        Ok(ProviderOptions_ServerSideProvider | ProviderOptions_UseComThreading)
    }

    fn GetPatternProvider(&self, _pattern: UIA_PATTERN_ID) -> Result<IUnknown> {
        none()
    }

    fn GetPropertyValue(&self, property: UIA_PROPERTY_ID) -> Result<VARIANT> {
        surface_of(self.key)?;
        Ok(match property {
            UIA_FrameworkIdPropertyId | UIA_ProviderDescriptionPropertyId => Var::str("nsh"),
            _ => Var::empty(),
        }
        .into_raw())
    }

    fn HostRawElementProvider(&self) -> Result<IRawElementProviderSimple> {
        let surface = surface_of(self.key)?;
        // SAFETY: the surface's window.
        unsafe { UiaHostProviderFromHwnd(surface.hwnd()) }
    }
}

impl IRawElementProviderFragment_Impl for Root_Impl {
    fn Navigate(&self, direction: NavigateDirection) -> Result<IRawElementProviderFragment> {
        let surface = surface_of(self.key)?;
        let pick = match direction {
            NavigateDirection_FirstChild => <[NshView]>::first,
            NavigateDirection_LastChild => <[NshView]>::last,
            _ => return none(),
        };
        let kids = super::element_children(&surface.root, true);
        match pick(&kids) {
            Some(v) => Ok(element(self.key, v)),
            None => none(),
        }
    }

    fn GetRuntimeId(&self) -> Result<*mut SAFEARRAY> {
        // The window's provider gives the root its runtime id.
        Ok(std::ptr::null_mut())
    }

    fn BoundingRectangle(&self) -> Result<UiaRect> {
        // The window's provider gives the root its bounds.
        Ok(UiaRect::default())
    }

    fn GetEmbeddedFragmentRoots(&self) -> Result<*mut SAFEARRAY> {
        Ok(std::ptr::null_mut())
    }

    fn SetFocus(&self) -> Result<()> {
        Ok(())
    }

    fn FragmentRoot(&self) -> Result<IRawElementProviderFragmentRoot> {
        Ok(Root { key: self.key }.into())
    }
}

impl IRawElementProviderFragmentRoot_Impl for Root_Impl {
    fn ElementProviderFromPoint(&self, x: f64, y: f64) -> Result<IRawElementProviderFragment> {
        let surface = surface_of(self.key)?;
        let mut p = POINT {
            x: x as i32,
            y: y as i32,
        };
        // SAFETY: a point to convert.
        let _ = unsafe { ScreenToClient(surface.hwnd(), &mut p) };
        let scale = surface.scale().max(0.01);
        let (px, py) = (p.x as f32 / scale, p.y as f32 / scale);
        let found = hit(&surface.root, &Mat4::new(), px, py)
            .and_then(|v| super::exposed(&v).ok().flatten());
        Ok(match found {
            Some(v) => element(self.key, &v),
            None => Root { key: self.key }.into(),
        })
    }

    fn GetFocus(&self) -> Result<IRawElementProviderFragment> {
        let surface = surface_of(self.key)?;
        match super::focused(&surface) {
            Some(v) => Ok(element(self.key, &v)),
            None => none(),
        }
    }
}

// --- Elements --------------------------------------------------------------

/// One exposed view.
#[implement(
    IRawElementProviderSimple,
    IRawElementProviderFragment,
    IInvokeProvider,
    IValueProvider,
    IRangeValueProvider,
    IToggleProvider,
    IExpandCollapseProvider,
    ISelectionItemProvider,
    IScrollProvider
)]
struct Element {
    key: u64,
    id: NodeId,
}

impl Element_Impl {
    fn target(&self) -> Result<Target> {
        target(self.key, self.id)
    }

    /// The view and its control type, refusing changes to disabled
    /// elements.
    fn enabled(&self) -> Result<Target> {
        let t = self.target()?;
        if t.view.state().props.accessibility.state.disabled {
            return Err(not_enabled());
        }
        Ok(t)
    }

    fn range(&self) -> Result<(Target, (f64, f64, f64))> {
        let t = self.target()?;
        let range = {
            let s = t.view.state();
            match part(&s) {
                Part::Element(c) => super::range_of(&s.props.accessibility, c),
                _ => None,
            }
        };
        let range = range.ok_or_else(not_supported)?;
        Ok((t, range))
    }

    fn scroll_metrics(&self) -> Result<Scroll> {
        let t = self.target()?;
        let s = t.view.state();
        let sc = s.scroll.as_ref().ok_or_else(not_supported)?;
        let viewport = (s.frame.size.width.0, s.frame.size.height.0);
        let max = sc.max(s.frame.size);
        let inset = sc.behavior.content_inset;
        Ok(Scroll {
            offset: (sc.x.0, sc.y.0),
            max: (max.x.0, max.y.0),
            viewport,
            extent: (
                sc.content.width.0 + inset.left.0 + inset.right.0,
                sc.content.height.0 + inset.top.0 + inset.bottom.0,
            ),
        })
    }

    fn scroll_to(&self, x: f32, y: f32) -> Result<()> {
        let t = self.target()?;
        let command = Command::ScrollTo {
            x: Points(x),
            y: Points(y),
            animated: false,
        };
        crate::scroll::command(&t.surface, &t.view, &command);
        Ok(())
    }
}

/// A scroll view's offset, largest offsets, viewport and content extent.
struct Scroll {
    offset: (f32, f32),
    max: (f32, f32),
    viewport: (f32, f32),
    extent: (f32, f32),
}

/// What a scroll by `amount` moves in a viewport of `size`.
fn scroll_step(amount: ScrollAmount, size: f32) -> f32 {
    match amount {
        ScrollAmount_LargeIncrement => size,
        ScrollAmount_LargeDecrement => -size,
        ScrollAmount_SmallIncrement => (size * 0.1).max(16.0),
        ScrollAmount_SmallDecrement => -(size * 0.1).max(16.0),
        _ => 0.0,
    }
}

fn percent(offset: f32, max: f32) -> f64 {
    if max <= 0.0 {
        UIA_ScrollPatternNoScroll
    } else {
        (offset / max * 100.0).clamp(0.0, 100.0) as f64
    }
}

impl IRawElementProviderSimple_Impl for Element_Impl {
    fn ProviderOptions(&self) -> Result<ProviderOptions> {
        Ok(ProviderOptions_ServerSideProvider | ProviderOptions_UseComThreading)
    }

    fn GetPatternProvider(&self, pattern: UIA_PATTERN_ID) -> Result<IUnknown> {
        let t = self.target()?;
        let supported = {
            let s = t.view.state();
            let a = &s.props.accessibility;
            let Part::Element(control) = part(&s) else {
                return none();
            };
            match pattern {
                UIA_InvokePatternId => {
                    a.state.checked.is_none()
                        && (s.events.contains(nsh_core::EventKind::Press)
                            || a.actions.iter().any(|x| &*x.name == "activate"))
                }
                UIA_TogglePatternId => a.state.checked.is_some(),
                UIA_ExpandCollapsePatternId => a.state.expanded.is_some(),
                UIA_SelectionItemPatternId => {
                    a.state.selected || matches!(control, Control::TabItem | Control::RadioButton)
                }
                UIA_RangeValuePatternId => super::range_of(a, control).is_some(),
                UIA_ValuePatternId => s.kind == ViewKind::Input,
                UIA_ScrollPatternId => s.scroll.is_some(),
                _ => false,
            }
        };
        if supported {
            Ok(self.to_object().to_interface())
        } else {
            none()
        }
    }

    fn GetPropertyValue(&self, property: UIA_PROPERTY_ID) -> Result<VARIANT> {
        let t = self.target()?;
        let view = &t.view;
        let Some(control) = control_of(view) else {
            return Err(not_available());
        };
        let var = match property {
            UIA_ControlTypePropertyId => Var::i32(control_type(control).0),
            UIA_NamePropertyId => Var::opt_str(super::name_of(view).as_deref()),
            UIA_LocalizedControlTypePropertyId => Var::opt_str(control.localized()),
            UIA_AutomationIdPropertyId => Var::opt_str(view.state().props.test_id.as_deref()),
            UIA_HelpTextPropertyId => {
                let s = view.state();
                Var::opt_str(super::help_of(&s.props.accessibility, Some(control)).as_deref())
            }
            UIA_IsEnabledPropertyId => Var::bool(!view.state().props.accessibility.state.disabled),
            UIA_IsKeyboardFocusablePropertyId => Var::bool(
                control.focusable() || view.state().events.contains(nsh_core::EventKind::Press),
            ),
            UIA_HasKeyboardFocusPropertyId => {
                Var::bool(super::focused(&t.surface).is_some_and(|f| f == *view))
            }
            UIA_IsOffscreenPropertyId => {
                Var::bool(!placement(view).is_some_and(|(_, shown)| shown))
            }
            UIA_IsPasswordPropertyId => {
                Var::bool(crate::text_input::accessible_value(view).is_some_and(|v| v.password))
            }
            UIA_ItemStatusPropertyId if view.state().props.accessibility.state.busy => {
                Var::str("busy")
            }
            UIA_LiveSettingPropertyId => match view.state().props.accessibility.live_region {
                nsh_core::LiveRegion::None => Var::empty(),
                nsh_core::LiveRegion::Polite => Var::i32(Polite.0),
                nsh_core::LiveRegion::Assertive => Var::i32(Assertive.0),
            },
            UIA_HeadingLevelPropertyId if control == Control::Heading => Var::i32(HeadingLevel1.0),
            UIA_FrameworkIdPropertyId | UIA_ProviderDescriptionPropertyId => Var::str("nsh"),
            UIA_IsControlElementPropertyId | UIA_IsContentElementPropertyId => Var::bool(true),
            _ => Var::empty(),
        };
        Ok(var.into_raw())
    }

    fn HostRawElementProvider(&self) -> Result<IRawElementProviderSimple> {
        none()
    }
}

impl IRawElementProviderFragment_Impl for Element_Impl {
    fn Navigate(&self, direction: NavigateDirection) -> Result<IRawElementProviderFragment> {
        let t = self.target()?;
        let view = &t.view;
        let found = match direction {
            NavigateDirection_Parent => {
                return Ok(match super::parent_element(view) {
                    Some(p) => element(self.key, &p),
                    None => Root { key: self.key }.into(),
                });
            }
            NavigateDirection_FirstChild => super::element_children(view, false).first().cloned(),
            NavigateDirection_LastChild => super::element_children(view, false).last().cloned(),
            NavigateDirection_NextSibling | NavigateDirection_PreviousSibling => {
                let siblings = match super::parent_element(view) {
                    Some(p) => super::element_children(&p, false),
                    None => super::element_children(&t.surface.root, true),
                };
                siblings.iter().position(|v| v == view).and_then(|i| {
                    if direction == NavigateDirection_NextSibling {
                        siblings.get(i + 1).cloned()
                    } else {
                        i.checked_sub(1).and_then(|i| siblings.get(i).cloned())
                    }
                })
            }
            _ => None,
        };
        match found {
            Some(v) => Ok(element(self.key, &v)),
            None => none(),
        }
    }

    fn GetRuntimeId(&self) -> Result<*mut SAFEARRAY> {
        let id = runtime_id(self.id);
        // SAFETY: a new array of two VT_I4 elements, filled in place and
        // handed over to the caller.
        unsafe {
            let array = SafeArrayCreateVector(VT_I4, 0, id.len() as u32);
            if array.is_null() {
                return Err(Error::from_hresult(
                    windows::Win32::Foundation::E_OUTOFMEMORY,
                ));
            }
            for (i, v) in id.iter().enumerate() {
                let index = i as i32;
                SafeArrayPutElement(array, &index, (v as *const i32).cast())?;
            }
            Ok(array)
        }
    }

    fn BoundingRectangle(&self) -> Result<UiaRect> {
        let t = self.target()?;
        let Some(((x, y, w, h), _)) = placement(&t.view) else {
            return Ok(UiaRect::default());
        };
        let scale = t.surface.scale() as f64;
        let (ox, oy) = client_origin(t.surface.hwnd());
        Ok(UiaRect {
            left: ox + x as f64 * scale,
            top: oy + y as f64 * scale,
            width: w as f64 * scale,
            height: h as f64 * scale,
        })
    }

    fn GetEmbeddedFragmentRoots(&self) -> Result<*mut SAFEARRAY> {
        Ok(std::ptr::null_mut())
    }

    fn SetFocus(&self) -> Result<()> {
        let t = self.target()?;
        if t.view.kind() == ViewKind::Input {
            crate::text_input::focus(&t.view);
            super::focus_changed(&t.surface, &t.view);
        } else {
            super::focus(&t.surface, &t.view);
        }
        Ok(())
    }

    fn FragmentRoot(&self) -> Result<IRawElementProviderFragmentRoot> {
        surface_of(self.key)?;
        Ok(Root { key: self.key }.into())
    }
}

impl IInvokeProvider_Impl for Element_Impl {
    fn Invoke(&self) -> Result<()> {
        let t = self.enabled()?;
        if !super::activate(&t.surface, &t.view) {
            return Err(not_supported());
        }
        let p = simple(self.key, Some(&t.view));
        // SAFETY: plain call.
        let _ = unsafe { UiaRaiseAutomationEvent(&p, UIA_Invoke_InvokedEventId) };
        Ok(())
    }
}

impl IValueProvider_Impl for Element_Impl {
    fn SetValue(&self, value: &PCWSTR) -> Result<()> {
        let t = self.enabled()?;
        // SAFETY: UIA passes a NUL-terminated string.
        let text = unsafe { value.to_string() }.map_err(|_| not_supported())?;
        if crate::text_input::set_accessible_value(&t.surface, &t.view, &text) {
            Ok(())
        } else {
            Err(not_enabled())
        }
    }

    fn Value(&self) -> Result<BSTR> {
        let t = self.target()?;
        let v = crate::text_input::accessible_value(&t.view).unwrap_or_default();
        Ok(BSTR::from(v.text))
    }

    fn IsReadOnly(&self) -> Result<BOOL> {
        let t = self.target()?;
        let v = crate::text_input::accessible_value(&t.view);
        Ok(v.is_none_or(|v| v.read_only).into())
    }
}

impl IRangeValueProvider_Impl for Element_Impl {
    fn SetValue(&self, value: f64) -> Result<()> {
        let (t, (_, _, now)) = self.range()?;
        if t.view.state().props.accessibility.state.disabled {
            return Err(not_enabled());
        }
        // Apps change their value in steps: one step toward the target.
        let name = if value > now {
            "increment"
        } else if value < now {
            "decrement"
        } else {
            return Ok(());
        };
        if super::action_or_press(&t.surface, &t.view, name, false) {
            Ok(())
        } else {
            Err(not_enabled())
        }
    }

    fn Value(&self) -> Result<f64> {
        Ok(self.range()?.1.2)
    }

    fn IsReadOnly(&self) -> Result<BOOL> {
        let (t, _) = self.range()?;
        let s = t.view.state();
        let adjustable = s
            .props
            .accessibility
            .actions
            .iter()
            .any(|a| &*a.name == "increment" || &*a.name == "decrement");
        Ok((!adjustable).into())
    }

    fn Maximum(&self) -> Result<f64> {
        Ok(self.range()?.1.1)
    }

    fn Minimum(&self) -> Result<f64> {
        Ok(self.range()?.1.0)
    }

    fn LargeChange(&self) -> Result<f64> {
        let (min, max, _) = self.range()?.1;
        Ok((max - min) / 5.0)
    }

    fn SmallChange(&self) -> Result<f64> {
        let (min, max, _) = self.range()?.1;
        Ok((max - min) / 20.0)
    }
}

impl IToggleProvider_Impl for Element_Impl {
    fn Toggle(&self) -> Result<()> {
        let t = self.enabled()?;
        if super::activate(&t.surface, &t.view) {
            Ok(())
        } else {
            Err(not_supported())
        }
    }

    fn ToggleState(&self) -> Result<ToggleState> {
        let t = self.target()?;
        Ok(toggle_state(
            t.view.state().props.accessibility.state.checked,
        ))
    }
}

impl Element_Impl {
    /// Expands (or collapses) with the `expand` (`collapse`) action, else
    /// as a tap would.
    fn expand(&self, expand: bool) -> Result<()> {
        let t = self.enabled()?;
        let state = t.view.state().props.accessibility.state.expanded;
        if state == Some(expand) {
            return Ok(());
        }
        let name = if expand { "expand" } else { "collapse" };
        if super::action_or_press(&t.surface, &t.view, name, false)
            || super::activate(&t.surface, &t.view)
        {
            Ok(())
        } else {
            Err(not_supported())
        }
    }

    /// Selects (or deselects) as a tap would.
    fn select(&self, select: bool) -> Result<()> {
        let t = self.enabled()?;
        if t.view.state().props.accessibility.state.selected == select {
            return Ok(());
        }
        if super::activate(&t.surface, &t.view) {
            Ok(())
        } else {
            Err(not_supported())
        }
    }
}

impl IExpandCollapseProvider_Impl for Element_Impl {
    fn Expand(&self) -> Result<()> {
        self.expand(true)
    }

    fn Collapse(&self) -> Result<()> {
        self.expand(false)
    }

    fn ExpandCollapseState(&self) -> Result<ExpandCollapseState> {
        let t = self.target()?;
        Ok(expand_state(
            t.view.state().props.accessibility.state.expanded,
        ))
    }
}

impl ISelectionItemProvider_Impl for Element_Impl {
    fn Select(&self) -> Result<()> {
        self.select(true)
    }

    fn AddToSelection(&self) -> Result<()> {
        self.select(true)
    }

    fn RemoveFromSelection(&self) -> Result<()> {
        self.select(false)
    }

    fn IsSelected(&self) -> Result<BOOL> {
        let t = self.target()?;
        Ok(t.view.state().props.accessibility.state.selected.into())
    }

    fn SelectionContainer(&self) -> Result<IRawElementProviderSimple> {
        let t = self.target()?;
        match super::parent_element(&t.view) {
            Some(p) => Ok(simple(self.key, Some(&p))),
            None => none(),
        }
    }
}

impl IScrollProvider_Impl for Element_Impl {
    fn Scroll(&self, horizontal: ScrollAmount, vertical: ScrollAmount) -> Result<()> {
        let m = self.scroll_metrics()?;
        let x = (m.offset.0 + scroll_step(horizontal, m.viewport.0)).clamp(0.0, m.max.0);
        let y = (m.offset.1 + scroll_step(vertical, m.viewport.1)).clamp(0.0, m.max.1);
        self.scroll_to(x, y)
    }

    fn SetScrollPercent(&self, horizontal: f64, vertical: f64) -> Result<()> {
        let m = self.scroll_metrics()?;
        let at = |p: f64, offset: f32, max: f32| {
            if p == UIA_ScrollPatternNoScroll {
                offset
            } else {
                (p.clamp(0.0, 100.0) as f32 / 100.0) * max
            }
        };
        self.scroll_to(
            at(horizontal, m.offset.0, m.max.0),
            at(vertical, m.offset.1, m.max.1),
        )
    }

    fn HorizontalScrollPercent(&self) -> Result<f64> {
        let m = self.scroll_metrics()?;
        Ok(percent(m.offset.0, m.max.0))
    }

    fn VerticalScrollPercent(&self) -> Result<f64> {
        let m = self.scroll_metrics()?;
        Ok(percent(m.offset.1, m.max.1))
    }

    fn HorizontalViewSize(&self) -> Result<f64> {
        let m = self.scroll_metrics()?;
        Ok(view_size(m.viewport.0, m.extent.0))
    }

    fn VerticalViewSize(&self) -> Result<f64> {
        let m = self.scroll_metrics()?;
        Ok(view_size(m.viewport.1, m.extent.1))
    }

    fn HorizontallyScrollable(&self) -> Result<BOOL> {
        Ok((self.scroll_metrics()?.max.0 > 0.0).into())
    }

    fn VerticallyScrollable(&self) -> Result<BOOL> {
        Ok((self.scroll_metrics()?.max.1 > 0.0).into())
    }
}

/// The part of the content the viewport shows, in percent.
fn view_size(viewport: f32, extent: f32) -> f64 {
    if extent <= 0.0 {
        100.0
    } else {
        (viewport / extent * 100.0).min(100.0) as f64
    }
}

/// The UIA control type of `c`.
fn control_type(c: Control) -> UIA_CONTROLTYPE_ID {
    match c {
        Control::Button | Control::Switch => UIA_ButtonControlTypeId,
        Control::Hyperlink => UIA_HyperlinkControlTypeId,
        Control::Edit | Control::SearchBox => UIA_EditControlTypeId,
        Control::Image => UIA_ImageControlTypeId,
        Control::Text | Control::Heading | Control::Timer => UIA_TextControlTypeId,
        Control::Slider => UIA_SliderControlTypeId,
        Control::Status => UIA_StatusBarControlTypeId,
        Control::Alert | Control::RadioGroup | Control::Grid | Control::Group => {
            UIA_GroupControlTypeId
        }
        Control::CheckBox => UIA_CheckBoxControlTypeId,
        Control::ComboBox => UIA_ComboBoxControlTypeId,
        Control::Menu => UIA_MenuControlTypeId,
        Control::MenuBar => UIA_MenuBarControlTypeId,
        Control::MenuItem => UIA_MenuItemControlTypeId,
        Control::ProgressBar => UIA_ProgressBarControlTypeId,
        Control::RadioButton => UIA_RadioButtonControlTypeId,
        Control::ScrollBar => UIA_ScrollBarControlTypeId,
        Control::Spinner => UIA_SpinnerControlTypeId,
        Control::TabItem => UIA_TabItemControlTypeId,
        Control::TabList => UIA_TabControlTypeId,
        Control::ToolBar => UIA_ToolBarControlTypeId,
        Control::List => UIA_ListControlTypeId,
        Control::Pane => UIA_PaneControlTypeId,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_types() {
        assert_eq!(control_type(Control::Switch), UIA_ButtonControlTypeId);
        assert_eq!(control_type(Control::Heading), UIA_TextControlTypeId);
        assert_eq!(control_type(Control::TabList), UIA_TabControlTypeId);
        assert_eq!(control_type(Control::Pane), UIA_PaneControlTypeId);
    }

    #[test]
    fn scrolling() {
        assert_eq!(scroll_step(ScrollAmount_LargeIncrement, 400.0), 400.0);
        assert_eq!(scroll_step(ScrollAmount_SmallDecrement, 400.0), -40.0);
        assert_eq!(scroll_step(ScrollAmount_SmallIncrement, 50.0), 16.0);
        assert_eq!(scroll_step(ScrollAmount_NoAmount, 400.0), 0.0);
        assert_eq!(percent(50.0, 200.0), 25.0);
        assert_eq!(percent(0.0, 0.0), UIA_ScrollPatternNoScroll);
        assert_eq!(view_size(100.0, 400.0), 25.0);
        assert_eq!(view_size(100.0, 0.0), 100.0);
    }

    #[test]
    fn areas() {
        assert_eq!(
            intersect((0.0, 0.0, 100.0, 100.0), (50.0, 80.0, 100.0, 100.0)),
            (50.0, 80.0, 50.0, 20.0)
        );
        assert_eq!(
            intersect((0.0, 0.0, 10.0, 10.0), (20.0, 0.0, 5.0, 5.0)).2,
            0.0
        );
    }
}

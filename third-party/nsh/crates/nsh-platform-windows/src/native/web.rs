//! Web views: WebView2 composition controllers in the window's
//! composition.
//!
//! Each web view is a WebView2 composition controller ("visual hosting")
//! drawing into a visual of the surface's [`Composition`] ([`Portal`]):
//! the frame records where the view goes as it draws the tree, the visual
//! is clipped, transformed and faded like the view, and what nsh draws
//! after it goes on a layer above it, so dialogs, sheets, toasts, the dev
//! overlay and later siblings cover the page as they would any view. The
//! window gets the input: nsh hit-tests it as for any view, and what falls
//! on the page (nothing of nsh's is over it there) is forwarded to it as
//! it comes ([`Hosted::raw`]): mouse buttons, moves and wheels through
//! `SendMouseInput`, touch and pen contacts through `SendPointerInput`. The
//! page's cursor comes back through `CursorChanged`. A click on the page
//! gives it the keyboard focus (`MoveFocus`: WebView2 then takes keys and
//! the IME itself), which blurs nsh's text fields; a click on nsh content
//! gives it back to the window, and Tab out of the page
//! (`MoveFocusRequested`) too. The page is rasterized at the window's
//! scale (`RasterizationScale`); its bounds are where its view is in the
//! window's pixels, which WebView2 places pop-ups (select menus) and the
//! IME's candidates from.
//!
//! WebView2 is asynchronous: the environment (one per thread and profile
//! folder, `%LOCALAPPDATA%\<app id>\WebView2`) and then the controller are
//! made in the background. Props and commands that come before the
//! controller is ready wait for it ([`WebItem::ready`]). The WebView2
//! loader is linked statically (`WebView2LoaderStatic.lib`), so apps do not
//! ship `WebView2Loader.dll`; the WebView2 runtime itself comes with
//! Windows 11 (and Edge's installer on Windows 10). Without it, a web view
//! draws a neutral placeholder, as on Linux.
//!
//! Pages talk to the app through `window.nsh`: the bridge script
//! defines `window.nsh.postMessage(data)` (`onMessage`), and
//! `postMessage()` dispatches a `message` event on the page's `window`.
//! Top-level navigations stay within the app's `webview` capability.
//! Events and their payloads are the iOS ones: `onLoadStart` and
//! `onNavigationStateChange` when a navigation starts, `onLoad` and
//! `onNavigationStateChange` when it completes, `onError` when it fails.
//!
//! - `source.html` with a `baseUrl` navigates to the base URL and answers
//!   that document's request with the HTML (`WebResourceRequested`): the
//!   page's URL and origin are the base URL's and relative URLs resolve
//!   against it, as with `loadHTMLString:baseURL:`. Without a base URL the
//!   HTML is loaded with `NavigateToString`.
//! - `scrollable={false}`: the wheel goes to the scroll views around the
//!   web view instead of the page, and a style keeps the page's viewport
//!   from scrolling (`overflow: hidden` on its root element) while scripts
//!   still may, as a `UIScrollView` with scrolling disabled.
//! - `desktop={{ allowsBackForwardNavigationGestures }}`: WebView2's swipe navigation
//!   (`IsSwipeNavigationEnabled`, touch swipes).

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::{Rc, Weak},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use nsh_core::{Color, Command, EventKind, EventPayload, PayloadValue, WebProps, WebSource};
use webview2_com::{
    AddScriptToExecuteOnDocumentCreatedCompletedHandler,
    CreateCoreWebView2CompositionControllerCompletedHandler,
    CreateCoreWebView2EnvironmentCompletedHandler, CursorChangedEventHandler,
    FocusChangedEventHandler,
    Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_COLOR, COREWEBVIEW2_MOUSE_EVENT_KIND,
        COREWEBVIEW2_MOUSE_EVENT_KIND_HORIZONTAL_WHEEL, COREWEBVIEW2_MOUSE_EVENT_KIND_LEAVE,
        COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOUBLE_CLICK,
        COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOWN,
        COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_UP,
        COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_DOUBLE_CLICK,
        COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_DOWN,
        COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_UP, COREWEBVIEW2_MOUSE_EVENT_KIND_MOVE,
        COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_DOUBLE_CLICK,
        COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_DOWN,
        COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_UP, COREWEBVIEW2_MOUSE_EVENT_KIND_WHEEL,
        COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_DOUBLE_CLICK,
        COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_DOWN, COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_UP,
        COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS, COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC,
        COREWEBVIEW2_POINTER_EVENT_KIND, COREWEBVIEW2_WEB_ERROR_STATUS,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT, ICoreWebView2,
        ICoreWebView2CompositionController, ICoreWebView2Controller, ICoreWebView2Controller2,
        ICoreWebView2Controller3, ICoreWebView2Environment, ICoreWebView2Environment3,
        ICoreWebView2ExecuteScriptCompletedHandler, ICoreWebView2Settings2, ICoreWebView2Settings6,
    },
    MoveFocusRequestedEventHandler, NavigationCompletedEventHandler,
    NavigationStartingEventHandler, WebMessageReceivedEventHandler,
    WebResourceRequestedEventHandler, take_pwstr,
};
use windows::{
    Win32::{
        Foundation::{POINT, RECT},
        Graphics::{
            Direct2D::D2D1_DRAW_TEXT_OPTIONS_NONE,
            DirectComposition::IDCompositionVisual2,
            DirectWrite::{
                DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_WEIGHT_NORMAL,
                DWRITE_MEASURING_MODE_NATURAL, DWRITE_PARAGRAPH_ALIGNMENT_CENTER,
                DWRITE_TEXT_ALIGNMENT_CENTER, DWRITE_WORD_WRAPPING_WRAP, IDWriteTextFormat,
            },
            Gdi::ScreenToClient,
        },
        UI::{
            Input::{
                KeyboardAndMouse::{GetFocus, SetFocus},
                Pointer::{
                    GetPointerDeviceRects, GetPointerInfo, GetPointerPenInfo, GetPointerTouchInfo,
                    POINTER_INFO, POINTER_PEN_INFO, POINTER_TOUCH_INFO,
                },
            },
            Shell::SHCreateMemStream,
            WindowsAndMessaging::{HCURSOR, IsChild, SetCursor},
        },
    },
    core::{BOOL, HRESULT, HSTRING, Interface, PCWSTR, PWSTR, w},
};

use super::{Emitter, error};
use crate::{
    compose::{Placement, Portal},
    gfx,
    input::{Modifiers, PointerKind, WheelEvent},
    render::{DrawCx, rect_f},
    surface::Surface,
    view::{Hosted, ItemPointer, NshView},
};

/// Lets pages talk to the app: `window.nsh.postMessage(data)`.
const BRIDGE: &str = "window.nsh = window.nsh || { postMessage: function (data) { window.chrome.webview.postMessage(String(data)); } };";

// The loader, linked statically (webview2-com-sys imports it from
// `WebView2Loader.dll`, which would have to ship next to every app).
#[link(name = "WebView2LoaderStatic", kind = "static")]
unsafe extern "system" {
    #[link_name = "CreateCoreWebView2EnvironmentWithOptions"]
    fn create_environment(
        browser_folder: PCWSTR,
        user_data_folder: PCWSTR,
        options: *mut std::ffi::c_void,
        handler: *mut std::ffi::c_void,
    ) -> HRESULT;
}

/// A web view: its visuals and, once made, its controller.
pub(crate) struct WebItem {
    emitter: Emitter,
    surface: Weak<Surface>,
    /// The visuals the page is composed in (`None` once closed, or when the
    /// window has no composition).
    portal: RefCell<Option<Portal>>,
    env: RefCell<Option<ICoreWebView2Environment>>,
    composition: RefCell<Option<ICoreWebView2CompositionController>>,
    controller: RefCell<Option<ICoreWebView2Controller>>,
    webview: RefCell<Option<ICoreWebView2>>,
    /// No web view can be made (no WebView2 runtime): a placeholder.
    failed: Cell<bool>,
    /// Closed (its view was deleted and is not drawn anymore, or the app
    /// stopped).
    closed: Cell<bool>,
    /// Its view was deleted: it closes once the view is not drawn anymore
    /// (a removal animation keeps it on screen a little longer).
    retired: Cell<bool>,
    /// The props asked for (applied once the controller is ready).
    props: RefCell<Option<WebProps>>,
    /// The props applied to the web view.
    applied: RefCell<Option<WebProps>>,
    /// Commands that came before the controller.
    queued: RefCell<Vec<Command>>,
    /// The ids of the app's document scripts (removed when they change).
    scripts: Rc<RefCell<Vec<String>>>,
    /// The id of the document script that keeps the page from scrolling.
    scroll_script: Rc<RefCell<Option<String>>>,
    /// The engine's own user agent (restored when the app's is removed).
    default_agent: RefCell<Option<String>>,
    /// The HTML served at its base URL (`baseUrl`).
    html: RefCell<Option<(String, Arc<str>)>>,
    /// The document requests are watched (for `html`).
    serving: Cell<bool>,
    /// Where the last frame put it.
    at: Cell<Option<Placement>>,
    /// The controller's bounds applied (window pixels; `None`: hidden).
    bounds: Cell<Option<RECT>>,
    /// The rasterization scale applied.
    raster: Cell<f32>,
    /// The view's background, the page's until it paints.
    background: Cell<Color>,
    /// The page's cursor (an `HCURSOR`).
    cursor: Cell<isize>,
    /// The mouse is over the page.
    hovered: Cell<bool>,
    /// The page has the keyboard focus.
    focused: Cell<bool>,
    /// Mouse buttons held on the page (bits by button).
    buttons: Cell<u8>,
}

impl WebItem {
    pub(super) fn focused(&self) -> bool {
        self.focused.get()
    }

    pub(crate) fn new(surface: &Rc<Surface>, view: &NshView) -> Rc<Self> {
        let portal = surface
            .compose()
            .and_then(Portal::new)
            .map_err(|err| log::warn!("web view: no composition: {err}"))
            .ok();
        let item = Rc::new(WebItem {
            emitter: Emitter::new(surface, view.id()),
            surface: Rc::downgrade(surface),
            portal: RefCell::new(portal),
            env: RefCell::new(None),
            composition: RefCell::new(None),
            controller: RefCell::new(None),
            webview: RefCell::new(None),
            failed: Cell::new(false),
            closed: Cell::new(false),
            retired: Cell::new(false),
            props: RefCell::new(None),
            applied: RefCell::new(None),
            queued: RefCell::new(Vec::new()),
            scripts: Rc::default(),
            scroll_script: Rc::default(),
            default_agent: RefCell::new(None),
            html: RefCell::new(None),
            serving: Cell::new(false),
            at: Cell::new(None),
            bounds: Cell::new(None),
            raster: Cell::new(0.0),
            background: Cell::new(view.state().style.background_color),
            cursor: Cell::new(0),
            hovered: Cell::new(false),
            focused: Cell::new(false),
            buttons: Cell::new(0),
        });
        if item.portal.borrow().is_none() {
            item.unavailable("the window cannot compose it");
            return item;
        }
        let folder = profile_folder(&surface.native.app_id.borrow());
        let weak = Rc::downgrade(&item);
        with_environment(&folder, move |env| {
            if let Some(item) = weak.upgrade() {
                item.environment_ready(env);
            }
        });
        item
    }

    /// No web view: the placeholder shows.
    fn unavailable(&self, why: &str) {
        self.failed.set(true);
        self.portal.borrow_mut().take();
        static WARNED: AtomicBool = AtomicBool::new(false);
        if !WARNED.swap(true, Ordering::Relaxed) {
            log::warn!(
                target: "js",
                "WebView is not available ({why}; is the WebView2 runtime installed?): it shows a placeholder"
            );
        }
        if let Some(surface) = self.surface.upgrade() {
            surface.invalidate();
        }
    }

    fn environment_ready(self: &Rc<Self>, env: Option<ICoreWebView2Environment>) {
        if self.closed.get() {
            return;
        }
        let Some(env) = env else {
            return self.unavailable("no WebView2 environment");
        };
        let (Ok(env3), Some(surface)) = (
            env.cast::<ICoreWebView2Environment3>(),
            self.surface.upgrade(),
        ) else {
            return self.unavailable("the WebView2 runtime cannot host it in a visual");
        };
        *self.env.borrow_mut() = Some(env);
        let weak = Rc::downgrade(self);
        let handler = CreateCoreWebView2CompositionControllerCompletedHandler::create(Box::new(
            move |result, controller| {
                let Some(item) = weak.upgrade().filter(|i| !i.closed.get()) else {
                    // The view went away meanwhile.
                    if let Some(c) =
                        controller.and_then(|c| c.cast::<ICoreWebView2Controller>().ok())
                    {
                        // SAFETY: a call on the controller just made.
                        let _ = unsafe { c.Close() };
                    }
                    return Ok(());
                };
                match (result, controller) {
                    (Ok(()), Some(controller)) => item.ready(controller),
                    (result, _) => {
                        log::warn!("web view: no controller: {result:?}");
                        item.unavailable("cannot create a WebView2 controller");
                    }
                }
                Ok(())
            },
        ));
        // SAFETY: a call on a live environment with the live window of
        // this thread.
        if let Err(err) =
            unsafe { env3.CreateCoreWebView2CompositionController(surface.hwnd(), &handler) }
        {
            log::warn!("web view: cannot create a controller: {err}");
            self.unavailable("cannot create a WebView2 controller");
        }
    }

    /// The controller is made: sets it up, applies what waited for it.
    fn ready(self: &Rc<Self>, composition: ICoreWebView2CompositionController) {
        let target = self.portal.borrow().as_ref().map(|p| p.target().clone());
        let (Some(target), Ok(controller)) =
            (target, composition.cast::<ICoreWebView2Controller>())
        else {
            return self.unavailable("no WebView2 controller");
        };
        // SAFETY: WebView2 calls on the live controller, on its thread.
        let webview = match unsafe { controller.CoreWebView2() } {
            Ok(webview) => webview,
            Err(err) => {
                log::warn!("web view: {err}");
                return self.unavailable("no WebView2 core");
            }
        };
        // SAFETY: as above; the visual belongs to this thread's
        // composition.
        unsafe {
            if let Err(err) = composition.SetRootVisualTarget(&target) {
                log::warn!("web view: cannot compose it: {err}");
                let _ = controller.Close();
                return self.unavailable("cannot compose a WebView2 controller");
            }
            if let Ok(c) = controller.cast::<ICoreWebView2Controller3>() {
                // The window's scale, not the monitor's: nsh decides.
                let _ = c.SetShouldDetectMonitorScaleChanges(false);
            }
            let _ = controller.SetIsVisible(false);
            if let Ok(settings) = webview.Settings() {
                let _ = settings.SetIsStatusBarEnabled(false);
                if let Ok(settings) = settings.cast::<ICoreWebView2Settings2>() {
                    let mut agent = PWSTR::null();
                    if settings.UserAgent(&mut agent).is_ok() {
                        *self.default_agent.borrow_mut() = Some(take_pwstr(agent));
                    }
                }
            }
            let _ = webview.AddScriptToExecuteOnDocumentCreated(
                &HSTRING::from(BRIDGE),
                None::<&webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler>,
            );
        }
        self.listen(&webview);
        self.listen_input(&composition, &controller);
        *self.composition.borrow_mut() = Some(composition);
        *self.controller.borrow_mut() = Some(controller);
        *self.webview.borrow_mut() = Some(webview);
        self.paint_background();
        self.bounds.set(None);
        self.place();
        let props = self.props.borrow().clone();
        if let Some(props) = props {
            self.apply(&props);
        }
        let queued = std::mem::take(&mut *self.queued.borrow_mut());
        for command in &queued {
            self.command(command);
        }
    }

    /// Reports the web view's navigations and messages.
    fn listen(self: &Rc<Self>, webview: &ICoreWebView2) {
        let mut token = 0i64;
        let weak = Rc::downgrade(self);
        let starting = NavigationStartingEventHandler::create(Box::new(move |sender, args| {
            let (Some(item), Some(sender), Some(args)) = (weak.upgrade(), sender, args) else {
                return Ok(());
            };
            let mut uri = PWSTR::null();
            // SAFETY: WebView2 calls on the event's live objects.
            let url = unsafe { args.Uri(&mut uri).map(|()| take_pwstr(uri)) }.unwrap_or_default();
            if !item.allows(&url) {
                // SAFETY: as above.
                let _ = unsafe { args.SetCancel(true) };
                log::warn!(target: "js", "web view navigation to {url} is not granted");
                let message = format!("navigation to {url} is not granted");
                item.emitter.emit(EventKind::Error, || {
                    EventPayload::Map(vec![
                        ("message", PayloadValue::Str(message)),
                        ("url", PayloadValue::Str(url.clone())),
                    ])
                });
                return Ok(());
            }
            let mut state = navigation(&sender, true);
            state.url = url;
            item.emitter.emit(EventKind::LoadStart, || state.payload());
            item.emitter
                .emit(EventKind::NavigationStateChange, || state.payload());
            Ok(())
        }));
        let weak = Rc::downgrade(self);
        let completed = NavigationCompletedEventHandler::create(Box::new(move |sender, args| {
            let (Some(item), Some(sender), Some(args)) = (weak.upgrade(), sender, args) else {
                return Ok(());
            };
            let mut success = BOOL(0);
            let mut status = COREWEBVIEW2_WEB_ERROR_STATUS(0);
            // SAFETY: WebView2 calls on the event's live objects.
            unsafe {
                let _ = args.IsSuccess(&mut success);
                let _ = args.WebErrorStatus(&mut status);
            }
            if success.as_bool() {
                let state = navigation(&sender, false);
                item.emitter.emit(EventKind::Load, || state.payload());
                item.emitter
                    .emit(EventKind::NavigationStateChange, || state.payload());
            } else if let Some(message) = web_error(status.0) {
                item.emitter
                    .emit(EventKind::Error, || error(message.to_owned()));
            }
            Ok(())
        }));
        let weak = Rc::downgrade(self);
        let message = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
            let (Some(item), Some(args)) = (weak.upgrade(), args) else {
                return Ok(());
            };
            let mut text = PWSTR::null();
            // SAFETY: WebView2 calls on the event's live object; a message
            // that is not a string comes as JSON.
            let data = unsafe {
                match args.TryGetWebMessageAsString(&mut text) {
                    Ok(()) => take_pwstr(text),
                    Err(_) => {
                        let mut json = PWSTR::null();
                        args.WebMessageAsJson(&mut json)
                            .map(|()| take_pwstr(json))
                            .unwrap_or_default()
                    }
                }
            };
            item.emitter.emit(EventKind::Message, || {
                EventPayload::Map(vec![("data", PayloadValue::Str(data))])
            });
            Ok(())
        }));
        // SAFETY: WebView2 calls on the live web view; the handlers hold the
        // item weakly, and go with the web view.
        unsafe {
            let _ = webview.add_NavigationStarting(&starting, &mut token);
            let _ = webview.add_NavigationCompleted(&completed, &mut token);
            let _ = webview.add_WebMessageReceived(&message, &mut token);
        }
    }

    /// Follows the page's cursor and keyboard focus.
    fn listen_input(
        self: &Rc<Self>,
        composition: &ICoreWebView2CompositionController,
        controller: &ICoreWebView2Controller,
    ) {
        let mut token = 0i64;
        let weak = Rc::downgrade(self);
        let cursor = CursorChangedEventHandler::create(Box::new(move |sender, _| {
            let (Some(item), Some(sender)) = (weak.upgrade(), sender) else {
                return Ok(());
            };
            let mut handle = HCURSOR::default();
            // SAFETY: a WebView2 getter on the event's live sender.
            if unsafe { sender.Cursor(&mut handle) }.is_ok() {
                item.cursor.set(handle.0 as isize);
                if item.hovered.get() && !handle.is_invalid() {
                    // The window asks for the cursor only when the mouse
                    // moves: show the page's now.
                    // SAFETY: a cursor handle WebView2 just gave.
                    unsafe { SetCursor(Some(handle)) };
                }
            }
            Ok(())
        }));
        let weak = Rc::downgrade(self);
        let got = FocusChangedEventHandler::create(Box::new(move |_, _| {
            if let Some(item) = weak.upgrade() {
                item.focused.set(true);
                // The page has the keyboard: nsh's fields give it up, as a
                // text field resigns when a web view becomes first
                // responder.
                if let Some(surface) = item.surface.upgrade() {
                    crate::text_input::blur_all(&surface);
                    surface.sync_focus();
                }
            }
            Ok(())
        }));
        let weak = Rc::downgrade(self);
        let lost = FocusChangedEventHandler::create(Box::new(move |_, _| {
            if let Some(item) = weak.upgrade() {
                item.focused.set(false);
                if let Some(surface) = item.surface.upgrade() {
                    surface.sync_focus();
                }
            }
            Ok(())
        }));
        let weak = Rc::downgrade(self);
        let tab_out = MoveFocusRequestedEventHandler::create(Box::new(move |_, args| {
            if let (Some(item), Some(args)) = (weak.upgrade(), args) {
                item.focus_window();
                // SAFETY: a WebView2 call on the event's live object.
                let _ = unsafe { args.SetHandled(true) };
            }
            Ok(())
        }));
        // SAFETY: WebView2 calls on the live controllers; the handlers hold
        // the item weakly.
        unsafe {
            let _ = composition.add_CursorChanged(&cursor, &mut token);
            let _ = controller.add_GotFocus(&got, &mut token);
            let _ = controller.add_LostFocus(&lost, &mut token);
            let _ = controller.add_MoveFocusRequested(&tab_out, &mut token);
        }
    }

    /// Gives the keyboard back to the surface's window.
    fn focus_window(&self) {
        let Some(surface) = self.surface.upgrade() else {
            return;
        };
        let hwnd = surface.hwnd();
        // SAFETY: plain calls on this thread's window.
        unsafe {
            let focus = GetFocus();
            if focus != hwnd && (focus.is_invalid() || IsChild(hwnd, focus).as_bool()) {
                let _ = SetFocus(Some(hwnd));
            }
        }
        self.focused.set(false);
        surface.sync_focus();
    }

    /// True when the app may show `url` at the top level.
    fn allows(&self, url: &str) -> bool {
        // Pages the app gave as HTML.
        if url.starts_with("data:")
            || self
                .html
                .borrow()
                .as_ref()
                .is_some_and(|(base, _)| same_document(url, base))
        {
            return true;
        }
        let Some(surface) = self.surface.upgrade() else {
            return false;
        };
        let access = surface.native.access.borrow().clone();
        access.is_none_or(|a: Arc<nsh_engine::Access>| a.allows_webview(url))
    }

    pub(crate) fn set(&self, surface: &Rc<Surface>, view: &NshView, p: &WebProps) {
        self.background.set(view.state().style.background_color);
        *self.props.borrow_mut() = Some(p.clone());
        if self.webview.borrow().is_some() {
            self.paint_background();
            self.apply(p);
        }
        surface.invalidate();
    }

    /// Applies `p` to the web view (it is ready).
    fn apply(&self, p: &WebProps) {
        let Some(webview) = self.webview.borrow().clone() else {
            return;
        };
        let old = self.applied.borrow_mut().replace(p.clone());
        let scripts_changed = old.as_ref().is_none_or(|o| {
            o.injected_js != p.injected_js || o.injected_js_before != p.injected_js_before
        });
        // SAFETY: WebView2 calls on the live web view, on its thread.
        unsafe {
            if let Ok(settings) = webview.Settings() {
                let _ = settings.SetIsScriptEnabled(p.javascript_enabled);
                if let Ok(settings) = settings.cast::<ICoreWebView2Settings2>() {
                    let agent = p
                        .user_agent
                        .as_deref()
                        .map(str::to_owned)
                        .or_else(|| self.default_agent.borrow().clone());
                    if let Some(agent) = agent {
                        let _ = settings.SetUserAgent(&HSTRING::from(agent));
                    }
                }
                if let Ok(settings) = settings.cast::<ICoreWebView2Settings6>() {
                    let _ = settings.SetIsSwipeNavigationEnabled(p.back_forward_gestures);
                }
            }
            if scripts_changed {
                for id in self.scripts.borrow_mut().drain(..) {
                    let _ = webview.RemoveScriptToExecuteOnDocumentCreated(&HSTRING::from(id));
                }
                let scripts = [
                    p.injected_js_before.as_deref().map(before_content),
                    p.injected_js.as_deref().map(after_content),
                ];
                for script in scripts.into_iter().flatten() {
                    let ids = Rc::downgrade(&self.scripts);
                    let handler = AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(
                        Box::new(move |result, id| {
                            if let (Ok(()), Some(ids)) = (result, ids.upgrade()) {
                                ids.borrow_mut().push(id);
                            }
                            Ok(())
                        }),
                    );
                    let _ = webview
                        .AddScriptToExecuteOnDocumentCreated(&HSTRING::from(script), &handler);
                }
            }
            if old.as_ref().is_none_or(|o| o.scrollable) != p.scrollable {
                self.set_scrolls(&webview, p.scrollable);
            }
            let navigate = scripts_changed || old.as_ref().is_none_or(|o| o.source != p.source);
            if navigate {
                let result = match &p.source {
                    WebSource::Uri(uri) => {
                        self.html.borrow_mut().take();
                        webview.Navigate(&HSTRING::from(&**uri))
                    }
                    WebSource::Html {
                        html,
                        base_url: Some(base),
                    } if !base.is_empty() => {
                        *self.html.borrow_mut() = Some((base.to_string(), html.clone()));
                        self.serve_html(&webview);
                        webview.Navigate(&HSTRING::from(&**base))
                    }
                    WebSource::Html { html, .. } => {
                        self.html.borrow_mut().take();
                        webview.NavigateToString(&HSTRING::from(&**html))
                    }
                    WebSource::None => {
                        self.html.borrow_mut().take();
                        webview.Navigate(w!("about:blank"))
                    }
                };
                if let Err(err) = result {
                    let message = err.message();
                    self.emitter.emit(EventKind::Error, || error(message));
                }
            }
        }
    }

    /// `scrollable`: the page's viewport scrolls, or not (the style is
    /// put in the page now and in every page loaded later).
    fn set_scrolls(&self, webview: &ICoreWebView2, enabled: bool) {
        let none = None::<&ICoreWebView2ExecuteScriptCompletedHandler>;
        // SAFETY: WebView2 calls on the live web view, on its thread.
        unsafe {
            if let Some(id) = self.scroll_script.borrow_mut().take() {
                let _ = webview.RemoveScriptToExecuteOnDocumentCreated(&HSTRING::from(id));
            }
            if !enabled {
                let slot = Rc::downgrade(&self.scroll_script);
                let handler = AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(
                    Box::new(move |result, id| {
                        if let (Ok(()), Some(slot)) = (result, slot.upgrade()) {
                            *slot.borrow_mut() = Some(id);
                        }
                        Ok(())
                    }),
                );
                let _ = webview.AddScriptToExecuteOnDocumentCreated(
                    &HSTRING::from(scroll_style(false)),
                    &handler,
                );
            }
            let _ = webview.ExecuteScript(&HSTRING::from(scroll_style(enabled)), none);
        }
    }

    /// Answers the request of the document at the base URL with the app's
    /// HTML (`baseUrl`).
    fn serve_html(&self, webview: &ICoreWebView2) {
        if self.serving.replace(true) {
            return;
        }
        let item = self.emitter.clone();
        let surface = self.surface.clone();
        let handler = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let Some(web) = surface.upgrade().and_then(|s| super::web_item(&s, item.id)) else {
                return Ok(());
            };
            let Some((base, html)) = web.html.borrow().clone() else {
                return Ok(());
            };
            let Some(env) = web.env.borrow().clone() else {
                return Ok(());
            };
            // SAFETY: WebView2 calls on the event's live objects; the
            // stream holds a copy of the bytes.
            unsafe {
                let request = args.Request()?;
                let mut uri = PWSTR::null();
                request.Uri(&mut uri)?;
                if !same_document(&take_pwstr(uri), &base) {
                    return Ok(());
                }
                let Some(stream) = SHCreateMemStream(Some(html.as_bytes())) else {
                    return Ok(());
                };
                let response = env.CreateWebResourceResponse(
                    &stream,
                    200,
                    w!("OK"),
                    w!("Content-Type: text/html; charset=utf-8"),
                )?;
                args.SetResponse(&response)?;
            }
            Ok(())
        }));
        let mut token = 0i64;
        // SAFETY: WebView2 calls on the live web view; the handler finds the
        // item through its surface.
        unsafe {
            let _ = webview
                .AddWebResourceRequestedFilter(w!("*"), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT);
            let _ = webview.add_WebResourceRequested(&handler, &mut token);
        }
    }

    /// `reload()`, `goBack()`, `goForward()`, `stopLoading()`,
    /// `injectJavaScript()` and `postMessage()`.
    pub(crate) fn command(&self, command: &Command) {
        let Some(webview) = self.webview.borrow().clone() else {
            if !self.failed.get() {
                self.queued.borrow_mut().push(command.clone());
            }
            return;
        };
        let none = None::<&ICoreWebView2ExecuteScriptCompletedHandler>;
        // SAFETY: WebView2 calls on the live web view, on its thread.
        let _ = unsafe {
            match command {
                Command::Reload => webview.Reload(),
                Command::GoBack => webview.GoBack(),
                Command::GoForward => webview.GoForward(),
                Command::StopLoading => webview.Stop(),
                Command::InjectJavaScript(js) => webview.ExecuteScript(&HSTRING::from(js), none),
                Command::PostMessage(data) => {
                    webview.ExecuteScript(&HSTRING::from(post_message(data)), none)
                }
                _ => Ok(()),
            }
        };
    }

    /// The view's background behind the page until it paints (when the
    /// view has an opaque one).
    fn paint_background(&self) {
        let color = self.background.get();
        let Some(controller) = self.controller.borrow().clone() else {
            return;
        };
        let (r, g, b, a) = color.to_f64();
        if a < 1.0 {
            return;
        }
        let byte = |v: f64| (v * 255.0).round() as u8;
        // SAFETY: a WebView2 call on the live controller.
        unsafe {
            if let Ok(c) = controller.cast::<ICoreWebView2Controller2>() {
                let _ = c.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR {
                    A: 255,
                    R: byte(r),
                    G: byte(g),
                    B: byte(b),
                });
            }
        }
    }

    /// Gives the controller the bounds, visibility and scale of where the
    /// last frame put the page.
    fn place(&self) {
        let Some(controller) = self.controller.borrow().clone() else {
            return;
        };
        let at = self.at.get();
        let bounds = at.map(|p| p.bounds());
        let before = self.bounds.replace(bounds);
        if before == bounds {
            return;
        }
        // SAFETY: WebView2 calls on the live controller, on its thread.
        unsafe {
            if let Some(b) = bounds {
                let scale = self.surface.upgrade().map_or(1.0, |s| s.scale());
                if self.raster.replace(scale) != scale
                    && let Ok(c) = controller.cast::<ICoreWebView2Controller3>()
                {
                    let _ = c.SetRasterizationScale(scale as f64);
                }
                let _ = controller.SetBounds(b);
                if before.is_none() {
                    let _ = controller.SetIsVisible(true);
                } else {
                    // Pop-ups (select menus, tooltips) follow the page.
                    let _ = controller.NotifyParentWindowPositionChanged();
                }
            } else {
                let _ = controller.SetIsVisible(false);
            }
        }
        if bounds.is_none() && self.focused.get() {
            // A hidden page keeps no keyboard focus.
            self.focus_window();
        }
    }

    /// Its view was deleted: it closes once the view is not drawn anymore
    /// (now, unless a removal animation keeps it on screen).
    pub(crate) fn retire(&self) {
        self.retired.set(true);
        if self.at.get().is_none() {
            self.close();
        }
    }

    /// The page closes (the app stopped, or its view is gone).
    pub(crate) fn close(&self) {
        if self.closed.replace(true) {
            return;
        }
        if self.focused.get() {
            self.focus_window();
        }
        self.webview.borrow_mut().take();
        self.queued.borrow_mut().clear();
        self.composition.borrow_mut().take();
        if let Some(controller) = self.controller.borrow_mut().take() {
            // SAFETY: closes the live controller; it is not used afterwards.
            let _ = unsafe { controller.Close() };
        }
        // Its visuals leave the composition (gone with the last web view).
        self.portal.borrow_mut().take();
        if let Some(surface) = self.surface.upgrade() {
            surface.invalidate();
        }
    }

    /// Pixels per point of the window.
    fn scale(&self) -> f32 {
        self.surface.upgrade().map_or(1.0, |s| s.scale())
    }

    /// A touch or pen contact through `SendPointerInput`, with the
    /// system's data of pointer `id` moved to `point` (the page's pixels).
    /// False when the system has no data for it (synthesized input).
    fn send_pointer(&self, event: &ItemPointer, point: POINT) -> bool {
        let (Some(composition), Some(env), Some(surface)) = (
            self.composition.borrow().clone(),
            self.env.borrow().clone(),
            self.surface.upgrade(),
        ) else {
            return false;
        };
        let Some(id) = event.pointer.checked_sub(2) else {
            return false;
        };
        let Ok(env) = env.cast::<ICoreWebView2Environment3>() else {
            return false;
        };
        let kind = match event.kind {
            PointerKind::Down => 0x0246,
            PointerKind::Move => 0x0245,
            PointerKind::Up | PointerKind::Cancel => 0x0247,
            PointerKind::Leave => 0x024A,
        };
        // SAFETY: plain pointer queries into locals, then WebView2 calls on
        // live objects of this thread.
        unsafe {
            let mut info = POINTER_INFO::default();
            if GetPointerInfo(id, &mut info).is_err() {
                return false;
            }
            let Ok(p) = env.CreateCoreWebView2PointerInfo() else {
                return false;
            };
            let mut client = info.ptPixelLocation;
            let _ = ScreenToClient(surface.hwnd(), &mut client);
            // From where the contact is in the window to where nsh put it
            // on the page.
            let (dx, dy) = (point.x - client.x, point.y - client.y);
            let mut device = RECT::default();
            let mut display = RECT::default();
            let _ = GetPointerDeviceRects(info.sourceDevice, &mut device, &mut display);
            // Himetric units per pixel.
            let ratio = |d: i32, s: i32| if s != 0 { d as f32 / s as f32 } else { 1.0 };
            let (hx, hy) = (
                ratio(device.right - device.left, display.right - display.left),
                ratio(device.bottom - device.top, display.bottom - display.top),
            );
            let moved = |q: POINT| POINT {
                x: q.x + dx,
                y: q.y + dy,
            };
            let moved_himetric = |q: POINT| POINT {
                x: q.x + (dx as f32 * hx) as i32,
                y: q.y + (dy as f32 * hy) as i32,
            };
            let _ = p.SetPointerKind(info.pointerType.0 as u32);
            let _ = p.SetPointerId(info.pointerId);
            let _ = p.SetFrameId(info.frameId);
            let _ = p.SetPointerFlags(info.pointerFlags.0);
            let _ = p.SetPointerDeviceRect(device);
            let _ = p.SetDisplayRect(display);
            let _ = p.SetPixelLocation(point);
            let _ = p.SetHimetricLocation(moved_himetric(info.ptHimetricLocation));
            let _ = p.SetPixelLocationRaw(moved(info.ptPixelLocationRaw));
            let _ = p.SetHimetricLocationRaw(moved_himetric(info.ptHimetricLocationRaw));
            let _ = p.SetTime(info.dwTime);
            let _ = p.SetHistoryCount(info.historyCount);
            let _ = p.SetInputData(info.InputData);
            let _ = p.SetKeyStates(info.dwKeyStates);
            let _ = p.SetPerformanceCount(info.PerformanceCount);
            let _ = p.SetButtonChangeKind(info.ButtonChangeType.0);
            if event.touch {
                let mut touch = POINTER_TOUCH_INFO::default();
                if GetPointerTouchInfo(id, &mut touch).is_ok() {
                    let shift = |r: RECT| RECT {
                        left: r.left + dx,
                        top: r.top + dy,
                        right: r.right + dx,
                        bottom: r.bottom + dy,
                    };
                    let _ = p.SetTouchFlags(touch.touchFlags);
                    let _ = p.SetTouchMask(touch.touchMask);
                    let _ = p.SetTouchContact(shift(touch.rcContact));
                    let _ = p.SetTouchContactRaw(shift(touch.rcContactRaw));
                    let _ = p.SetTouchOrientation(touch.orientation);
                    let _ = p.SetTouchPressure(touch.pressure);
                }
            } else {
                let mut pen = POINTER_PEN_INFO::default();
                if GetPointerPenInfo(id, &mut pen).is_ok() {
                    let _ = p.SetPenFlags(pen.penFlags);
                    let _ = p.SetPenMask(pen.penMask);
                    let _ = p.SetPenPressure(pen.pressure);
                    let _ = p.SetPenRotation(pen.rotation);
                    let _ = p.SetPenTiltX(pen.tiltX);
                    let _ = p.SetPenTiltY(pen.tiltY);
                }
            }
            composition
                .SendPointerInput(COREWEBVIEW2_POINTER_EVENT_KIND(kind), &p)
                .is_ok()
        }
    }

    /// Sends a mouse event to the page.
    fn send_mouse(
        &self,
        kind: COREWEBVIEW2_MOUSE_EVENT_KIND,
        data: u32,
        point: POINT,
        m: Modifiers,
    ) {
        let Some(composition) = self.composition.borrow().clone() else {
            return;
        };
        // MK_LBUTTON, MK_RBUTTON, MK_MBUTTON, MK_XBUTTON1 and MK_XBUTTON2 by
        // button; MK_SHIFT and MK_CONTROL.
        const BUTTON_KEYS: [i32; 5] = [0x1, 0x2, 0x10, 0x20, 0x40];
        let held = self.buttons.get();
        let mut keys = (0..5)
            .filter(|b| held & (1 << b) != 0)
            .fold(0, |k, b| k | BUTTON_KEYS[b]);
        if m.shift {
            keys |= 0x4;
        }
        if m.ctrl {
            keys |= 0x8;
        }
        // SAFETY: a WebView2 call on the live controller, on its thread.
        let sent = unsafe {
            composition.SendMouseInput(
                kind,
                COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS(keys),
                data,
                point,
            )
        };
        if let Err(err) = sent {
            log::debug!("web view: input not sent: {err}");
        }
    }
}

impl Drop for WebItem {
    fn drop(&mut self) {
        self.close();
    }
}

/// The mouse event of `button` going down (with its click count) or up.
fn button_event(button: u8, down: bool, clicks: u32) -> (COREWEBVIEW2_MOUSE_EVENT_KIND, u32) {
    // Windows sends a double click as the second press of a pair.
    let double = down && clicks >= 2 && clicks.is_multiple_of(2);
    let kind = match (button, down, double) {
        (0, true, false) => COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOWN,
        (0, true, true) => COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOUBLE_CLICK,
        (0, false, _) => COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_UP,
        (1, true, false) => COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_DOWN,
        (1, true, true) => COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_DOUBLE_CLICK,
        (1, false, _) => COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_UP,
        (2, true, false) => COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_DOWN,
        (2, true, true) => COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_DOUBLE_CLICK,
        (2, false, _) => COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_UP,
        (_, true, false) => COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_DOWN,
        (_, true, true) => COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_DOUBLE_CLICK,
        (_, false, _) => COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_UP,
    };
    // XBUTTON1 is the back button (3), XBUTTON2 the forward one (4).
    let data = match button {
        3 => 1,
        4 => 2,
        _ => 0,
    };
    (kind, data)
}

/// The wheel delta (120 a notch) of a scroll by `points`.
fn wheel_delta(points: f32) -> i32 {
    (points / (crate::window::lines_per_notch() * 16.0) * 120.0).round() as i32
}

impl Hosted for WebItem {
    fn draw(&self, cx: &mut DrawCx<'_>, size: (f32, f32)) {
        if !self.failed.get() {
            return;
        }
        let Some(format) = placeholder_format() else {
            return;
        };
        let text: Vec<u16> = "WebView is not available on this system"
            .encode_utf16()
            .collect();
        cx.push_clip_rect(0.0, 0.0, size.0, size.1);
        // SAFETY: a Direct2D call between BeginDraw and EndDraw.
        unsafe {
            cx.dc.DrawText(
                &text,
                &format,
                &rect_f(8.0, 0.0, (size.0 - 16.0).max(0.0), size.1),
                cx.solid(Color::rgba(140, 140, 140, 255)),
                D2D1_DRAW_TEXT_OPTIONS_NONE,
                DWRITE_MEASURING_MODE_NATURAL,
            );
        }
        cx.pop();
    }

    fn hit(&self, x: f32, y: f32, size: (f32, f32)) -> bool {
        // The page takes the pointer where nothing of nsh's covers it.
        self.composed() && x >= 0.0 && y >= 0.0 && x < size.0 && y < size.1
    }

    fn composed(&self) -> bool {
        !self.failed.get() && !self.closed.get() && self.portal.borrow().is_some()
    }

    fn visual(&self) -> Option<IDCompositionVisual2> {
        self.portal.borrow().as_ref().map(|p| p.visual().clone())
    }

    fn compose_at(&self, at: Option<&Placement>) {
        self.at.set(at.copied());
        if let Some(portal) = &*self.portal.borrow() {
            match at {
                Some(p) => portal.place(p),
                None => portal.hidden(),
            }
        }
        self.place();
        if at.is_none() && self.retired.get() {
            self.close();
        }
    }

    fn raw(&self) -> bool {
        self.composed()
    }

    fn pointer(&self, event: &ItemPointer) -> bool {
        let s = self.scale();
        let point = POINT {
            x: (event.x * s).round() as i32,
            y: (event.y * s).round() as i32,
        };
        if (event.touch || event.pen) && self.send_pointer(event, point) {
            if event.kind == PointerKind::Down && !self.focused.get() {
                self.take_focus();
            }
            return true;
        }
        // Synthesized contacts (and pens without data) come as the left
        // button.
        let button = if event.touch || event.pen {
            0
        } else {
            event.button
        };
        let bit = 1u8 << button.min(7);
        match event.kind {
            PointerKind::Down => {
                let (kind, data) = button_event(button, true, event.clicks);
                self.buttons.set(self.buttons.get() | bit);
                self.send_mouse(kind, data, point, event.modifiers);
                if !self.focused.get() {
                    self.take_focus();
                }
            }
            PointerKind::Up => {
                let (kind, data) = button_event(button, false, 1);
                self.buttons.set(self.buttons.get() & !bit);
                self.send_mouse(kind, data, point, event.modifiers);
            }
            PointerKind::Move => {
                self.hovered.set(true);
                self.send_mouse(
                    COREWEBVIEW2_MOUSE_EVENT_KIND_MOVE,
                    0,
                    point,
                    event.modifiers,
                );
            }
            PointerKind::Cancel | PointerKind::Leave => {
                self.hovered.set(false);
                self.buttons.set(0);
                self.send_mouse(
                    COREWEBVIEW2_MOUSE_EVENT_KIND_LEAVE,
                    0,
                    point,
                    event.modifiers,
                );
            }
        }
        true
    }

    fn wheel(&self, x: f32, y: f32, event: &WheelEvent) -> bool {
        if !self.applied.borrow().as_ref().is_none_or(|p| p.scrollable) {
            // The scroll views around it scroll instead.
            return false;
        }
        let s = self.scale();
        let point = POINT {
            x: (x * s).round() as i32,
            y: (y * s).round() as i32,
        };
        // Positive deltas scroll up and right, as `WM_MOUSEWHEEL` and
        // `WM_MOUSEHWHEEL`.
        if event.dy != 0.0 {
            let delta = wheel_delta(-event.dy);
            self.send_mouse(
                COREWEBVIEW2_MOUSE_EVENT_KIND_WHEEL,
                delta as u32,
                point,
                event.modifiers,
            );
        }
        if event.dx != 0.0 {
            let delta = wheel_delta(event.dx);
            self.send_mouse(
                COREWEBVIEW2_MOUSE_EVENT_KIND_HORIZONTAL_WHEEL,
                delta as u32,
                point,
                event.modifiers,
            );
        }
        true
    }

    fn cursor(&self, _x: f32, _y: f32) -> Option<crate::input::Cursor> {
        let c = self.cursor.get();
        (c != 0 && self.composed()).then_some(crate::input::Cursor::Native(c))
    }
}

impl WebItem {
    /// Gives the page the keyboard focus (a click on it).
    fn take_focus(&self) {
        if let Some(controller) = self.controller.borrow().clone() {
            // SAFETY: a WebView2 call on the live controller.
            let _ = unsafe { controller.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC) };
        }
    }
}

/// True when `a` and `b` name the same document (fragments aside; a URL
/// with no path is its root's).
fn same_document(a: &str, b: &str) -> bool {
    fn normal(url: &str) -> String {
        let url = url.split('#').next().unwrap_or(url);
        match url.find("://") {
            Some(i) => {
                let rest = &url[i + 3..];
                let (host, path) = match rest.find('/') {
                    Some(j) => (&rest[..j], &rest[j..]),
                    None => (rest, "/"),
                };
                format!(
                    "{}://{}{path}",
                    url[..i].to_ascii_lowercase(),
                    host.to_ascii_lowercase()
                )
            }
            None => url.to_owned(),
        }
    }
    normal(a) == normal(b)
}

/// The script that lets the page's viewport scroll, or keeps it from
/// scrolling (a style on its root element; scripts still scroll it).
fn scroll_style(enabled: bool) -> String {
    format!(
        "(function () {{ var on = {enabled}; var id = 'nsh-no-scroll'; \
         function apply() {{ var s = document.getElementById(id); \
         if (on) {{ if (s) s.remove(); return; }} \
         if (!s && document.documentElement) {{ s = document.createElement('style'); s.id = id; \
         s.textContent = 'html {{ overflow: hidden !important; }}'; document.documentElement.appendChild(s); }} }} \
         if (document.documentElement) apply(); else document.addEventListener('readystatechange', apply, {{ once: true }}); }})();"
    )
}

/// The page's navigation state, as `WebViewNavigation`.
#[derive(Debug, Clone, Default, PartialEq)]
struct Navigation {
    url: String,
    title: String,
    loading: bool,
    can_go_back: bool,
    can_go_forward: bool,
}

impl Navigation {
    fn payload(&self) -> EventPayload {
        EventPayload::Map(vec![
            ("url", PayloadValue::Str(self.url.clone())),
            ("title", PayloadValue::Str(self.title.clone())),
            ("loading", PayloadValue::Bool(self.loading)),
            ("canGoBack", PayloadValue::Bool(self.can_go_back)),
            ("canGoForward", PayloadValue::Bool(self.can_go_forward)),
        ])
    }
}

/// The navigation state of `webview`.
fn navigation(webview: &ICoreWebView2, loading: bool) -> Navigation {
    let mut url = PWSTR::null();
    let mut title = PWSTR::null();
    let (mut back, mut forward) = (BOOL(0), BOOL(0));
    // SAFETY: WebView2 getters on the live web view; the strings are freed
    // by `take_pwstr`.
    unsafe {
        let url = webview
            .Source(&mut url)
            .map(|()| take_pwstr(url))
            .unwrap_or_default();
        let title = webview
            .DocumentTitle(&mut title)
            .map(|()| take_pwstr(title))
            .unwrap_or_default();
        let _ = webview.CanGoBack(&mut back);
        let _ = webview.CanGoForward(&mut forward);
        Navigation {
            url,
            title,
            loading,
            can_go_back: back.as_bool(),
            can_go_forward: forward.as_bool(),
        }
    }
}

/// What a failed navigation reports, `None` for one that was replaced or
/// cancelled (not an error).
fn web_error(status: i32) -> Option<&'static str> {
    Some(match status {
        1 => "The certificate's common name does not match the host.",
        2 => "The certificate has expired.",
        3 => "The client certificate contains errors.",
        4 => "The certificate has been revoked.",
        5 => "The certificate is invalid.",
        6 => "The server is unreachable.",
        7 => "The connection timed out.",
        8 => "The server returned an invalid response.",
        9 => "The connection was aborted.",
        10 => "The connection was reset.",
        11 => "The internet connection was lost.",
        12 => "Cannot connect to the server.",
        13 => "The host name could not be resolved.",
        14 => return None,
        15 => "A redirect failed.",
        17 => "Authentication is required.",
        18 => "Proxy authentication is required.",
        _ => "The page could not be loaded.",
    })
}

/// A JS string literal for `s`.
fn js_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The script `postMessage(data)` runs in the page.
fn post_message(data: &str) -> String {
    format!(
        "window.dispatchEvent(new MessageEvent('message', {{ data: {} }}));",
        js_string(data)
    )
}

/// `injectedJavaScriptBeforeContentLoaded`: in the main frame, before the
/// page's own scripts (WebView2 runs document scripts in every frame).
fn before_content(js: &str) -> String {
    format!("if (window === window.top) {{\n{js}\n}}")
}

/// `injectedJavaScript`: in the main frame, once the document is parsed.
fn after_content(js: &str) -> String {
    format!(
        "if (window === window.top) {{ (function () {{ var run = function () {{\n{js}\n}}; \
         if (document.readyState === 'loading') {{ document.addEventListener('DOMContentLoaded', run, {{ once: true }}); }} \
         else {{ run(); }} }})(); }}"
    )
}

/// Where web views of app `app_id` keep their profile.
fn profile_folder(app_id: &str) -> String {
    let base = std::env::var("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    let app = if app_id.is_empty() { "nsh" } else { app_id };
    // An id is a reverse domain name: keep it a single, valid folder name.
    let app: String = app
        .chars()
        .map(|c| if r#"\/:*?"<>|"#.contains(c) { '_' } else { c })
        .collect();
    base.join(app)
        .join("WebView2")
        .to_string_lossy()
        .into_owned()
}

/// Waiting for an environment.
type EnvCallback = Box<dyn FnOnce(Option<ICoreWebView2Environment>)>;

enum EnvState {
    Pending(Vec<EnvCallback>),
    Ready(ICoreWebView2Environment),
    Failed,
}

thread_local! {
    /// WebView2 environments by profile folder: one browser process
    /// serves every web view of a profile.
    static ENVIRONMENTS: RefCell<HashMap<String, EnvState>> = RefCell::default();
}

/// Calls `f` with the environment of profile `folder` once it is made
/// (`None` when it cannot be).
fn with_environment(folder: &str, f: impl FnOnce(Option<ICoreWebView2Environment>) + 'static) {
    let known = ENVIRONMENTS.with(|envs| match envs.borrow().get(folder) {
        Some(EnvState::Ready(env)) => Some(Some(env.clone())),
        Some(EnvState::Failed) => Some(None),
        _ => None,
    });
    if let Some(env) = known {
        return f(env);
    }
    let start = ENVIRONMENTS.with(|envs| {
        let mut envs = envs.borrow_mut();
        if let Some(EnvState::Pending(waiting)) = envs.get_mut(folder) {
            waiting.push(Box::new(f));
            false
        } else {
            envs.insert(folder.to_owned(), EnvState::Pending(vec![Box::new(f)]));
            true
        }
    });
    // Outside the borrow: a loader that fails at once calls back here.
    if start {
        start_environment(folder);
    }
}

/// Starts making the environment of profile `folder`.
fn start_environment(folder: &str) {
    let key = folder.to_owned();
    let handler =
        CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(move |result, env| {
            if let Err(err) = &result {
                log::warn!("web view: no WebView2 environment: {err}");
            }
            let env = result.ok().and(env);
            let waiting = ENVIRONMENTS.with(|envs| {
                let mut envs = envs.borrow_mut();
                let state = match &env {
                    Some(env) => EnvState::Ready(env.clone()),
                    None => EnvState::Failed,
                };
                match envs.insert(key.clone(), state) {
                    Some(EnvState::Pending(waiting)) => waiting,
                    _ => Vec::new(),
                }
            });
            for f in waiting {
                f(env.clone());
            }
            Ok(())
        }));
    let folder = HSTRING::from(folder);
    // SAFETY: valid strings; the handler is an owned COM object the loader
    // keeps until it calls it.
    let result = unsafe {
        create_environment(
            PCWSTR::null(),
            PCWSTR(folder.as_ptr()),
            std::ptr::null_mut(),
            windows::core::Interface::as_raw(&handler),
        )
    };
    if let Err(err) = result.ok() {
        log::warn!("web view: cannot start WebView2: {err}");
        let waiting = ENVIRONMENTS.with(|envs| {
            match envs
                .borrow_mut()
                .insert(folder.to_string(), EnvState::Failed)
            {
                Some(EnvState::Pending(waiting)) => waiting,
                _ => Vec::new(),
            }
        });
        for f in waiting {
            f(None);
        }
    }
}

/// The placeholder's text format, made once per thread.
fn placeholder_format() -> Option<IDWriteTextFormat> {
    thread_local! {
        static FORMAT: Option<IDWriteTextFormat> = {
            // SAFETY: plain DirectWrite calls with valid strings.
            unsafe {
                gfx::dwrite()
                    .CreateTextFormat(
                        &HSTRING::from("Segoe UI"),
                        None,
                        DWRITE_FONT_WEIGHT_NORMAL,
                        DWRITE_FONT_STYLE_NORMAL,
                        DWRITE_FONT_STRETCH_NORMAL,
                        14.0,
                        &HSTRING::from(""),
                    )
                    .ok()
                    .inspect(|f| {
                        let _ = f.SetTextAlignment(DWRITE_TEXT_ALIGNMENT_CENTER);
                        let _ = f.SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER);
                        let _ = f.SetWordWrapping(DWRITE_WORD_WRAPPING_WRAP);
                    })
            }
        };
    }
    FORMAT.with(Clone::clone)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_js_strings() {
        assert_eq!(js_string("a\"b\\c\nd\u{1}"), r#""a\"b\\c\nd\u0001""#);
        assert_eq!(
            post_message("hi #1"),
            r#"window.dispatchEvent(new MessageEvent('message', { data: "hi #1" }));"#
        );
    }

    #[test]
    fn wraps_injected_scripts() {
        assert!(before_content("x()").starts_with("if (window === window.top) {\nx()"));
        let after = after_content("y()");
        assert!(after.contains("DOMContentLoaded") && after.contains("\ny()\n"));
    }

    #[test]
    fn makes_navigation_payloads() {
        let state = Navigation {
            url: "https://example.com/".into(),
            title: "Example".into(),
            loading: false,
            can_go_back: true,
            can_go_forward: false,
        };
        assert_eq!(
            state.payload(),
            EventPayload::Map(vec![
                ("url", PayloadValue::Str("https://example.com/".into())),
                ("title", PayloadValue::Str("Example".into())),
                ("loading", PayloadValue::Bool(false)),
                ("canGoBack", PayloadValue::Bool(true)),
                ("canGoForward", PayloadValue::Bool(false)),
            ])
        );
    }

    #[test]
    fn words_web_errors() {
        assert_eq!(web_error(13), Some("The host name could not be resolved."));
        assert_eq!(web_error(14), None);
        assert_eq!(web_error(99), Some("The page could not be loaded."));
    }

    #[test]
    fn names_profile_folders() {
        let folder = profile_folder("com.example.app");
        assert!(folder.ends_with(r"com.example.app\WebView2"), "{folder}");
        assert!(profile_folder("a:b").contains("a_b"));
    }

    #[test]
    fn matches_base_documents() {
        assert!(same_document("https://Example.com", "https://example.com/"));
        assert!(same_document(
            "https://example.com/a/b.html#top",
            "https://example.com/a/b.html"
        ));
        assert!(!same_document(
            "https://example.com/a/",
            "https://example.com/a/b.html"
        ));
        assert!(!same_document(
            "https://example.com/A",
            "https://example.com/a"
        ));
    }

    #[test]
    fn maps_buttons_to_mouse_events() {
        assert_eq!(
            button_event(0, true, 1),
            (COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOWN, 0)
        );
        assert_eq!(
            button_event(0, true, 2),
            (COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOUBLE_CLICK, 0)
        );
        assert_eq!(
            button_event(0, true, 3),
            (COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOWN, 0)
        );
        assert_eq!(
            button_event(1, false, 1),
            (COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_UP, 0)
        );
        assert_eq!(
            button_event(4, true, 1),
            (COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_DOWN, 2)
        );
    }

    #[test]
    fn styles_scrolling() {
        assert!(scroll_style(false).contains("var on = false"));
        assert!(scroll_style(true).contains("var on = true"));
        assert!(scroll_style(false).contains("overflow: hidden !important"));
    }
}

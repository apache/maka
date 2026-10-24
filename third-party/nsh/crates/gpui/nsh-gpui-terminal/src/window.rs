use std::{
    cell::RefCell,
    ops::Range,
    rc::{Rc, Weak},
    sync::Arc,
};

use anyhow::{Result, anyhow, ensure};
use futures_channel::oneshot;
use gpui::{
    AnyWindowHandle, Bounds, Capslock, DevicePixels, DispatchEventResult, FrameRequestSource,
    GpuSpecs, Modifiers, Pixels, PlatformAtlas, PlatformDisplay, PlatformInput,
    PlatformInputHandler, PlatformWindow, Point, PromptButton, PromptLevel, RequestFrameOptions,
    Scene, Size, WindowAppearance, WindowBackgroundAppearance, WindowBounds, WindowControlArea,
    WindowParams, WindowVisibility,
};
use raw_window_handle::{HasDisplayHandle, HasWindowHandle};

use crate::{FrameToken, SubmittedFrame};
type SubmissionSink = Box<dyn FnMut(SubmittedFrame)>;
type Wake = Arc<dyn Fn() + Send + Sync>;
type Resize = Box<dyn FnMut(Size<Pixels>, f32)>;

#[derive(Default)]
struct Callbacks {
    frame: Option<Box<dyn FnMut(RequestFrameOptions)>>,
    input: Option<Box<dyn FnMut(PlatformInput) -> DispatchEventResult>>,
    active: Option<Box<dyn FnMut(bool)>>,
    visibility: Option<Box<dyn FnMut(WindowVisibility)>>,
    hover: Option<Box<dyn FnMut(bool)>>,
    resize: Option<Resize>,
    moved: Option<Box<dyn FnMut()>>,
    display: Option<Box<dyn FnMut()>>,
    should_close: Option<Box<dyn FnMut() -> bool>>,
    hit_test: Option<Box<dyn FnMut() -> Option<WindowControlArea>>>,
    close: Option<Box<dyn FnOnce()>>,
    appearance: Option<Box<dyn FnMut()>>,
}

pub(crate) struct WindowState {
    pub(crate) handle: AnyWindowHandle,
    closed: bool,
    bounds: Bounds<Pixels>,
    size: Size<DevicePixels>,
    scale_factor: f32,
    active: bool,
    visible: WindowVisibility,
    hovered: bool,
    mouse: Point<Pixels>,
    modifiers: Modifiers,
    capslock: Capslock,
    title: String,
    background: WindowBackgroundAppearance,
    input_handler: Option<PlatformInputHandler>,
    callbacks: Callbacks,
    frame_requested: bool,
    resized: bool,
    activation: Option<bool>,
    visibility_change: Option<WindowVisibility>,
    sequence: u64,
    issuer: Arc<()>,
    viewport_generation: u64,
    published: Option<FrameToken>,
    error: Option<String>,
    renderer: Box<gpui_wgpu::WgpuHeadlessRenderer>,
    atlas: Arc<dyn PlatformAtlas>,
    sink: Option<SubmissionSink>,
    wake: Wake,
}

pub(crate) struct TerminalWindow(Rc<RefCell<WindowState>>);

pub(crate) type WindowRef = Weak<RefCell<WindowState>>;

pub(crate) fn rgba_len(size: Size<DevicePixels>) -> Result<usize> {
    let width =
        usize::try_from(size.width.0).map_err(|_| anyhow!("invalid terminal pixel width"))?;
    let height =
        usize::try_from(size.height.0).map_err(|_| anyhow!("invalid terminal pixel height"))?;
    ensure!(
        width > 0 && height > 0,
        "terminal viewport must have positive dimensions"
    );
    width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| anyhow!("terminal pixel dimensions overflow"))
}

fn device_size(size: Size<Pixels>, scale_factor: f32) -> Result<Size<DevicePixels>> {
    let convert = |value: Pixels| -> Result<DevicePixels> {
        let value = f64::from(f32::from(value) * scale_factor).round();
        ensure!(
            value.is_finite() && value >= 1.0 && value <= f64::from(i32::MAX),
            "invalid terminal viewport"
        );
        Ok(DevicePixels(value as i32))
    };
    let size = gpui::size(convert(size.width)?, convert(size.height)?);
    rgba_len(size)?;
    Ok(size)
}

impl TerminalWindow {
    pub(crate) fn new(
        handle: AnyWindowHandle,
        params: WindowParams,
        renderer: Box<gpui_wgpu::WgpuHeadlessRenderer>,
        sink: SubmissionSink,
        wake: Wake,
        viewport: Option<(Size<DevicePixels>, f32)>,
    ) -> Result<(Self, WindowRef)> {
        let (size, scale_factor) = match viewport {
            Some(viewport) => viewport,
            None => (device_size(params.bounds.size, 1.0)?, 1.0),
        };
        let state = Rc::new(RefCell::new(WindowState {
            handle,
            closed: false,
            bounds: Bounds::new(
                Point::default(),
                gpui::size(
                    gpui::px(size.width.0 as f32 / scale_factor),
                    gpui::px(size.height.0 as f32 / scale_factor),
                ),
            ),
            size,
            scale_factor,
            active: params.focus,
            visible: if params.show {
                WindowVisibility::Visible
            } else {
                WindowVisibility::Hidden
            },
            hovered: false,
            mouse: Point::default(),
            modifiers: Modifiers::default(),
            capslock: Capslock::default(),
            title: String::new(),
            background: WindowBackgroundAppearance::Opaque,
            input_handler: None,
            callbacks: Callbacks::default(),
            frame_requested: true,
            resized: false,
            activation: None,
            visibility_change: None,
            sequence: 0,
            issuer: Arc::new(()),
            viewport_generation: 1,
            published: None,
            error: None,
            atlas: renderer.sprite_atlas(),
            renderer,
            sink: Some(sink),
            wake,
        }));
        let weak = Rc::downgrade(&state);
        Ok((Self(state), weak))
    }
}

impl WindowState {
    fn wake(&mut self) -> bool {
        // Deferred drawing keeps this demand pending. Repeated GPUI updates
        // must not wake the owner again for the same unconsumed frame.
        !std::mem::replace(&mut self.frame_requested, true)
    }

    pub(crate) fn active(&self) -> bool {
        self.active
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed
    }

    pub(crate) fn has_pending(&self, allow_draw: bool) -> bool {
        !self.closed
            && ((allow_draw && self.frame_requested && self.visible.is_visible())
                || self.resized
                || self.activation.is_some()
                || self.visibility_change.is_some())
    }

    pub(crate) fn take_error(&mut self) -> Option<String> {
        self.error.take()
    }

    pub(crate) fn published(&self) -> Option<FrameToken> {
        self.published.clone()
    }

    pub(crate) fn mark_presented(&mut self, token: FrameToken) -> Result<()> {
        ensure!(
            token
                .issuer
                .as_ref()
                .is_some_and(|issuer| Arc::ptr_eq(issuer, &self.issuer)),
            "terminal receipt belongs to another renderer"
        );
        ensure!(
            token.viewport_generation == self.viewport_generation,
            "terminal receipt belongs to an obsolete viewport"
        );
        ensure!(
            token.sequence > 0 && token.sequence <= self.sequence,
            "terminal receipt does not name an issued candidate"
        );
        ensure!(
            self.published
                .as_ref()
                .is_none_or(|old| token.sequence > old.sequence),
            "terminal receipt was already superseded"
        );
        self.published = Some(token);
        Ok(())
    }

    pub(crate) fn resize(&mut self, size: Size<DevicePixels>, scale_factor: f32) -> Result<()> {
        rgba_len(size)?;
        if size == self.size && scale_factor == self.scale_factor {
            return Ok(());
        }
        self.viewport_generation = self
            .viewport_generation
            .checked_add(1)
            .ok_or_else(|| anyhow!("terminal viewport generation exhausted"))?;
        self.size = size;
        self.scale_factor = scale_factor;
        self.bounds.size = gpui::size(
            gpui::px(size.width.0 as f32 / scale_factor),
            gpui::px(size.height.0 as f32 / scale_factor),
        );
        self.published = None;
        self.resized = true;
        self.wake();
        Ok(())
    }

    pub(crate) fn set_active(&mut self, active: bool) {
        if self.active != active {
            self.active = active;
            self.activation = Some(active);
            self.wake();
        }
    }

    pub(crate) fn set_visibility(&mut self, visible: WindowVisibility) {
        if self.visible != visible {
            self.visible = visible;
            self.visibility_change = Some(visible);
            self.wake();
        }
    }

    /// Routes physical input through the current native GPUI callback.
    pub(crate) fn dispatch_input(
        state: &Rc<RefCell<Self>>,
        input: PlatformInput,
    ) -> DispatchEventResult {
        let (hover_changed, hovered) = {
            let mut state = state.borrow_mut();
            let previous = state.hovered;
            match &input {
                PlatformInput::KeyDown(event) => state.modifiers = event.keystroke.modifiers,
                PlatformInput::KeyUp(event) => state.modifiers = event.keystroke.modifiers,
                PlatformInput::ModifiersChanged(event) => {
                    state.modifiers = event.modifiers;
                    state.capslock = event.capslock;
                }
                PlatformInput::MouseDown(event) => {
                    state.mouse = event.position;
                    state.modifiers = event.modifiers;
                    state.hovered = true;
                }
                PlatformInput::MouseUp(event) => {
                    state.mouse = event.position;
                    state.modifiers = event.modifiers;
                    state.hovered = true;
                }
                PlatformInput::MouseMove(event) => {
                    state.mouse = event.position;
                    state.modifiers = event.modifiers;
                    state.hovered = true;
                }
                PlatformInput::ScrollWheel(event) => {
                    state.mouse = event.position;
                    state.modifiers = event.modifiers;
                    state.hovered = true;
                }
                PlatformInput::MouseExited(_) => state.hovered = false,
                _ => {}
            }
            (previous != state.hovered, state.hovered)
        };
        if hover_changed {
            let callback = state.borrow_mut().callbacks.hover.take();
            if let Some(mut callback) = callback {
                callback(hovered);
                state.borrow_mut().callbacks.hover.get_or_insert(callback);
            }
        }
        if state.borrow().closed {
            return DispatchEventResult::default();
        }
        let callback = state.borrow_mut().callbacks.input.take();
        let result = if let Some(mut callback) = callback {
            let result = callback(input.clone());
            state.borrow_mut().callbacks.input.get_or_insert(callback);
            result
        } else {
            DispatchEventResult::default()
        };
        if result.propagate
            && !result.default_prevented
            && let PlatformInput::KeyDown(event) = input
            && event.keystroke.modifiers.is_subset_of(&Modifiers::shift())
            && let Some(text) = event.keystroke.key_char
        {
            Self::paste(state, &text);
        }
        result
    }

    pub(crate) fn paste(state: &Rc<RefCell<Self>>, text: &str) {
        if state.borrow().closed {
            return;
        }
        let handler = state.borrow_mut().input_handler.take();
        if let Some(mut handler) = handler {
            if handler.query_accepts_focused_text_input() {
                handler.replace_text_in_range(None, text);
            }
            state.borrow_mut().input_handler.get_or_insert(handler);
        }
    }

    pub(crate) fn text_input_target(state: &Rc<RefCell<Self>>) -> Option<gpui::TextInputTarget> {
        {
            let state = state.borrow();
            if state.closed || !state.active || !state.visible.is_visible() {
                return None;
            }
        }
        let mut handler = state.borrow_mut().input_handler.take()?;
        let target = handler.text_input_target();
        state.borrow_mut().input_handler.get_or_insert(handler);
        target
    }

    pub(crate) fn apply_composition(
        state: &Rc<RefCell<Self>>,
        target: &gpui::TextInputTarget,
        commit_prefix: &str,
        preedit: &str,
        selection_utf16: Option<Range<usize>>,
        active: bool,
    ) -> Result<bool> {
        {
            let state = state.borrow();
            if state.closed || !state.active || !state.visible.is_visible() {
                return Ok(false);
            }
        }
        let Some(mut handler) = state.borrow_mut().input_handler.take() else {
            return Ok(false);
        };
        let result =
            handler.apply_composition(target, commit_prefix, preedit, selection_utf16, active);
        state.borrow_mut().input_handler.get_or_insert(handler);
        result
    }

    pub(crate) fn input_caret_bounds(state: &Rc<RefCell<Self>>) -> Option<Bounds<Pixels>> {
        {
            let state = state.borrow();
            if state.closed || !state.active || !state.visible.is_visible() {
                return None;
            }
        }
        let mut handler = state.borrow_mut().input_handler.take()?;
        let bounds = (|| {
            if !handler.query_accepts_focused_text_input() {
                return None;
            }
            let selection = handler.selected_text_range(false)?;
            let caret = if selection.reversed {
                selection.range.start
            } else {
                selection.range.end
            };
            handler.bounds_for_range(caret..caret)
        })();
        state.borrow_mut().input_handler.get_or_insert(handler);
        bounds
    }

    pub(crate) fn request_close(state: &Rc<RefCell<Self>>) {
        if state.borrow().closed {
            return;
        }
        let callback = state.borrow_mut().callbacks.should_close.take();
        let allowed = if let Some(mut callback) = callback {
            let allowed = callback();
            state
                .borrow_mut()
                .callbacks
                .should_close
                .get_or_insert(callback);
            allowed
        } else {
            true
        };
        if allowed && !state.borrow().closed {
            let callback = state.borrow_mut().callbacks.close.take();
            if let Some(callback) = callback {
                callback();
            }
        }
    }

    pub(crate) fn pump(state: &Rc<RefCell<Self>>, allow_draw: bool) -> bool {
        let mut worked = false;
        if state.borrow().closed {
            return worked;
        }
        let resized = std::mem::take(&mut state.borrow_mut().resized);
        if resized {
            let callback = state.borrow_mut().callbacks.resize.take();
            if let Some(mut callback) = callback {
                let size = state.borrow().bounds.size;
                let scale_factor = state.borrow().scale_factor;
                callback(size, scale_factor);
                state.borrow_mut().callbacks.resize.get_or_insert(callback);
            }
            worked = true;
        }
        if state.borrow().closed {
            return worked;
        }
        let active = state.borrow_mut().activation.take();
        if let Some(active) = active {
            let callback = state.borrow_mut().callbacks.active.take();
            if let Some(mut callback) = callback {
                callback(active);
                state.borrow_mut().callbacks.active.get_or_insert(callback);
            }
            worked = true;
        }
        if state.borrow().closed {
            return worked;
        }
        let visible = state.borrow_mut().visibility_change.take();
        if let Some(visible) = visible {
            let callback = state.borrow_mut().callbacks.visibility.take();
            if let Some(mut callback) = callback {
                callback(visible);
                state
                    .borrow_mut()
                    .callbacks
                    .visibility
                    .get_or_insert(callback);
            }
            worked = true;
        }
        if state.borrow().closed {
            return worked;
        }
        let callback = {
            let mut state = state.borrow_mut();
            if allow_draw
                && state.frame_requested
                && state.visible.is_visible()
                && state.callbacks.frame.is_some()
            {
                state.frame_requested = false;
                state.callbacks.frame.take()
            } else {
                None
            }
        };
        if let Some(mut callback) = callback {
            callback(RequestFrameOptions {
                signal_source: FrameRequestSource::LocalSchedule,
                ..RequestFrameOptions::default()
            });
            state.borrow_mut().callbacks.frame.get_or_insert(callback);
            worked = true;
        }
        worked
    }
}

impl Drop for TerminalWindow {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.try_borrow_mut() {
            state.closed = true;
        }
    }
}

impl HasWindowHandle for TerminalWindow {
    fn window_handle(
        &self,
    ) -> Result<raw_window_handle::WindowHandle<'_>, raw_window_handle::HandleError> {
        Err(raw_window_handle::HandleError::NotSupported)
    }
}

impl HasDisplayHandle for TerminalWindow {
    fn display_handle(
        &self,
    ) -> Result<raw_window_handle::DisplayHandle<'_>, raw_window_handle::HandleError> {
        Err(raw_window_handle::HandleError::NotSupported)
    }
}

impl PlatformWindow for TerminalWindow {
    #[cfg(windows)]
    fn get_raw_handle(&self) -> windows::Win32::Foundation::HWND {
        // This is an offscreen target, not a native Win32 window.
        windows::Win32::Foundation::HWND::default()
    }

    fn bounds(&self) -> Bounds<Pixels> {
        self.0.borrow().bounds
    }
    fn is_maximized(&self) -> bool {
        false
    }
    fn window_bounds(&self) -> WindowBounds {
        WindowBounds::Windowed(self.bounds())
    }
    fn content_size(&self) -> Size<Pixels> {
        self.bounds().size
    }
    fn resize(&mut self, size: Size<Pixels>) {
        let scale_factor = self.0.borrow().scale_factor;
        let result = device_size(size, scale_factor)
            .and_then(|size| self.0.borrow_mut().resize(size, scale_factor));
        if let Err(error) = result {
            self.0.borrow_mut().error.get_or_insert(error.to_string());
        }
        let wake = self.0.borrow().wake.clone();
        wake();
    }
    fn scale_factor(&self) -> f32 {
        self.0.borrow().scale_factor
    }
    fn appearance(&self) -> WindowAppearance {
        WindowAppearance::Dark
    }
    fn display(&self) -> Option<Rc<dyn PlatformDisplay>> {
        None
    }
    fn mouse_position(&self) -> Point<Pixels> {
        self.0.borrow().mouse
    }
    fn modifiers(&self) -> Modifiers {
        self.0.borrow().modifiers
    }
    fn capslock(&self) -> Capslock {
        self.0.borrow().capslock
    }
    fn set_input_handler(&mut self, handler: PlatformInputHandler) {
        self.0.borrow_mut().input_handler = Some(handler);
    }
    fn take_input_handler(&mut self) -> Option<PlatformInputHandler> {
        self.0.borrow_mut().input_handler.take()
    }
    fn prompt(
        &self,
        _: PromptLevel,
        _: &str,
        _: Option<&str>,
        _: &[PromptButton],
    ) -> Option<oneshot::Receiver<usize>> {
        None
    }
    fn activate(&self) {
        self.0.borrow_mut().set_active(true);
        let wake = self.0.borrow().wake.clone();
        wake();
    }
    fn is_active(&self) -> bool {
        self.0.borrow().active
    }
    fn visibility(&self) -> WindowVisibility {
        self.0.borrow().visible
    }
    fn is_hovered(&self) -> bool {
        self.0.borrow().hovered
    }
    fn background_appearance(&self) -> WindowBackgroundAppearance {
        self.0.borrow().background
    }
    fn set_title(&mut self, title: &str) {
        self.0.borrow_mut().title = title.to_owned();
    }
    fn get_title(&self) -> String {
        self.0.borrow().title.clone()
    }
    fn set_background_appearance(&self, background: WindowBackgroundAppearance) {
        self.0.borrow_mut().background = background;
    }
    fn minimize(&self) {}
    fn zoom(&self) {}
    fn toggle_fullscreen(&self) {}
    fn is_fullscreen(&self) -> bool {
        false
    }
    fn frame_waker(&self) -> Option<Rc<dyn Fn()>> {
        let state = Rc::downgrade(&self.0);
        Some(Rc::new(move || {
            if let Some(state) = state.upgrade() {
                let requested = state.borrow_mut().wake();
                if requested {
                    let wake = state.borrow().wake.clone();
                    wake();
                }
            }
        }))
    }
    fn schedule_frame(&self) {
        let requested = self.0.borrow_mut().wake();
        if requested {
            let wake = self.0.borrow().wake.clone();
            wake();
        }
    }
    fn on_request_frame(&self, callback: Box<dyn FnMut(RequestFrameOptions)>) {
        self.0.borrow_mut().callbacks.frame = Some(callback);
    }
    fn on_input(&self, callback: Box<dyn FnMut(PlatformInput) -> DispatchEventResult>) {
        self.0.borrow_mut().callbacks.input = Some(callback);
    }
    fn on_active_status_change(&self, callback: Box<dyn FnMut(bool)>) {
        self.0.borrow_mut().callbacks.active = Some(callback);
    }
    fn on_visibility_change(&self, callback: Box<dyn FnMut(WindowVisibility)>) {
        self.0.borrow_mut().callbacks.visibility = Some(callback);
    }
    fn on_hover_status_change(&self, callback: Box<dyn FnMut(bool)>) {
        self.0.borrow_mut().callbacks.hover = Some(callback);
    }
    fn on_resize(&self, callback: Box<dyn FnMut(Size<Pixels>, f32)>) {
        self.0.borrow_mut().callbacks.resize = Some(callback);
    }
    fn on_moved(&self, callback: Box<dyn FnMut()>) {
        self.0.borrow_mut().callbacks.moved = Some(callback);
    }
    fn on_display_changed(&self, callback: Box<dyn FnMut()>) {
        self.0.borrow_mut().callbacks.display = Some(callback);
    }
    fn on_should_close(&self, callback: Box<dyn FnMut() -> bool>) {
        self.0.borrow_mut().callbacks.should_close = Some(callback);
    }
    fn on_hit_test_window_control(&self, callback: Box<dyn FnMut() -> Option<WindowControlArea>>) {
        self.0.borrow_mut().callbacks.hit_test = Some(callback);
    }
    fn on_close(&self, callback: Box<dyn FnOnce()>) {
        self.0.borrow_mut().callbacks.close = Some(callback);
    }
    fn on_appearance_changed(&self, callback: Box<dyn FnMut()>) {
        self.0.borrow_mut().callbacks.appearance = Some(callback);
    }
    fn draw(&self, scene: &Scene) {
        if self.0.borrow().closed {
            return;
        }
        let submitted = (|| -> Result<SubmittedFrame> {
            let mut state = self.0.borrow_mut();
            let size = state.size;
            let sequence = state
                .sequence
                .checked_add(1)
                .ok_or_else(|| anyhow!("terminal candidate sequence exhausted"))?;
            let readback = state.renderer.submit_scene(scene, size)?;
            state.sequence = sequence;
            Ok(SubmittedFrame {
                token: FrameToken {
                    issuer: Some(state.issuer.clone()),
                    sequence: state.sequence,
                    viewport_generation: state.viewport_generation,
                },
                readback,
            })
        })();
        match submitted {
            Ok(submitted) => {
                let sink = self.0.borrow_mut().sink.take();
                if let Some(mut sink) = sink {
                    sink(submitted);
                    self.0.borrow_mut().sink = Some(sink);
                }
            }
            Err(error) => {
                self.0.borrow_mut().error.get_or_insert(error.to_string());
            }
        }
    }
    fn sprite_atlas(&self) -> Arc<dyn PlatformAtlas> {
        self.0.borrow().atlas.clone()
    }
    fn is_subpixel_rendering_supported(&self) -> bool {
        false
    }
    fn gpu_specs(&self) -> Option<GpuSpecs> {
        self.0.borrow().renderer.gpu_specs()
    }
    fn update_ime_position(&self, _: Bounds<Pixels>) {}
}

use std::{
    cell::{Cell, RefCell},
    ffi::OsString,
    ops::Range,
    path::{Path, PathBuf},
    rc::Rc,
    sync::Arc,
    time::Instant,
};

use anyhow::{Result, anyhow, ensure};
use futures_channel::oneshot;
use gpui::{
    Action, ActivityGuard, AnyWindowHandle, BackgroundExecutor, ClipboardItem, CursorStyle,
    DevicePixels, DispatchEventResult, DummyKeyboardMapper, ForegroundExecutor, Keymap, Menu,
    MenuItem, OwnedMenu, PathPromptOptions, Platform, PlatformDisplay, PlatformInput,
    PlatformKeyboardLayout, PlatformKeyboardMapper, PlatformTextSystem, PlatformWindow, Size, Task,
    ThermalState, WindowAppearance, WindowParams, WindowVisibility,
};

use crate::{
    FrameToken, PreparedFrame,
    dispatcher::Dispatcher,
    window::{TerminalWindow, WindowRef, WindowState},
};

type Wake = Arc<dyn Fn() + Send + Sync>;
type PreparationSink = Box<dyn FnMut(PreparedFrame)>;
type MenuAction = Box<dyn FnMut(&dyn Action)>;
type ValidateMenuAction = Box<dyn FnMut(&dyn Action) -> bool>;

#[derive(Default)]
struct Callbacks {
    quit: Option<Box<dyn FnMut() -> bool>>,
    reopen: Option<Box<dyn FnMut()>>,
    sleep: Option<Box<dyn FnMut()>>,
    wake: Option<Box<dyn FnMut()>>,
    displays: Option<Box<dyn FnMut()>>,
    open_urls: Option<Box<dyn FnMut(Vec<String>)>>,
    menu: Option<MenuAction>,
    open_menu: Option<Box<dyn FnMut()>>,
    validate_menu: Option<ValidateMenuAction>,
    keyboard: Option<Box<dyn FnMut()>>,
    thermal: Option<Box<dyn FnMut()>>,
}

/// One GPUI surface driven by an external terminal host's main-thread loop.
///
/// This owns no terminal input or output. Keep the `ApplicationHandle` returned
/// by `Application::run_embedded`, call [`Self::pump`] when woken, and send
/// prepared scenes to a background executor for submission/readback, and
/// completed candidates to the host's sole writer. Neither is a presentation.
#[non_exhaustive]
pub struct TerminalPlatform {
    dispatcher: Arc<Dispatcher>,
    background: BackgroundExecutor,
    foreground: ForegroundExecutor,
    text: Arc<dyn PlatformTextSystem>,
    resources: RefCell<Option<(Box<gpui_wgpu::WgpuHeadlessRenderer>, PreparationSink)>>,
    window: RefCell<Option<WindowRef>>,
    viewport: Cell<Option<(Size<DevicePixels>, f32)>>,
    callbacks: RefCell<Callbacks>,
    started: Cell<bool>,
    pending_quit: Cell<bool>,
    quit: Cell<bool>,
    error: RefCell<Option<String>>,
    clipboard: RefCell<Option<ClipboardItem>>,
    clipboard_write: RefCell<Option<ClipboardItem>>,
    #[cfg(target_os = "macos")]
    find_pasteboard: RefCell<Option<ClipboardItem>>,
    menus: RefCell<Vec<OwnedMenu>>,
    cursor: Cell<CursorStyle>,
    cursor_visible: Cell<bool>,
    wake: Wake,
}

impl TerminalPlatform {
    /// Creates a real text/scene platform. `wake` schedules the external loop;
    /// it must not enter GPUI synchronously from a callback or worker thread.
    pub fn new(
        renderer: Box<gpui_wgpu::WgpuHeadlessRenderer>,
        sink: Box<dyn FnMut(PreparedFrame)>,
        wake: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Rc<Self>> {
        let dispatcher = Dispatcher::new(wake.clone())?;
        Ok(Rc::new(Self {
            background: BackgroundExecutor::new(dispatcher.clone()),
            foreground: ForegroundExecutor::new(dispatcher.clone()),
            dispatcher,
            text: Arc::new(gpui_wgpu::CosmicTextSystem::new(
                if cfg!(target_os = "macos") {
                    "Helvetica"
                } else if cfg!(windows) {
                    "Segoe UI"
                } else {
                    "DejaVu Sans"
                },
            )),
            resources: RefCell::new(Some((renderer, sink))),
            window: RefCell::new(None),
            viewport: Cell::new(None),
            callbacks: RefCell::new(Callbacks::default()),
            started: Cell::new(false),
            pending_quit: Cell::new(false),
            quit: Cell::new(false),
            error: RefCell::new(None),
            clipboard: RefCell::new(None),
            clipboard_write: RefCell::new(None),
            #[cfg(target_os = "macos")]
            find_pasteboard: RefCell::new(None),
            menus: RefCell::new(Vec::new()),
            cursor: Cell::new(CursorStyle::Arrow),
            cursor_visible: Cell::new(true),
            wake,
        }))
    }

    fn window(&self) -> Result<Rc<RefCell<WindowState>>> {
        self.window
            .borrow()
            .as_ref()
            .and_then(WindowRef::upgrade)
            .filter(|window| !window.borrow().is_closed())
            .ok_or_else(|| anyhow!("terminal GPUI window is not open"))
    }

    fn unsupported(&self, capability: &str) {
        self.error
            .borrow_mut()
            .get_or_insert_with(|| format!("terminal GPUI does not support {capability}"));
    }

    /// Runs at most 64 foreground tasks and one window frame on the creating
    /// thread. Pending work re-wakes the host. Drawing prepares owned GPU
    /// commands; the host submits and reads them back off this input thread.
    pub fn pump(&self) -> bool {
        self.pump_with_draw(true)
    }

    /// Runs foreground and window lifecycle work while allowing the host to
    /// defer drawing until its output pipeline has room for another candidate.
    /// A deferred frame stays dirty and does not re-wake the host by itself.
    pub fn pump_with_draw(&self, allow_draw: bool) -> bool {
        let mut worked = self.dispatcher.pump();
        if let Ok(window) = self.window() {
            worked |= WindowState::pump(&window, allow_draw);
        } else {
            if self.window.borrow_mut().take().is_some() {
                self.pending_quit.set(true);
            }
        }
        if self.pending_quit.replace(false) && !self.quit.get() {
            let callback = self.callbacks.borrow_mut().quit.take();
            let allowed = if let Some(mut callback) = callback {
                let allowed = callback();
                self.callbacks.borrow_mut().quit.get_or_insert(callback);
                allowed
            } else {
                true
            };
            self.quit.set(allowed);
            worked = true;
        }
        if self.dispatcher.has_pending()
            || self.pending_quit.get()
            || self
                .window()
                .is_ok_and(|window| window.borrow().has_pending(allow_draw))
        {
            (self.wake)();
        }
        worked
    }

    /// Whether an immediate pump is needed, independent of future deadlines.
    pub fn has_pending(&self) -> bool {
        self.dispatcher.has_pending()
            || self.pending_quit.get()
            || self
                .window()
                .is_ok_and(|window| window.borrow().has_pending(true))
    }

    /// Earliest delayed dispatcher task. Native GPUI futures also wake the
    /// host through the existing async-io timer reactor.
    pub fn next_deadline(&self) -> Option<Instant> {
        self.dispatcher.next_deadline()
    }

    /// Whether GPUI has accepted a quit request on the main-thread pump.
    pub fn is_quit_requested(&self) -> bool {
        self.quit.get()
    }

    /// Returns the first pending rendering or unsupported-service error.
    pub fn take_error(&self) -> Option<String> {
        self.error
            .borrow_mut()
            .take()
            .or_else(|| self.window().ok()?.borrow_mut().take_error())
    }

    /// Changes the real pixel viewport. Old presentation receipts become
    /// invalid immediately; GPUI's resize callback runs on the next pump.
    pub fn resize(&self, size: Size<DevicePixels>) -> Result<()> {
        let scale_factor = self.viewport.get().map_or(1.0, |(_, scale)| scale);
        self.set_viewport(size, scale_factor)
    }

    /// Sets the physical render target and its logical pixel density together.
    /// May be called before opening the window. A density-only change revokes
    /// previous presentation tokens just like a size change; input positions
    /// supplied by the host must use logical pixels (device pixels / density).
    pub fn set_viewport(&self, size: Size<DevicePixels>, scale_factor: f32) -> Result<()> {
        crate::window::rgba_len(size)?;
        ensure!(
            scale_factor.is_finite() && scale_factor > 0.0,
            "invalid terminal pixel density"
        );
        if self.window.borrow().is_some() {
            self.window()?.borrow_mut().resize(size, scale_factor)?;
        }
        self.viewport.set(Some((size, scale_factor)));
        (self.wake)();
        Ok(())
    }

    /// Reports terminal focus tracking without changing native field focus.
    pub fn set_active(&self, active: bool) -> Result<()> {
        self.window()?.borrow_mut().set_active(active);
        (self.wake)();
        Ok(())
    }

    /// Delivers input in physical order through GPUI's ordinary native callback.
    /// Drawing and terminal output receipts do not gate this input path.
    pub fn dispatch_input(&self, input: PlatformInput) -> Result<DispatchEventResult> {
        let window = self.window()?;
        if matches!(input, PlatformInput::MouseMove(_)) {
            self.cursor_visible.set(true);
        }
        Ok(WindowState::dispatch_input(&window, input))
    }

    /// Commits bracketed paste through the current GPUI input handler.
    pub fn paste(&self, text: &str) -> Result<()> {
        WindowState::paste(&self.window()?, text);
        Ok(())
    }

    /// Identifies the live native editor, including fields inside one NSH surface.
    /// Keep this token on the native owner thread and send transport session
    /// generations separately.
    pub fn text_input_target(&self) -> Option<gpui::TextInputTarget> {
        WindowState::text_input_target(&self.window().ok()?)
    }

    /// Applies an ordered composition snapshot to its original native editor.
    /// `selection_utf16` is relative to `preedit`, in UTF-16 code units.
    /// An inactive snapshot cancels the temporary mark. A stale target returns
    /// false; if committing the prefix changed focus, that prefix remains
    /// committed and the rest of this snapshot is discarded.
    pub fn apply_composition(
        &self,
        target: &gpui::TextInputTarget,
        commit_prefix: &str,
        preedit: &str,
        selection_utf16: Option<Range<usize>>,
        active: bool,
    ) -> Result<bool> {
        WindowState::apply_composition(
            &self.window()?,
            target,
            commit_prefix,
            preedit,
            selection_utf16,
            active,
        )
    }

    /// The live focused editor's caret in logical window pixels. A terminal
    /// host maps this to its VT cursor so its own input method can follow it,
    /// independently of whether the host draws that cursor.
    pub fn input_caret_bounds(&self) -> Option<gpui::Bounds<gpui::Pixels>> {
        WindowState::input_caret_bounds(&self.window().ok()?)
    }

    /// The native IME candidate rectangle in logical window pixels: the marked
    /// range's start on the caret's visual line, or the active selection endpoint.
    /// Preserve all four edges when converting units. Native height and any
    /// zero-width insertion rectangle are returned unchanged.
    pub fn input_candidate_bounds(&self) -> Option<gpui::Bounds<gpui::Pixels>> {
        WindowState::input_candidate_bounds(&self.window().ok()?)
    }

    /// Records a receipt from the host's trusted sole writer. This confirms
    /// transport completion for output diagnostics, without authorizing input.
    pub fn mark_presented(&self, token: FrameToken) -> Result<()> {
        self.window()?.borrow_mut().mark_presented(token)
    }

    /// Last accepted writer receipt, if its viewport remains current.
    pub fn presented(&self) -> Option<FrameToken> {
        self.window().ok()?.borrow().published()
    }

    /// Requests the actual registered GPUI close path, respecting its veto.
    pub fn request_close(&self) -> Result<()> {
        WindowState::request_close(&self.window()?);
        Ok(())
    }

    /// A local clipboard write for the host to forward through its existing
    /// terminal clipboard transport. Reading does not query the OS clipboard.
    pub fn take_clipboard_write(&self) -> Option<ClipboardItem> {
        self.clipboard_write.borrow_mut().take()
    }

    /// Cancels foreground work on its owner thread. Call after dropping the
    /// embedded application; background work cannot delay terminal cleanup.
    pub fn shutdown(&self) {
        self.dispatcher.shutdown();
    }
}

impl Drop for TerminalPlatform {
    fn drop(&mut self) {
        self.dispatcher.shutdown();
    }
}

fn unsupported_reply<T>(capability: &str) -> oneshot::Receiver<Result<T>> {
    let (send, receive) = oneshot::channel();
    let _ = send.send(Err(anyhow!("terminal GPUI does not support {capability}")));
    receive
}

struct TerminalKeyboardLayout;

impl PlatformKeyboardLayout for TerminalKeyboardLayout {
    fn id(&self) -> &str {
        "terminal-decoded"
    }
    fn name(&self) -> &str {
        "Terminal decoded keys"
    }
}

impl Platform for TerminalPlatform {
    fn background_executor(&self) -> BackgroundExecutor {
        self.background.clone()
    }
    fn foreground_executor(&self) -> ForegroundExecutor {
        self.foreground.clone()
    }
    fn text_system(&self) -> Arc<dyn PlatformTextSystem> {
        self.text.clone()
    }
    fn run(&self, launch: Box<dyn FnOnce()>) {
        if self.started.replace(true) {
            self.unsupported("launching the same platform twice");
            return;
        }
        launch();
        (self.wake)();
    }
    fn quit(&self) {
        self.pending_quit.set(true);
        (self.wake)();
    }
    fn restart(&self, _: Option<PathBuf>, _: Vec<OsString>) {
        self.unsupported("process restart");
    }
    fn activate(&self, _: bool) {
        let _ = self.set_active(true);
    }
    fn hide(&self) {
        if let Ok(window) = self.window() {
            window.borrow_mut().set_visibility(WindowVisibility::Hidden);
        }
        (self.wake)();
    }
    fn hide_other_apps(&self) {
        self.unsupported("hiding other applications");
    }
    fn unhide_other_apps(&self) {
        self.unsupported("showing other applications");
    }
    fn displays(&self) -> Vec<Rc<dyn PlatformDisplay>> {
        Vec::new()
    }
    fn primary_display(&self) -> Option<Rc<dyn PlatformDisplay>> {
        None
    }
    fn on_displays_changed(&self, callback: Box<dyn FnMut()>) {
        self.callbacks.borrow_mut().displays = Some(callback);
    }
    fn active_window(&self) -> Option<AnyWindowHandle> {
        self.window().ok().and_then(|window| {
            let window = window.borrow();
            window.active().then_some(window.handle)
        })
    }
    fn open_window(
        &self,
        handle: AnyWindowHandle,
        params: WindowParams,
    ) -> Result<Box<dyn PlatformWindow>> {
        ensure!(
            self.window.borrow().is_none(),
            "terminal GPUI supports one embedded window"
        );
        let (renderer, sink) = self
            .resources
            .borrow_mut()
            .take()
            .ok_or_else(|| anyhow!("terminal renderer already belongs to a window"))?;
        let (window, weak) = TerminalWindow::new(
            handle,
            params,
            renderer,
            sink,
            self.wake.clone(),
            self.viewport.get(),
        )?;
        *self.window.borrow_mut() = Some(weak);
        Ok(Box::new(window))
    }
    fn window_appearance(&self) -> WindowAppearance {
        WindowAppearance::Dark
    }
    fn open_url(&self, _: &str) {
        self.unsupported("opening external URLs");
    }
    fn on_open_urls(&self, callback: Box<dyn FnMut(Vec<String>)>) {
        self.callbacks.borrow_mut().open_urls = Some(callback);
    }
    fn register_url_scheme(&self, _: &str) -> Task<Result<()>> {
        Task::ready(Err(anyhow!("terminal GPUI cannot register URL schemes")))
    }
    fn prompt_for_paths(
        &self,
        _: PathPromptOptions,
    ) -> oneshot::Receiver<Result<Option<Vec<PathBuf>>>> {
        unsupported_reply("native path prompts")
    }
    fn prompt_for_new_path(
        &self,
        _: &Path,
        _: Option<&str>,
    ) -> oneshot::Receiver<Result<Option<PathBuf>>> {
        unsupported_reply("native path prompts")
    }
    fn can_select_mixed_files_and_dirs(&self) -> bool {
        false
    }
    fn reveal_path(&self, _: &Path) {
        self.unsupported("native file reveal");
    }
    fn open_with_system(&self, _: &Path) {
        self.unsupported("opening external applications");
    }
    fn on_quit(&self, callback: Box<dyn FnMut() -> bool>) {
        self.callbacks.borrow_mut().quit = Some(callback);
    }
    fn on_reopen(&self, callback: Box<dyn FnMut()>) {
        self.callbacks.borrow_mut().reopen = Some(callback);
    }
    fn on_system_sleep(&self, callback: Box<dyn FnMut()>) {
        self.callbacks.borrow_mut().sleep = Some(callback);
    }
    fn on_system_wake(&self, callback: Box<dyn FnMut()>) {
        self.callbacks.borrow_mut().wake = Some(callback);
    }
    fn set_menus(&self, menus: Vec<Menu>, _: &Keymap) {
        *self.menus.borrow_mut() = menus.into_iter().map(|menu| menu.owned()).collect();
    }
    fn get_menus(&self) -> Option<Vec<OwnedMenu>> {
        Some(self.menus.borrow().clone())
    }
    fn set_dock_menu(&self, _: Vec<MenuItem>, _: &Keymap) {}
    fn on_app_menu_action(&self, callback: Box<dyn FnMut(&dyn Action)>) {
        self.callbacks.borrow_mut().menu = Some(callback);
    }
    fn on_will_open_app_menu(&self, callback: Box<dyn FnMut()>) {
        self.callbacks.borrow_mut().open_menu = Some(callback);
    }
    fn on_validate_app_menu_command(&self, callback: Box<dyn FnMut(&dyn Action) -> bool>) {
        self.callbacks.borrow_mut().validate_menu = Some(callback);
    }
    fn thermal_state(&self) -> ThermalState {
        ThermalState::Nominal
    }
    fn on_thermal_state_change(&self, callback: Box<dyn FnMut()>) {
        self.callbacks.borrow_mut().thermal = Some(callback);
    }
    fn prevent_idle_sleep(&self, _: &str) -> Task<Result<ActivityGuard>> {
        Task::ready(Err(anyhow!("terminal GPUI cannot prevent OS sleep")))
    }
    fn app_path(&self) -> Result<PathBuf> {
        Ok(std::env::current_exe()?)
    }
    fn path_for_auxiliary_executable(&self, name: &str) -> Result<PathBuf> {
        ensure!(
            Path::new(name).components().count() == 1,
            "auxiliary executable must be a file name"
        );
        let executable = std::env::current_exe()?;
        Ok(executable
            .parent()
            .ok_or_else(|| anyhow!("executable has no directory"))?
            .join(name))
    }
    fn set_cursor_style(&self, style: CursorStyle) {
        self.cursor.set(style);
    }
    fn hide_cursor_until_mouse_moves(&self) {
        self.cursor_visible.set(false);
    }
    fn is_cursor_visible(&self) -> bool {
        self.cursor_visible.get()
    }
    fn should_auto_hide_scrollbars(&self) -> bool {
        false
    }
    fn read_from_clipboard(&self) -> Option<ClipboardItem> {
        self.clipboard.borrow().clone()
    }
    fn write_to_clipboard(&self, item: ClipboardItem) {
        *self.clipboard.borrow_mut() = Some(item.clone());
        *self.clipboard_write.borrow_mut() = Some(item);
        (self.wake)();
    }
    #[cfg(target_os = "linux")]
    fn read_from_primary(&self) -> Option<ClipboardItem> {
        None
    }
    #[cfg(target_os = "linux")]
    fn write_to_primary(&self, _: ClipboardItem) {}
    #[cfg(target_os = "macos")]
    fn read_from_find_pasteboard(&self) -> Option<ClipboardItem> {
        self.find_pasteboard.borrow().clone()
    }
    #[cfg(target_os = "macos")]
    fn write_to_find_pasteboard(&self, item: ClipboardItem) {
        *self.find_pasteboard.borrow_mut() = Some(item);
    }
    fn write_credentials(&self, _: &str, _: &str, _: &[u8]) -> Task<Result<()>> {
        Task::ready(Err(anyhow!("terminal GPUI has no OS credential store")))
    }
    fn read_credentials(&self, _: &str) -> Task<Result<Option<(String, Vec<u8>)>>> {
        Task::ready(Err(anyhow!("terminal GPUI has no OS credential store")))
    }
    fn delete_credentials(&self, _: &str) -> Task<Result<()>> {
        Task::ready(Err(anyhow!("terminal GPUI has no OS credential store")))
    }
    fn keyboard_layout(&self) -> Box<dyn PlatformKeyboardLayout> {
        Box::new(TerminalKeyboardLayout)
    }
    fn keyboard_mapper(&self) -> Rc<dyn PlatformKeyboardMapper> {
        Rc::new(DummyKeyboardMapper)
    }
    fn on_keyboard_layout_change(&self, callback: Box<dyn FnMut()>) {
        self.callbacks.borrow_mut().keyboard = Some(callback);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use gpui::{
        AppContext, Application, Bounds, Context, InteractiveElement, IntoElement, MouseButton,
        Render, Styled, Window, WindowBounds, WindowOptions, div, point, px, rgb, size,
    };

    use super::*;

    struct RedQuad(Rc<Cell<usize>>);

    impl Render for RedQuad {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            let presses = self.0.clone();
            div()
                .id("red-quad")
                .size_full()
                .bg(rgb(0xff0000))
                .on_mouse_down(MouseButton::Left, move |_, _, _| {
                    presses.set(presses.get() + 1);
                })
        }
    }

    #[test]
    fn deferred_frames_keep_foreground_work_live_without_self_waking() -> Result<()> {
        let wakes = Arc::new(AtomicUsize::new(0));
        let wake = wakes.clone();
        let frames = Rc::new(RefCell::new(Vec::new()));
        let received = frames.clone();
        let platform = TerminalPlatform::new(
            Box::new(gpui_wgpu::WgpuHeadlessRenderer::new()?),
            Box::new(move |frame| {
                let issued = frame.token();
                let submitted = frame.submit().expect("GPU submission");
                assert_eq!(submitted.token(), issued);
                received.borrow_mut().push(submitted);
            }),
            Arc::new(move || {
                wake.fetch_add(1, Ordering::SeqCst);
            }),
        )?;
        // Resolve the same default font descriptor used by GPUI views, then
        // exercise system fallback rather than assuming a Linux font exists.
        let text = platform.text_system();
        let font_id = text.font_id(&gpui::font(".SystemUIFont"))?;
        assert!(text.glyph_for_char(font_id, 'M').is_some());
        let has_color_emoji = text.all_font_names().iter().any(|name| {
            matches!(
                name.as_str(),
                "Apple Color Emoji" | "Segoe UI Emoji" | "Noto Color Emoji"
            )
        });
        let sample = if has_color_emoji { "Maka 🐱" } else { "Maka" };
        let line = text.layout_line(
            sample,
            px(16.0),
            &[gpui::FontRun {
                len: sample.len(),
                font_id,
            }],
        );
        assert!(line.width > px(0.0));
        assert!(
            line.runs
                .iter()
                .flat_map(|run| &run.glyphs)
                .all(|glyph| glyph.id.0 != 0)
        );
        if has_color_emoji {
            assert!(
                line.runs
                    .iter()
                    .flat_map(|run| &run.glyphs)
                    .any(|glyph| glyph.is_emoji)
            );
        }
        for run in &line.runs {
            for glyph in run.glyphs.iter().filter(|glyph| glyph.is_emoji) {
                let params = gpui::RenderGlyphParams {
                    font_id: run.font_id,
                    glyph_id: glyph.id,
                    font_size: px(16.0),
                    subpixel_variant: point(0, 0),
                    scale_factor: 1.0,
                    is_emoji: true,
                    subpixel_rendering: false,
                    dilation: 0,
                };
                let bounds = text.glyph_raster_bounds(&params)?;
                let (size, pixels) = text.rasterize_glyph(&params, bounds)?;
                assert!(size.width.0 > 0 && size.height.0 > 0);
                assert!(pixels.as_chunks::<4>().0.iter().any(|pixel| pixel[3] != 0));
            }
        }
        if has_color_emoji {
            for sample in ["©\u{fe0f}", "👩🏽‍💻", "1\u{fe0f}\u{20e3}"] {
                let line = text.layout_line(
                    sample,
                    px(16.0),
                    &[gpui::FontRun {
                        len: sample.len(),
                        font_id,
                    }],
                );
                assert!(line.width > px(0.0), "{sample}");
                assert!(!line.runs.is_empty(), "{sample}");
                assert!(
                    line.runs
                        .iter()
                        .flat_map(|run| &run.glyphs)
                        .all(|glyph| glyph.id.0 != 0 && glyph.is_emoji),
                    "the whole presentation cluster must use the color font: {sample}"
                );
            }
        }
        for sample in ["©", "©\u{fe0e}"] {
            let line = text.layout_line(
                sample,
                px(16.0),
                &[gpui::FontRun {
                    len: sample.len(),
                    font_id,
                }],
            );
            assert!(line.width > px(0.0), "{sample}");
            assert!(
                line.runs
                    .iter()
                    .flat_map(|run| &run.glyphs)
                    .all(|glyph| glyph.id.0 != 0 && !glyph.is_emoji),
                "default text and explicit VS15 must retain the text font: {sample}"
            );
        }
        let presses = Rc::new(Cell::new(0));
        let pressed = presses.clone();
        let window = Rc::new(RefCell::new(None));
        let created = window.clone();
        let application = Application::with_platform(platform.clone()).run_embedded(move |cx| {
            *created.borrow_mut() = Some(
                cx.open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            point(px(0.0), px(0.0)),
                            size(px(64.0), px(48.0)),
                        ))),
                        inactive_frame_interval: None,
                        ..Default::default()
                    },
                    move |_, cx| cx.new(|_| RedQuad(pressed)),
                )
                .unwrap(),
            );
        });
        assert!(platform.pump());
        assert_eq!(frames.borrow().len(), 1);
        let original = frames.borrow_mut().remove(0).complete()?.token();
        platform.mark_presented(original.clone())?;

        let foreground = Rc::new(Cell::new(0));
        let next_frame = foreground.clone();
        application.update(|cx| {
            window
                .borrow()
                .as_ref()
                .unwrap()
                .update(cx, |_, window, _| {
                    window.on_next_frame(move |_, _| next_frame.set(1));
                })
                .unwrap();
        });
        // A next-frame callback can run without changing the visual scene.
        // Servicing it must not submit the already-presented pixels again.
        assert!(platform.pump());
        assert_eq!(foreground.get(), 1);
        assert!(frames.borrow().is_empty());

        let progressed = foreground.clone();
        platform
            .foreground_executor()
            .spawn(async move { progressed.set(7) })
            .detach();
        platform.resize(size(DevicePixels(80), DevicePixels(40)))?;
        platform.set_active(false)?;
        let press = PlatformInput::MouseDown(gpui::MouseDownEvent {
            button: MouseButton::Left,
            position: point(px(16.0), px(16.0)),
            click_count: 1,
            ..Default::default()
        });
        assert!(platform.pump_with_draw(false));
        assert_eq!(foreground.get(), 7);
        application.update(|cx| {
            window
                .borrow()
                .as_ref()
                .unwrap()
                .update(cx, |_, window, _| {
                    assert_eq!(window.viewport_size(), size(px(80.0), px(40.0)));
                    assert!(!window.is_window_active());
                })
                .unwrap();
        });
        platform.set_active(true)?;
        assert!(platform.pump_with_draw(false));

        wakes.store(0, Ordering::SeqCst);
        assert!(!platform.pump_with_draw(false));
        assert_eq!(wakes.load(Ordering::SeqCst), 0);
        assert_eq!(frames.borrow().len(), 0);
        assert!(platform.has_pending());
        platform.dispatch_input(press.clone())?;
        assert_eq!(presses.get(), 1);
        assert_eq!(frames.borrow().len(), 0);

        assert!(platform.pump());
        let current = {
            let mut frames = frames.borrow_mut();
            assert_eq!(frames.len(), 1);
            let frame = frames.remove(0).complete()?;
            assert_eq!(frame.size(), size(DevicePixels(80), DevicePixels(40)));
            assert_eq!(
                &frame.pixels()[(20 * 80 + 40) * 4..][..4],
                &[255, 0, 0, 255]
            );
            frame.token()
        };
        platform.dispatch_input(press.clone())?;
        assert_eq!(presses.get(), 2);
        platform.mark_presented(current.clone())?;
        platform.dispatch_input(press)?;
        assert_eq!(presses.get(), 3);
        assert_eq!(platform.take_error(), None);
        // A monitor/font density change can keep the same physical canvas.
        // It still changes logical layout and invalidates old frame receipts.
        platform.set_viewport(size(DevicePixels(80), DevicePixels(40)), 2.0)?;
        assert!(platform.mark_presented(current).is_err());
        assert!(platform.pump_with_draw(false));
        application.update(|cx| {
            window
                .borrow()
                .as_ref()
                .unwrap()
                .update(cx, |_, window, _| {
                    assert_eq!(window.viewport_size(), size(px(40.0), px(20.0)));
                    assert_eq!(window.scale_factor(), 2.0);
                })
                .unwrap();
        });
        assert!(platform.pump());
        let scaled = frames.borrow_mut().remove(0).complete()?;
        assert_eq!(scaled.size(), size(DevicePixels(80), DevicePixels(40)));
        assert_eq!(
            &scaled.pixels()[(20 * 80 + 40) * 4..][..4],
            &[255, 0, 0, 255]
        );
        assert!(
            platform
                .set_viewport(size(DevicePixels(80), DevicePixels(40)), f32::NAN)
                .is_err()
        );
        drop(application);
        platform.shutdown();
        Ok(())
    }
}

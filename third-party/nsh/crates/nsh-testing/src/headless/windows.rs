//! The app's windows as a desktop platform keeps them, for headless runs
//! of desktop apps: the main window and the windows of the app's own
//! (`nsh/desktop`'s `Window`), on one primary display.
//!
//! The model answers the window commands as a platform does: it opens a
//! window with its options (its kind's attributes resolved by the core),
//! applies attribute diffs and requests (bounds, modes, minimizing,
//! showing, hiding, the focus), moves the keyboard focus as presses and
//! requests move it, and carries out the policies the platform holds
//! without asking JS (`closeOnPress`, `closeOnEscape`, `closeOnBlur`, a
//! parent closing). What changes it reports as the platform would
//! ([`Report`]): a window of the app's own on its root node
//! (`EventKind::Window`), the main window in the environment
//! (`Environment::window_state`). A window has no title bar: its content
//! fills it.

use nsh_core::{
    NodeId, ROOT_ID,
    desktop::{
        CloseReason, Display, DisplayId, OpenWindow, WindowAttributes, WindowCloseCause,
        WindowEvent, WindowMode, WindowPlacement, WindowPosition, WindowRequest, WindowState,
    },
    geometry::{Bounds, Point, Points, Size, point, size},
};

/// The size of a window opened without one.
const DEFAULT_SIZE: Size<Points> = Size {
    width: Points(400.0),
    height: Points(300.0),
};

/// The size of the display headless desktops have (larger when the main
/// window is).
const DISPLAY: Size<Points> = Size {
    width: Points(1920.0),
    height: Points(1080.0),
};

/// What a change of the model reports to the app, in order.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Report {
    /// The main window's state changed: the environment's.
    Main(WindowState),
    /// A window of the app's own reports this, on its root.
    Window(NodeId, WindowEvent),
    /// A window came on the screen (`false`) or left it (`true`): its views
    /// are found or not (the main window's, `ROOT_ID`: those outside the
    /// windows of the app's own).
    Hidden(NodeId, bool),
    /// The content of a window of the app's own is this size: its root
    /// view's (`EngineControl::set_root_size`).
    RootSize(NodeId, Size<Points>),
}

/// A window of the app's own.
#[derive(Debug, Clone)]
struct Own {
    root: NodeId,
    /// The app's id for it.
    id: String,
    /// Its parent's root, if it has one.
    parent: Option<NodeId>,
    /// Its attributes, resolved.
    attributes: WindowAttributes,
    state: WindowState,
    /// A policy closed it: hidden until the app removes its root.
    closed: bool,
}

/// The app's windows ([`self`]).
#[derive(Debug)]
pub(crate) struct Windows {
    display: Display,
    main: WindowState,
    /// The main window's attributes the app set (its policies).
    main_attributes: WindowAttributes,
    /// The windows of the app's own, in the order they opened.
    own: Vec<Own>,
    /// The window with the keyboard focus (`ROOT_ID`: the main window).
    focused: Option<NodeId>,
    reports: Vec<Report>,
    /// The main window's content size a `SetContentSize` asked for, until
    /// the driver resizes its viewport.
    main_resize: Option<Size<Points>>,
}

impl Windows {
    /// The windows of an app whose main window's content is `viewport`, at
    /// the display's top left, focused.
    pub(crate) fn new(viewport: Size<Points>) -> Windows {
        let display_size = size(
            DISPLAY.width.max(viewport.width),
            DISPLAY.height.max(viewport.height),
        );
        let area = Bounds::new(Point::default(), display_size);
        let mut display = Display::new(DisplayId(1), area, area, true);
        display.name = "Headless".into();
        let bounds = Bounds::new(Point::default(), viewport);
        let mut main = WindowState::new(bounds, WindowPlacement::new(WindowMode::Normal, bounds));
        main.focused = true;
        main.display = Some(display.id);
        Windows {
            display,
            main,
            main_attributes: WindowAttributes::default(),
            own: Vec::new(),
            focused: Some(ROOT_ID),
            reports: Vec::new(),
            main_resize: None,
        }
    }

    /// The main window starts hidden (nsh.json `window.defaultVisible:
    /// false`): made, unseen and unfocused, until the app shows it.
    pub(crate) fn start_hidden(&mut self) {
        self.main.visible = false;
        self.main.focused = false;
        self.focused = None;
    }

    /// The displays there are: one, the primary.
    pub(crate) fn displays(&self) -> Vec<Display> {
        vec![self.display.clone()]
    }

    /// The main window's state.
    pub(crate) fn main(&self) -> WindowState {
        self.main
    }

    /// The main window's content became `viewport` (`setViewport`).
    pub(crate) fn resize_main(&mut self, viewport: Size<Points>) {
        let origin = self.main.bounds.origin;
        let bounds = Bounds::new(origin, viewport);
        self.main.bounds = bounds;
        self.main.content_bounds = bounds;
        if self.main.mode == WindowMode::Normal {
            self.main.placement.bounds = bounds;
        }
        self.reports.push(Report::Main(self.main));
    }

    /// The state of the window whose root is `root` (`ROOT_ID`: the main
    /// window's); `None` when it is not open.
    pub(crate) fn state(&self, root: NodeId) -> Option<WindowState> {
        if root == ROOT_ID {
            return Some(self.main);
        }
        self.own.iter().find(|w| w.root == root).map(|w| w.state)
    }

    /// The root of the window with the keyboard focus (`ROOT_ID`: the
    /// main window), if one has it.
    pub(crate) fn focused(&self) -> Option<NodeId> {
        self.focused
    }

    /// The main window's content size the app asked for
    /// (`SetContentSize` on it), taken.
    pub(crate) fn take_main_resize(&mut self) -> Option<Size<Points>> {
        self.main_resize.take()
    }

    /// What changed since the last call, in order.
    pub(crate) fn take_reports(&mut self) -> Vec<Report> {
        std::mem::take(&mut self.reports)
    }

    /// Carries out a window command addressed to `root`.
    pub(crate) fn command(&mut self, root: NodeId, command: &nsh_core::desktop::DesktopCommand) {
        use nsh_core::desktop::DesktopCommand;
        match command {
            DesktopCommand::OpenWindow(open) if root != ROOT_ID => self.open(root, open),
            DesktopCommand::SetAttributes(attributes) => self.set_attributes(root, attributes),
            DesktopCommand::Request(request) => self.request(root, request),
            _ => {}
        }
    }

    /// The node `id` left the tree: when it is a window's root, the window
    /// closes; the windows it owns close with it.
    pub(crate) fn removed(&mut self, id: NodeId) {
        let Some(at) = self.own.iter().position(|w| w.root == id) else {
            return;
        };
        self.own.remove(at);
        if self.focused == Some(id) {
            self.focused = None;
            self.focus_next();
        }
        let children: Vec<NodeId> = self
            .own
            .iter()
            .filter(|w| w.parent == Some(id) && !w.closed)
            .map(|w| w.root)
            .collect();
        for child in children {
            self.close_by_policy(child, WindowCloseCause::ParentClose);
        }
    }

    fn open(&mut self, root: NodeId, open: &OpenWindow) {
        if self.own.iter().any(|w| w.root == root) {
            return;
        }
        let options = &open.options;
        let attributes = options.attributes.clone();
        let parent = open.parent;
        let (mode, bounds) = match open.placement {
            Some(placement) => (placement.mode, placement.bounds),
            None => {
                let size = options.default_size.unwrap_or(DEFAULT_SIZE);
                let parent_bounds = parent.and_then(|p| self.state(p)).map(|s| s.bounds);
                let area = self.display.visible_bounds;
                let origin = match options.default_position {
                    Some(WindowPosition::At(at)) => at,
                    Some(WindowPosition::ParentCenter) => {
                        centered(parent_bounds.unwrap_or(area), size)
                    }
                    _ => centered(area, size),
                };
                (
                    options.default_mode.unwrap_or_default(),
                    Bounds::new(origin, size),
                )
            }
        };
        let mut state = WindowState::new(bounds, WindowPlacement::new(mode, bounds));
        state.display = Some(self.display.id);
        self.apply_mode(&mut state, mode);
        self.own.push(Own {
            root,
            id: options.id.clone(),
            parent,
            attributes,
            state,
            closed: false,
        });
        self.report(root);
        if self.takes_focus(root) {
            self.focus(Some(root));
        }
    }

    /// Whether window `root` takes the focus as it opens: it activates and
    /// can have the focus.
    fn takes_focus(&self, root: NodeId) -> bool {
        self.own.iter().find(|w| w.root == root).is_some_and(|w| {
            w.attributes.activate != Some(false) && w.attributes.focusable != Some(false)
        })
    }

    fn set_attributes(&mut self, root: NodeId, attributes: &WindowAttributes) {
        if root == ROOT_ID {
            self.main_attributes.merge(attributes);
            return;
        }
        let Some(w) = self.own.iter_mut().find(|w| w.root == root) else {
            return;
        };
        w.attributes.merge(attributes);
        // A window that can no longer have the focus loses it.
        if attributes.focusable == Some(false) && self.focused == Some(root) {
            self.focus(Some(ROOT_ID));
        }
    }

    fn request(&mut self, root: NodeId, request: &WindowRequest) {
        if root != ROOT_ID && !self.own.iter().any(|w| w.root == root && !w.closed) {
            return;
        }
        match request {
            WindowRequest::Show => {
                self.change(root, |s| {
                    s.minimized = false;
                    s.visible = true;
                });
            }
            WindowRequest::Hide => {
                self.change(root, |s| s.visible = false);
                if self.focused == Some(root) {
                    self.blur_to_next(root);
                }
            }
            WindowRequest::Focus => {
                self.change(root, |s| {
                    s.minimized = false;
                    s.visible = true;
                });
                self.focus(Some(root));
            }
            WindowRequest::Close => {
                if root == ROOT_ID {
                    self.change(root, |s| s.visible = false);
                    if self.focused == Some(root) {
                        self.blur_to_next(root);
                    }
                } else {
                    self.close_by_policy(root, WindowCloseCause::ClosePress);
                }
            }
            WindowRequest::Minimize => {
                self.change(root, |s| {
                    s.minimized = true;
                    s.visible = false;
                });
                if self.focused == Some(root) {
                    self.blur_to_next(root);
                }
            }
            WindowRequest::Restore => {
                self.change(root, |s| {
                    s.minimized = false;
                    s.visible = true;
                });
                self.focus(Some(root));
            }
            WindowRequest::SetMode(mode) => {
                let mode = *mode;
                let display = self.display.clone();
                self.change(root, |s| {
                    s.minimized = false;
                    s.visible = true;
                    s.placement.mode = mode;
                    apply_mode(&display, s, mode);
                });
            }
            WindowRequest::SetBounds(frame) => {
                let frame = *frame;
                self.change(root, |s| {
                    let b = s.placement.bounds;
                    let bounds = Bounds::new(
                        point(frame.x.unwrap_or(b.origin.x), frame.y.unwrap_or(b.origin.y)),
                        size(
                            frame.width.unwrap_or(b.size.width),
                            frame.height.unwrap_or(b.size.height),
                        ),
                    );
                    s.mode = WindowMode::Normal;
                    s.placement = WindowPlacement::new(WindowMode::Normal, bounds);
                    s.bounds = bounds;
                    s.content_bounds = bounds;
                });
            }
            WindowRequest::SetContentSize { width, height } if root == ROOT_ID => {
                let now = self.main.content_bounds.size;
                self.main_resize = Some(size(
                    width.unwrap_or(now.width),
                    height.unwrap_or(now.height),
                ));
            }
            WindowRequest::SetContentSize { width, height } => {
                // No title bar: the content is the whole window; its top
                // left corner stays.
                let (width, height) = (*width, *height);
                self.change(root, |s| {
                    let b = s.bounds;
                    let bounds = Bounds::new(
                        b.origin,
                        size(
                            width.unwrap_or(b.size.width),
                            height.unwrap_or(b.size.height),
                        ),
                    );
                    s.mode = WindowMode::Normal;
                    s.placement = WindowPlacement::new(WindowMode::Normal, bounds);
                    s.bounds = bounds;
                    s.content_bounds = bounds;
                });
            }
            WindowRequest::SetPlacement(placement) => {
                let placement = *placement;
                let display = self.display.clone();
                self.change(root, |s| {
                    s.placement = placement;
                    apply_mode(&display, s, placement.mode);
                });
            }
            WindowRequest::Center { .. } => {
                let area = self.display.visible_bounds;
                self.change(root, |s| {
                    if s.mode != WindowMode::Normal {
                        return;
                    }
                    let bounds = Bounds::new(centered(area, s.bounds.size), s.bounds.size);
                    s.placement.bounds = bounds;
                    s.bounds = bounds;
                    s.content_bounds = bounds;
                });
            }
            WindowRequest::RequestAttention { .. } => {}
        }
    }

    /// A press in window `root`: the platform activates it first.
    pub(crate) fn pressed_in(&mut self, root: NodeId) {
        if self.focused == Some(root) {
            return;
        }
        let focusable = root == ROOT_ID
            || self
                .own
                .iter()
                .any(|w| w.root == root && !w.closed && w.attributes.focusable != Some(false));
        if focusable {
            self.focus(Some(root));
        }
    }

    /// Escape in the focused window: one of the app's own whose
    /// `closeOnEscape` is set closes. Whether it did.
    pub(crate) fn escape(&mut self) -> bool {
        let Some(root) = self.focused.filter(|r| *r != ROOT_ID) else {
            return false;
        };
        let closes = self
            .own
            .iter()
            .any(|w| w.root == root && !w.closed && w.attributes.close_on_escape == Some(true));
        if closes {
            self.close_by_policy(root, WindowCloseCause::Escape);
        }
        closes
    }

    /// The user pressed the close button of the window `root`: it reports
    /// the press and closes when its `closeOnPress` lets it. An error when
    /// it has no close button (`closable: false`).
    pub(crate) fn press_close(&mut self, root: NodeId) -> Result<(), String> {
        let (attributes, name) = if root == ROOT_ID {
            (&self.main_attributes, "main")
        } else {
            match self.own.iter().find(|w| w.root == root && !w.closed) {
                Some(w) => (&w.attributes, w.id.as_str()),
                None => return Err("the window is not open".into()),
            }
        };
        if attributes.closable == Some(false) {
            return Err(format!(
                "the window {name:?} has no close button: it is not `closable`"
            ));
        }
        let closes = attributes.close_on_press != Some(false);
        self.reports.push(Report::Window(
            root,
            WindowEvent::ClosePress {
                reason: CloseReason::CloseButton,
            },
        ));
        if closes {
            if root == ROOT_ID {
                self.change(root, |s| s.visible = false);
                if self.focused == Some(root) {
                    self.blur_to_next(root);
                }
            } else {
                self.close_by_policy(root, WindowCloseCause::ClosePress);
            }
        }
        Ok(())
    }

    /// The platform closes window `root` by itself (a policy): it hides,
    /// reports why, and stays until the app removes its root.
    fn close_by_policy(&mut self, root: NodeId, cause: WindowCloseCause) {
        let Some(w) = self.own.iter_mut().find(|w| w.root == root && !w.closed) else {
            return;
        };
        w.closed = true;
        self.change(root, |s| {
            s.visible = false;
            s.focused = false;
        });
        if self.focused == Some(root) {
            self.focused = None;
            self.focus_next();
        }
        self.reports
            .push(Report::Window(root, WindowEvent::Closed { cause }));
    }

    /// Window `root` lost the focus by being hidden: the next window takes
    /// it.
    fn blur_to_next(&mut self, root: NodeId) {
        self.change(root, |s| s.focused = false);
        self.focused = None;
        self.focus_next();
    }

    /// The focus goes to the main window when it is on screen, else to the
    /// newest window of the app's own on screen.
    fn focus_next(&mut self) {
        let next = if self.main.visible {
            Some(ROOT_ID)
        } else {
            self.own
                .iter()
                .rev()
                .find(|w| !w.closed && w.state.visible && w.attributes.focusable != Some(false))
                .map(|w| w.root)
        };
        self.focus(next);
    }

    /// Window `to` takes the focus: the one that had it loses it (a window
    /// of the app's own with `closeOnBlur` then closes).
    fn focus(&mut self, to: Option<NodeId>) {
        let from = self.focused;
        if from == to {
            return;
        }
        self.focused = to;
        if let Some(from) = from {
            self.change(from, |s| s.focused = false);
        }
        if let Some(to) = to {
            self.change(to, |s| s.focused = true);
        }
        if let Some(from) = from
            && self
                .own
                .iter()
                .any(|w| w.root == from && !w.closed && w.attributes.close_on_blur == Some(true))
        {
            self.close_by_policy(from, WindowCloseCause::Blur);
        }
    }

    /// Changes window `root`'s state with `f`, and reports it when it
    /// changed.
    fn change(&mut self, root: NodeId, f: impl FnOnce(&mut WindowState)) {
        let state = if root == ROOT_ID {
            &mut self.main
        } else {
            match self.own.iter_mut().find(|w| w.root == root) {
                Some(w) => &mut w.state,
                None => return,
            }
        };
        let before = *state;
        f(state);
        if *state != before {
            self.report(root);
        }
    }

    /// Reports window `root`'s state (once per window among the reports
    /// not taken yet: the last one), and whether it is on screen.
    fn report(&mut self, root: NodeId) {
        if root == ROOT_ID {
            self.reports.retain(|r| {
                !matches!(r, Report::Main(_))
                    && !matches!(r, Report::Hidden(id, _) if *id == ROOT_ID)
            });
            self.reports.push(Report::Main(self.main));
            self.reports
                .push(Report::Hidden(ROOT_ID, !self.main.visible));
            return;
        }
        let Some(w) = self.own.iter().find(|w| w.root == root) else {
            return;
        };
        let state = w.state;
        self.reports.retain(|r| {
            !matches!(r, Report::Window(id, WindowEvent::State(_)) if *id == root)
                && !matches!(r, Report::Hidden(id, _) if *id == root)
                && !matches!(r, Report::RootSize(id, _) if *id == root)
        });
        self.reports
            .push(Report::RootSize(root, state.content_bounds.size));
        self.reports
            .push(Report::Window(root, WindowEvent::State(Box::new(state))));
        self.reports.push(Report::Hidden(root, !state.visible));
    }

    fn apply_mode(&self, state: &mut WindowState, mode: WindowMode) {
        apply_mode(&self.display, state, mode);
    }
}

/// Puts `state` in `mode` on `display`: maximized on its visible area, in
/// full screen on all of it, else at its normal bounds.
fn apply_mode(display: &Display, state: &mut WindowState, mode: WindowMode) {
    state.mode = mode;
    let bounds = match mode {
        WindowMode::Maximized => display.visible_bounds,
        WindowMode::FullScreen => display.bounds,
        _ => state.placement.bounds,
    };
    state.bounds = bounds;
    state.content_bounds = bounds;
}

/// The origin of `size` centered on `area`.
fn centered(area: Bounds<Points>, size: Size<Points>) -> Point<Points> {
    point(
        area.origin.x + (area.size.width - size.width) / 2.0,
        area.origin.y + (area.size.height - size.height) / 2.0,
    )
}

#[cfg(test)]
mod tests {
    use nsh_core::{
        desktop::{DesktopCommand, WindowFrame, WindowKind, WindowOptions},
        geometry::px,
    };

    use super::*;

    const NOTES: NodeId = 10;
    const POPUP: NodeId = 12;

    fn windows() -> Windows {
        Windows::new(size(px(900.0), px(700.0)))
    }

    fn open(windows: &mut Windows, root: NodeId, id: &str, kind: WindowKind) {
        let mut options = WindowOptions::new(id);
        options.kind = kind;
        options.default_size = Some(size(px(220.0), px(140.0)));
        options.default_position = Some(WindowPosition::At(point(px(24.0), px(500.0))));
        options.attributes = WindowAttributes::resolve(kind, &WindowAttributes::default());
        let mut open = OpenWindow::default();
        open.options = options;
        open.parent = Some(ROOT_ID);
        windows.command(root, &DesktopCommand::OpenWindow(Box::new(open)));
    }

    fn request(windows: &mut Windows, root: NodeId, request: WindowRequest) {
        windows.command(root, &DesktopCommand::Request(request));
    }

    fn closed(reports: &[Report]) -> Vec<(NodeId, WindowCloseCause)> {
        reports
            .iter()
            .filter_map(|r| match r {
                Report::Window(id, WindowEvent::Closed { cause }) => Some((*id, *cause)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_window_opens_shown_and_focused_where_the_app_says() {
        let mut w = windows();
        open(&mut w, NOTES, "notes", WindowKind::Normal);
        let state = w.state(NOTES).unwrap();
        assert!(state.visible && state.focused && !state.minimized);
        assert_eq!(state.mode, WindowMode::Normal);
        let at = Bounds::new(point(px(24.0), px(500.0)), size(px(220.0), px(140.0)));
        assert_eq!(state.bounds, at);
        assert_eq!(state.content_bounds, at);
        assert_eq!(state.display, Some(DisplayId(1)));
        // The main window lost the focus, and said so.
        assert!(!w.main().focused);
        let reports = w.take_reports();
        assert!(reports.contains(&Report::Main(w.main())));
        assert!(reports.contains(&Report::Window(NOTES, WindowEvent::State(Box::new(state)))));
        assert!(reports.contains(&Report::Hidden(NOTES, false)));
    }

    #[test]
    fn a_main_window_hidden_at_launch_shows_when_the_app_asks() {
        let mut w = windows();
        w.start_hidden();
        let main = w.main();
        assert!(!main.visible && !main.focused && !main.minimized);
        assert_eq!(w.focused(), None);
        // A window of the app's own opens as ever, the main one unseen.
        open(&mut w, NOTES, "notes", WindowKind::Panel);
        assert!(w.state(NOTES).unwrap().visible);
        assert!(!w.main().visible);
        w.take_reports();
        request(&mut w, ROOT_ID, WindowRequest::Show);
        assert!(w.main().visible && !w.main().focused);
        let reports = w.take_reports();
        assert!(reports.contains(&Report::Main(w.main())));
        assert!(reports.contains(&Report::Hidden(ROOT_ID, false)));
        request(&mut w, ROOT_ID, WindowRequest::Hide);
        assert!(w.take_reports().contains(&Report::Hidden(ROOT_ID, true)));
        request(&mut w, ROOT_ID, WindowRequest::Focus);
        assert!(w.main().visible && w.main().focused);
        assert_eq!(w.focused(), Some(ROOT_ID));
    }

    #[test]
    fn a_panel_opens_without_the_focus() {
        let mut w = windows();
        open(&mut w, NOTES, "panel", WindowKind::Panel);
        assert!(!w.state(NOTES).unwrap().focused);
        assert!(w.main().focused);
    }

    #[test]
    fn requests_change_the_bounds_and_the_mode() {
        let mut w = windows();
        open(&mut w, NOTES, "notes", WindowKind::Normal);
        let frame = WindowFrame {
            width: Some(px(360.0)),
            height: Some(px(240.0)),
            ..WindowFrame::default()
        };
        request(&mut w, NOTES, WindowRequest::SetBounds(frame));
        let state = w.state(NOTES).unwrap();
        assert_eq!(state.bounds.size, size(px(360.0), px(240.0)));
        assert_eq!(state.bounds.origin, point(px(24.0), px(500.0)));
        request(&mut w, NOTES, WindowRequest::SetMode(WindowMode::Maximized));
        let state = w.state(NOTES).unwrap();
        assert_eq!(state.mode, WindowMode::Maximized);
        assert_eq!(state.bounds.size, size(px(1920.0), px(1080.0)));
        // The normal bounds are kept to go back to.
        assert_eq!(state.placement.bounds.size, size(px(360.0), px(240.0)));
        request(&mut w, NOTES, WindowRequest::SetMode(WindowMode::Normal));
        assert_eq!(
            w.state(NOTES).unwrap().bounds.size,
            size(px(360.0), px(240.0))
        );
        request(&mut w, NOTES, WindowRequest::Minimize);
        let state = w.state(NOTES).unwrap();
        assert!(state.minimized && !state.visible && !state.focused);
        assert!(w.main().focused);
        assert!(w.take_reports().contains(&Report::Hidden(NOTES, true)));
        request(&mut w, NOTES, WindowRequest::Restore);
        let state = w.state(NOTES).unwrap();
        assert!(!state.minimized && state.visible && state.focused);
    }

    #[test]
    fn the_content_size_the_core_asks_for_keeps_the_top_left_corner() {
        let mut w = windows();
        open(&mut w, NOTES, "notes", WindowKind::Normal);
        request(
            &mut w,
            NOTES,
            WindowRequest::SetContentSize {
                width: Some(px(240.0)),
                height: None,
            },
        );
        let state = w.state(NOTES).unwrap();
        assert_eq!(state.content_bounds.size, size(px(240.0), px(140.0)));
        assert_eq!(state.content_bounds.origin, point(px(24.0), px(500.0)));
        assert!(
            w.take_reports()
                .contains(&Report::RootSize(NOTES, size(px(240.0), px(140.0))))
        );
        request(
            &mut w,
            ROOT_ID,
            WindowRequest::SetContentSize {
                width: None,
                height: Some(px(500.0)),
            },
        );
        assert_eq!(w.take_main_resize(), Some(size(px(900.0), px(500.0))));
    }

    #[test]
    fn a_popup_closes_when_the_focus_leaves_it() {
        let mut w = windows();
        open(&mut w, NOTES, "notes", WindowKind::Normal);
        open(&mut w, POPUP, "popup", WindowKind::Popup);
        assert!(w.state(POPUP).unwrap().focused);
        w.take_reports();
        w.pressed_in(ROOT_ID);
        let reports = w.take_reports();
        assert_eq!(closed(&reports), [(POPUP, WindowCloseCause::Blur)]);
        assert!(reports.contains(&Report::Hidden(POPUP, true)));
        assert!(w.main().focused);
        // It stays, hidden, until the app removes it.
        assert!(!w.state(POPUP).unwrap().visible);
        w.removed(POPUP);
        assert_eq!(w.state(POPUP), None);
    }

    #[test]
    fn escape_closes_the_focused_dialog() {
        let mut w = windows();
        assert!(!w.escape());
        open(&mut w, NOTES, "notes", WindowKind::Normal);
        assert!(!w.escape(), "a normal window stays");
        open(&mut w, POPUP, "dialog", WindowKind::Dialog);
        w.take_reports();
        assert!(w.escape());
        assert_eq!(
            closed(&w.take_reports()),
            [(POPUP, WindowCloseCause::Escape)]
        );
        // The focus goes back to the main window.
        assert!(w.main().focused);
    }

    #[test]
    fn a_close_press_closes_unless_the_window_keeps_itself_open() {
        let mut w = windows();
        open(&mut w, NOTES, "notes", WindowKind::Normal);
        w.take_reports();
        w.press_close(NOTES).unwrap();
        let reports = w.take_reports();
        assert!(reports.contains(&Report::Window(
            NOTES,
            WindowEvent::ClosePress {
                reason: CloseReason::CloseButton
            }
        )));
        assert_eq!(closed(&reports), [(NOTES, WindowCloseCause::ClosePress)]);

        open(&mut w, POPUP, "guard", WindowKind::Normal);
        let mut keep = WindowAttributes::default();
        keep.close_on_press = Some(false);
        w.command(POPUP, &DesktopCommand::SetAttributes(Box::new(keep)));
        w.take_reports();
        w.press_close(POPUP).unwrap();
        let reports = w.take_reports();
        assert!(closed(&reports).is_empty());
        assert!(w.state(POPUP).unwrap().visible);

        let mut fixed = WindowAttributes::default();
        fixed.closable = Some(false);
        w.command(POPUP, &DesktopCommand::SetAttributes(Box::new(fixed)));
        assert!(w.press_close(POPUP).is_err());
    }

    #[test]
    fn a_window_closes_with_its_parent() {
        let mut w = windows();
        open(&mut w, NOTES, "notes", WindowKind::Normal);
        let mut options = WindowOptions::new("child");
        options.attributes = WindowAttributes::resolve(WindowKind::Panel, &Default::default());
        let mut child = OpenWindow::default();
        child.options = options;
        child.parent = Some(NOTES);
        w.command(POPUP, &DesktopCommand::OpenWindow(Box::new(child)));
        w.take_reports();
        w.removed(NOTES);
        assert_eq!(
            closed(&w.take_reports()),
            [(POPUP, WindowCloseCause::ParentClose)]
        );
    }
}

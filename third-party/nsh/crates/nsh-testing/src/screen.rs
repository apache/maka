//! A model of the native views a headless app builds, from its mount
//! batches: their tree, what they show, which events they report, what
//! inputs hold and where scroll views are. It answers the selectors of the
//! steps ([`Selector`]) as a user's eyes would: the top screen of a stack
//! and the top modal first.

// What only the headless driver uses (it does not run in WebAssembly).
#![cfg_attr(target_arch = "wasm32", allow(dead_code))]

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use nsh_core::{
    AccessibilityRole, AccessibilityState, Bounds, Command, Dialog, EventKind, EventMask,
    GestureValues, InputConfig, MountBatch, MountItem, NodeId, PanActivation, Point, PointerEvents,
    Points, Size, ViewKind, element::PropEnum,
};

use crate::selector::{Matcher, Selector, TextMatch};

/// The surface's root view: every app view hangs below it.
const ROOT: NodeId = 1;

/// The UTF-16 offset of byte `at` of `text`.
fn utf16_at(text: &str, at: usize) -> u32 {
    text[..at].encode_utf16().count() as u32
}

/// Where `want` reads in `text`, as the UTF-16 offset of each match.
fn char_starts(text: &str, want: &TextMatch) -> Vec<u32> {
    let ranges: Vec<usize> = match want {
        TextMatch::Exact(want) if want.is_empty() => Vec::new(),
        TextMatch::Exact(want) => text
            .match_indices(want.as_str())
            .map(|(at, _)| at)
            .collect(),
        TextMatch::Regex(re) => re
            .find_iter(text)
            .filter(|m| !m.is_empty())
            .map(|m| m.start())
            .collect(),
    };
    ranges.into_iter().map(|at| utf16_at(text, at)).collect()
}

/// The ids the model gives a canvas's nodes ([`nsh_core::canvas::CanvasNode`]),
/// counting down from the top of the id space, where the core and JS
/// never reach.
const FIRST_CANVAS_NODE: NodeId = NodeId::MAX;

/// Whether view `v` shows a text `want` matches: its own, or an input's
/// (what it holds, or while empty its placeholder).
fn shows_text(v: &View, want: &TextMatch) -> bool {
    v.text.as_deref().is_some_and(|t| want.matches(t))
        || v.span.as_ref().is_some_and(|s| want.matches(&s.text))
        || v.input.as_ref().is_some_and(|i| {
            want.matches(&i.text) || (i.text.is_empty() && want.matches(&i.config.placeholder))
        })
}

/// The characters of `text` from UTF-16 offset `start` to `end`.
fn utf16_slice(text: &str, start: u32, end: u32) -> String {
    let mut at = 0;
    text.chars()
        .filter(|c| {
            let here = at;
            at += c.len_utf16() as u32;
            here >= start && at <= end
        })
        .collect()
}

/// What a back does ([`Screen::back_target`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Back {
    /// The stack pops this screen.
    Pop(NodeId),
    /// This screen prevents going back: it is asked.
    Ask(NodeId),
    /// The modal asks to close, and closes when the user may close it.
    Close {
        modal: NodeId,
        close_on_escape: bool,
    },
    /// Nothing to go back from.
    Nothing,
}

/// The native views as the mount items built them: their tree, what they
/// show (text, test id, accessibility label), the events they report,
/// inputs' text, scroll views' offsets, the screens and modals a back
/// took away, the dialogs shown, the clipboard, and the commands sent
/// (focus, scrolling, ...).
#[derive(Debug, Default)]
pub struct Screen {
    nodes: HashMap<NodeId, View>,
    /// Children of each view, bottom to top.
    children: HashMap<NodeId, Vec<NodeId>>,
    commands: Vec<(NodeId, Command)>,
    /// The input that has the focus.
    focused: Option<NodeId>,
    /// The view that takes presses Tab gave the keyboard focus to (macOS,
    /// the web).
    key_focus: Option<NodeId>,
    /// Scroll views a command moved, whose offset the engine is told
    /// ([`Screen::take_scrolled`]), as a platform reports it.
    scrolled: Vec<NodeId>,
    /// Screens a back popped natively, until the app removes them.
    popped: HashSet<NodeId>,
    /// Modals a back closed natively, until the app removes them.
    closed: HashSet<NodeId>,
    /// Modals presented since the last call (`onShow`).
    presented: Vec<NodeId>,
    /// The dialogs shown, in order, and how many were answered.
    dialogs: Vec<Dialog>,
    answered: usize,
    /// The clipboard's text.
    clipboard: Option<String>,
    /// Clipboard reads to answer: the request, and whether it asks only if
    /// the clipboard holds text.
    clipboard_reads: Vec<(u32, bool)>,
    /// The `Image.getSize` / `Image.prefetch` requests to answer.
    image_infos: Vec<u32>,
    /// The source each image view is loading, until a test fails it
    /// ([`Screen::fail_images`]): headless runs load none.
    loading_images: HashMap<NodeId, Arc<str>>,
    /// The picks asked (`Picker.pickImages`), in order, and how many were
    /// answered.
    picks: Vec<(u32, nsh_core::picker::Pick)>,
    picks_answered: usize,
    /// The URLs the app had the system open (`openUrl`), in order.
    opened_urls: Vec<String>,
    /// The `openUrl` requests to answer.
    url_opens: Vec<u32>,
    /// The screen colors asked for (`pick_screen_color`), to answer.
    screen_colors: Vec<u32>,
    /// The requests on local paths that reached the platform
    /// (`pick_paths`, `open_path`, ...), in order.
    file_requests: Vec<nsh_core::file_dialog::FileRequest>,
    /// Those to answer.
    file_answers: Vec<(u32, nsh_core::file_dialog::FileRequest)>,
    /// What the app asked that only a real platform answers, since the
    /// last call.
    unsupported: Vec<&'static str>,
    /// The app asked for a back (`Command::Back`, what no listener took).
    back_asked: bool,
    /// A JS responder holds the touches and keeps native drags from
    /// starting (`SetJsResponder`'s `block`).
    js_block: bool,
    /// The JS responder's grants since a drag looked (`SetJsResponder`'s
    /// `block`, in order).
    js_grants: Vec<bool>,
    /// The app's keyboard shortcuts (`nsh/keymap`, the root's `Keymap`).
    keymap: Option<Arc<nsh_core::keymap::Keymap>>,
    /// The views under the mouse that care (`input::hoverable`), innermost
    /// first.
    hovered: Vec<NodeId>,
    /// Views a removal took out of the hover or the keyboard focus, with
    /// their states since, for the engine ([`Screen::take_restated`]).
    restated: Vec<(NodeId, u16)>,
    /// The context menu the app showed (`Menu.popup`), until it is chosen
    /// from or closed.
    menu: Option<Arc<[nsh_core::desktop::MenuItem]>>,
    /// The edit menu an input opened (`Command::OpenEditMenu`) and what it
    /// offers, until it is chosen from or closed.
    edit_menu: Option<(NodeId, Vec<nsh_core::EditAction>)>,
    /// The application menu the app set (`Menu.setApplicationMenu`), whose
    /// shortcuts the keyboard chooses.
    app_menu: Option<Arc<[nsh_core::desktop::MenuItem]>>,
    /// The window's size, when the driver knows it: what lies outside it
    /// (and no scroll view brings in) is not on screen.
    viewport: Option<Size<Points>>,
    /// The nodes each canvas's drawing has, as views of the model.
    canvas_nodes: HashMap<NodeId, Vec<NodeId>>,
    /// The app's windows of its own, in the order they opened: each one's
    /// root (a modal the platform shows in a window of its own,
    /// `DesktopCommand::OpenWindow`) and the app's id for it.
    windows: Vec<(NodeId, String)>,
    /// Those not on screen (minimized, hidden, closed by a policy of
    /// theirs), as the driver keeps them: their views are not found.
    hidden_windows: HashSet<NodeId>,
    /// The main window is not on screen (hidden at launch, hidden,
    /// minimized): its views are not found, those of the windows of the
    /// app's own are.
    main_hidden: bool,
    /// The id the next canvas node gets.
    next_canvas_node: NodeId,
}

#[derive(Debug, Default)]
struct View {
    kind: Option<ViewKind>,
    parent: Option<NodeId>,
    events: EventMask,
    test_id: Option<Arc<str>>,
    label: Option<Arc<str>>,
    text: Option<String>,
    frame: Bounds<Points>,
    input: Option<Input>,
    scroll: Option<Scroll>,
    /// A screen that asks before going back (`preventBack`).
    prevent_back: bool,
    /// A modal the user's back closes natively (`ModalConfig::close_on_escape`).
    close_on_escape: bool,
    /// Its `role`.
    role: AccessibilityRole,
    /// It takes no presses (`disabled`, its accessibility state).
    disabled: bool,
    /// `focusable`: `Some(true)` makes it a stop of Tab, `Some(false)` keeps
    /// a pressable out ([`nsh_core::ViewProps::focus_stop`]).
    focusable: Option<bool>,
    /// A shown overlay's place in the Tab order
    /// ([`nsh_core::ViewProps::tab_after`]).
    tab_after: Option<NodeId>,
    /// It is selected (`selected`, its accessibility state; a canvas node's
    /// `selected`).
    selected: bool,
    /// Its `accessibilityState`.
    accessibility_state: AccessibilityState,
    /// Its `accessibilityLevel`.
    level: Option<u32>,
    /// Its `accessibilityDescription`.
    description: Option<Arc<str>>,
    /// The view its `accessibilityActiveDescendant` names.
    active_descendant: Option<NodeId>,
    /// The view its `accessibilityControls` names.
    controls: Option<NodeId>,
    /// How long a press must last to be a long one (`delayLongPress`), in
    /// milliseconds.
    long_press_delay: Option<f32>,
    /// A selectable view (a `View` with `selectable`): its texts share
    /// one selection.
    selectable_view: bool,
    /// The interaction states it tracks (`TrackStates`: pressed, hovered).
    tracked: u16,
    /// The interaction states it is in (of those it tracks).
    states: u16,
    /// The values its drags, pinches and rotations drive natively.
    gestures: GestureValues,
    /// When a drag on it activates its JS responder (`panActivation`).
    pan_activation: Option<PanActivation>,
    /// Neither it nor what it holds shows (`visibility: hidden`).
    hidden: bool,
    /// It clips what it holds to its bounds (`overflow: hidden`).
    clips: bool,
    /// A span of a text that takes presses (a nested `<Text onPress>`):
    /// not a view of its own, its parent is the text view showing it, or
    /// the span around it.
    span: Option<Span>,
    /// The spans of a text view's text that take presses.
    spans: Vec<NodeId>,
    /// The text a text view shows, styles included, so a step can read a
    /// span's style.
    attributed: Option<Arc<nsh_core::AttributedText>>,
    /// Where a text view's layout goes inside it (inside padding and
    /// border).
    text_content: Bounds<Points>,
    /// Which touches it and its subtree receive (`pointerEvents`).
    pointer_events: PointerEvents,
    /// Its children are read in screen order along this axis (a list in
    /// its parent's viewport, `ViewProps::screen_order`).
    screen_order: Option<nsh_core::geometry::Axis>,
    /// A node of a canvas's drawing, not a view of its own.
    canvas_node: bool,
}

/// A link of a text view's text ([`nsh_core::TextLink`]): a span that takes
/// presses, or one a hint watches (the pointer only).
#[derive(Debug, Clone)]
struct Span {
    /// The text view showing it.
    view: NodeId,
    /// Its characters.
    text: String,
    /// Where they are in the view's text (UTF-16 units).
    start: u32,
    end: u32,
}

/// Where the views around a view let it show, in the root's points.
#[derive(Debug, Clone, Copy)]
enum Clip {
    /// Anywhere: no view around it clips, or a scroll view brings any part
    /// of its content in.
    All,
    /// Inside these bounds.
    Within(Bounds<Points>),
}

impl Clip {
    fn shows(self, bounds: &Bounds<Points>) -> bool {
        match self {
            Clip::All => true,
            Clip::Within(clip) => clip.intersects(bounds),
        }
    }

    fn within(self, bounds: Bounds<Points>) -> Clip {
        match self {
            Clip::All => Clip::Within(bounds),
            Clip::Within(clip) => Clip::Within(clip.intersect(&bounds)),
        }
    }
}

/// A view on screen as layout placed it ([`Screen::layout_nodes`]): for
/// checks of the layout itself (what overflows, overlaps or is cut). Its
/// boxes are in the root's points and leave transforms aside: a scaled,
/// rotated or translated view is reported at the box layout gave it.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct LayoutNode {
    /// The view.
    pub id: NodeId,
    /// Its kind.
    pub kind: ViewKind,
    /// Its `testID`.
    pub test_id: Option<Arc<str>>,
    /// The view it is in ([`ROOT_ID`](nsh_core::ROOT_ID) for one at the
    /// top).
    pub parent: NodeId,
    /// Its bounds in the root's points: moved by the views around it and
    /// the offsets of the scroll views around it; a modal's from the
    /// window's origin.
    pub bounds: Bounds<Points>,
    /// It or a view around it is hidden (`visibility: hidden`).
    pub hidden: bool,
    /// It clips what it holds (`overflow: hidden`).
    pub clips: bool,
    /// Its scrolling, for a scroll view.
    pub scroll: Option<LayoutScroll>,
    /// Its text, for a text view.
    pub text: Option<LayoutText>,
}

impl Default for LayoutNode {
    fn default() -> Self {
        LayoutNode {
            id: NodeId::default(),
            kind: ViewKind::View,
            test_id: None,
            parent: NodeId::default(),
            bounds: Bounds::default(),
            hidden: false,
            clips: false,
            scroll: None,
            text: None,
        }
    }
}

/// How a scroll view of [`LayoutNode::scroll`] scrolls.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct LayoutScroll {
    /// It scrolls horizontally (else vertically).
    pub horizontal: bool,
    /// The size of its content, once known.
    pub content_size: Option<Size<Points>>,
}

/// The text of a text view of [`LayoutNode::text`], as laid out.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct LayoutText {
    /// The text with its runs' fonts, line limit and ellipsis: measured
    /// with the engine that laid it out, it gives the width it needs.
    pub text: Arc<nsh_core::AttributedText>,
    /// The box it was laid out in (inside the view's padding and border),
    /// in the root's points as [`LayoutNode::bounds`]: its width is the
    /// width the text was given.
    pub content: Bounds<Points>,
}

/// Which views a selector matched, for a step that acts on one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pick {
    /// The view.
    One(NodeId),
    /// None matched.
    None,
    /// Several did: how many.
    Many(usize),
    /// The match takes no presses (it, or the view between it and the one
    /// that would hear them, is disabled), or no scrolling (a scroll view
    /// the user cannot scroll).
    Disabled,
}

/// What an input holds, as its platform view keeps it.
#[derive(Debug, Default)]
pub(crate) struct Input {
    pub(crate) text: String,
    /// The edits reported so far ([`nsh_core::EventPayload::Text`]).
    pub(crate) count: u32,
    pub(crate) config: Box<InputConfig>,
    /// What an input method composes in it (`app.compose`), at the end of
    /// its text: marked, not in `text` until it commits.
    pub(crate) composition: Option<String>,
    /// Where its text goes in the view (inside padding and border); the
    /// whole view until the core says.
    pub(crate) content: Option<Bounds<Points>>,
}

/// Where a scroll view is, as its platform view keeps it.
#[derive(Debug, Default)]
pub(crate) struct Scroll {
    /// The content offset.
    pub(crate) x: Points,
    pub(crate) y: Points,
    /// The scrolls the core asked for (`ScrollBy`, `ScrollTo`) applied.
    pub(crate) applied: u32,
    pub(crate) horizontal: bool,
    content: Option<Size<Points>>,
    /// The user cannot scroll it (`scrollable={false}`).
    pub(crate) locked: bool,
    /// How it scrolls (where a pull refreshes).
    pub(crate) behavior: nsh_core::ScrollBehavior,
}

impl Screen {
    /// Applies `batch`.
    pub fn apply(&mut self, batch: &MountBatch) {
        for item in &batch.items {
            self.apply_item(item);
        }
    }

    fn apply_item(&mut self, item: &MountItem) {
        match item {
            MountItem::Create { id, kind } => {
                let view = View {
                    kind: Some(*kind),
                    input: (*kind == ViewKind::Input).then(Input::default),
                    scroll: (*kind == ViewKind::Scroll).then(Scroll::default),
                    ..View::default()
                };
                self.nodes.insert(*id, view);
            }
            MountItem::Insert {
                parent,
                child,
                before,
            } => {
                self.detach(*child);
                let siblings = self.children.entry(*parent).or_default();
                let at = before
                    .and_then(|b| siblings.iter().position(|s| *s == b))
                    .unwrap_or(siblings.len());
                siblings.insert(at, *child);
                self.nodes.entry(*child).or_default().parent = Some(*parent);
                if self.kind(*child) == Some(ViewKind::Modal) {
                    self.presented.push(*child);
                }
            }
            MountItem::Remove { id } => {
                self.taken_out(*id);
                self.detach(*id);
                self.popped.remove(id);
                self.closed.remove(id);
                self.forget_window(*id);
            }
            MountItem::Delete { id } => {
                self.taken_out(*id);
                self.drop_spans(*id);
                self.canvas(*id, &[]);
                self.detach(*id);
                self.nodes.remove(id);
                self.children.remove(id);
                self.popped.remove(id);
                self.closed.remove(id);
                self.forget_window(*id);
                self.loading_images.remove(id);
            }
            MountItem::Image { id, source, .. } => match source {
                Some(source) => {
                    self.loading_images.insert(*id, source.uri.clone());
                }
                None => {
                    self.loading_images.remove(id);
                }
            },
            MountItem::ScreenConfig { id, config } => {
                self.nodes.entry(*id).or_default().prevent_back = config.prevent_back;
            }
            MountItem::ModalConfig { id, config } => {
                self.nodes.entry(*id).or_default().close_on_escape = config.close_on_escape;
            }
            MountItem::Frame { id, frame } => {
                self.nodes.entry(*id).or_default().frame = *frame;
                self.pull_back(*id);
            }
            MountItem::ViewStyle { id, style } => {
                let view = self.nodes.entry(*id).or_default();
                view.hidden = style.hidden;
                view.clips = style.overflow_hidden;
            }
            MountItem::ScrollBehavior { id, behavior } => {
                if let Some(scroll) = self.scroll_mut(*id) {
                    scroll.locked = !behavior.enabled;
                    scroll.behavior = (**behavior).clone();
                }
            }
            MountItem::Events { id, events } => self.nodes.entry(*id).or_default().events = *events,
            MountItem::ViewProps { id, props } => {
                let view = self.nodes.entry(*id).or_default();
                view.test_id = props.test_id.clone();
                view.label = props.accessibility.label.clone();
                view.role = props.accessibility.role;
                view.disabled = props.accessibility.state.disabled;
                view.focusable = props.focusable;
                view.tab_after = props.tab_after;
                view.selected = props.accessibility.state.selected;
                view.accessibility_state = props.accessibility.state;
                view.level = props.accessibility.level;
                view.description = props.accessibility.description.clone();
                view.active_descendant = props.accessibility.active_descendant;
                view.controls = props.accessibility.controls;
                view.long_press_delay = props.long_press_delay;
                view.selectable_view = props.selectable_view;
                view.pan_activation = props.pan_activation;
                view.pointer_events = props.pointer_events;
                view.screen_order = props.screen_order;
            }
            MountItem::Keymap(keymap) => self.keymap = Some(keymap.clone()),
            MountItem::TrackStates { id, states } => {
                self.nodes.entry(*id).or_default().tracked = *states;
            }
            MountItem::Gestures { id, values } => {
                self.nodes.entry(*id).or_default().gestures = *values;
            }
            MountItem::Canvas { id, drawing } => self.canvas(*id, &drawing.nodes),
            MountItem::AccessibilityLabel { id, label } => {
                self.nodes.entry(*id).or_default().label = label.clone();
            }
            MountItem::Text {
                id, text, content, ..
            } => {
                {
                    let view = self.nodes.entry(*id).or_default();
                    // What the user sees: hidden runs are not.
                    view.text = Some(text.visible_text().into_owned());
                    view.attributed = Some(Arc::clone(text));
                    view.text_content = *content;
                }
                self.set_spans(*id, text);
            }
            MountItem::Input { id, config } => {
                if let Some(input) = self.input_mut(*id) {
                    input.config = config.clone();
                }
            }
            MountItem::InputContent { id, content } => {
                if let Some(input) = self.input_mut(*id) {
                    input.content = Some(*content);
                }
            }
            MountItem::InputValue { id, text, count } => {
                // A value based on fewer edits than the user made is stale.
                if let Some(input) = self.input_mut(*id)
                    && *count >= input.count
                {
                    input.text = text.clone();
                }
            }
            MountItem::ScrollConfig { id, horizontal, .. } => {
                if let Some(scroll) = self.scroll_mut(*id) {
                    scroll.horizontal = *horizontal;
                }
            }
            MountItem::ScrollContent { id, size } => {
                if let Some(scroll) = self.scroll_mut(*id) {
                    scroll.content = Some(*size);
                }
                self.pull_back(*id);
            }
            MountItem::ScrollBy { id, dx, dy } => {
                // Not clamped: the core knows its content.
                if let Some(scroll) = self.scroll_mut(*id) {
                    scroll.applied = scroll.applied.wrapping_add(1);
                    if scroll.horizontal {
                        scroll.x += *dx;
                    } else {
                        scroll.y += *dy;
                    }
                }
            }
            MountItem::Command { id, command } => {
                self.command(*id, command);
                self.commands.push((*id, command.clone()));
            }
            _ => {}
        }
    }

    /// The nodes of canvas `id`'s drawing become its children in the
    /// model, in place of those it had.
    fn canvas(&mut self, id: NodeId, nodes: &[nsh_core::canvas::CanvasNode]) {
        for old in self.canvas_nodes.remove(&id).unwrap_or_default() {
            self.detach(old);
            self.nodes.remove(&old);
        }
        if nodes.is_empty() {
            return;
        }
        let mut ids = Vec::with_capacity(nodes.len());
        for node in nodes {
            if self.next_canvas_node == 0 {
                self.next_canvas_node = FIRST_CANVAS_NODE;
            }
            let child = self.next_canvas_node;
            self.next_canvas_node -= 1;
            self.nodes.insert(
                child,
                View {
                    parent: Some(id),
                    test_id: node.test_id.clone(),
                    label: Some(node.label.clone()),
                    // What it names is drawn: it shows as text does.
                    text: Some(node.label.to_string()),
                    frame: node.bounds,
                    role: node.role,
                    selected: node.selected,
                    canvas_node: true,
                    ..View::default()
                },
            );
            ids.push(child);
        }
        self.children
            .entry(id)
            .or_default()
            .extend(ids.iter().copied());
        self.canvas_nodes.insert(id, ids);
    }

    /// What a platform view does with `command`, as far as the model
    /// keeps it.
    fn command(&mut self, id: NodeId, command: &Command) {
        match command {
            Command::Dialog(dialog) => self.dialogs.push((**dialog).clone()),
            Command::SetClipboard(text) => self.clipboard = Some(text.clone()),
            // An image replaces the text.
            Command::SetClipboardImage(_) => self.clipboard = None,
            Command::ReadClipboard { id, has_only } => self.clipboard_reads.push((*id, *has_only)),
            Command::ReadClipboardImage { .. } => {
                self.unsupported.push("reading an image from the clipboard");
            }
            Command::ReadClipboardFiles { .. } => {
                self.unsupported.push("reading files from the clipboard");
            }
            // Headless runs load no images: the size is answered as a
            // failed load (a `TextView` asks for its images' sizes).
            Command::ImageInfo { id, .. } => self.image_infos.push(*id),
            Command::PickImages { id, request } => self
                .picks
                .push((*id, nsh_core::picker::Pick::Images(*request))),
            Command::PickFiles { id, request } => self
                .picks
                .push((*id, nsh_core::picker::Pick::Files(request.clone()))),
            // Recorded, never opened: a test's machine opens nothing.
            Command::OpenUrl { id, url } => {
                self.opened_urls.push(url.clone());
                self.url_opens.push(*id);
            }
            Command::PickScreenColor { id } => self.screen_colors.push(*id),
            // Recorded, never carried out: a test's machine opens, shows
            // and trashes nothing.
            Command::FileRequest { id, request } => {
                self.file_requests.push((**request).clone());
                self.file_answers.push((*id, (**request).clone()));
            }
            Command::Back => self.back_asked = true,
            Command::Desktop(desktop) => match &**desktop {
                nsh_core::desktop::DesktopCommand::PopupMenu { items, .. } => {
                    self.menu = Some(items.clone());
                }
                nsh_core::desktop::DesktopCommand::SetMenu(items) => {
                    self.app_menu = items.clone();
                }
                nsh_core::desktop::DesktopCommand::OpenWindow(open)
                    if !self.windows.iter().any(|(root, _)| *root == id) =>
                {
                    self.windows.push((id, open.options.id.clone()));
                }
                _ => {}
            },
            Command::OpenEditMenu { actions, .. } => self.edit_menu = Some((id, actions.clone())),
            Command::CloseEditMenu
                if self.edit_menu.as_ref().is_some_and(|(open, _)| *open == id) =>
            {
                self.edit_menu = None;
            }
            Command::SetJsResponder { block } => {
                self.js_block = *block;
                self.js_grants.push(*block);
            }
            Command::ClearJsResponder => self.js_block = false,
            Command::Focus if self.input(id).is_some() => self.focused = Some(id),
            Command::Blur if id == ROOT || self.focused == Some(id) => self.focused = None,
            Command::ScrollTo { x, y, .. } => {
                let end = self.scroll_end(id);
                if let Some(scroll) = self.scroll_mut(id) {
                    if scroll.horizontal {
                        scroll.x = x.clamp(Points::ZERO, end);
                    } else {
                        scroll.y = y.clamp(Points::ZERO, end);
                    }
                    scroll.applied = scroll.applied.wrapping_add(1);
                    self.scrolled.push(id);
                }
            }
            Command::ScrollToEnd { .. } => {
                let end = self.scroll_end(id);
                if let Some(scroll) = self.scroll_mut(id) {
                    if scroll.horizontal {
                        scroll.x = end;
                    } else {
                        scroll.y = end;
                    }
                    scroll.applied = scroll.applied.wrapping_add(1);
                    self.scrolled.push(id);
                }
            }
            _ => {}
        }
    }

    /// The spans of text view `id` that take presses become those of
    /// `text`: each a view in the model, inside the text view (or the span
    /// around it), as a platform finds the one under a finger.
    fn set_spans(&mut self, id: NodeId, text: &nsh_core::AttributedText) {
        self.drop_spans(id);
        let mut links = text.links.clone();
        // Outer spans first, so each finds the one around it made.
        links.sort_by_key(|l| (l.start, std::cmp::Reverse(l.end)));
        let mut spans = Vec::with_capacity(links.len());
        for (i, link) in links.iter().enumerate() {
            let parent = links[..i]
                .iter()
                .rev()
                .find(|l| l.start <= link.start && link.end <= l.end)
                .map_or(id, |l| l.node);
            self.nodes.insert(
                link.node,
                View {
                    parent: Some(parent),
                    events: link.events,
                    focusable: Some(link.focus_stop),
                    span: Some(Span {
                        view: id,
                        text: utf16_slice(&text.text, link.start, link.end),
                        start: link.start,
                        end: link.end,
                    }),
                    ..View::default()
                },
            );
            self.children.entry(parent).or_default().push(link.node);
            spans.push(link.node);
        }
        if let Some(view) = self.nodes.get_mut(&id) {
            view.spans = spans;
        }
    }

    /// Text view `id`'s spans are gone.
    fn drop_spans(&mut self, id: NodeId) {
        let Some(spans) = self
            .nodes
            .get_mut(&id)
            .map(|v| std::mem::take(&mut v.spans))
        else {
            return;
        };
        for span in spans {
            self.nodes.remove(&span);
            self.children.remove(&span);
        }
        let nodes = &self.nodes;
        if let Some(children) = self.children.get_mut(&id) {
            children.retain(|c| nodes.contains_key(c));
        }
    }

    /// The text view showing span `id`, and where in its text the span is
    /// (UTF-16 units); `None` for a view.
    pub(crate) fn span(&self, id: NodeId) -> Option<(NodeId, u32, u32)> {
        let span = self.nodes.get(&id)?.span.as_ref()?;
        Some((span.view, span.start, span.end))
    }

    /// The style of the span `selector` names, from its first character,
    /// inherited from the spans around it. `id:<testID>` names a nested
    /// text's span. `text:<text>` names where the text reads it. The parts
    /// before the last name the views to look in. An error when none or
    /// several match, when the matched span is empty, or when the last part
    /// is not a span name.
    pub fn span_style(&self, selector: &str) -> Result<nsh_core::ResolvedTextStyle, String> {
        let selector = Selector::parse(selector)?;
        let scope = selector.scope().map(|s| self.resolve(&s));
        let last = selector.parts.last().expect("a selector has a part");
        let mut hits = Vec::new();
        for id in self.by_layer() {
            if scope
                .as_ref()
                .is_some_and(|scope| !scope.iter().any(|s| *s == id || self.is_inside(id, *s)))
            {
                continue;
            }
            let Some(text) = self.nodes.get(&id).and_then(|v| v.attributed.as_ref()) else {
                continue;
            };
            let ranges = match &last.matcher {
                Matcher::TestId(want) => text
                    .test_ids
                    .iter()
                    .filter(|t| &*t.test_id == want)
                    .map(|t| (t.start < t.end).then_some(t.start))
                    .collect(),
                // Hidden characters (`visibility: "hidden"`) are not seen.
                Matcher::Text(want) => char_starts(&text.text, want)
                    .into_iter()
                    .filter(|&at| !text.hidden_at(at))
                    .map(Some)
                    .collect(),
                Matcher::Any(want) => {
                    let ids: Vec<Option<u32>> = text
                        .test_ids
                        .iter()
                        .filter(|t| &*t.test_id == want)
                        .map(|t| (t.start < t.end).then_some(t.start))
                        .collect();
                    if ids.is_empty() {
                        char_starts(&text.text, &TextMatch::Exact(want.trim().to_owned()))
                            .into_iter()
                            .filter(|&at| !text.hidden_at(at))
                            .map(Some)
                            .collect()
                    } else {
                        ids
                    }
                }
                Matcher::Label(_) | Matcher::Role { .. } | Matcher::View(_) => {
                    return Err(format!(
                        "`{selector}`: a span is named by `id:<testID>` or `text:<text>`"
                    ));
                }
            };
            hits.extend(ranges.into_iter().map(|start| (id, start)));
        }
        if let Some(n) = last.nth {
            hits = hits.get(n).copied().into_iter().collect();
        }
        let (id, start) = match hits.as_slice() {
            [(id, Some(start))] => (*id, *start),
            [(_, None)] => return Err(format!("span `{selector}` has no characters")),
            [] => return Err(crate::failure::not_found("span", selector)),
            many => {
                return Err(format!(
                    "`{selector}` matches {} spans; add `nth=<n>` or name the text views to look in",
                    many.len()
                ));
            }
        };
        self.nodes
            .get(&id)
            .and_then(|v| v.attributed.as_ref())
            .and_then(|text| text.span_at(start))
            .map(|span| span.style)
            .ok_or_else(|| crate::failure::not_found("span", selector))
    }

    /// View `id` leaves the tree with what it holds: none of it is under
    /// the mouse or has the focus any more, and it hears no leave or blur
    /// for that, as a removed DOM element does not. A removed view may live
    /// on (a JS cycle keeps it until a collection) while its component is
    /// gone, whose handlers must not run.
    fn taken_out(&mut self, id: NodeId) {
        let mut hovered = std::mem::take(&mut self.hovered);
        hovered.retain(|&v| {
            let inside = self.within(v, id);
            if inside {
                self.clear_state(v, nsh_core::tailwind::state::HOVERED);
            }
            !inside
        });
        self.hovered = hovered;
        if self.focused.is_some_and(|v| self.within(v, id)) {
            self.focused = None;
        }
        if let Some(key) = self.key_focus.filter(|&v| self.within(v, id)) {
            self.key_focus = None;
            self.clear_state(key, nsh_core::tailwind::state::FOCUSED);
        }
    }

    fn clear_state(&mut self, id: NodeId, bit: u16) {
        if let Some(states) = self.set_state(id, bit, false) {
            self.restated.push((id, states));
        }
    }

    /// The views a removal took out of the hover or the keyboard focus
    /// since the last call, still alive, with their states now.
    pub(crate) fn take_restated(&mut self) -> Vec<(NodeId, u16)> {
        let mut restated = std::mem::take(&mut self.restated);
        restated.retain(|(id, _)| self.nodes.contains_key(id));
        restated
    }

    fn detach(&mut self, id: NodeId) {
        if let Some(parent) = self.nodes.get_mut(&id).and_then(|v| v.parent.take())
            && let Some(siblings) = self.children.get_mut(&parent)
        {
            siblings.retain(|s| *s != id);
        }
    }

    /// The views on screen, in tree order: below the root, of a stack
    /// only its top screen (the others are covered), without what a back
    /// took away.
    fn attached(&self) -> Vec<NodeId> {
        let mut out = Vec::new();
        // A view, and whether it is in a window of the app's own.
        let mut stack = vec![(ROOT, false)];
        while let Some((id, own)) = stack.pop() {
            if self.closed.contains(&id) || self.hidden_windows.contains(&id) {
                continue;
            }
            let own = own || self.is_window(id);
            if id != ROOT && self.on_screen(own) {
                out.push(id);
            }
            if self.kind(id) == Some(ViewKind::Stack) {
                stack.extend(self.screens(id).last().map(|s| (*s, own)));
            } else if let Some(children) = self.children.get(&id) {
                stack.extend(children.iter().rev().map(|c| (*c, own)));
            }
        }
        out
    }

    /// Whether a view of a window of the app's own (`own`), or else of the
    /// main window, is on screen as far as its window goes.
    fn on_screen(&self, own: bool) -> bool {
        own || !self.main_hidden
    }

    /// The views of [`Screen::attached`] (below the root, of a stack only
    /// its top screen, spans of text aside), in tree order, as layout
    /// placed them. Each one's [`LayoutNode::parent`] is the root or a view
    /// before it in the list.
    pub fn layout_nodes(&self) -> Vec<LayoutNode> {
        let mut out = Vec::new();
        // A view, the view it is in, the origin of that view's content in
        // the root's points, whether a view around it is hidden, and whether
        // it is in a window of the app's own.
        let mut stack = vec![(ROOT, ROOT, Point::default(), false, false)];
        while let Some((id, parent, origin, hidden, own)) = stack.pop() {
            if self.closed.contains(&id) || self.hidden_windows.contains(&id) {
                continue;
            }
            let own = own || self.is_window(id);
            let root = View::default();
            let view = match self.nodes.get(&id) {
                Some(view) if view.span.is_some() => continue,
                Some(view) => view,
                None if id == ROOT => &root,
                None => continue,
            };
            // A view the core never created is not on screen, nor is what
            // it holds: leaving out the whole subtree keeps every node's
            // parent in the list.
            if id != ROOT && view.kind.is_none() {
                continue;
            }
            let hidden = hidden || view.hidden;
            let origin = if view.kind == Some(ViewKind::Modal) {
                Point::default()
            } else {
                origin
            };
            let bounds = Bounds::new(origin + view.frame.origin, view.frame.size);
            let mut content = bounds.origin;
            if let Some(scroll) = &view.scroll {
                content -= Point::new(scroll.x, scroll.y);
            }
            let listed = view.kind.filter(|_| id != ROOT && self.on_screen(own));
            if let Some(kind) = listed {
                out.push(LayoutNode {
                    id,
                    kind,
                    test_id: view.test_id.clone(),
                    parent,
                    bounds,
                    hidden,
                    clips: view.clips,
                    scroll: view.scroll.as_ref().map(|s| LayoutScroll {
                        horizontal: s.horizontal,
                        content_size: s.content,
                    }),
                    text: view.attributed.as_ref().map(|text| LayoutText {
                        text: Arc::clone(text),
                        content: Bounds::new(
                            bounds.origin + view.text_content.origin,
                            view.text_content.size,
                        ),
                    }),
                });
            }
            let children: Vec<NodeId> = if self.kind(id) == Some(ViewKind::Stack) {
                self.screens(id).last().copied().into_iter().collect()
            } else {
                self.children.get(&id).cloned().unwrap_or_default()
            };
            // What a view left out holds (a hidden main window's views
            // hold the windows of the app's own) is in the view around it
            // that is listed.
            let parent = if listed.is_some() { id } else { parent };
            stack.extend(
                children
                    .into_iter()
                    .rev()
                    .map(|c| (c, parent, content, hidden, own)),
            );
        }
        out
    }

    /// The views of [`Screen::attached`] a user sees, in tree order: those
    /// with an area that no view around them hides (`visibility: hidden`)
    /// or clips away (`overflow: hidden`, a scroll view the user cannot
    /// scroll, the window), transforms aside. A scroll view the user can
    /// scroll shows all of its content: it scrolls into view. The views a
    /// platform places show where it puts them: modals over the window,
    /// screens in their stack, header items and input accessories
    /// anywhere.
    fn shown(&self) -> Vec<NodeId> {
        let mut out = Vec::new();
        let window = self.viewport.map_or(Clip::All, |size| {
            Clip::Within(Bounds::new(Point::default(), size))
        });
        // A view, the origin of its parent's content and its clip in the
        // root's points, whether a view around it is hidden, whether its
        // parent shows, and whether it is in a window of the app's own.
        let mut stack = vec![(ROOT, Point::default(), window, false, true, false)];
        while let Some((id, origin, clip, hidden, parent_shown, own)) = stack.pop() {
            if self.closed.contains(&id) || self.hidden_windows.contains(&id) {
                continue;
            }
            let own = own || self.is_window(id);
            // The root is the platform's: no batch creates it.
            let root = View::default();
            let view = match self.nodes.get(&id) {
                Some(view) => view,
                None if id == ROOT => &root,
                None => continue,
            };
            let hidden = hidden || view.hidden;
            // A modal is presented over the window, wherever it is in the
            // tree; a window of the app's own is a window of its own, as
            // large as the main one (its root fills it).
            let (origin, clip) = if view.kind == Some(ViewKind::Modal) {
                (Point::default(), window)
            } else {
                (origin, clip)
            };
            let bounds = Bounds::new(origin + view.frame.origin, view.frame.size);
            let placed = matches!(
                view.kind,
                Some(
                    ViewKind::Screen
                        | ViewKind::Modal
                        | ViewKind::HeaderItem
                        | ViewKind::InputAccessory
                )
            );
            let shows = if view.span.is_some() {
                // Where its text view is.
                parent_shown
            } else {
                !hidden && (placed || (!bounds.is_empty() && clip.shows(&bounds)))
            };
            if id != ROOT && shows && self.on_screen(own) {
                out.push(id);
            }
            let mut inner = if matches!(
                view.kind,
                Some(ViewKind::HeaderItem | ViewKind::InputAccessory)
            ) {
                Clip::All
            } else {
                clip
            };
            let mut content = bounds.origin;
            if let Some(scroll) = &view.scroll {
                content -= Point::new(scroll.x, scroll.y);
                inner = if scroll.locked {
                    inner.within(bounds)
                } else if inner.shows(&bounds) {
                    // Any of its content scrolls into view, nothing before
                    // its start along its axis: lists park the cells they do
                    // not use there. Across it nothing is clipped (the
                    // headless text engine puts inline views on one line).
                    let far = Points(f32::MAX / 4.0);
                    let start = if scroll.horizontal {
                        Point::new(content.x, -far)
                    } else {
                        Point::new(-far, content.y)
                    };
                    Clip::Within(Bounds::new(
                        start,
                        Size::new(Points(f32::MAX), Points(f32::MAX)),
                    ))
                } else {
                    Clip::Within(Bounds::default())
                };
            } else if view.clips && id != ROOT {
                inner = inner.within(bounds);
            }
            stack.extend(
                self.reading_children(id)
                    .into_iter()
                    .rev()
                    .map(|child| (child, content, inner, hidden, shows || id == ROOT, own)),
            );
        }
        out
    }

    /// `id`'s children in reading order: a stack's top screen; a scroll
    /// view's content, and a list's cells in its parent's viewport, in the
    /// order they are on screen, as macOS, iOS and Android order Tab and
    /// screen readers (a list's recycled cells are in the order they were
    /// made).
    fn reading_children(&self, id: NodeId) -> Vec<NodeId> {
        let mut children: Vec<NodeId> = if self.kind(id) == Some(ViewKind::Stack) {
            self.screens(id).last().copied().into_iter().collect()
        } else {
            self.children.get(&id).cloned().unwrap_or_default()
        };
        let horizontal = self.nodes.get(&id).and_then(|view| {
            view.scroll.as_ref().map(|s| s.horizontal).or(view
                .screen_order
                .map(|a| a == nsh_core::geometry::Axis::Horizontal))
        });
        if let Some(horizontal) = horizontal
            && children.len() > 1
        {
            let start = |child: &NodeId| {
                let frame = self.nodes.get(child).map(|v| v.frame).unwrap_or_default();
                let (main, cross) = if horizontal {
                    (frame.origin.x, frame.origin.y)
                } else {
                    (frame.origin.y, frame.origin.x)
                };
                (main.0, cross.0)
            };
            children.sort_by(|a, b| {
                let (a, b) = (start(a), start(b));
                a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1))
            });
        }
        children
    }

    /// The window is `size` (what lies outside it is not on screen).
    pub(crate) fn set_viewport(&mut self, size: Size<Points>) {
        self.viewport = Some(size);
    }

    /// The screens stack `id` shows, bottom to top (without those a back
    /// popped).
    fn screens(&self, id: NodeId) -> Vec<NodeId> {
        self.children
            .get(&id)
            .map(|c| {
                c.iter()
                    .copied()
                    .filter(|s| !self.popped.contains(s))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// What going back does now, as a platform's back does it: in the
    /// newest modal (else the whole screen) the innermost stack that can go
    /// back and is laid out with a size (`shown_in_layout`) pops its top
    /// screen, or asks it when it prevents going back;
    /// without one, the newest modal asks to close.
    pub(crate) fn back_target(&self) -> Back {
        let attached = self.attached();
        let modal = attached
            .iter()
            .rev()
            .copied()
            .find(|id| self.kind(*id) == Some(ViewKind::Modal) && !self.is_window(*id));
        let can_go_back = |stack: NodeId| {
            let screens = self.screens(stack);
            screens.len() >= 2
                || screens
                    .last()
                    .is_some_and(|s| self.nodes.get(s).is_some_and(|v| v.prevent_back))
        };
        let stacks: Vec<NodeId> = attached
            .iter()
            .copied()
            .filter(|id| {
                self.kind(*id) == Some(ViewKind::Stack)
                    && modal.is_none_or(|m| self.is_inside(*id, m))
                    && can_go_back(*id)
                    && nsh_core::navigation::shown_in_layout(
                        std::iter::successors(Some(*id), |id| self.nodes.get(id)?.parent)
                            .filter(|id| *id != ROOT)
                            .filter_map(|id| Some(self.nodes.get(&id)?.frame)),
                    )
            })
            .collect();
        let innermost = stacks
            .iter()
            .copied()
            .find(|s| !stacks.iter().any(|o| o != s && self.is_inside(*o, *s)));
        if let Some(stack) = innermost
            && let Some(&top) = self.screens(stack).last()
        {
            return if self.nodes.get(&top).is_some_and(|v| v.prevent_back) {
                Back::Ask(top)
            } else {
                Back::Pop(top)
            };
        }
        match modal {
            Some(modal) => Back::Close {
                modal,
                close_on_escape: self.nodes.get(&modal).is_some_and(|v| v.close_on_escape),
            },
            None => Back::Nothing,
        }
    }

    /// A back popped `screen` natively: it is gone until the app removes it.
    pub(crate) fn pop(&mut self, screen: NodeId) {
        self.popped.insert(screen);
    }

    /// A back closed `modal` natively.
    pub(crate) fn close(&mut self, modal: NodeId) {
        self.closed.insert(modal);
    }

    /// The modals presented since the last call (not the windows of the
    /// app's own: the platform shows those in windows of their own).
    pub(crate) fn take_presented(&mut self) -> Vec<NodeId> {
        let mut presented = std::mem::take(&mut self.presented);
        presented.retain(|id| !self.is_window(*id));
        presented
    }

    /// The modals presented since the last [`Screen::take_presented`],
    /// which it leaves for that call.
    pub(crate) fn presenting(&self) -> Vec<NodeId> {
        let mut presented = self.presented.clone();
        presented.retain(|id| !self.is_window(*id));
        presented
    }

    /// Whether view `id` is still in the tree: attached up to the root,
    /// with nothing on the way a back closed natively.
    pub(crate) fn in_tree(&self, mut id: NodeId) -> bool {
        loop {
            if id == ROOT {
                return true;
            }
            if self.closed.contains(&id) {
                return false;
            }
            match self.nodes.get(&id).and_then(|v| v.parent) {
                Some(parent) => id = parent,
                None => return false,
            }
        }
    }

    /// Whether `id` is the root of a window of the app's own.
    pub(crate) fn is_window(&self, id: NodeId) -> bool {
        self.windows.iter().any(|(root, _)| *root == id)
    }

    /// The root of the window view `id` is in: a window of the app's own,
    /// else the main window's root.
    pub(crate) fn window_of(&self, mut id: NodeId) -> NodeId {
        loop {
            if self.is_window(id) {
                return id;
            }
            match self.nodes.get(&id).and_then(|v| v.parent) {
                Some(parent) => id = parent,
                None => return ROOT,
            }
        }
    }

    /// The root of the window the app calls `id` (`"main"`: the main
    /// window's), while it is open.
    pub(crate) fn window_root(&self, id: &str) -> Option<NodeId> {
        if id == "main" {
            return Some(ROOT);
        }
        self.windows
            .iter()
            .find(|(_, own)| own == id)
            .map(|(root, _)| *root)
    }

    /// Window `root` (the main window's root, or a window of the app's
    /// own's) is on screen (`!hidden`) or not (minimized, hidden, closed by
    /// a policy until the app removes it).
    pub(crate) fn set_window_hidden(&mut self, root: NodeId, hidden: bool) {
        if root == ROOT {
            self.main_hidden = hidden;
        } else if hidden {
            self.hidden_windows.insert(root);
        } else {
            self.hidden_windows.remove(&root);
        }
    }

    /// Node `id` left the tree: when it was a window's root, the window
    /// closed.
    fn forget_window(&mut self, id: NodeId) {
        self.windows.retain(|(root, _)| *root != id);
        self.hidden_windows.remove(&id);
    }

    /// Whether the app asked for a back since the last call.
    pub(crate) fn take_back_asked(&mut self) -> bool {
        std::mem::take(&mut self.back_asked)
    }

    /// The dialogs shown so far, in order (`AlertDialog.show`, action sheets).
    pub fn dialogs(&self) -> &[Dialog] {
        &self.dialogs
    }

    /// The oldest dialog not answered yet.
    pub(crate) fn pending_dialog(&self) -> Option<&Dialog> {
        self.dialogs.get(self.answered)
    }

    /// The oldest dialog was answered.
    pub(crate) fn answered(&mut self) {
        self.answered = (self.answered + 1).min(self.dialogs.len());
    }

    /// The picks the app asked for so far, in order (`Picker.pickImages`,
    /// `Picker.pickFiles`).
    pub fn picks(&self) -> Vec<nsh_core::picker::Pick> {
        self.picks
            .iter()
            .map(|(_, request)| request.clone())
            .collect()
    }

    /// The oldest pick not answered yet: its request's id and what it
    /// asks.
    pub(crate) fn pending_pick(&self) -> Option<(u32, nsh_core::picker::Pick)> {
        self.picks.get(self.picks_answered).cloned()
    }

    /// The oldest pick was answered.
    pub(crate) fn picked(&mut self) {
        self.picks_answered = (self.picks_answered + 1).min(self.picks.len());
    }

    /// The clipboard's text.
    pub fn clipboard(&self) -> Option<&str> {
        self.clipboard.as_deref()
    }

    pub(crate) fn set_clipboard(&mut self, text: Option<String>) {
        self.clipboard = text;
    }

    /// The clipboard reads asked since the last call.
    pub(crate) fn take_clipboard_reads(&mut self) -> Vec<(u32, bool)> {
        std::mem::take(&mut self.clipboard_reads)
    }

    /// What the app asked that only a real platform answers, since the
    /// last call.
    pub(crate) fn take_image_infos(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.image_infos)
    }

    /// Ends the loads of the images whose source `fails` picks, as failed:
    /// the views and their sources, in no particular order. A view's next
    /// source loads again.
    pub(crate) fn fail_images(&mut self, fails: impl Fn(&str) -> bool) -> Vec<(NodeId, Arc<str>)> {
        let mut failed = Vec::new();
        self.loading_images.retain(|id, uri| {
            let fail = fails(uri);
            if fail {
                failed.push((*id, uri.clone()));
            }
            !fail
        });
        failed
    }

    /// The URLs the app had the system open (`openUrl`, a `TextView`'s
    /// links), in order: what reached the platform, past the URL check,
    /// the `openUrl` capability and the embedding app's URL handler.
    pub fn opened_urls(&self) -> &[String] {
        &self.opened_urls
    }

    /// The requests on local paths that reached the platform, in order
    /// (`pick_paths`, `pick_save_path`, `open_path`, `reveal_path`,
    /// `move_to_trash`; only once the environment has
    /// [`nsh_core::platform::Environment::file_requests`]).
    pub fn file_requests(&self) -> &[nsh_core::file_dialog::FileRequest] {
        &self.file_requests
    }

    /// The requests on local paths to answer since the last call.
    pub(crate) fn take_file_answers(&mut self) -> Vec<(u32, nsh_core::file_dialog::FileRequest)> {
        std::mem::take(&mut self.file_answers)
    }

    /// The screen color requests to answer since the last call.
    pub(crate) fn take_screen_colors(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.screen_colors)
    }

    /// The `openUrl` requests to answer since the last call.
    pub(crate) fn take_url_opens(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.url_opens)
    }

    pub(crate) fn take_unsupported(&mut self) -> Vec<&'static str> {
        std::mem::take(&mut self.unsupported)
    }

    /// The views on screen in the order a user's eyes find them: the
    /// topmost modal's first (the last presented), then the rest.
    fn by_layer(&self) -> Vec<NodeId> {
        let attached = self.shown();
        // Windows of the app's own are side by side with the main one, not
        // over it: their views are found in tree order.
        let modals: Vec<NodeId> = attached
            .iter()
            .copied()
            .filter(|id| self.kind(*id) == Some(ViewKind::Modal) && !self.is_window(*id))
            .collect();
        let Some(top) = modals.last() else {
            return attached;
        };
        let (mut first, rest): (Vec<NodeId>, Vec<NodeId>) = attached
            .into_iter()
            .partition(|id| *id == *top || self.is_inside(*id, *top));
        first.extend(rest);
        first
    }

    /// The view `selector` matches inside `target` (a text in the button
    /// a press goes to); `None` when the match is `target` itself.
    pub(crate) fn match_inside(&self, selector: &Selector, target: NodeId) -> Option<NodeId> {
        self.resolve(selector)
            .into_iter()
            .find(|id| self.is_inside(*id, target))
    }

    /// Where in `target` a press of what `selector` names lands: the
    /// center of the view it matches inside `target`, as a finger taps the
    /// text it reads. `None` when the match is `target` itself.
    pub(crate) fn press_point(&self, selector: &Selector, target: NodeId) -> Option<Point<Points>> {
        let inner = self.bounds_in_root(self.match_inside(selector, target)?)?;
        let outer = self.bounds_in_root(target)?;
        Some(nsh_core::geometry::point(
            inner.origin.x - outer.origin.x + inner.size.width / 2.0,
            inner.origin.y - outer.origin.y + inner.size.height / 2.0,
        ))
    }

    pub(crate) fn is_inside(&self, mut id: NodeId, ancestor: NodeId) -> bool {
        while let Some(parent) = self.nodes.get(&id).and_then(|v| v.parent) {
            if parent == ancestor {
                return true;
            }
            id = parent;
        }
        false
    }

    fn kind(&self, id: NodeId) -> Option<ViewKind> {
        self.nodes.get(&id)?.kind
    }

    /// The texts on screen, in tree order (a scroll view's content in
    /// screen order).
    pub fn texts(&self) -> Vec<&str> {
        self.shown()
            .into_iter()
            .filter_map(|id| self.nodes.get(&id)?.text.as_deref())
            .collect()
    }

    /// Whether a view on screen shows the text `text` (spaces around it
    /// aside).
    pub fn shows(&self, text: &str) -> bool {
        self.texts().iter().any(|t| t.trim() == text)
    }

    /// Whether a view on screen matches `selector` (the module
    /// `selector`'s: `id:<testID>`, `label:<label>`, `text:<text>`,
    /// `role:<role>[<name>]`, `view:<id>`, a bare string; ` >> ` looks
    /// inside, `nth=<n>` picks); an error for a selector that does not
    /// parse.
    pub fn matches(&self, selector: &str) -> Result<bool, String> {
        self.count(selector).map(|n| n > 0)
    }

    /// How many views on screen match `selector` ([`Screen::matches`]).
    pub fn count(&self, selector: &str) -> Result<usize, String> {
        Ok(self.resolve(&Selector::parse(selector)?).len())
    }

    /// The commands sent so far, in order, with the view each went to.
    pub fn commands(&self) -> &[(NodeId, Command)] {
        &self.commands
    }

    /// Whether the command `command` was sent.
    pub fn sent(&self, command: &Command) -> bool {
        self.commands.iter().any(|(_, c)| c == command)
    }

    /// The view a press on `selector` goes to ([`Screen::matches`]'s
    /// selectors): the matching view, or its nearest ancestor that hears
    /// presses (a text inside a button). `None` when none matches, or it is
    /// disabled; an error for a selector that does not parse or matches
    /// views a press would reach apart.
    pub fn press_target(&self, selector: &str) -> Result<Option<NodeId>, String> {
        let parsed = Selector::parse(selector)?;
        match self.pressable(&parsed) {
            Pick::One(id) => Ok(Some(id)),
            Pick::None | Pick::Disabled => Ok(None),
            Pick::Many(n) => Err(format!("`{selector}` matches {n} views")),
        }
    }

    /// The text of the input `selector` names ([`Screen::matches`]'s
    /// selectors; `text:` matches an input's text or placeholder); an
    /// error when it names several.
    pub fn input_text(&self, selector: &str) -> Result<Option<&str>, String> {
        let parsed = Selector::parse(selector)?;
        match self.input_view(&parsed) {
            Pick::One(id) => Ok(self.input(id).map(|input| input.text.as_str())),
            Pick::Many(n) => Err(format!("`{selector}` matches {n} inputs")),
            Pick::None | Pick::Disabled => Ok(None),
        }
    }

    /// The input `selector` names, as [`Screen::input_text`] finds it.
    #[cfg(feature = "agent")]
    pub(crate) fn input_id(&self, selector: &str) -> Result<Option<NodeId>, String> {
        let parsed = Selector::parse(selector)?;
        match self.input_view(&parsed) {
            Pick::One(id) => Ok(Some(id)),
            Pick::Many(n) => Err(format!("`{selector}` matches {n} inputs")),
            Pick::None | Pick::Disabled => Ok(None),
        }
    }

    /// Whether the view `selector` names takes input: neither it nor a view
    /// around it is disabled, and an input is editable; an error when none
    /// or several match.
    pub fn enabled(&self, selector: &str) -> Result<bool, String> {
        let parsed = Selector::parse(selector)?;
        match self.resolve(&parsed)[..] {
            [id] => {
                Ok(!self.disabled_from(id, None)
                    && self.input(id).is_none_or(|i| i.config.editable))
            }
            [] => Err(crate::failure::not_found("view", selector)),
            ref all => Err(format!("`{selector}` matches {} views", all.len())),
        }
    }

    /// Whether the view `selector` names is in a selectable view (it or a
    /// view around it is one: a `View` with `selectable`, a selectable
    /// `TextView`); an error when none or several match.
    pub fn in_selectable_view(&self, selector: &str) -> Result<bool, String> {
        let parsed = Selector::parse(selector)?;
        match self.resolve(&parsed)[..] {
            [mut id] => loop {
                let Some(view) = self.nodes.get(&id) else {
                    return Ok(false);
                };
                if view.selectable_view {
                    return Ok(true);
                }
                match view.parent {
                    Some(parent) => id = parent,
                    None => return Ok(false),
                }
            },
            [] => Err(crate::failure::not_found("view", selector)),
            ref all => Err(format!("`{selector}` matches {} views", all.len())),
        }
    }

    /// Whether the view `selector` names is selected (its accessibility
    /// state, or a canvas node's `selected`); an error when none or several
    /// match.
    pub fn selected(&self, selector: &str) -> Result<bool, String> {
        let parsed = Selector::parse(selector)?;
        match self.resolve(&parsed)[..] {
            [id] => Ok(self.nodes.get(&id).is_some_and(|v| v.selected)),
            [] => Err(crate::failure::not_found("view", selector)),
            ref all => Err(format!("`{selector}` matches {} views", all.len())),
        }
    }

    /// The accessibility state of the view `selector` names (its
    /// `accessibilityState`: a toggle button's `pressed`, a page's
    /// `current`, ...); an error when none or several match.
    pub fn accessibility_state(&self, selector: &str) -> Result<AccessibilityState, String> {
        let parsed = Selector::parse(selector)?;
        match self.resolve(&parsed)[..] {
            [id] => Ok(self
                .nodes
                .get(&id)
                .map(|v| v.accessibility_state)
                .unwrap_or_default()),
            [] => Err(crate::failure::not_found("view", selector)),
            ref all => Err(format!("`{selector}` matches {} views", all.len())),
        }
    }

    /// The level of the view `selector` names (its `accessibilityLevel`:
    /// a heading's, a tree item's depth); an error when none or several
    /// match.
    pub fn accessibility_level(&self, selector: &str) -> Result<Option<u32>, String> {
        let parsed = Selector::parse(selector)?;
        match self.resolve(&parsed)[..] {
            [id] => Ok(self.nodes.get(&id).and_then(|v| v.level)),
            [] => Err(crate::failure::not_found("view", selector)),
            ref all => Err(format!("`{selector}` matches {} views", all.len())),
        }
    }

    /// The description of the view `selector` names (its
    /// `accessibilityDescription`: a dialog's message), which screen
    /// readers read after its name; an error when none or several match.
    pub fn accessibility_description(&self, selector: &str) -> Result<Option<String>, String> {
        let parsed = Selector::parse(selector)?;
        match self.resolve(&parsed)[..] {
            [id] => Ok(self
                .nodes
                .get(&id)
                .and_then(|v| v.description.as_deref().map(str::to_owned))),
            [] => Err(crate::failure::not_found("view", selector)),
            ref all => Err(format!("`{selector}` matches {} views", all.len())),
        }
    }

    /// The id of the one view `selector` names: what
    /// [`Screen::active_descendant`] and [`Screen::accessibility_controls`]
    /// give; an error when none or several match.
    pub fn id(&self, selector: &str) -> Result<NodeId, String> {
        let parsed = Selector::parse(selector)?;
        match self.resolve(&parsed)[..] {
            [id] => Ok(id),
            [] => Err(crate::failure::not_found("view", selector)),
            ref all => Err(format!("`{selector}` matches {} views", all.len())),
        }
    }

    /// The view the view `selector` names has as its active descendant
    /// (its `accessibilityActiveDescendant`: a combo box's highlighted
    /// option), by its id ([`Screen::id`]); an error when none or several
    /// match.
    pub fn active_descendant(&self, selector: &str) -> Result<Option<NodeId>, String> {
        let id = self.id(selector)?;
        Ok(self.nodes.get(&id).and_then(|v| v.active_descendant))
    }

    /// The view whose content the view `selector` names controls (its
    /// `accessibilityControls`: a combo box's listbox), by its id
    /// ([`Screen::id`]); an error when none or several match.
    pub fn accessibility_controls(&self, selector: &str) -> Result<Option<NodeId>, String> {
        let id = self.id(selector)?;
        Ok(self.nodes.get(&id).and_then(|v| v.controls))
    }

    /// The views on screen `selector` matches, in the order a user's eyes
    /// find them ([`Screen::by_layer`]): each part looks inside what the
    /// one before matched.
    pub(crate) fn resolve(&self, selector: &Selector) -> Vec<NodeId> {
        let layers = self.by_layer();
        let mut scope: Option<Vec<NodeId>> = None;
        for part in &selector.parts {
            let inside = |id: NodeId| {
                scope
                    .as_ref()
                    .is_none_or(|scope| scope.iter().any(|s| self.is_inside(id, *s)))
            };
            let matching = |test: &dyn Fn(NodeId, &View) -> bool| -> Vec<NodeId> {
                layers
                    .iter()
                    .copied()
                    .filter(|id| inside(*id) && self.nodes.get(id).is_some_and(|v| test(*id, v)))
                    .collect()
            };
            let is = |value: &Option<Arc<str>>, want: &str| value.as_deref() == Some(want);
            let mut found = match &part.matcher {
                Matcher::TestId(want) => matching(&|_, v| is(&v.test_id, want)),
                Matcher::Label(want) => {
                    matching(&|_, v| v.label.as_deref().is_some_and(|l| want.matches(l)))
                }
                Matcher::Text(want) => matching(&|_, v| shows_text(v, want)),
                Matcher::Role { role, name } => matching(&|id, v| {
                    v.role != AccessibilityRole::None
                        && v.role.js_name() == role
                        && name
                            .as_ref()
                            .is_none_or(|name| name.matches(&self.name(id)))
                }),
                Matcher::View(id) => layers
                    .iter()
                    .copied()
                    .filter(|v| v == id && inside(*v))
                    .collect(),
                Matcher::Any(want) => {
                    let exact = TextMatch::Exact(want.trim().to_owned());
                    let ids = matching(&|_, v| is(&v.test_id, want));
                    let ids = if ids.is_empty() {
                        matching(&|_, v| is(&v.label, want))
                    } else {
                        ids
                    };
                    if ids.is_empty() {
                        matching(&|_, v| shows_text(v, &exact))
                    } else {
                        ids
                    }
                }
            };
            if let Some(n) = part.nth {
                found = found.get(n).copied().into_iter().collect();
            }
            scope = Some(found);
        }
        scope.unwrap_or_default()
    }

    /// The one view the matches of `selector` lead to through `target`
    /// (several matches leading to one view are one).
    fn pick(&self, selector: &Selector, target: impl Fn(NodeId) -> Option<NodeId>) -> Pick {
        let mut targets: Vec<NodeId> = Vec::new();
        for id in self.resolve(selector) {
            if let Some(t) = target(id)
                && !targets.contains(&t)
            {
                targets.push(t);
            }
        }
        match targets[..] {
            [] => Pick::None,
            [one] => Pick::One(one),
            ref all => Pick::Many(all.len()),
        }
    }

    /// The center of canvas node `id` in the root; `None` for a view.
    pub(crate) fn canvas_node_center(&self, id: NodeId) -> Option<Point<Points>> {
        if !self.nodes.get(&id)?.canvas_node {
            return None;
        }
        Some(self.bounds_in_root(id)?.center())
    }

    /// The canvas containing the one node `selector` names, and its
    /// center in that canvas's coordinates; `None` for ordinary views.
    pub(crate) fn canvas_node(&self, selector: &Selector) -> Option<(NodeId, Point<Points>)> {
        let [id] = self.resolve(selector)[..] else {
            return None;
        };
        let view = self.nodes.get(&id)?;
        view.canvas_node
            .then_some((view.parent?, view.frame.center()))
    }

    /// The view that takes a pointer at `at` (in the root) instead of
    /// `target`: one drawn over it there, neither in it nor around it.
    /// `None` when the pointer reaches `target` (or a view in it), only
    /// views around it (a target scrolled out of view or of no size, which
    /// a press still reaches as before), or a view that handles presses or
    /// touches itself.
    pub(crate) fn covering(&self, target: NodeId, at: Point<Points>) -> Option<NodeId> {
        let hit = self.hit_pointer(at, self.window_of(target));
        let reaches = hit == target || self.is_inside(hit, target) || self.is_inside(target, hit);
        if reaches {
            return None;
        }
        // A view over the target that hears presses or touches itself (a
        // data table's or an editor's input layer) takes the press and
        // places it as the app wants; only one that hears neither swallows
        // it.
        let mut id = hit;
        loop {
            if id == target || self.is_inside(target, id) {
                return Some(hit);
            }
            if self.hears(id, EventKind::Press) || self.hears(id, EventKind::Touch) {
                return None;
            }
            id = self.nodes.get(&id).and_then(|v| v.parent)?;
        }
    }

    /// `id` as a selector a test would write: its test id, else the first
    /// text in it, else `view:<id>`.
    pub(crate) fn selector_of(&self, id: NodeId) -> String {
        if let Some(test_id) = self.nodes.get(&id).and_then(|v| v.test_id.as_deref()) {
            return format!("`id:{test_id}`");
        }
        match self
            .down_to(id, |v| v.text.is_some())
            .and_then(|t| self.nodes.get(&t)?.text.as_deref())
        {
            Some(text) => format!("`{}`", text.trim()),
            None => format!("`view:{id}`"),
        }
    }

    /// Where a press on `target` at `at` (in its window's root) goes when
    /// `target` takes no pointer (it or a view around it has
    /// `pointerEvents: none`): the view around what a pointer there reaches
    /// that hears presses, and the point in it. `None` for a target that
    /// takes a pointer, or when the press would reach it all the same.
    pub(crate) fn routed_press(
        &self,
        target: NodeId,
        at: Point<Points>,
    ) -> Option<(NodeId, Point<Points>)> {
        if self.receives_pointer(target) {
            return None;
        }
        let hit = self.hit_pointer(at, self.window_of(target));
        let to = self.up_to(hit, |v| v.events.contains(EventKind::Press))?;
        if to == target {
            return None;
        }
        let origin = self.bounds_in_root(to)?.origin;
        Some((
            to,
            nsh_core::geometry::point(at.x - origin.x, at.y - origin.y),
        ))
    }

    /// Whether a pointer can reach `id`: neither it nor a view around it
    /// has `pointerEvents: none` or is hidden, and no view around it takes
    /// touches only for itself (`box-only`).
    fn receives_pointer(&self, id: NodeId) -> bool {
        let mut at = Some(id);
        while let Some(current) = at {
            let Some(view) = self.nodes.get(&current) else {
                break;
            };
            if view.pointer_events == PointerEvents::None
                || view.hidden
                || (current != id && view.pointer_events == PointerEvents::BoxOnly)
            {
                return false;
            }
            at = view.parent;
        }
        true
    }

    /// The view a pointer at `at` (in the root of `window`, a window's
    /// root) reaches in that window: the topmost, innermost one there that
    /// receives touches. Canvas nodes are not views, and the windows of the
    /// app's own are windows of their own.
    fn hit_pointer(&self, at: Point<Points>, window: NodeId) -> NodeId {
        let order = self.attached();
        let attached: HashSet<NodeId> = order.iter().copied().collect();
        // The dialogs presented over this window first, the last one on
        // top: a dialog is over its window wherever its node is in the
        // tree, so the views around that node (a card that clips) take no
        // part in where it is hit.
        let dialogs = order.iter().rev().copied().filter(|id| {
            self.kind(*id) == Some(ViewKind::Modal)
                && !self.is_window(*id)
                && self.window_of(*id) == window
        });
        for dialog in dialogs {
            if let Some(hit) = self.hit_in(dialog, at, &attached) {
                return hit;
            }
        }
        self.hit_in(window, at, &attached).unwrap_or(window)
    }

    fn hit_in(&self, id: NodeId, at: Point<Points>, attached: &HashSet<NodeId>) -> Option<NodeId> {
        let view = self.nodes.get(&id);
        let receives = view.map_or(PointerEvents::Auto, |v| v.pointer_events);
        if receives == PointerEvents::None || view.is_some_and(|v| v.hidden) {
            return None;
        }
        let inside = id == ROOT
            || self.is_window(id)
            || self.bounds_in_root(id).is_some_and(|b| b.contains(&at));
        // Unclipped children can receive a pointer outside their parent's box.
        if !inside
            && (receives == PointerEvents::BoxOnly
                || view.is_some_and(|v| v.clips || v.scroll.is_some()))
        {
            return None;
        }
        if receives != PointerEvents::BoxOnly
            && let Some(children) = self.children.get(&id)
        {
            // Header items and input accessories are in the bars the
            // platform draws over a screen's content (a large title's header
            // included), wherever they are among its children: they are on
            // top.
            let placed = |c: &NodeId| {
                matches!(
                    self.kind(*c),
                    Some(ViewKind::HeaderItem | ViewKind::InputAccessory)
                )
            };
            let order = children
                .iter()
                .rev()
                .filter(|c| placed(c))
                .chain(children.iter().rev().filter(|c| !placed(c)));
            for &child in order {
                let node = self.nodes.get(&child).is_some_and(|v| v.canvas_node);
                // Windows are windows of their own; dialogs were tried
                // first ([`Screen::hit_pointer`]).
                if node || !attached.contains(&child) || self.kind(child) == Some(ViewKind::Modal) {
                    continue;
                }
                if let Some(hit) = self.hit_in(child, at, attached) {
                    return Some(hit);
                }
            }
        }
        (inside && receives != PointerEvents::BoxNone).then_some(id)
    }

    /// The view a press on the selector's match goes to: it, or its nearest
    /// pressable ancestor (a text inside a button); [`Pick::Disabled`] when
    /// it or a view on the way is disabled.
    pub(crate) fn pressable(&self, selector: &Selector) -> Pick {
        let matches = self.resolve(selector);
        if let [id] = matches[..]
            && let Some(at) = self.canvas_node_center(id)
        {
            let Some(target) = self.up_to(self.hit_pointer(at, self.window_of(id)), |v| {
                v.events.contains(EventKind::Press)
            }) else {
                return Pick::None;
            };
            return if self.disabled_from(target, None) {
                Pick::Disabled
            } else {
                Pick::One(target)
            };
        }
        if !matches.is_empty()
            && matches.iter().all(|id| {
                let target = self.up_to(*id, |v| v.events.contains(EventKind::Press));
                self.disabled_from(*id, target)
            })
        {
            return Pick::Disabled;
        }
        self.pick(selector, |id| {
            let target = self.up_to(id, |v| v.events.contains(EventKind::Press))?;
            (!self.disabled_from(id, Some(target))).then_some(target)
        })
    }

    /// Whether `id` or a view around it, up to `until` (else the root), is
    /// disabled.
    fn disabled_from(&self, mut id: NodeId, until: Option<NodeId>) -> bool {
        loop {
            let Some(view) = self.nodes.get(&id) else {
                return false;
            };
            if view.disabled {
                return true;
            }
            if Some(id) == until {
                return false;
            }
            match view.parent {
                Some(parent) => id = parent,
                None => return false,
            }
        }
    }

    /// The input the selector names: the matching view, or the first input
    /// in it (a text field's frame).
    pub(crate) fn input_view(&self, selector: &Selector) -> Pick {
        self.pick(selector, |id| self.down_to(id, |v| v.input.is_some()))
    }

    /// The scroll view the selector names: the matching view, or the
    /// nearest scroll view around it (a row of a list), else the first in
    /// it; [`Pick::Disabled`] when the user cannot scroll it.
    pub(crate) fn scroll_view(&self, selector: &Selector) -> Pick {
        let is_scroll = |v: &View| v.scroll.is_some();
        match self.pick(selector, |id| {
            self.up_to(id, is_scroll)
                .or_else(|| self.down_to(id, is_scroll))
        }) {
            Pick::One(id) if self.scroll(id).is_some_and(|s| s.locked) => Pick::Disabled,
            pick => pick,
        }
    }

    /// The view the selector names, for a drag: the finger lands on it.
    pub(crate) fn view(&self, selector: &Selector) -> Pick {
        self.pick(selector, Some)
    }

    /// The view the selector names, for a long press: it, or its nearest
    /// ancestor that hears long presses or presses.
    pub(crate) fn long_pressable(&self, selector: &Selector) -> Pick {
        self.pick(selector, |id| {
            // A view watching touches hears a held finger too (a context
            // menu's trigger).
            let target = self.up_to(id, |v| {
                v.events.contains(EventKind::LongPress)
                    || v.events.contains(EventKind::Press)
                    || v.events.contains(EventKind::Touch)
            })?;
            (!self.disabled_from(id, Some(target))).then_some(target)
        })
    }

    /// How long a press on `id` must last to be a long one, in milliseconds.
    pub(crate) fn long_press_delay(&self, id: NodeId) -> Option<f32> {
        self.nodes.get(&id)?.long_press_delay
    }

    /// A view's accessible name: its label, else the texts in it.
    fn name(&self, id: NodeId) -> String {
        if let Some(label) = self.nodes.get(&id).and_then(|v| v.label.as_deref()) {
            return label.to_owned();
        }
        let mut texts = Vec::new();
        let mut stack = vec![id];
        while let Some(id) = stack.pop() {
            if let Some(text) = self.nodes.get(&id).and_then(|v| v.text.as_deref()) {
                texts.push(text.trim());
            }
            if let Some(children) = self.children.get(&id) {
                stack.extend(children.iter().rev());
            }
        }
        texts.join(" ")
    }

    /// `id`, or its nearest ancestor, that `test` accepts.
    /// The scroll views around `id` (not it) up to the modal it is in,
    /// innermost first, with whether each scrolls horizontally.
    #[cfg(feature = "agent")]
    pub(crate) fn scroll_ancestors(&self, id: NodeId) -> Vec<(NodeId, bool)> {
        let mut out = Vec::new();
        let mut at = self.nodes.get(&id).and_then(|v| v.parent);
        while let Some(id) = at {
            let Some(view) = self.nodes.get(&id) else {
                break;
            };
            if let Some(scroll) = &view.scroll {
                out.push((id, scroll.horizontal));
            }
            // A modal shows over the window wherever it is in the tree:
            // the scroll views around it there do not move it.
            if view.kind == Some(ViewKind::Modal) {
                break;
            }
            at = view.parent;
        }
        out
    }

    /// The views inside scroll view `id` that take a finger's drag
    /// themselves: they hear touches (a responder, JS's or a component's,
    /// which may keep them from the scroll view) or pan natively. A finger
    /// that lands on one to scroll may move it instead, or the scroll view
    /// only until the app's answer comes, so a step's scrolling lands
    /// elsewhere. What one holds lands on it, and is not listed.
    #[cfg(feature = "agent")]
    pub(crate) fn drag_takers(&self, id: NodeId) -> Vec<NodeId> {
        let attached: HashSet<NodeId> = self.attached().into_iter().collect();
        let mut out = Vec::new();
        let mut stack: Vec<NodeId> = self.children.get(&id).cloned().unwrap_or_default();
        while let Some(id) = stack.pop() {
            let Some(view) = self.nodes.get(&id) else {
                continue;
            };
            let receives = view.pointer_events;
            if !attached.contains(&id)
                || view.canvas_node
                || view.hidden
                || receives == PointerEvents::None
            {
                continue;
            }
            let takes = view.events.contains(EventKind::Touch)
                || view.events.contains(EventKind::PanStart)
                || view.events.contains(EventKind::PanEnd)
                || view.gestures.pan_x.is_some()
                || view.gestures.pan_y.is_some();
            if takes && receives != PointerEvents::BoxNone {
                out.push(id);
                continue;
            }
            if receives != PointerEvents::BoxOnly
                && let Some(children) = self.children.get(&id)
            {
                stack.extend(children.iter().copied());
            }
        }
        out
    }

    fn up_to(&self, mut id: NodeId, test: impl Fn(&View) -> bool) -> Option<NodeId> {
        loop {
            let view = self.nodes.get(&id)?;
            if test(view) {
                return Some(id);
            }
            id = view.parent?;
        }
    }

    /// `id`, or the first view in it, in tree order, that `test` accepts.
    fn down_to(&self, id: NodeId, test: impl Fn(&View) -> bool) -> Option<NodeId> {
        let mut stack = vec![id];
        while let Some(id) = stack.pop() {
            if self.nodes.get(&id).is_some_and(&test) {
                return Some(id);
            }
            if let Some(children) = self.children.get(&id) {
                stack.extend(children.iter().rev());
            }
        }
        None
    }

    /// The views around `id` (it included, the root too) that listen to
    /// touches, innermost first: the path a platform reports a finger with.
    pub(crate) fn touch_path(&self, mut id: NodeId) -> Vec<NodeId> {
        let mut path = Vec::new();
        loop {
            if self.hears(id, EventKind::Touch) {
                path.push(id);
            }
            match self.nodes.get(&id).and_then(|v| v.parent) {
                Some(parent) => id = parent,
                None => return path,
            }
        }
    }

    /// `id` and the views around it, innermost first: what a finger on it
    /// lands on.
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn chain(&self, id: NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        let mut at = Some(id);
        while let Some(id) = at {
            let Some(view) = self.nodes.get(&id) else {
                break;
            };
            out.push(id);
            at = view.parent;
        }
        out
    }

    /// What pointer input knows of view `id` ([`nsh_core::input::Link`]).
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn link(&self, id: NodeId) -> Option<nsh_core::input::Link> {
        let view = self.nodes.get(&id)?;
        Some(nsh_core::input::Link::new(
            id,
            view.events,
            view.tracked,
            view.gestures,
            view.scroll.as_ref().map(|s| s.horizontal),
            view.pan_activation,
        ))
    }

    /// The press a finger on the views of `chain` starts: the innermost
    /// enabled one hearing presses, with its events and `delayLongPress`.
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn press_in_chain(
        &self,
        chain: &[NodeId],
    ) -> Option<(NodeId, EventMask, Option<f32>)> {
        chain.iter().find_map(|&id| {
            let view = self.nodes.get(&id)?;
            (nsh_core::input::has_press(view.events) && !view.disabled).then_some((
                id,
                view.events,
                view.long_press_delay,
            ))
        })
    }

    /// View `id`'s bounds in the root's points: its frame moved by those
    /// of the views around it and the offsets of the scroll views around
    /// it (transforms aside).
    pub(crate) fn bounds_in_root(&self, id: NodeId) -> Option<Bounds<Points>> {
        if let Some((text, ..)) = self.span(id) {
            return self.bounds_in_root(text);
        }
        let view = self.nodes.get(&id)?;
        let mut origin = view.frame.origin;
        // A modal (a window of the app's own too) is placed over its
        // window, wherever it is in the tree: what it holds is where it
        // is in it, in that window's points.
        let mut at = (view.kind != Some(ViewKind::Modal))
            .then_some(view.parent)
            .flatten();
        while let Some(parent) = at {
            let Some(p) = self.nodes.get(&parent) else {
                break;
            };
            origin += p.frame.origin;
            if let Some(scroll) = &p.scroll {
                origin -= nsh_core::Point::new(scroll.x, scroll.y);
            }
            if p.kind == Some(ViewKind::Modal) {
                break;
            }
            at = p.parent;
        }
        Some(Bounds::new(origin, view.frame.size))
    }

    /// View `id`'s bounds in the root's points, clipped to the boxes of
    /// the views around it that clip (a scroll view's viewport, `overflow:
    /// hidden`): where a finger can land on it. `None` when nothing of it
    /// is visible (a view scrolled out of view).
    pub(crate) fn visible_bounds_in_root(&self, id: NodeId) -> Option<Bounds<Points>> {
        let mut visible = self.bounds_in_root(id)?;
        let mut at = self.nodes.get(&id).and_then(|v| v.parent);
        while let Some(parent) = at {
            let Some(p) = self.nodes.get(&parent) else {
                break;
            };
            if (p.scroll.is_some() || (p.clips && parent != ROOT))
                && let Some(box_) = self.bounds_in_root(parent)
            {
                visible = visible.intersect(&box_);
            }
            // A modal is its own placement ([`Screen::bounds_in_root`]):
            // what is above it holds where it is in the tree, not where it
            // shows.
            if p.kind == Some(ViewKind::Modal) {
                break;
            }
            at = p.parent;
        }
        (!visible.is_empty()).then_some(visible)
    }

    /// The views of `chain` (innermost first) that hovering matters to:
    /// their `hover:` styles or hover events (`input::hoverable`).
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn hoverable(&self, chain: &[NodeId]) -> Vec<NodeId> {
        chain
            .iter()
            .copied()
            .filter(|id| {
                self.nodes
                    .get(id)
                    .is_some_and(|v| nsh_core::input::hoverable(v.tracked, v.events))
            })
            .collect()
    }

    /// The views under the mouse are now `views`: the ones it was over.
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn set_hovered(&mut self, views: Vec<NodeId>) -> Vec<NodeId> {
        std::mem::replace(&mut self.hovered, views)
    }

    /// View `id`'s interaction states with `bit` set (or cleared), when it
    /// tracks it and they change.
    pub(crate) fn set_state(&mut self, id: NodeId, bit: u16, on: bool) -> Option<u16> {
        let view = self.nodes.get_mut(&id)?;
        let next = nsh_core::input::next_states(view.tracked, view.states, bit, on)?;
        view.states = next;
        Some(next)
    }

    /// The context menu the app shows (`Menu.popup`), if one is open.
    pub(crate) fn menu(&self) -> Option<&[nsh_core::desktop::MenuItem]> {
        self.menu.as_deref()
    }

    /// The application menu the app set, if it set one.
    pub(crate) fn app_menu(&self) -> Option<&[nsh_core::desktop::MenuItem]> {
        self.app_menu.as_deref()
    }

    /// The open context menu was chosen from or closed.
    pub(crate) fn menu_closed(&mut self) {
        self.menu = None;
    }

    /// The edit menu an input opened over a selection it draws: the input
    /// and what the menu offers, if one is open.
    pub(crate) fn edit_menu(&self) -> Option<(NodeId, &[nsh_core::EditAction])> {
        self.edit_menu
            .as_ref()
            .map(|(id, actions)| (*id, actions.as_slice()))
    }

    /// The open edit menu was chosen from or closed.
    pub(crate) fn edit_menu_closed(&mut self) {
        self.edit_menu = None;
    }

    /// The view a right click on `id` asks for a context menu: it, or the
    /// nearest around it listening to `onContextMenu`.
    pub(crate) fn context_menu_target(&self, id: NodeId) -> Option<NodeId> {
        self.up_to(id, |v| v.events.contains(EventKind::ContextMenu))
    }

    /// The views that hear a mouse button released on `id`: it and every
    /// view around it listening to `onMouseUp`, inside out, as the
    /// platforms walk them.
    pub(crate) fn mouse_up_targets(&self, mut id: NodeId) -> Vec<NodeId> {
        let mut targets = Vec::new();
        while let Some(view) = self.nodes.get(&id) {
            if view.events.contains(EventKind::MouseUp) {
                targets.push(id);
            }
            let Some(parent) = view.parent else {
                break;
            };
            id = parent;
        }
        targets
    }

    /// The app's keyboard shortcuts (`nsh/keymap`).
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn keymap(&self) -> Option<&nsh_core::keymap::Keymap> {
        self.keymap.as_deref()
    }

    /// Whether a JS responder keeps native drags from starting.
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn js_block(&self) -> bool {
        self.js_block
    }

    /// A drag starts: the JS responder blocks nothing yet, as a platform's
    /// first finger down resets it.
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn reset_js_block(&mut self) {
        self.js_block = false;
        self.js_grants.clear();
    }

    /// The JS responder's grants since the last look (`block` each).
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn take_js_grants(&mut self) -> Vec<bool> {
        std::mem::take(&mut self.js_grants)
    }

    /// Whether view `id` reports `event`.
    pub(crate) fn hears(&self, id: NodeId, event: EventKind) -> bool {
        self.nodes
            .get(&id)
            .is_some_and(|v| v.events.contains(event))
    }

    pub(crate) fn input(&self, id: NodeId) -> Option<&Input> {
        self.nodes.get(&id)?.input.as_ref()
    }

    /// Input `id`'s caret at the end of its text, in the view, as
    /// [`nsh_core::ApproxTextEngine`] lays the text out: characters `0.55 ×`
    /// the font size wide, lines `1.2 ×` it tall, wrapped at the content
    /// box's width when multiline; a single line is centered in the box and
    /// keeps the caret inside it.
    pub(crate) fn input_caret(&self, id: NodeId) -> Option<Bounds<Points>> {
        let view = self.nodes.get(&id)?;
        let input = view.input.as_ref()?;
        let content = input
            .content
            .unwrap_or_else(|| Bounds::new(Point::default(), view.frame.size));
        let font = input.config.style.font_size.0;
        let (advance, line) = (font * 0.55, font * 1.2);
        let (column, row) = if input.config.multiline {
            let per_line = ((content.size.width.0 / advance).floor() as usize).max(1);
            let mut row = 0;
            let mut column = 0;
            for (i, part) in input.text.split('\n').enumerate() {
                let chars = part.chars().count();
                if i > 0 {
                    row += 1;
                }
                row += chars / per_line;
                column = chars % per_line;
            }
            (column, row)
        } else {
            (input.text.chars().count(), 0)
        };
        let mut x = content.origin.x.0 + column as f32 * advance;
        let y = if input.config.multiline {
            content.origin.y.0 + row as f32 * line
        } else {
            x = x.min(content.origin.x.0 + (content.size.width.0 - 1.0).max(0.0));
            content.origin.y.0 + (content.size.height.0 - line) / 2.0
        };
        Some(Bounds::new(
            nsh_core::geometry::point(Points(x), Points(y)),
            nsh_core::geometry::size(Points(1.0), Points(line)),
        ))
    }

    pub(crate) fn input_mut(&mut self, id: NodeId) -> Option<&mut Input> {
        self.nodes.get_mut(&id)?.input.as_mut()
    }

    /// The input that has the focus.
    pub(crate) fn focused(&self) -> Option<NodeId> {
        self.focused
    }

    pub(crate) fn set_focused(&mut self, id: Option<NodeId>) {
        self.focused = id;
    }

    /// The view (not an input) with the keyboard focus, while it is
    /// mounted: a pressable or a `focusable` view Tab moved it to.
    pub(crate) fn key_focus(&self) -> Option<NodeId> {
        self.key_focus.filter(|id| self.nodes.contains_key(id))
    }

    pub(crate) fn set_key_focus(&mut self, id: Option<NodeId>) {
        self.key_focus = id;
    }

    /// Tab's stops, in tree order (a scroll view's content in screen
    /// order), a shown overlay's content right after the view it follows
    /// where the app put it ([`nsh_core::input::tab_order`]: a popover's
    /// after its trigger): the
    /// inputs that edit and the views [`nsh_core::ViewProps::focus_stop`]
    /// takes (those that take presses unless `focusable={false}`, and
    /// `focusable={true}` ones whether or not they do), shown and enabled.
    pub(crate) fn tab_stops(&self) -> Vec<NodeId> {
        let shown: HashSet<NodeId> = self.shown().into_iter().collect();
        nsh_core::input::tab_order(
            ROOT,
            |&id| self.reading_children(id),
            |&id| id,
            |&id| self.nodes.get(&id).and_then(|v| v.tab_after),
        )
        .into_iter()
        .filter(|&id| {
            if !shown.contains(&id) {
                return false;
            }
            let Some(v) = self.nodes.get(&id) else {
                return false;
            };
            if let Some(input) = &v.input {
                return input.config.editable && !self.disabled_from(id, None);
            }
            // A link in a text view is a stop after it, in text order
            // (`TextLink::focus_stop`).
            if v.span.is_some() {
                return v.focusable == Some(true) && !self.disabled_from(id, None);
            }
            // Disabled is the ancestors' too here (`disabled_from`).
            let props = nsh_core::ViewProps {
                focusable: v.focusable,
                ..Default::default()
            };
            props.focus_stop(v.events.contains(EventKind::Press)) && !self.disabled_from(id, None)
        })
        .collect()
    }

    /// The newest modal shown over `window` (the root of a window of the
    /// app's own, else the main window's): the desktops and the web keep
    /// Tab inside it, its views the only stops while it is shown.
    pub(crate) fn focus_scope(&self, window: NodeId) -> Option<NodeId> {
        self.shown().into_iter().rev().find(|&id| {
            self.kind(id) == Some(ViewKind::Modal)
                && !self.is_window(id)
                && self.window_of(id) == window
        })
    }

    /// Whether view `id` is `scope` or inside it.
    pub(crate) fn within(&self, id: NodeId, scope: NodeId) -> bool {
        id == scope || self.is_inside(id, scope)
    }

    /// The stop a press on `id` gives the focus to in a terminal: `id` or
    /// its nearest ancestor that Tab stops at (`tab_stops`), else the
    /// topmost stop over the press's point (a table's hit layer over its
    /// rows), as a terminal finds what is under the pointer.
    pub(crate) fn stop_around(&self, id: NodeId) -> Option<NodeId> {
        let stops = self.tab_stops();
        let mut at = Some(id);
        while let Some(id) = at {
            if stops.contains(&id) {
                return Some(id);
            }
            at = self.nodes.get(&id).and_then(|v| v.parent);
        }
        let point = self.bounds_in_root(id)?.center();
        // Topmost by how they are stacked, not by Tab's order (an
        // overlay's content is not last there).
        self.shown().into_iter().rev().find(|stop| {
            stops.contains(stop)
                && self
                    .bounds_in_root(*stop)
                    .is_some_and(|bounds| bounds.contains(&point))
        })
    }

    pub(crate) fn scroll(&self, id: NodeId) -> Option<&Scroll> {
        self.nodes.get(&id)?.scroll.as_ref()
    }

    pub(crate) fn scroll_mut(&mut self, id: NodeId) -> Option<&mut Scroll> {
        self.nodes.get_mut(&id)?.scroll.as_mut()
    }

    /// The scroll views around `id`, innermost first.
    pub(crate) fn scrolls_around(&self, id: NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        let mut at = self.nodes.get(&id).and_then(|v| v.parent);
        while let Some(parent) = at {
            let Some(view) = self.nodes.get(&parent) else {
                break;
            };
            if view.scroll.is_some() {
                out.push(parent);
            }
            at = view.parent;
        }
        out
    }

    /// How far scroll view `id` goes along its axis: its content past its
    /// frame (unbounded while the content's size is not known).
    pub(crate) fn scroll_end(&self, id: NodeId) -> Points {
        let Some(view) = self.nodes.get(&id) else {
            return Points::ZERO;
        };
        let Some(scroll) = &view.scroll else {
            return Points::ZERO;
        };
        match scroll.content {
            Some(content) if scroll.horizontal => {
                (content.width - view.frame.size.width).max(Points::ZERO)
            }
            Some(content) => (content.height - view.frame.size.height).max(Points::ZERO),
            None => Points(f32::INFINITY),
        }
    }

    /// Scroll view `id`'s content or viewport changed: an offset past the
    /// new end comes back to it and is reported, as the platforms' scroll
    /// views do (UIKit adjusts the offset as the content size changes, the
    /// desktops clamp what they report), so the rows that remain show. A
    /// pull past the start is the finger's and stays.
    fn pull_back(&mut self, id: NodeId) {
        let end = self.scroll_end(id);
        let Some(scroll) = self.scroll_mut(id) else {
            return;
        };
        let at = if scroll.horizontal {
            &mut scroll.x
        } else {
            &mut scroll.y
        };
        if *at > end {
            *at = end;
            self.scrolled.push(id);
        }
    }

    /// The scroll views a command moved since the last call.
    pub(crate) fn take_scrolled(&mut self) -> Vec<NodeId> {
        std::mem::take(&mut self.scrolled)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A canvas over a pressable pad, both inside a plain container.
    fn canvas_screen() -> Screen {
        let mut screen = Screen::default();
        screen.apply(&batch(vec![
            create(2, ViewKind::View),
            create(4, ViewKind::Canvas),
            create(6, ViewKind::View),
            frame(2, 0.0, 0.0, 200.0, 40.0),
            frame(4, 0.0, 0.0, 200.0, 40.0),
            frame(6, 0.0, 0.0, 200.0, 40.0),
            insert(1, 2),
            insert(2, 6),
            insert(2, 4),
        ]));
        screen.nodes.get_mut(&4).unwrap().pointer_events = PointerEvents::None;
        screen
            .nodes
            .get_mut(&6)
            .unwrap()
            .events
            .set(EventKind::Press, true);
        screen.canvas(
            4,
            &[nsh_core::canvas::CanvasNode::new(
                Bounds::new(Point::default(), Size::new(Points(100.0), Points(40.0))),
                AccessibilityRole::Text,
                "cell",
            )
            .test_id("cell")],
        );
        screen
    }

    #[test]
    fn canvas_presses_skip_hidden_subtrees() {
        let mut screen = canvas_screen();
        screen.apply(&batch(vec![
            create(8, ViewKind::View),
            create(10, ViewKind::View),
            frame(8, 0.0, 0.0, 200.0, 40.0),
            frame(10, 0.0, 0.0, 200.0, 40.0),
            insert(2, 8),
            insert(8, 10),
            style(8, |s| s.hidden = true),
        ]));
        screen
            .nodes
            .get_mut(&10)
            .unwrap()
            .events
            .set(EventKind::Press, true);
        assert_eq!(
            screen.pressable(&Selector::parse("id:cell").unwrap()),
            Pick::One(6)
        );
    }

    #[test]
    fn canvas_presses_reach_visible_overflow_but_respect_clipping() {
        let mut screen = canvas_screen();
        screen.apply(&batch(vec![
            frame(2, 0.0, 0.0, 100.0, 40.0),
            frame(4, 100.0, 0.0, 100.0, 40.0),
            frame(6, 100.0, 0.0, 100.0, 40.0),
        ]));
        let selector = Selector::parse("id:cell").unwrap();
        assert_eq!(screen.count("id:cell"), Ok(1));
        assert_eq!(screen.pressable(&selector), Pick::One(6));
        screen.nodes.get_mut(&2).unwrap().clips = true;
        assert_eq!(screen.pressable(&selector), Pick::None);
        screen.nodes.get_mut(&2).unwrap().clips = false;
        screen.nodes.get_mut(&2).unwrap().pointer_events = PointerEvents::BoxOnly;
        assert_eq!(screen.pressable(&selector), Pick::None);
    }

    #[test]
    #[cfg(feature = "agent")]
    fn a_scroll_views_drag_takers_are_the_views_that_take_touches_or_pan() {
        let mut screen = Screen::default();
        let mut items = vec![create(2, ViewKind::Scroll), insert(1, 2)];
        for id in [4, 6, 8, 10, 12, 14, 16] {
            items.extend([create(id, ViewKind::View), insert(2, id)]);
        }
        // Inside the responder at 4, and inside the view at 12 that keeps
        // touches from what it holds.
        items.extend([
            create(18, ViewKind::View),
            insert(4, 18),
            create(20, ViewKind::View),
            insert(12, 20),
        ]);
        screen.apply(&batch(items));
        let events = |screen: &mut Screen, id: NodeId, kind: EventKind| {
            screen.nodes.get_mut(&id).unwrap().events.set(kind, true);
        };
        // A responder, a native pan, a button, a responder no touch
        // reaches, a responder only what it holds hears, and a drag that
        // moves a value.
        for (id, kind) in [
            (4, EventKind::Touch),
            (6, EventKind::PanStart),
            (8, EventKind::Press),
            (10, EventKind::Touch),
            (14, EventKind::Touch),
            (18, EventKind::Touch),
            (20, EventKind::Touch),
        ] {
            events(&mut screen, id, kind);
        }
        screen.nodes.get_mut(&10).unwrap().pointer_events = PointerEvents::None;
        screen.nodes.get_mut(&12).unwrap().pointer_events = PointerEvents::BoxOnly;
        screen.nodes.get_mut(&14).unwrap().pointer_events = PointerEvents::BoxNone;
        screen.nodes.get_mut(&16).unwrap().gestures.pan_y = Some(1);
        let mut takers = screen.drag_takers(2);
        takers.sort_unstable();
        assert_eq!(takers, [4, 6, 16]);
    }

    fn batch(items: Vec<MountItem>) -> MountBatch {
        MountBatch { items }
    }

    fn create(id: NodeId, kind: ViewKind) -> MountItem {
        MountItem::Create { id, kind }
    }

    fn insert(parent: NodeId, child: NodeId) -> MountItem {
        MountItem::Insert {
            parent,
            child,
            before: None,
        }
    }

    fn frame(id: NodeId, x: f32, y: f32, width: f32, height: f32) -> MountItem {
        MountItem::Frame {
            id,
            frame: Bounds::new(
                Point::new(Points(x), Points(y)),
                Size::new(Points(width), Points(height)),
            ),
        }
    }

    fn style(id: NodeId, change: impl FnOnce(&mut nsh_core::ViewStyle)) -> MountItem {
        let mut style = nsh_core::ViewStyle::default();
        change(&mut style);
        MountItem::ViewStyle {
            id,
            style: Box::new(style),
        }
    }

    fn text(id: NodeId, value: &str) -> MountItem {
        MountItem::Text {
            id,
            text: Arc::new(nsh_core::AttributedText {
                text: value.into(),
                ..Default::default()
            }),
            layout: nsh_core::TextLayout(Arc::new(())),
            content: Bounds::default(),
        }
    }

    #[test]
    fn an_input_caret_follows_its_text_as_the_approximate_engine_lays_it_out() {
        let mut screen = Screen::default();
        let mut config = nsh_core::InputConfig::default();
        config.style.font_size = Points(10.0);
        config.multiline = true;
        screen.apply(&batch(vec![
            create(2, ViewKind::Input),
            frame(2, 0.0, 0.0, 60.0, 100.0),
            MountItem::Input {
                id: 2,
                config: Box::new(config),
            },
            MountItem::InputContent {
                id: 2,
                content: Bounds::new(
                    Point::new(Points(4.0), Points(6.0)),
                    Size::new(Points(55.0), Points(88.0)),
                ),
            },
            insert(1, 2),
        ]));
        let caret = |screen: &Screen| {
            let b = screen.input_caret(2).unwrap();
            (b.origin.x.0, b.origin.y.0, b.size.height.0)
        };
        assert_eq!(caret(&screen), (4.0, 6.0, 12.0));
        // Ten characters fit a line of 55 points (5.5 each): the twelfth is
        // the second of the next line.
        screen.input_mut(2).unwrap().text = "abcdefghijkl".into();
        assert_eq!(caret(&screen), (4.0 + 2.0 * 5.5, 18.0, 12.0));
        // A line break starts a line.
        screen.input_mut(2).unwrap().text = "ab\nc".into();
        assert_eq!(caret(&screen), (4.0 + 5.5, 18.0, 12.0));
    }

    #[test]
    fn an_offset_past_the_content_comes_back_to_its_end_and_is_reported() {
        let mut screen = Screen::default();
        let content = |height: f32| MountItem::ScrollContent {
            id: 2,
            size: Size::new(Points(390.0), Points(height)),
        };
        let by = |dy: f32| MountItem::ScrollBy {
            id: 2,
            dx: Points::ZERO,
            dy: Points(dy),
        };
        screen.apply(&batch(vec![
            create(2, ViewKind::Scroll),
            frame(2, 0.0, 0.0, 390.0, 800.0),
            content(56.0),
            insert(1, 2),
        ]));
        // Rows arrive above the one row: the core keeps it in place with a
        // scroll it sends before the new content size, and the view goes
        // as far as that size lets it.
        screen.apply(&batch(vec![by(1176.0), content(1232.0)]));
        assert_eq!(screen.scroll(2).unwrap().y, Points(432.0));
        assert_eq!(screen.take_scrolled(), [2]);
        // The content shrinks to a row again: the offset follows, so the
        // row shows.
        screen.apply(&batch(vec![content(56.0)]));
        assert_eq!(screen.scroll(2).unwrap().y, Points::ZERO);
        assert_eq!(screen.take_scrolled(), [2]);
        // So does a viewport growing past the content's end.
        screen.apply(&batch(vec![by(432.0), content(1232.0)]));
        assert!(screen.take_scrolled().is_empty());
        screen.apply(&batch(vec![frame(2, 0.0, 0.0, 390.0, 1000.0)]));
        assert_eq!(screen.scroll(2).unwrap().y, Points(232.0));
        assert_eq!(screen.take_scrolled(), [2]);
        // A pull past the start is the finger's: content changes leave it.
        screen.scroll_mut(2).unwrap().y = Points(-40.0);
        screen.apply(&batch(vec![content(2000.0)]));
        assert_eq!(screen.scroll(2).unwrap().y, Points(-40.0));
        assert!(screen.take_scrolled().is_empty());
    }

    #[test]
    fn layout_nodes_leave_out_what_is_in_a_view_never_created() {
        let mut screen = Screen::default();
        // 2 is inserted without being created: what it holds is not on
        // screen either, and no node names it as its parent.
        screen.apply(&batch(vec![
            create(4, ViewKind::View),
            create(6, ViewKind::View),
            frame(4, 0.0, 0.0, 100.0, 20.0),
            frame(6, 0.0, 0.0, 100.0, 20.0),
            insert(1, 2),
            insert(2, 4),
            insert(1, 6),
        ]));
        let nodes = screen.layout_nodes();
        let ids: Vec<NodeId> = nodes.iter().map(|n| n.id).collect();
        assert_eq!(ids, [6]);
        assert!(
            nodes
                .iter()
                .all(|n| n.parent == ROOT || ids.contains(&n.parent))
        );
    }

    #[test]
    fn layout_nodes_of_a_hidden_main_window_hold_its_app_windows_in_the_root() {
        let mut screen = Screen::default();
        // 2 is a view of the main window, 4 in it the root of a window of
        // the app's own, and 6 in that window.
        screen.apply(&batch(vec![
            create(2, ViewKind::View),
            create(4, ViewKind::Modal),
            create(6, ViewKind::View),
            frame(2, 0.0, 0.0, 100.0, 100.0),
            frame(4, 0.0, 0.0, 100.0, 20.0),
            frame(6, 0.0, 0.0, 100.0, 20.0),
            insert(1, 2),
            insert(2, 4),
            insert(4, 6),
        ]));
        screen.windows.push((4, "tools".into()));
        screen.set_window_hidden(ROOT, true);
        let nodes = screen.layout_nodes();
        let parents: Vec<_> = nodes.iter().map(|n| (n.id, n.parent)).collect();
        assert_eq!(parents, [(4, ROOT), (6, 4)]);
        screen.set_window_hidden(ROOT, false);
        let nodes = screen.layout_nodes();
        let parents: Vec<_> = nodes.iter().map(|n| (n.id, n.parent)).collect();
        assert_eq!(parents, [(2, ROOT), (4, 2), (6, 4)]);
    }

    #[test]
    fn layout_nodes_hold_only_the_top_screen_of_a_stack() {
        let mut screen = Screen::default();
        screen.apply(&batch(vec![
            create(2, ViewKind::Stack),
            create(4, ViewKind::Screen),
            create(6, ViewKind::Text),
            create(8, ViewKind::Screen),
            create(10, ViewKind::Text),
            frame(2, 0.0, 0.0, 100.0, 200.0),
            frame(4, 0.0, 0.0, 100.0, 200.0),
            frame(8, 0.0, 0.0, 100.0, 200.0),
            frame(6, 0.0, 0.0, 100.0, 20.0),
            frame(10, 0.0, 0.0, 100.0, 20.0),
            insert(1, 2),
            insert(2, 4),
            insert(4, 6),
            insert(2, 8),
            insert(8, 10),
        ]));
        let ids = |screen: &Screen| -> Vec<NodeId> {
            screen.layout_nodes().iter().map(|n| n.id).collect()
        };
        assert_eq!(ids(&screen), [2, 8, 10]);
        // Popped: the screen under it is the one laid out.
        screen.apply(&batch(vec![MountItem::Remove { id: 8 }]));
        assert_eq!(ids(&screen), [2, 4, 6]);
    }

    #[test]
    fn a_removed_subtree_leaves_the_hover_and_the_focus_without_a_word() {
        use nsh_core::tailwind::state::{FOCUSED, HOVERED};
        let mut screen = Screen::default();
        screen.apply(&batch(vec![
            create(2, ViewKind::View),
            create(4, ViewKind::View),
            create(6, ViewKind::Input),
            create(8, ViewKind::View),
            MountItem::TrackStates {
                id: 4,
                states: HOVERED,
            },
            insert(1, 2),
            insert(2, 4),
            insert(4, 6),
            insert(4, 8),
        ]));
        screen.set_hovered(vec![4, 2]);
        screen.set_state(4, HOVERED, true);
        screen.set_focused(Some(6));
        screen.set_key_focus(Some(8));
        screen.set_state(8, FOCUSED, true);
        // Removed, kept alive (a JS cycle holds it): it and what it holds
        // leave the hover and the focus, their states cleared.
        screen.apply(&batch(vec![MountItem::Remove { id: 4 }]));
        assert_eq!(screen.set_hovered(vec![2]), [2]);
        assert_eq!(screen.focused(), None);
        assert_eq!(screen.key_focus(), None);
        assert_eq!(screen.take_restated(), [(4, 0), (8, 0)]);
        assert!(!screen.in_tree(6));
        assert!(screen.in_tree(2));
        // Deleted: nothing left to report on.
        screen.apply(&batch(vec![MountItem::Delete { id: 2 }]));
        assert_eq!(screen.set_hovered(Vec::new()), Vec::<NodeId>::new());
        assert_eq!(screen.take_restated(), []);
    }

    #[test]
    fn only_the_top_screen_of_a_stack_and_the_top_modal_first_are_seen() {
        let mut screen = Screen::default();
        screen.apply(&batch(vec![
            create(2, ViewKind::Stack),
            create(4, ViewKind::Screen),
            create(6, ViewKind::Text),
            create(8, ViewKind::Screen),
            create(10, ViewKind::Text),
            create(12, ViewKind::Modal),
            create(14, ViewKind::Text),
            text(6, "Home"),
            text(10, "Details"),
            text(14, "Close"),
            frame(6, 0.0, 0.0, 100.0, 20.0),
            frame(10, 0.0, 0.0, 100.0, 20.0),
            frame(14, 0.0, 0.0, 100.0, 20.0),
            insert(1, 2),
            insert(2, 4),
            insert(4, 6),
            insert(2, 8),
            insert(8, 10),
        ]));
        assert_eq!(screen.texts(), ["Details"]);
        screen.apply(&batch(vec![
            text(10, "Close"),
            insert(1, 12),
            insert(12, 14),
        ]));
        assert_eq!(screen.texts(), ["Close", "Close"]);
        // The modal's text comes first, though the stack is before it.
        assert_eq!(
            screen.resolve(&Selector::parse("text:Close").unwrap()),
            [14, 10]
        );
        screen.apply(&batch(vec![MountItem::Remove { id: 8 }]));
        assert_eq!(screen.texts(), ["Home", "Close"]);
    }

    #[test]
    fn hidden_collapsed_and_clipped_views_are_not_on_screen() {
        let mut screen = Screen::default();
        screen.set_viewport(Size::new(Points(400.0), Points(800.0)));
        let shown = |screen: &Screen| screen.texts().join(" ");
        screen.apply(&batch(vec![
            create(2, ViewKind::View),
            create(4, ViewKind::Text),
            create(6, ViewKind::Text),
            create(8, ViewKind::Text),
            create(10, ViewKind::View),
            create(12, ViewKind::Text),
            create(14, ViewKind::Scroll),
            create(16, ViewKind::Text),
            text(4, "shown"),
            text(6, "collapsed"),
            text(8, "outside"),
            text(12, "clipped"),
            text(16, "row"),
            frame(2, 0.0, 0.0, 400.0, 800.0),
            frame(4, 0.0, 0.0, 100.0, 20.0),
            // `display: none`: no area.
            frame(6, 0.0, 0.0, 0.0, 0.0),
            frame(8, 5000.0, 0.0, 100.0, 20.0),
            frame(10, 0.0, 100.0, 400.0, 0.0),
            frame(12, 0.0, 0.0, 100.0, 20.0),
            frame(14, 0.0, 200.0, 400.0, 100.0),
            frame(16, 0.0, 1000.0, 100.0, 20.0),
            insert(1, 2),
            insert(2, 4),
            insert(2, 6),
            insert(2, 8),
            insert(2, 10),
            insert(10, 12),
            insert(2, 14),
            insert(14, 16),
            // A cell a list parked before the start of its content.
            create(18, ViewKind::Text),
            text(18, "parked"),
            frame(18, 0.0, -1.0e6, 100.0, 20.0),
            insert(14, 18),
        ]));
        // Without `overflow: hidden` a view of no height shows what it
        // holds; a row far down a scroll view scrolls into view, nothing
        // before its start does.
        assert_eq!(shown(&screen), "shown clipped row");
        screen.apply(&batch(vec![style(10, |s| s.overflow_hidden = true)]));
        assert_eq!(shown(&screen), "shown row");
        // A scroll view the user cannot scroll clips as a box does.
        let locked = nsh_core::ScrollBehavior {
            enabled: false,
            ..Default::default()
        };
        screen.apply(&batch(vec![MountItem::ScrollBehavior {
            id: 14,
            behavior: Box::new(locked),
        }]));
        assert_eq!(shown(&screen), "shown");
        assert_eq!(
            screen.scroll_view(&Selector::parse("view:14").unwrap()),
            Pick::Disabled
        );
        screen.apply(&batch(vec![style(2, |s| s.hidden = true)]));
        assert_eq!(shown(&screen), "");
    }

    #[test]
    fn visible_bounds_stop_at_the_views_around_that_clip() {
        let mut screen = Screen::default();
        screen.apply(&batch(vec![
            create(2, ViewKind::View),
            create(4, ViewKind::Scroll),
            create(6, ViewKind::View),
            create(8, ViewKind::View),
            create(10, ViewKind::View),
            create(12, ViewKind::View),
            frame(2, 0.0, 0.0, 390.0, 844.0),
            frame(4, 0.0, 0.0, 390.0, 744.0),
            frame(6, 0.0, 724.0, 120.0, 60.0),
            frame(8, 0.0, 744.0, 390.0, 100.0),
            frame(10, 0.0, 700.0, 390.0, 80.0),
            frame(12, 0.0, 60.0, 120.0, 60.0),
            insert(1, 2),
            insert(2, 4),
            insert(2, 8),
            insert(2, 10),
            insert(4, 6),
            insert(10, 12),
        ]));
        let at = |screen: &Screen, id: NodeId| {
            screen
                .visible_bounds_in_root(id)
                .map(|b| (b.origin.x.0, b.origin.y.0, b.size.width.0, b.size.height.0))
        };
        // A button across the fold: of its frame 724..784 the top 20
        // points are visible, its center lying below the fold, on the bar
        // under the scroll view.
        assert_eq!(at(&screen, 6), Some((0.0, 724.0, 120.0, 20.0)));
        // Scrolled into view, all of it is visible; scrolled past, nothing
        // of it is.
        screen.scroll_mut(4).unwrap().y = Points(60.0);
        assert_eq!(at(&screen, 6), Some((0.0, 664.0, 120.0, 60.0)));
        screen.scroll_mut(4).unwrap().y = Points(800.0);
        assert_eq!(at(&screen, 6), None);
        screen.scroll_mut(4).unwrap().y = Points(0.0);
        // `overflow: hidden` clips as a scroll view's fold does: of the
        // view at 760..820 its box leaves 760..780.
        screen.apply(&batch(vec![style(10, |s| s.overflow_hidden = true)]));
        assert_eq!(at(&screen, 12), Some((0.0, 760.0, 120.0, 20.0)));
        screen.apply(&batch(vec![style(10, |s| s.overflow_hidden = false)]));
        assert_eq!(at(&screen, 12), Some((0.0, 760.0, 120.0, 60.0)));
    }

    #[test]
    fn spans_that_take_presses_are_found_by_their_characters() {
        let mut screen = Screen::default();
        let mut events = EventMask::default();
        events.set(EventKind::Press, true);
        let link = |start, end, node| nsh_core::TextLink {
            start,
            end,
            node,
            events,
            focus_stop: true,
        };
        let linked = |links: Vec<nsh_core::TextLink>| MountItem::Text {
            id: 4,
            text: Arc::new(nsh_core::AttributedText {
                text: "Agree to the Terms 🙂 and Privacy".into(),
                links,
                ..Default::default()
            }),
            layout: nsh_core::TextLayout(Arc::new(())),
            content: Bounds::default(),
        };
        screen.apply(&batch(vec![
            create(2, ViewKind::View),
            create(4, ViewKind::Text),
            frame(2, 0.0, 0.0, 400.0, 800.0),
            frame(4, 0.0, 0.0, 300.0, 40.0),
            insert(1, 2),
            insert(2, 4),
            // "Terms 🙂" (the emoji is two UTF-16 units), and "Privacy".
            linked(vec![link(13, 21, 100), link(26, 33, 102)]),
        ]));
        let pick = |screen: &Screen, s: &str| screen.pressable(&Selector::parse(s).unwrap());
        assert_eq!(pick(&screen, "Privacy"), Pick::One(102));
        assert_eq!(pick(&screen, "text:Terms 🙂"), Pick::One(100));
        assert_eq!(screen.span(102), Some((4, 26, 33)));
        // They are not texts of their own.
        assert_eq!(screen.texts(), ["Agree to the Terms 🙂 and Privacy"]);
        screen.apply(&batch(vec![linked(Vec::new())]));
        assert_eq!(pick(&screen, "Privacy"), Pick::None);
        assert_eq!(screen.span(102), None);
    }
}

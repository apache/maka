//! A model of the native views a headless app builds, from its mount
//! batches: their tree, what they show, which events they report, what
//! inputs hold and where scroll views are. It answers the selectors of the
//! steps ([`Selector`]) as a user's eyes would: the top screen of a stack
//! and the top modal first.

// What only the headless driver uses (it does not run in WebAssembly).
#![cfg_attr(target_arch = "wasm32", allow(dead_code))]

use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
};

use nsh_core::{
    AccessibilityRole, Bounds, Command, Dialog, EventKind, EventMask, GestureValues, InputConfig,
    MountBatch, MountItem, NodeId, PanActivation, Point, PointerEvents, Points, Size, ViewKind,
    ui::PropEnum,
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

/// Why a [`Pick::Disabled`] match takes no step on `what` (the kind of
/// view the step looks for).
pub(crate) fn disabled(what: &str) -> &'static str {
    if what == "scroll view" {
        "does not scroll: the user cannot scroll it (`scrollable` is false)"
    } else {
        "is disabled"
    }
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

#[derive(Debug)]
pub(crate) enum InputResult {
    CancelTouch(u32),
    SetStates(NodeId, u8),
    RetireListCell {
        id: NodeId,
        request: u64,
        /// A focused descendant refused retirement; its path precedes the reply.
        focus_path: Option<Vec<NodeId>>,
    },
}

/// One actual finger, shared with the driver while its gesture is running.
/// Removing its owners ends this contact even if their ids mount again.
#[derive(Debug)]
pub(crate) struct Contact {
    pub(crate) id: u32,
    pub(crate) target: NodeId,
    owners: Vec<NodeId>,
    active: AtomicBool,
    reporting: AtomicBool,
    native: AtomicU32,
}

/// The window's native modal presentation slots, including parked ones.
#[derive(Debug)]
struct Presentation {
    id: NodeId,
    live: bool,
}

impl Contact {
    pub(crate) fn active(&self) -> bool {
        self.active.load(Ordering::Relaxed)
    }

    pub(crate) fn reporting(&self) -> bool {
        self.reporting.load(Ordering::Relaxed)
    }

    pub(crate) fn stop_reporting(&self) {
        self.reporting.store(false, Ordering::Relaxed);
    }

    pub(crate) fn capture_native(&self, owner: NodeId) {
        self.native.store(owner, Ordering::Relaxed);
    }

    pub(crate) fn native_owner(&self) -> Option<NodeId> {
        match self.native.load(Ordering::Relaxed) {
            0 => None,
            owner => Some(owner),
        }
    }
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
    /// Actual fingers down, until they lift or the native tree revokes them.
    contacts: Vec<Arc<Contact>>,
    /// Native input results retain their order within each consumed batch.
    input_results: Vec<InputResult>,
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
    /// Canonical native modal order: projection restores the existing slot.
    presented: Vec<Presentation>,
    /// New presentations waiting for `onShow`; this is only an event queue.
    shows: Vec<NodeId>,
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
    /// The picks asked (`Picker.pickImages`), in order, and how many were
    /// answered.
    picks: Vec<(u32, nsh_core::picker::PickRequest)>,
    picks_answered: usize,
    /// The URLs the app had the system open (`openUrl`), in order.
    opened_urls: Vec<String>,
    /// The `openUrl` requests to answer.
    url_opens: Vec<u32>,
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
    /// The context menu the app showed (`Menu.popup`), until it is chosen
    /// from or closed.
    menu: Option<Arc<[nsh_core::desktop::MenuItem]>>,
    /// The window's size, when the driver knows it: what lies outside it
    /// (and no scroll view brings in) is not on screen.
    viewport: Option<Size<Points>>,
    /// The nodes each canvas's drawing has, as views of the model.
    canvas_nodes: HashMap<NodeId, Vec<NodeId>>,
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
    /// `focusable`: `Some(false)` keeps a pressable out of Tab's stops.
    focusable: Option<bool>,
    /// It is selected (`selected`, its accessibility state; a canvas node's
    /// `selected`).
    selected: bool,
    /// How long a press must last to be a long one (`delayLongPress`), in
    /// milliseconds.
    long_press_delay: Option<f32>,
    /// A selection area (`SelectionArea` of `nsh/base`): its texts share
    /// one selection.
    selection_area: bool,
    /// The interaction states it tracks (`TrackStates`: pressed, hovered).
    tracked: u8,
    /// The interaction states it is in (of those it tracks).
    states: u8,
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
    /// Which touches it and its subtree receive (`pointerEvents`).
    pointer_events: PointerEvents,
    /// A node of a canvas's drawing, not a view of its own.
    canvas_node: bool,
}

/// A span of a text view's text that takes presses ([`nsh_core::TextLink`]).
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
}

impl Screen {
    /// Applies `batch`.
    pub fn apply(&mut self, batch: &MountBatch) {
        for item in &batch.items {
            self.apply_item(item);
        }
    }

    /// A real host owns retirement decisions; only the core's confirmation
    /// updates this mirror after the native reply reaches the core.
    #[cfg(feature = "agent")]
    pub(crate) fn observe(&mut self, batch: &MountBatch) {
        for item in &batch.items {
            match item {
                MountItem::RetireListCell { .. } => {}
                MountItem::ListCellRetired { roots } => {
                    for root in roots {
                        self.park_presentations(*root);
                        self.detach(*root);
                        self.popped.remove(root);
                        self.closed.remove(root);
                    }
                }
                _ => self.apply_item(item),
            }
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
            } => self.insert(*parent, *child, *before),
            MountItem::ProjectRoot {
                parent,
                id,
                following,
            } => {
                // Logical siblings do not describe the window's modal stack.
                let before = if self.kind(*id) == Some(ViewKind::Modal) {
                    None
                } else {
                    // These roots have platform-owned presentation slots,
                    // rather than their parent's ordinary content host.
                    let slot = |node| {
                        self.kind(node).filter(|kind| {
                            matches!(
                                kind,
                                ViewKind::Modal
                                    | ViewKind::Screen
                                    | ViewKind::HeaderItem
                                    | ViewKind::InputAccessory
                            )
                        })
                    };
                    let host = slot(*id);
                    following.iter().copied().find(|next| {
                        next != id
                            && slot(*next) == host
                            && self
                                .nodes
                                .get(next)
                                .is_some_and(|view| view.parent == Some(*parent))
                            && self
                                .children
                                .get(parent)
                                .is_some_and(|siblings| siblings.contains(next))
                    })
                };
                self.insert(*parent, *id, before);
            }
            MountItem::RetireListCell { id, request, roots } => {
                let actual = self.focus_path();
                let focus_path = roots
                    .iter()
                    .any(|root| actual.contains(root))
                    .then_some(actual);
                if focus_path.is_none() {
                    for root in roots {
                        self.revoke_contacts(*root);
                        self.revoke_hovered(*root);
                        self.park_presentations(*root);
                        self.detach(*root);
                        self.popped.remove(root);
                        self.closed.remove(root);
                    }
                }
                self.input_results.push(InputResult::RetireListCell {
                    id: *id,
                    request: *request,
                    focus_path,
                });
            }
            // The real host already detached these roots before replying.
            MountItem::ListCellRetired { .. } => {}
            MountItem::Remove { id } => {
                self.revoke_contacts(*id);
                self.revoke_hovered(*id);
                self.revoke_focus(*id);
                self.remove_presentations(*id);
                self.detach(*id);
                self.popped.remove(id);
                self.closed.remove(id);
            }
            MountItem::Delete { id } => {
                self.revoke_contacts(*id);
                self.revoke_hovered(*id);
                self.revoke_focus(*id);
                self.remove_presentations(*id);
                self.drop_spans(*id);
                self.canvas(*id, &[]);
                self.detach(*id);
                self.nodes.remove(id);
                self.children.remove(id);
                self.popped.remove(id);
                self.closed.remove(id);
            }
            MountItem::ScreenConfig { id, config } => {
                self.nodes.entry(*id).or_default().prevent_back = config.prevent_back;
            }
            MountItem::ModalConfig { id, config } => {
                self.nodes.entry(*id).or_default().close_on_escape = config.close_on_escape;
            }
            MountItem::Frame { id, frame } => self.nodes.entry(*id).or_default().frame = *frame,
            MountItem::ViewStyle { id, style } => {
                let view = self.nodes.entry(*id).or_default();
                view.hidden = style.hidden;
                view.clips = style.overflow_hidden;
            }
            MountItem::ScrollBehavior { id, behavior } => {
                if let Some(scroll) = self.scroll_mut(*id) {
                    scroll.locked = !behavior.enabled;
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
                view.selected = props.accessibility.state.selected;
                view.long_press_delay = props.long_press_delay;
                view.selection_area = props.selection_area;
                view.pan_activation = props.pan_activation;
                view.pointer_events = props.pointer_events;
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
            MountItem::Text { id, text, .. } => {
                {
                    let view = self.nodes.entry(*id).or_default();
                    view.text = Some(text.text.clone());
                    view.attributed = Some(Arc::clone(text));
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
            Command::PickImages { id, request } => self.picks.push((*id, *request)),
            // Recorded, never opened: a test's machine opens nothing.
            Command::OpenUrl { id, url } => {
                self.opened_urls.push(url.clone());
                self.url_opens.push(*id);
            }
            Command::Back => self.back_asked = true,
            Command::Desktop(desktop) => {
                if let nsh_core::desktop::DesktopCommand::PopupMenu { items, .. } = &**desktop {
                    self.menu = Some(items.clone());
                }
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
        let retired = self
            .nodes
            .get(&id)
            .map(|view| {
                view.spans
                    .iter()
                    .copied()
                    .filter(|old| {
                        !text
                            .links
                            .iter()
                            .any(|next| next.node == *old && next.is_enabled())
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for old in retired {
            self.revoke_contacts(old);
            self.revoke_hovered(old);
        }
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
                Matcher::Text(want) => char_starts(&text.text, want)
                    .into_iter()
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
            [] => return Err(format!("no span matches `{selector}`")),
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
            .ok_or_else(|| format!("no span matches `{selector}`"))
    }

    fn detach(&mut self, id: NodeId) {
        if let Some(parent) = self.nodes.get_mut(&id).and_then(|v| v.parent.take())
            && let Some(siblings) = self.children.get_mut(&parent)
        {
            siblings.retain(|s| *s != id);
        }
    }

    fn insert(&mut self, parent: NodeId, child: NodeId, before: Option<NodeId>) {
        self.detach(child);
        let siblings = self.children.entry(parent).or_default();
        let at = before
            .and_then(|before| siblings.iter().position(|sibling| *sibling == before))
            .unwrap_or(siblings.len());
        siblings.insert(at, child);
        self.nodes.entry(child).or_default().parent = Some(parent);
        if self.kind(child) == Some(ViewKind::Modal) {
            if let Some(presentation) = self.presented.iter_mut().find(|entry| entry.id == child) {
                presentation.live = true;
            } else {
                self.presented.push(Presentation {
                    id: child,
                    live: true,
                });
                self.shows.push(child);
            }
        }
    }

    fn park_presentations(&mut self, root: NodeId) {
        for at in 0..self.presented.len() {
            let id = self.presented[at].id;
            if id == root || self.is_inside(id, root) {
                self.presented[at].live = false;
                self.shows.retain(|shown| *shown != id);
            }
        }
    }

    fn remove_presentations(&mut self, root: NodeId) {
        let presentations = std::mem::take(&mut self.presented);
        for presentation in presentations {
            if presentation.id == root || self.is_inside(presentation.id, root) {
                self.shows.retain(|shown| *shown != presentation.id);
            } else {
                self.presented.push(presentation);
            }
        }
    }

    fn top_modal(&self, attached: &[NodeId]) -> Option<NodeId> {
        self.presented
            .iter()
            .rev()
            .find(|entry| entry.live && attached.contains(&entry.id))
            .map(|entry| entry.id)
    }

    fn revoke_focus(&mut self, id: NodeId) {
        if self
            .focused
            .is_some_and(|focus| focus == id || self.is_inside(focus, id))
        {
            self.focused = None;
        }
    }

    /// Revoke before changing ancestry: a later Insert cannot revive a finger.
    fn revoke_contacts(&mut self, root: NodeId) {
        let contains = |id| id == root || self.is_inside(id, root);
        let mut cancelled = Vec::new();
        for contact in &self.contacts {
            if contact.owners.iter().copied().any(contains) {
                contact.active.store(false, Ordering::Relaxed);
                if contact.reporting.swap(false, Ordering::Relaxed) {
                    cancelled.push(InputResult::CancelTouch(contact.id));
                }
            }
            if contact.native_owner().is_some_and(contains) {
                contact.native.store(0, Ordering::Relaxed);
            }
        }
        self.input_results.extend(cancelled);
    }

    /// Forget the actual hovered owners before their ids can be reused.
    fn revoke_hovered(&mut self, root: NodeId) {
        let hovered = std::mem::take(&mut self.hovered);
        for owner in hovered {
            if owner == root || self.is_inside(owner, root) {
                if let Some(states) =
                    self.set_state(owner, nsh_core::tailwind::state::HOVERED, false)
                {
                    self.input_results
                        .push(InputResult::SetStates(owner, states));
                }
            } else {
                self.hovered.push(owner);
            }
        }
    }

    pub(crate) fn begin_contact(
        &mut self,
        id: u32,
        target: NodeId,
        mut owners: Vec<NodeId>,
        reporting: bool,
    ) -> Arc<Contact> {
        owners.push(target);
        let contact = Arc::new(Contact {
            id,
            target,
            owners,
            active: AtomicBool::new(true),
            reporting: AtomicBool::new(reporting),
            native: AtomicU32::new(0),
        });
        self.contacts.push(contact.clone());
        contact
    }

    pub(crate) fn end_contact(&mut self, contact: &Arc<Contact>) {
        self.contacts.retain(|other| !Arc::ptr_eq(other, contact));
        contact.active.store(false, Ordering::Relaxed);
        contact.stop_reporting();
        contact.native.store(0, Ordering::Relaxed);
    }

    /// The views on screen, in tree order: below the root, of a stack
    /// only its top screen (the others are covered), without what a back
    /// took away.
    fn attached(&self) -> Vec<NodeId> {
        let mut out = Vec::new();
        let mut stack = vec![ROOT];
        while let Some(id) = stack.pop() {
            if self.closed.contains(&id) {
                continue;
            }
            if id != ROOT {
                out.push(id);
            }
            if self.kind(id) == Some(ViewKind::Stack) {
                stack.extend(self.screens(id).last());
            } else if let Some(children) = self.children.get(&id) {
                stack.extend(children.iter().rev());
            }
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
        // root's points, whether a view around it is hidden, and whether its
        // parent shows.
        let mut stack = vec![(ROOT, Point::default(), window, false, true)];
        while let Some((id, origin, clip, hidden, parent_shown)) = stack.pop() {
            if self.closed.contains(&id) {
                continue;
            }
            // The root is the platform's: no batch creates it.
            let root = View::default();
            let view = match self.nodes.get(&id) {
                Some(view) => view,
                None if id == ROOT => &root,
                None => continue,
            };
            let hidden = hidden || view.hidden;
            // A modal is presented over the window, wherever it is in the
            // tree.
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
            if id != ROOT && shows {
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
            let children: Vec<NodeId> = if self.kind(id) == Some(ViewKind::Stack) {
                self.screens(id).last().copied().into_iter().collect()
            } else {
                self.children.get(&id).cloned().unwrap_or_default()
            };
            stack.extend(
                children
                    .into_iter()
                    .rev()
                    .map(|child| (child, content, inner, hidden, shows || id == ROOT)),
            );
        }
        out
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
    /// back pops its top screen, or asks it when it prevents going back;
    /// without one, the newest modal asks to close.
    pub(crate) fn back_target(&self) -> Back {
        let attached = self.attached();
        let modal = self.top_modal(&attached);
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

    /// The modals presented since the last call.
    pub(crate) fn take_presented(&mut self) -> Vec<NodeId> {
        std::mem::take(&mut self.shows)
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

    /// The picks the app asked for so far, in order (`Picker.pickImages`).
    pub fn picks(&self) -> Vec<nsh_core::picker::PickRequest> {
        self.picks.iter().map(|(_, request)| *request).collect()
    }

    /// The oldest pick not answered yet: its request's id and what it
    /// asks.
    pub(crate) fn pending_pick(&self) -> Option<(u32, nsh_core::picker::PickRequest)> {
        self.picks.get(self.picks_answered).copied()
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

    /// The URLs the app had the system open (`openUrl`, a `TextView`'s
    /// links), in order: what reached the platform, past the URL check,
    /// the `openUrl` capability and the embedding app's URL handler.
    pub fn opened_urls(&self) -> &[String] {
        &self.opened_urls
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
        let Some(top) = self.top_modal(&attached) else {
            return attached;
        };
        let (mut first, rest): (Vec<NodeId>, Vec<NodeId>) = attached
            .into_iter()
            .partition(|id| *id == top || self.is_inside(*id, top));
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

    fn is_inside(&self, mut id: NodeId, ancestor: NodeId) -> bool {
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

    /// The texts on screen, in tree order.
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
            [] => Err(format!("no view matches `{selector}`")),
            ref all => Err(format!("`{selector}` matches {} views", all.len())),
        }
    }

    /// Whether the view `selector` names is in a selection area (it or a
    /// view around it is one: `SelectionArea` of `nsh/base`, a selectable
    /// `TextView`); an error when none or several match.
    pub fn in_selection_area(&self, selector: &str) -> Result<bool, String> {
        let parsed = Selector::parse(selector)?;
        match self.resolve(&parsed)[..] {
            [mut id] => loop {
                let Some(view) = self.nodes.get(&id) else {
                    return Ok(false);
                };
                if view.selection_area {
                    return Ok(true);
                }
                match view.parent {
                    Some(parent) => id = parent,
                    None => return Ok(false),
                }
            },
            [] => Err(format!("no view matches `{selector}`")),
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
            [] => Err(format!("no view matches `{selector}`")),
            ref all => Err(format!("`{selector}` matches {} views", all.len())),
        }
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

    /// The view a pointer at `at` (in the root) reaches: the topmost,
    /// innermost one there that receives touches. Canvas nodes are not views.
    fn hit_pointer(&self, at: Point<Points>) -> NodeId {
        let attached: HashSet<NodeId> = self.attached().into_iter().collect();
        self.hit_in(ROOT, at, &attached).unwrap_or(ROOT)
    }

    fn hit_in(&self, id: NodeId, at: Point<Points>, attached: &HashSet<NodeId>) -> Option<NodeId> {
        let view = self.nodes.get(&id);
        let receives = view.map_or(PointerEvents::Auto, |v| v.pointer_events);
        if receives == PointerEvents::None || view.is_some_and(|v| v.hidden) {
            return None;
        }
        let inside = id == ROOT || self.bounds_in_root(id).is_some_and(|b| b.contains(&at));
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
            for &child in children.iter().rev() {
                let node = self.nodes.get(&child).is_some_and(|v| v.canvas_node);
                if node || !attached.contains(&child) {
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
            let Some(target) = self.up_to(self.hit_pointer(at), |v| {
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
    /// The scroll views around `id` (not it), innermost first, with whether
    /// each scrolls horizontally.
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
            at = view.parent;
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
        let mut at = view.parent;
        while let Some(parent) = at {
            let Some(p) = self.nodes.get(&parent) else {
                break;
            };
            origin += p.frame.origin;
            if let Some(scroll) = &p.scroll {
                origin -= nsh_core::Point::new(scroll.x, scroll.y);
            }
            at = p.parent;
        }
        Some(Bounds::new(origin, view.frame.size))
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
    pub(crate) fn set_state(&mut self, id: NodeId, bit: u8, on: bool) -> Option<u8> {
        let view = self.nodes.get_mut(&id)?;
        let next = nsh_core::input::next_states(view.tracked, view.states, bit, on)?;
        view.states = next;
        Some(next)
    }

    /// The context menu the app shows (`Menu.popup`), if one is open.
    pub(crate) fn menu(&self) -> Option<&[nsh_core::desktop::MenuItem]> {
        self.menu.as_deref()
    }

    /// The open context menu was chosen from or closed.
    pub(crate) fn menu_closed(&mut self) {
        self.menu = None;
    }

    /// The view a right click on `id` asks for a context menu: it, or the
    /// nearest around it listening to `onContextMenu`.
    pub(crate) fn context_menu_target(&self, id: NodeId) -> Option<NodeId> {
        self.up_to(id, |v| v.events.contains(EventKind::ContextMenu))
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
        self.is_attached(id)
            && self
                .nodes
                .get(&id)
                .is_some_and(|view| view.events.contains(event))
    }

    pub(crate) fn is_attached(&self, id: NodeId) -> bool {
        id == ROOT || self.is_inside(id, ROOT)
    }

    pub(crate) fn take_input_results(&mut self) -> Vec<InputResult> {
        std::mem::take(&mut self.input_results)
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

    pub(crate) fn focus_path(&self) -> Vec<NodeId> {
        let Some(mut id) = self.focused else {
            return Vec::new();
        };
        let mut path = vec![id];
        while let Some(parent) = self.nodes.get(&id).and_then(|view| view.parent) {
            path.push(parent);
            id = parent;
        }
        path
    }

    pub(crate) fn set_focused(&mut self, id: Option<NodeId>) {
        self.focused = id;
    }

    /// The pressable with the keyboard focus, while it is mounted.
    pub(crate) fn key_focus(&self) -> Option<NodeId> {
        self.key_focus.filter(|id| self.nodes.contains_key(id))
    }

    pub(crate) fn set_key_focus(&mut self, id: Option<NodeId>) {
        self.key_focus = id;
    }

    /// Tab's stops, in tree order, as macOS and the web have them: the
    /// inputs that edit and the views that take presses, shown, enabled
    /// and not `focusable={false}`.
    pub(crate) fn tab_stops(&self) -> Vec<NodeId> {
        self.shown()
            .into_iter()
            .filter(|&id| {
                let Some(v) = self.nodes.get(&id) else {
                    return false;
                };
                if let Some(input) = &v.input {
                    return input.config.editable && !self.disabled_from(id, None);
                }
                v.span.is_none()
                    && v.events.contains(EventKind::Press)
                    && v.focusable != Some(false)
                    && !self.disabled_from(id, None)
            })
            .collect()
    }

    pub(crate) fn scroll(&self, id: NodeId) -> Option<&Scroll> {
        self.nodes.get(&id)?.scroll.as_ref()
    }

    pub(crate) fn scroll_mut(&mut self, id: NodeId) -> Option<&mut Scroll> {
        self.nodes.get_mut(&id)?.scroll.as_mut()
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
            project(1, 2, &[]),
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

    fn project(parent: NodeId, id: NodeId, following: &[NodeId]) -> MountItem {
        MountItem::ProjectRoot {
            parent,
            id,
            following: following.to_vec(),
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
            project(1, 2, &[]),
            project(2, 4, &[]),
            insert(4, 6),
            project(2, 8, &[]),
            insert(8, 10),
        ]));
        assert_eq!(screen.texts(), ["Details"]);
        screen.apply(&batch(vec![
            create(16, ViewKind::Screen), // An independent root still parked.
            create(18, ViewKind::Screen),
            create(20, ViewKind::Stack),
            project(1, 20, &[]),
            project(20, 18, &[]), // An existing root in another native host.
            project(2, 4, &[16, 18, 8]),
        ]));
        // A missing or foreign first candidate must not append Home on top.
        assert_eq!(screen.texts(), ["Details"]);
        screen.apply(&batch(vec![project(2, 8, &[16, 18, 4])]));
        assert_eq!(screen.texts(), ["Home"]);
        screen.apply(&batch(vec![project(2, 4, &[16, 18, 8])]));
        assert_eq!(screen.texts(), ["Details"]);
        screen.apply(&batch(vec![
            text(10, "Close"),
            project(1, 12, &[]),
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
    fn projected_cells_use_the_first_live_sibling_after_native_retirement() {
        let mut screen = Screen::default();
        screen.apply(&batch(vec![
            create(2, ViewKind::View),
            frame(2, 0.0, 0.0, 400.0, 400.0),
            project(ROOT, 2, &[]),
            create(18, ViewKind::View),
            frame(18, 0.0, 0.0, 400.0, 400.0),
            project(ROOT, 18, &[]),
            create(20, ViewKind::View),
            project(18, 20, &[]),
            create(22, ViewKind::View), // A root not currently in a native host.
        ]));
        for (id, label) in [(4, "A"), (8, "B"), (12, "C")] {
            screen.apply(&batch(vec![
                create(id, ViewKind::View),
                create(id + 2, ViewKind::Text),
                text(id + 2, label),
                frame(id, 0.0, 0.0, 100.0, 40.0),
                frame(id + 2, 0.0, 0.0, 100.0, 20.0),
                project(2, id, &[]),
                insert(id, id + 2),
            ]));
        }
        screen.apply(&batch(vec![
            create(24, ViewKind::Modal),
            project(2, 24, &[]), // Same logical parent, a different native host.
            create(16, ViewKind::Input),
            insert(8, 16),
            MountItem::Command {
                id: 16,
                command: Command::Focus,
            },
            MountItem::RetireListCell {
                id: 8,
                request: 1,
                roots: vec![8],
            },
            project(2, 4, &[22, 20, 24, 8, 12]),
        ]));
        assert_eq!(screen.texts(), ["A", "B", "C"]);
        assert!(matches!(screen.take_input_results().as_slice(),
            [InputResult::RetireListCell { id: 8, request: 1, focus_path: Some(path) }]
                if path.first() == Some(&16)));

        screen.apply(&batch(vec![
            MountItem::Command {
                id: ROOT,
                command: Command::Blur,
            },
            MountItem::RetireListCell {
                id: 8,
                request: 2,
                roots: vec![8],
            },
            project(2, 4, &[22, 20, 24, 8, 12]),
        ]));
        assert_eq!(screen.texts(), ["A", "C"]);
        assert!(matches!(
            screen.take_input_results().as_slice(),
            [InputResult::RetireListCell {
                id: 8,
                request: 2,
                focus_path: None
            }]
        ));
        screen.apply(&batch(vec![project(2, 8, &[12])]));
        assert_eq!(screen.texts(), ["A", "B", "C"]);
    }

    #[test]
    fn parked_modals_keep_their_window_slot_across_projection_parents() {
        let mut screen = Screen::default();
        screen.apply(&batch(vec![
            create(2, ViewKind::View),
            create(18, ViewKind::View),
            project(ROOT, 2, &[]),
            project(ROOT, 18, &[]),
            create(4, ViewKind::Modal),
            create(6, ViewKind::Text),
            text(6, "Choose"),
            frame(6, 0.0, 0.0, 100.0, 20.0),
            project(2, 4, &[]),
            insert(4, 6),
            create(8, ViewKind::Modal),
            create(10, ViewKind::Text),
            text(10, "Choose"),
            frame(10, 0.0, 0.0, 100.0, 20.0),
            project(18, 8, &[]),
            insert(8, 10),
            create(12, ViewKind::Input),
            insert(8, 12),
        ]));
        let choose = Selector::parse("text:Choose").unwrap();
        assert_eq!(screen.resolve(&choose), [10, 6]);
        assert_eq!(screen.take_presented(), [4, 8]);
        screen.apply(&batch(vec![
            MountItem::Command {
                id: 12,
                command: Command::Focus,
            },
            MountItem::RetireListCell {
                id: 8,
                request: 1,
                roots: vec![8],
            },
            project(18, 4, &[]),
        ]));
        assert!(matches!(
            screen.take_input_results().as_slice(),
            [InputResult::RetireListCell {
                id: 8,
                request: 1,
                focus_path: Some(_)
            }]
        ));
        assert_eq!(screen.resolve(&choose), [10, 6]);
        assert!(screen.take_presented().is_empty());

        screen.apply(&batch(vec![
            MountItem::Command {
                id: ROOT,
                command: Command::Blur,
            },
            MountItem::RetireListCell {
                id: 4,
                request: 2,
                roots: vec![4],
            },
        ]));
        assert_eq!(screen.resolve(&choose), [10]);
        screen.apply(&batch(vec![project(2, 4, &[])]));
        assert_eq!(screen.resolve(&choose), [10, 6]);
        assert!(screen.take_presented().is_empty());

        screen.apply(&batch(vec![
            MountItem::Remove { id: 4 },
            project(2, 4, &[]),
        ]));
        assert_eq!(screen.resolve(&choose), [6, 10]);
        assert_eq!(screen.take_presented(), [4]);
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
            project(1, 2, &[]),
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
    fn spans_that_take_presses_are_found_by_their_characters() {
        let mut screen = Screen::default();
        let mut events = EventMask::default();
        events.set(EventKind::Press, true);
        let link = |start, end, node| nsh_core::TextLink {
            start,
            end,
            node,
            events,
            props: Arc::default(),
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
            project(1, 2, &[]),
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

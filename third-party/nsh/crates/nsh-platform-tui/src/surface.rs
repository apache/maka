//! A retained terminal scene. One surface owns its nodes, input, animation
//! graph and graphics work; embedding several surfaces shares no app state.

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    sync::Arc,
};

use nsh_core::{
    AttributedText, Bounds, Color, Command, Dialog, EventKind, EventMask, EventPayload,
    GestureValues, InputConfig, ModalConfig, MountBatch, MountItem, NodeId, PayloadValue, Point,
    Points, ROOT_ID, ScreenConfig, ScrollBehavior, Size, StickyCell, TextLayout, Transform,
    ViewKind, ViewProps, ViewStyle,
    access::Access,
    animation::{AnimatedPropValue, AnimationProp, AnimationValue, Graph},
    geometry::{point, px},
    keymap::Keymap,
    overlay::HintObservation,
};
use ratatui::{buffer::Buffer, layout::Rect as CellRect};

use crate::{
    editor::Editor,
    image::{AnimatedRaster, Raster},
    input::FocusSource,
    metrics::CellMetrics,
};

// A mount batch can attach and position a virtual cell after its focus
// command. Preserve that request through the final tree; only its original
// native generation may issue the implicit reveal.
struct FocusReveal {
    target: (NodeId, u64),
    overridden: Vec<(NodeId, u64)>,
}

/// Input and native work to forward to a surface's engine in order.
#[derive(Debug)]
pub enum SurfaceEvent {
    /// An application event on a mounted view.
    Event(NodeId, EventKind, EventPayload),
    /// A native hint anchor observation, without application event dispatch.
    HintObservation(HintObservation),
    /// A scroll offset, with the number of core adjustments applied.
    Scroll(NodeId, Point<Points>, u32),
    /// Text offset, content extent and viewport while a built-in input bar is mounted.
    InputScroll(NodeId, Point<Points>, Size<Points>, Size<Points>),
    /// Whether a list cell left native input and Tab navigation for this request.
    ListCellRetired(NodeId, u64, bool),
    /// Interaction state bits requested by the mounted view.
    States(NodeId, u16),
    /// Animation completions and native value reads.
    AnimationsFinished(Vec<nsh_core::animation::Finished>),
    /// A hosted terminal component reported its natural size in points.
    ComponentSize(NodeId, Size<Points>),
    /// A terminal host operation, dispatched asynchronously by the embedding host.
    Service(crate::services::ServiceRequest),
    /// A scroll content scale, reported before its adjusted offset.
    Zoom(NodeId, f32),
    /// The independently laid out size and insets of a screen or modal.
    RootSize(NodeId, Size<Points>, nsh_core::EdgeInsets),
}

pub(crate) struct ScrollState {
    pub(crate) x: Points,
    pub(crate) y: Points,
    pub(crate) content: Size<Points>,
    pub(crate) horizontal: bool,
    pub(crate) enabled: bool,
    pub(crate) shows_indicator: bool,
    pub(crate) behavior: Box<ScrollBehavior>,
    pub(crate) count: u32,
    pub(crate) sticky: Vec<StickyCell>,
    pub(crate) scroll_value: Option<nsh_core::animation::NodeId>,
    pub(crate) pull_value: Option<nsh_core::animation::NodeId>,
    pub(crate) mirrored: bool,
    pub(crate) physics: crate::scroll::Physics,
}

impl Default for ScrollState {
    fn default() -> Self {
        Self {
            x: Points::ZERO,
            y: Points::ZERO,
            content: Size::default(),
            horizontal: false,
            enabled: true,
            shows_indicator: true,
            behavior: Box::default(),
            count: 0,
            sticky: Vec::new(),
            scroll_value: None,
            pull_value: None,
            mirrored: false,
            physics: crate::scroll::Physics::default(),
        }
    }
}

#[derive(Clone, Copy, Default)]
pub(crate) struct InputViewport {
    /// First visual row and column.
    pub(crate) origin: (usize, usize),
    /// Last laid out column and row count.
    pub(crate) size: (usize, usize),
    pub(crate) reveal: bool,
}

pub(crate) struct Node {
    pub(crate) generation: u64,
    pub(crate) kind: ViewKind,
    pub(crate) parent: Option<NodeId>,
    pub(crate) children: Vec<NodeId>,
    pub(crate) frame: Bounds<Points>,
    pub(crate) style: Box<ViewStyle>,
    pub(crate) props: Box<ViewProps>,
    pub(crate) events: EventMask,
    pub(crate) tracked: u16,
    pub(crate) text: Option<(Arc<AttributedText>, TextLayout, Bounds<Points>)>,
    pub(crate) input: InputConfig,
    pub(crate) editor: Editor,
    pub(crate) input_content: Bounds<Points>,
    pub(crate) input_viewport: Cell<InputViewport>,
    pub(crate) reported_input_scroll: Option<(Point<Points>, Size<Points>, Size<Points>)>,
    pub(crate) scroll: ScrollState,
    pub(crate) screen: ScreenConfig,
    pub(crate) modal: ModalConfig,
    pub(crate) popped: bool,
    pub(crate) drawing: Option<Arc<nsh_core::canvas::Drawing>>,
    pub(crate) image: crate::image_state::ImageState,
    pub(crate) canvas_raster: Option<Arc<Raster>>,
    pub(crate) bindings: Vec<(AnimationProp, nsh_core::animation::NodeId)>,
    pub(crate) gestures: GestureValues,
    pub(crate) canvas_args: Vec<(u16, AnimationValue)>,
    pub(crate) native: Option<Box<dyn crate::native::NativeComponent>>,
    component_slots: Vec<(Arc<str>, Option<AnimatedPropValue>)>,
    pub(crate) media: Option<Box<crate::media::MediaState>>,
    native_size: Option<Size<Points>>,
    pub(crate) motion: Option<Box<crate::motion::NodeMotion>>,
    pub(crate) delete_pending: bool,
}

impl Node {
    fn new(kind: ViewKind) -> Self {
        Self {
            generation: 0,
            kind,
            parent: None,
            children: Vec::new(),
            frame: Bounds::default(),
            style: Box::default(),
            props: Box::default(),
            events: EventMask::default(),
            tracked: 0,
            text: None,
            input: InputConfig::default(),
            editor: Editor::default(),
            input_content: Bounds::default(),
            input_viewport: Cell::default(),
            reported_input_scroll: None,
            scroll: ScrollState::default(),
            screen: ScreenConfig::default(),
            modal: ModalConfig::default(),
            popped: false,
            drawing: None,
            image: crate::image_state::ImageState::default(),
            canvas_raster: None,
            bindings: Vec::new(),
            gestures: GestureValues::default(),
            canvas_args: Vec::new(),
            native: None,
            component_slots: Vec::new(),
            media: None,
            native_size: None,
            motion: None,
            delete_pending: false,
        }
    }

    pub(crate) fn request_input_reveal(&self) {
        self.input_viewport.set(InputViewport {
            reveal: true,
            ..self.input_viewport.get()
        });
    }
}

/// A Native Shell scene that can be painted into any Ratatui rectangle.
///
/// This type does no terminal IO. Feed it mount batches and terminal events,
/// paint it into the host's buffer, then forward [`Self::drain_events`] to
/// the engine. [`crate::AppView`] combines these steps with an engine.
pub struct Surface {
    pub(crate) nodes: Vec<Option<Node>>,
    /// Locators into the resident Text snapshots, which remain the link authority.
    pub(crate) text_links: HashMap<NodeId, (NodeId, usize)>,
    pub(crate) metrics: CellMetrics,
    pub(crate) columns: u16,
    pub(crate) rows: u16,
    pub(crate) events: Vec<SurfaceEvent>,
    pub(crate) focus: Option<NodeId>,
    pub(crate) hovered: Option<NodeId>,
    pub(crate) pressed: Option<NodeId>,
    pub(crate) keymap: Arc<Keymap>,
    pub(crate) quit: bool,
    pub(crate) dialog: Option<Dialog>,
    pub(crate) dialog_selection: usize,
    pub(crate) clipboard: String,
    pub(crate) animation: Graph,
    pub(crate) hovered_path: Vec<NodeId>,
    pub(crate) last_mouse: Option<nsh_core::MouseEvent>,
    pub(crate) input_scrollers: Vec<NodeId>,
    pub(crate) autofocus_seen: Vec<NodeId>,
    pub(crate) drag_input: Option<NodeId>,
    pub(crate) area_selection: Option<crate::selectable_view::SelectableView>,
    pub(crate) pointer: Option<crate::input::Pointer>,
    pub(crate) input_paused: bool,
    pub(crate) focus_history: Vec<NodeId>,
    pub(crate) focus_returns: Vec<crate::input::FocusReturn>,
    pub(crate) toast: Option<(String, f64)>,
    pub(crate) dark: bool,
    pub(crate) now: f64,
    pub(crate) access: Access,
    pub(crate) components: crate::native::Components,
    pub(crate) graphics: crate::worker::Graphics,
    pub(crate) fonts: crate::fonts::FontCatalog,
    fonts_revision: u64,
    pub(crate) composites: RefCell<crate::composite::Cache>,
    pub(crate) geometry: RefCell<crate::geometry::GeometryCache>,
    pub(crate) navigation: crate::navigation::Navigation,
    pub(crate) reduce_motion: bool,
    pub(crate) services: crate::services::SurfaceServices,
    pub(crate) media_runtime: crate::media::MediaRuntime,
    pub(crate) protocol: crate::protocol::Images,
    assets: Option<Arc<dyn nsh_engine::Assets>>,
    canvas_dirty: Vec<NodeId>,
    canvas_pending: Vec<NodeId>,
    canvas_epoch: u64,
    node_generation: u64,
    image_cache: HashMap<String, CachedImage>,
    pending_images: HashMap<String, PendingImage>,
    pending_blurs: Vec<(NodeId, crate::image_state::ImageRequest)>,
}

struct CachedImage {
    animation: Arc<AnimatedRaster>,
    started: f64,
    frame: usize,
}

#[derive(Default)]
struct PendingImage {
    views: Vec<(NodeId, crate::image_state::ImageRequest)>,
    requests: Vec<u32>,
}

impl Surface {
    /// An empty scene, with its dimensions in terminal columns and rows.
    pub fn new(columns: u16, rows: u16, metrics: CellMetrics) -> Self {
        let fonts = crate::fonts::FontCatalog::default();
        let mut surface = Self {
            nodes: vec![None, Some(Node::new(ViewKind::View))],
            text_links: HashMap::new(),
            metrics,
            columns,
            rows,
            events: Vec::new(),
            focus: None,
            hovered: None,
            pressed: None,
            keymap: Arc::default(),
            quit: false,
            dialog: None,
            dialog_selection: 0,
            clipboard: String::new(),
            animation: Graph::default(),
            hovered_path: Vec::new(),
            last_mouse: None,
            input_scrollers: Vec::new(),
            autofocus_seen: Vec::new(),
            drag_input: None,
            area_selection: None,
            pointer: None,
            input_paused: false,
            focus_history: Vec::new(),
            focus_returns: Vec::new(),
            toast: None,
            dark: false,
            now: 0.0,
            access: Access::all(),
            components: crate::native::Components::default(),
            graphics: crate::worker::Graphics::new(fonts.clone()),
            fonts,
            fonts_revision: 0,
            composites: RefCell::default(),
            geometry: RefCell::default(),
            navigation: crate::navigation::Navigation::default(),
            reduce_motion: false,
            services: crate::services::SurfaceServices::default(),
            media_runtime: crate::media::MediaRuntime::default(),
            protocol: crate::protocol::Images::default(),
            assets: None,
            canvas_dirty: Vec::new(),
            canvas_pending: Vec::new(),
            canvas_epoch: 0,
            node_generation: 0,
            image_cache: HashMap::new(),
            pending_images: HashMap::new(),
            pending_blurs: Vec::new(),
        };
        surface.resize(columns, rows);
        surface
    }

    /// The virtual dimensions of one terminal cell.
    pub fn metrics(&self) -> CellMetrics {
        self.metrics
    }

    /// Pauses physical input while queued engine edits remain applicable.
    pub fn set_input_paused(&mut self, paused: bool) {
        self.input_paused = paused;
        if paused {
            self.pointer_left();
        }
    }

    /// Enables a terminal image protocol using the host's detected pixel
    /// cell size. `None` keeps deterministic colored half-block rendering.
    /// This method performs no terminal IO or capability queries.
    pub fn set_image_protocol(&mut self, protocol: Option<crate::ImageProtocol>) {
        self.protocol.configure(protocol);
    }

    /// Escape sequences for the host to flush before unmounting this surface.
    /// They release this surface's bounded Kitty image identifiers. The
    /// embedding host owns terminal IO and decides when to write them.
    pub fn image_protocol_cleanup(&self) -> String {
        self.protocol.cleanup()
    }

    pub(crate) fn inherit_image_protocol(&mut self, previous: &mut Self) {
        self.protocol = std::mem::take(&mut previous.protocol);
        self.protocol.reset_entries();
        self.media_runtime = previous.media_runtime.clone();
    }

    pub(crate) fn paint_image_protocol(
        &self,
        id: NodeId,
        request: crate::protocol::Request,
        buffer: &mut Buffer,
    ) -> bool {
        self.protocol.paint(id, request, &self.graphics, buffer)
    }

    /// The layout viewport in virtual points.
    pub fn viewport(&self) -> Size<Points> {
        self.metrics.viewport(self.columns, self.rows)
    }

    /// Resizes the scene; its host also sends the new viewport to the engine.
    pub fn resize(&mut self, columns: u16, rows: u16) {
        self.columns = columns;
        self.rows = rows;
        let size = self.viewport();
        if let Some(root) = self.node_mut(ROOT_ID) {
            root.frame = Bounds::new(Point::new(px(0.0), px(0.0)), size);
        }
    }

    /// Supplies the same asset reader that the engine uses for this app.
    pub fn set_assets(&mut self, assets: Option<Arc<dyn nsh_engine::Assets>>) {
        self.assets = assets;
    }

    /// Sets the verified bundle's media and clipboard permissions.
    pub fn set_access(&mut self, access: Access) {
        self.canvas_epoch = self.canvas_epoch.wrapping_add(1);
        for node in self.nodes.iter_mut().flatten() {
            if let Some(media) = &mut node.media {
                media.set_access(access.clone());
            }
            node.image.revoke(&access);
            if node.drawing.is_some() {
                node.canvas_raster = None;
            }
        }
        self.image_cache.retain(|uri, _| access.allows_media(uri));
        self.composites.borrow_mut().retain(&[]);
        self.protocol.reset_entries();
        self.access = access;
        let requests: Vec<_> = self
            .nodes
            .iter()
            .enumerate()
            .flat_map(|(id, node)| {
                node.as_ref()
                    .map(|node| node.image.requests())
                    .unwrap_or_default()
                    .into_iter()
                    .map(move |request| (id as NodeId, request))
            })
            .collect();
        for (id, request) in requests {
            self.request_view_image(id, request);
        }
        let ids: Vec<_> = self
            .nodes
            .iter()
            .enumerate()
            .filter_map(|(id, node)| {
                node.as_ref()
                    .filter(|node| node.drawing.is_some())
                    .map(|_| id as NodeId)
            })
            .collect();
        for id in ids {
            self.dirty_canvas(id);
        }
    }

    /// Chooses the fallback colors of native terminal overlays.
    pub fn set_dark(&mut self, dark: bool) {
        self.dark = dark;
    }

    /// Registers the factories this surface may instantiate through `nsh/native`.
    pub fn set_components(&mut self, components: crate::native::Components) {
        self.components = components;
    }

    /// Selects reduced navigation motion for this surface.
    pub fn set_reduce_motion(&mut self, reduce_motion: bool) {
        self.reduce_motion = reduce_motion;
    }

    /// Whether the app requested that its host close.
    pub fn should_quit(&self) -> bool {
        self.quit
    }

    /// The view currently receiving keyboard input.
    pub fn focused(&self) -> Option<NodeId> {
        self.focus
    }

    /// Drains application events in their original order.
    pub fn drain_events(&mut self) -> impl Iterator<Item = SurfaceEvent> {
        self.report_input_scrolls();
        self.events.drain(..)
    }

    /// A plain text view of the actual rendered buffer, for scripts and tests.
    pub fn snapshot(&self) -> String {
        let area = CellRect::new(0, 0, self.columns, self.rows);
        let mut buffer = Buffer::empty(area);
        self.render_plain(area, &mut buffer);
        let mut output = String::new();
        for y in 0..self.rows {
            let mut x = 0;
            let mut line = String::new();
            while x < self.columns {
                let symbol = buffer[(x, y)].symbol();
                line.push_str(symbol);
                x += unicode_width::UnicodeWidthStr::width(symbol).max(1) as u16;
            }
            output.push_str(line.trim_end());
            output.push('\n');
        }
        output
    }

    pub(crate) fn node(&self, id: NodeId) -> Option<&Node> {
        self.nodes.get(id as usize)?.as_ref()
    }
    pub(crate) fn node_mut(&mut self, id: NodeId) -> Option<&mut Node> {
        self.nodes.get_mut(id as usize)?.as_mut()
    }
    pub(crate) fn emit(&mut self, id: NodeId, kind: EventKind, payload: EventPayload) {
        self.events.push(SurfaceEvent::Event(id, kind, payload));
    }

    pub(crate) fn component_context(
        &self,
        id: NodeId,
        area: CellRect,
    ) -> crate::native::ComponentContext {
        let frame = self.global_frame(id).unwrap_or_default();
        let clip = intersect(frame, self.clip_rect(id));
        let cells = |rect: Bounds<Points>| {
            let left = (rect.origin.x / self.metrics.width()).floor().max(0.0) as u16;
            let top = (rect.origin.y / self.metrics.height()).floor().max(0.0) as u16;
            let right = ((rect.origin.x + rect.size.width) / self.metrics.width())
                .ceil()
                .max(0.0) as u16;
            let bottom = ((rect.origin.y + rect.size.height) / self.metrics.height())
                .ceil()
                .max(0.0) as u16;
            CellRect::new(
                area.x.saturating_add(left),
                area.y.saturating_add(top),
                right.saturating_sub(left),
                bottom.saturating_sub(top),
            )
            .intersection(area)
        };
        crate::native::ComponentContext {
            frame,
            clip,
            area: cells(frame),
            clip_area: cells(clip),
            metrics: self.metrics,
            focused: self.focus == Some(id),
        }
    }

    fn component_response(
        &mut self,
        id: NodeId,
        response: crate::native::ComponentResponse,
    ) -> bool {
        for event in response.events {
            self.emit(id, EventKind::NativeEvent, event.into());
        }
        response.handled
    }

    fn component_size(&mut self, id: NodeId) {
        if let Some(size) = self
            .node(id)
            .and_then(|node| node.native.as_ref())
            .and_then(|component| component.intrinsic_size())
            && size.width.is_finite()
            && size.height.is_finite()
            && size.width > Points::ZERO
            && size.height > Points::ZERO
            && self
                .node(id)
                .is_some_and(|node| node.native_size != Some(size))
        {
            if let Some(node) = self.node_mut(id) {
                node.native_size = Some(size);
            }
            self.events.push(SurfaceEvent::ComponentSize(id, size));
        }
    }

    pub(crate) fn native_event(&mut self, id: NodeId, event: &crossterm::event::Event) -> bool {
        let context = self.component_context(id, CellRect::new(0, 0, self.columns, self.rows));
        let response = self
            .node_mut(id)
            .and_then(|node| node.native.as_mut())
            .map(|component| component.handle_event(event, &context));
        let handled = response.is_some_and(|response| self.component_response(id, response));
        self.component_size(id);
        handled
    }

    fn set_media(&mut self, id: NodeId, props: nsh_core::NativeProps) {
        let (assets, access, now) = (self.assets.clone(), self.access.clone(), self.now);
        let runtime = self.media_runtime.clone();
        if let Some(node) = self.node_mut(id) {
            if let Some(media) = &mut node.media {
                media.set_props(props, assets, access, now, runtime);
            } else {
                node.media = Some(Box::new(crate::media::MediaState::new(
                    props, assets, access, now, runtime,
                )));
            }
        }
        self.drain_media_events(id);
    }

    fn drain_media_events(&mut self, id: NodeId) {
        let events = self
            .node_mut(id)
            .and_then(|node| node.media.as_mut())
            .map(|media| media.drain_events())
            .unwrap_or_default();
        for (kind, payload) in events {
            self.emit(id, kind, payload);
        }
    }

    fn tick_media(&mut self) -> bool {
        let mut changed = false;
        let mut events = Vec::new();
        for (id, node) in self.nodes.iter_mut().enumerate() {
            if let Some(media) = node.as_mut().and_then(|node| node.media.as_mut()) {
                changed |= media.tick(self.now);
                events.extend(
                    media
                        .drain_events()
                        .into_iter()
                        .map(|(kind, payload)| (id as NodeId, kind, payload)),
                );
            }
        }
        for (id, kind, payload) in events {
            self.emit(id, kind, payload);
        }
        changed
    }

    pub(crate) fn media_key(&mut self, id: NodeId, key: crossterm::event::KeyEvent) -> bool {
        let now = self.now;
        let handled = self
            .node_mut(id)
            .and_then(|node| node.media.as_mut())
            .is_some_and(|media| media.key(key, now));
        self.drain_media_events(id);
        handled
    }

    pub(crate) fn media_scroll(&mut self, id: NodeId, lines: i32) -> bool {
        let handled = self
            .node_mut(id)
            .and_then(|node| node.media.as_mut())
            .is_some_and(|media| media.scroll(lines));
        self.drain_media_events(id);
        handled
    }

    pub(crate) fn detach(&mut self, id: NodeId) {
        if let Some(parent) = self.node(id).and_then(|n| n.parent)
            && let Some(parent) = self.node_mut(parent)
        {
            parent.children.retain(|&child| child != id);
        }
        if let Some(node) = self.node_mut(id) {
            node.parent = None;
        }
    }

    fn insert(
        &mut self,
        parent: NodeId,
        child: NodeId,
        before: Option<NodeId>,
        layout: Option<&nsh_core::LayoutAnimation>,
    ) {
        let restored = self.navigation_reinserted(child);
        let now = self.now;
        if let Some(node) = self.node_mut(child) {
            let create = (!matches!(
                node.kind,
                ViewKind::Screen | ViewKind::Modal | ViewKind::Stack | ViewKind::HeaderItem
            ) && node.frame == Bounds::default())
            .then(|| layout.and_then(|a| a.create.as_ref()))
            .flatten();
            if create.is_some() || node.motion.is_some() {
                node.motion
                    .get_or_insert_with(Box::default)
                    .inserted(create, now);
            }
            node.delete_pending = false;
        }
        self.detach(child);
        if let Some(node) = self.node_mut(child) {
            node.parent = Some(parent);
            if !restored {
                node.popped = false;
            }
        }
        if let Some(node) = self.node_mut(parent) {
            let index = before
                .and_then(|id| node.children.iter().position(|&c| c == id))
                .unwrap_or(node.children.len());
            node.children.insert(index, child);
        }
    }

    fn forget_text_links(&mut self, owner: NodeId) {
        let Some((text, ..)) = self
            .nodes
            .get(owner as usize)
            .and_then(Option::as_ref)
            .and_then(|node| node.text.as_ref())
        else {
            return;
        };
        for link in &text.links {
            if self
                .text_links
                .get(&link.node)
                .is_some_and(|(current, _)| *current == owner)
            {
                self.text_links.remove(&link.node);
            }
        }
    }

    fn index_text_links(&mut self, owner: NodeId) {
        let Some((text, ..)) = self
            .nodes
            .get(owner as usize)
            .and_then(Option::as_ref)
            .and_then(|node| node.text.as_ref())
        else {
            return;
        };
        for (index, link) in text.links.iter().enumerate() {
            self.text_links.insert(link.node, (owner, index));
        }
    }

    /// Applies one core commit in order, then reconciles native interaction.
    pub fn apply(&mut self, batch: MountBatch) {
        let mut focus_return = self.prepare_focus_return(&batch);
        self.navigation_prepare(&batch);
        let mut finished = Vec::new();
        let mut tracked = Vec::new();
        let mut layout = None::<nsh_core::LayoutAnimation>;
        let mut scrolls = Vec::new();
        let mut focus_reveal: Option<FocusReveal> = None;
        let mut removed_focus = false;
        for item in batch.items {
            match item {
                MountItem::LayoutAnimation(animation) => layout = Some(animation),
                MountItem::Create { id, kind } => {
                    self.input_scrollers.retain(|&input| input != id);
                    self.forget_text_links(id);
                    self.composites.borrow_mut().invalidate(id);
                    self.canvas_pending.retain(|pending| *pending != id);
                    self.canvas_dirty.retain(|dirty| *dirty != id);
                    self.node_generation = self.node_generation.wrapping_add(1);
                    self.nodes
                        .resize_with(self.nodes.len().max(id as usize + 1), || None);
                    let mut node = Node::new(kind);
                    node.generation = self.node_generation;
                    self.nodes[id as usize] = Some(node);
                }
                MountItem::Insert {
                    parent,
                    child,
                    before,
                } => {
                    self.insert(parent, child, before, layout.as_ref());
                }
                MountItem::ProjectRoot {
                    parent,
                    id,
                    following,
                } => {
                    let before = following.into_iter().find(|&candidate| {
                        self.node(candidate)
                            .is_some_and(|node| node.parent == Some(parent))
                    });
                    self.insert(parent, id, before, layout.as_ref());
                }
                MountItem::RetireListCell { id, request, roots } => {
                    let focus = self.focus_path();
                    let retired = !roots.iter().any(|root| focus.contains(root));
                    if retired {
                        for &root in &roots {
                            if focus_reveal.as_ref().is_some_and(|reveal| {
                                self.ancestors(reveal.target.0).contains(&root)
                            }) {
                                focus_reveal = None;
                            }
                            removed_focus |= self.retire_recycled_focus(root);
                            self.cancel_input_within(root);
                        }
                        self.navigation_park(&roots);
                    }
                    self.events
                        .push(SurfaceEvent::ListCellRetired(id, request, retired));
                }
                MountItem::ListCellRetired { .. } => {}
                MountItem::Remove { id } => {
                    if self.navigation_is_parked(id) {
                        self.navigation_deleted(id);
                    }
                    if focus_reveal
                        .as_ref()
                        .is_some_and(|reveal| self.ancestors(reveal.target.0).contains(&id))
                    {
                        focus_reveal = None;
                    }
                    removed_focus |= self.retire_recycled_focus(id);
                    self.retire_input_within(id, focus_return.as_mut());
                    if self.navigation_removing(id) {
                        continue;
                    }
                    let now = self.now;
                    let retained = self.node_mut(id).is_some_and(|node| {
                        let transition = (!matches!(
                            node.kind,
                            ViewKind::Screen
                                | ViewKind::Modal
                                | ViewKind::Stack
                                | ViewKind::HeaderItem
                        ))
                        .then(|| layout.as_ref().and_then(|a| a.delete.as_ref()))
                        .flatten();
                        (transition.is_some() || node.motion.is_some())
                            && node
                                .motion
                                .get_or_insert_with(Box::default)
                                .removing(transition, now)
                    });
                    if !retained {
                        self.detach(id);
                    }
                }
                MountItem::Delete { id } => {
                    self.input_scrollers.retain(|&input| input != id);
                    if let Some(node) = self.node_mut(id) {
                        node.component_slots.clear();
                    }
                    if self.navigation_is_parked(id) {
                        self.navigation_deleted(id);
                    }
                    if let Some((owner, _)) = self.text_link(id) {
                        if focus_reveal
                            .as_ref()
                            .is_some_and(|reveal| reveal.target.0 == id)
                        {
                            focus_reveal = None;
                        }
                        removed_focus |= self.retire_recycled_focus(id);
                        self.retire_input_within(id, focus_return.as_mut());
                        self.text_links.remove(&id);
                        if let Some((text, ..)) = self
                            .nodes
                            .get_mut(owner as usize)
                            .and_then(Option::as_mut)
                            .and_then(|node| node.text.as_mut())
                        {
                            let text = Arc::make_mut(text);
                            text.links.retain(|link| link.node != id);
                            for (index, link) in text.links.iter().enumerate() {
                                if let Some((current, position)) =
                                    self.text_links.get_mut(&link.node)
                                    && *current == owner
                                {
                                    *position = index;
                                }
                            }
                        }
                        continue;
                    }
                    self.retire_input_within(id, focus_return.as_mut());
                    if self.navigation_removing(id) {
                        if let Some(node) = self.node_mut(id) {
                            node.delete_pending = true;
                        }
                        continue;
                    }
                    let now = self.now;
                    if !self.is_dying(id)
                        && self.node(id).is_some_and(|node| {
                            !matches!(
                                node.kind,
                                ViewKind::Screen
                                    | ViewKind::Modal
                                    | ViewKind::Stack
                                    | ViewKind::HeaderItem
                            )
                        })
                        && let Some(transition) = layout
                            .as_ref()
                            .and_then(|animation| animation.delete.as_ref())
                        && let Some(node) = self.node_mut(id)
                    {
                        node.motion
                            .get_or_insert_with(Box::default)
                            .removing(Some(transition), now);
                    }
                    if self.is_dying(id) {
                        if let Some(node) = self.node_mut(id) {
                            node.delete_pending = true;
                        }
                        continue;
                    }
                    self.detach(id);
                    self.composites.borrow_mut().invalidate(id);
                    self.canvas_pending.retain(|pending| *pending != id);
                    self.forget_text_links(id);
                    if let Some(node) = self.nodes.get_mut(id as usize) {
                        *node = None;
                    }
                    self.autofocus_seen.retain(|&seen| seen != id);
                    self.canvas_dirty.retain(|&dirty| dirty != id);
                }
                MountItem::Frame { id, frame } => {
                    let now = self.now;
                    if let Some(node) = self.node_mut(id) {
                        let transition = (!matches!(
                            node.kind,
                            ViewKind::Screen
                                | ViewKind::Modal
                                | ViewKind::Stack
                                | ViewKind::HeaderItem
                        ))
                        .then(|| layout.as_ref().and_then(|a| a.update.as_ref()))
                        .flatten();
                        if transition.is_some() || node.motion.is_some() {
                            let from = node
                                .motion
                                .as_ref()
                                .map_or(node.frame, |motion| motion.frame(node.frame, now));
                            node.motion
                                .get_or_insert_with(Box::default)
                                .frame_changed(from, transition, now);
                        }
                        node.frame = frame;
                        if node.kind == ViewKind::Scroll {
                            scrolls.push(id);
                        }
                    }
                    let requests = self
                        .node_mut(id)
                        .map(|node| {
                            node.image.resize(Size {
                                width: frame.size.width,
                                height: frame.size.height,
                            })
                        })
                        .unwrap_or_default();
                    for request in requests {
                        self.request_view_image(id, request);
                    }
                    self.dirty_canvas(id);
                }
                MountItem::ViewStyle { id, style } => {
                    let now = self.now;
                    if let Some(node) = self.node_mut(id) {
                        if style.transition.is_some()
                            || style.animation.is_some()
                            || node.motion.is_some()
                        {
                            let from = node.motion.as_ref().map_or_else(
                                || (*node.style).clone(),
                                |motion| {
                                    motion
                                        .sample(node.frame, &node.style, now)
                                        .style
                                        .into_owned()
                                },
                            );
                            node.motion
                                .get_or_insert_with(Box::default)
                                .style_changed(&from, &style, now);
                        }
                        node.style = style;
                    }
                }
                MountItem::ViewProps { id, props } => {
                    if let Some(node) = self.node_mut(id) {
                        node.props = props;
                    }
                }
                MountItem::AccessibilityLabel { id, label } => {
                    if let Some(node) = self.node_mut(id) {
                        node.props.accessibility.label = label;
                    }
                }
                MountItem::TrackStates { id, states } => {
                    if let Some(node) = self.node_mut(id) {
                        node.tracked = states;
                        tracked.push(id);
                    }
                }
                MountItem::Events { id, events } => {
                    if let Some(node) = self.node_mut(id) {
                        node.events = events;
                    }
                }
                MountItem::Text {
                    id,
                    text,
                    layout,
                    content,
                } => {
                    let retired = self
                        .node(id)
                        .and_then(|node| node.text.as_ref())
                        .map(|(old, ..)| {
                            old.links
                                .iter()
                                .filter(|link| {
                                    self.text_link(link.node)
                                        .is_some_and(|(owner, _)| owner == id)
                                })
                                .filter(|link| {
                                    !text
                                        .links
                                        .iter()
                                        .any(|next| next.node == link.node && next.is_enabled())
                                })
                                .map(|link| link.node)
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    for link in retired {
                        self.retire_input_within(link, None);
                        removed_focus |= self.retire_recycled_focus(link);
                    }
                    self.forget_text_links(id);
                    if let Some(node) = self.node_mut(id) {
                        node.editor.label_text(&text.text);
                        node.text = Some((text, layout, content));
                    }
                    self.index_text_links(id);
                }
                MountItem::Input { id, config } => {
                    let reports_scroll = config.multiline && config.replaced;
                    let was_reporting = self.input_scrollers.contains(&id);
                    if reports_scroll && !was_reporting {
                        self.input_scrollers.push(id);
                    } else if !reports_scroll && was_reporting {
                        self.input_scrollers.retain(|&input| input != id);
                    }
                    let selection_changed = if let Some(node) = self.node_mut(id) {
                        if node.input.multiline != config.multiline
                            || node.input.secure != config.secure
                        {
                            node.request_input_reveal();
                        }
                        // A true-to-true theme change can recreate the core bar
                        // and clear its report without changing the viewport.
                        node.reported_input_scroll = None;
                        let changed = node.editor.set_tokens(&config.tokens);
                        node.input = *config;
                        changed
                    } else {
                        false
                    };
                    if selection_changed {
                        self.report_selection(id);
                    }
                }
                MountItem::InputValue { id, text, count } => self.input_value(id, text, count),
                MountItem::InputContent { id, content } => {
                    if let Some(node) = self.node_mut(id) {
                        node.input_content = content;
                    }
                }
                MountItem::ScrollConfig {
                    id,
                    horizontal,
                    scrollbar_visible,
                    replaced: _,
                    scroll_value,
                    pull_value,
                    mirrored,
                    keyboard_dismiss,
                } => {
                    if let Some(node) = self.node_mut(id) {
                        node.scroll.horizontal = horizontal;
                        node.scroll.shows_indicator = scrollbar_visible;
                        node.scroll.scroll_value = scroll_value;
                        node.scroll.pull_value = pull_value.filter(|_| !horizontal);
                        node.scroll.mirrored = mirrored;
                    }
                    self.set_scroll_keyboard_dismiss(id, keyboard_dismiss);
                }
                MountItem::ScrollContent { id, size } => {
                    if let Some(node) = self.node_mut(id) {
                        node.scroll.content = size;
                        scrolls.push(id);
                    }
                }
                MountItem::ScrollBehavior { id, behavior } => {
                    let mut refresh_changed = false;
                    if let Some(node) = self.node_mut(id) {
                        refresh_changed =
                            node.scroll.behavior.refresh_indicator != behavior.refresh_indicator;
                        node.scroll.enabled = behavior.enabled;
                        node.scroll.behavior = behavior;
                        scrolls.push(id);
                    }
                    if refresh_changed {
                        self.refresh_inset_changed(id);
                    }
                }
                MountItem::ScrollBy { id, dx, dy } => self.adjust_scroll(id, dx, dy),
                MountItem::StickyCells { id, cells } => {
                    if let Some(node) = self.node_mut(id) {
                        node.scroll.sticky = cells;
                    }
                }
                MountItem::Keymap(keymap) => self.keymap = keymap,
                MountItem::ScreenConfig { id, config } => {
                    if let Some(node) = self.node_mut(id) {
                        node.screen = *config;
                    }
                }
                MountItem::ModalConfig { id, config } => {
                    if let Some(node) = self.node_mut(id) {
                        node.modal = config;
                    }
                }
                MountItem::Appearance { appearance } => {
                    self.dark = appearance.resolve(if self.dark {
                        nsh_core::platform::ColorScheme::Dark
                    } else {
                        nsh_core::platform::ColorScheme::Light
                    }) == nsh_core::platform::ColorScheme::Dark
                }
                MountItem::Animation(op) => {
                    self.animation.apply(op, &mut finished);
                }
                MountItem::ComponentPropSlots { id, names } => {
                    if let Some(node) = self.node_mut(id) {
                        node.component_slots = names
                            .into_iter()
                            .enumerate()
                            .map(|(slot, name)| {
                                let previous = node
                                    .component_slots
                                    .get(slot)
                                    .filter(|(old, _)| *old == name)
                                    .and_then(|(_, value)| *value);
                                (name, previous)
                            })
                            .collect();
                    }
                }
                MountItem::AnimationBindings { id, bindings } => {
                    if let Some(node) = self.node_mut(id) {
                        for (slot, (_, value)) in node.component_slots.iter_mut().enumerate() {
                            if !bindings
                                .iter()
                                .any(|(prop, _)| *prop == AnimationProp::ComponentSlot(slot as u16))
                            {
                                *value = None;
                            }
                        }
                        node.bindings = bindings;
                    }
                }
                MountItem::Gestures { id, values } => {
                    if let Some(node) = self.node_mut(id) {
                        node.gestures = values;
                    }
                }
                MountItem::Canvas { id, drawing } => {
                    let images: Vec<_> = drawing
                        .images()
                        .map(|image| image.uri.to_string())
                        .collect();
                    if let Some(node) = self.node_mut(id) {
                        node.drawing = Some(drawing);
                    }
                    for uri in images {
                        self.request_image(uri, None);
                    }
                    self.dirty_canvas(id);
                }
                MountItem::Image {
                    id,
                    source,
                    resize_mode,
                    options,
                } => {
                    let now = self.now;
                    let requests = self
                        .node_mut(id)
                        .map(|node| node.image.update(source, resize_mode, options, now))
                        .unwrap_or_default();
                    for request in requests {
                        self.request_view_image(id, request);
                    }
                }
                MountItem::Component { id, name } => {
                    let native = self.components.create(&name);
                    if let Some(node) = self.node_mut(id) {
                        node.native = native;
                        for (_, value) in &mut node.component_slots {
                            *value = None;
                        }
                    }
                    self.component_size(id);
                }
                MountItem::ComponentProps { id, props } => {
                    for (name, value) in props {
                        let response = self
                            .node_mut(id)
                            .and_then(|node| node.native.as_mut())
                            .map(|component| component.set_prop(&name, value.as_ref()));
                        if let Some(response) = response {
                            self.component_response(id, response);
                        }
                    }
                    self.component_size(id);
                }
                MountItem::Command { id, command } => {
                    let requested_focus =
                        matches!(command, Command::Focus | Command::AccessibilityFocus);
                    let focus_command = requested_focus || matches!(command, Command::Blur);
                    let explicit_scroll = match &command {
                        Command::ScrollTo { x, y, .. } => x.0.is_finite() && y.0.is_finite(),
                        Command::ScrollToEnd { .. } => true,
                        Command::ZoomTo { scale, .. } => scale.is_finite(),
                        _ => false,
                    };
                    let old_focus = self.focus;
                    self.command(id, command);
                    if focus_command {
                        if !requested_focus {
                            focus_reveal = None;
                            if self.focus.is_none() {
                                self.focus_history.clear();
                                removed_focus = false;
                            }
                        } else if self.focus != old_focus || self.focus.is_none() {
                            let target = self
                                .focus_owner(id)
                                .and_then(|owner| self.node(owner))
                                .map(|node| (id, node.generation));
                            if focus_reveal.as_ref().map(|reveal| reveal.target) != target {
                                focus_reveal = target.map(|target| FocusReveal {
                                    target,
                                    overridden: Vec::new(),
                                });
                            }
                        } else if focus_reveal
                            .as_ref()
                            .is_some_and(|reveal| reveal.target.0 != id)
                        {
                            focus_reveal = None;
                        }
                    } else if self.focus != old_focus {
                        focus_reveal = None;
                    } else if explicit_scroll
                        && let Some(reveal) = &mut focus_reveal
                        && let Some(node) = self.node(id)
                    {
                        reveal.overridden.push((id, node.generation));
                    }
                }
                MountItem::NativeProps { id, props } => self.set_media(id, props),
                MountItem::Refreshing { id, refreshing } => self.set_refreshing(id, refreshing),
                MountItem::Overflow { .. } | MountItem::LayoutDirection { .. } => {}
                // A terminal has no GPU layer: a shader view shows its
                // background and children.
                MountItem::Shader { .. } => {}
            }
        }
        if !finished.is_empty() {
            self.events.push(SurfaceEvent::AnimationsFinished(finished));
        }
        scrolls.sort_unstable();
        scrolls.dedup();
        for id in scrolls {
            self.clamp_scroll(id);
        }
        self.navigation_reconcile();
        if let Some(reveal) = &focus_reveal
            && self.visible_ids().contains(&reveal.target.0)
            && self.focusable(reveal.target.0)
        {
            self.set_focus_from(Some(reveal.target.0), crate::input::FocusSource::Mount);
        }
        let opened_popups = self.reconcile_focus_return(focus_return);
        self.reconcile_focus(removed_focus);
        self.focus_opened_popups(&opened_popups);
        if let Some(reveal) = focus_reveal
            && self.focus == Some(reveal.target.0)
            && self
                .focus_owner(reveal.target.0)
                .and_then(|owner| self.node(owner))
                .is_some_and(|node| node.generation == reveal.target.1)
        {
            self.reveal_focus(reveal.target.0, &reveal.overridden);
        }
        for id in tracked {
            self.refresh_input_states(id);
        }
        self.selectable_view_sync();
        self.update_component_props();
        self.update_canvas_args();
        self.schedule_graphics();
    }

    fn command(&mut self, id: NodeId, command: Command) {
        let now = self.now;
        if self
            .node_mut(id)
            .and_then(|node| node.media.as_mut())
            .is_some_and(|media| media.command(&command, now))
        {
            self.drain_media_events(id);
            return;
        }
        match command {
            Command::Focus | Command::AccessibilityFocus => {
                self.set_focus_from(Some(id), FocusSource::Mount)
            }
            Command::Blur => self.set_focus(None),
            Command::SetSelection { start, end } => self.selection(id, start, end),
            command @ Command::ReplaceRange { .. } => self.replace_input_range(id, command),
            Command::ScrollTo { x, y, animated } => {
                if self
                    .node(id)
                    .is_some_and(|node| node.kind == ViewKind::Input)
                {
                    self.scroll_input_to(id, y);
                } else {
                    self.scroll_command(id, x, y, animated);
                }
            }
            Command::ZoomTo {
                scale,
                center,
                animated,
            } => self.zoom_scroll(id, scale, center, animated),
            Command::ScrollToEnd { animated } => {
                if let Some(node) = self.node(id) {
                    self.scroll_command(
                        id,
                        node.scroll.content.width * node.scroll.physics.zoom,
                        node.scroll.content.height * node.scroll.physics.zoom,
                        animated,
                    );
                }
            }
            Command::Back => self.back(),
            Command::ExitApp => self.quit = true,
            Command::Dialog(dialog) => {
                self.dialog = Some(*dialog);
                self.dialog_selection = 0;
            }
            Command::Announce(text) => self.announce(text),
            Command::SetClipboard(text) => self.write_clipboard(text),
            Command::ReadClipboard { id, has_only } => self.read_clipboard(id, has_only),
            // A terminal has no system image picker. Complete the request as
            // cancelled instead of leaving the app's answer pending.
            Command::PickImages { id, .. } => self.emit(
                ROOT_ID,
                EventKind::Pick,
                EventPayload::Picked {
                    id,
                    files: Vec::new(),
                },
            ),
            // Terminal surfaces do not launch external applications. The host
            // channel may already have handled the URL before it reaches us.
            Command::OpenUrl { id, .. } => self.emit(
                ROOT_ID,
                EventKind::OpenUrl,
                EventPayload::Map(vec![
                    ("id", PayloadValue::Number(f64::from(id))),
                    ("opened", PayloadValue::Bool(false)),
                ]),
            ),
            Command::ImageInfo { id, uri } => self.request_image(uri, Some(id)),
            Command::Native { name, args } => {
                let response = self
                    .node_mut(id)
                    .and_then(|node| node.native.as_mut())
                    .map(|component| component.command(&name, &args));
                if let Some(response) = response {
                    self.component_response(id, response);
                }
                self.component_size(id);
            }
            Command::Desktop(command) => self.desktop_command(*command),
            Command::StatusBar(_)
            | Command::SetStatusBar(_)
            | Command::LayoutAnimation(_)
            | Command::SetJsResponder { .. }
            | Command::ClearJsResponder => {}
            other => log::debug!("terminal command: {other:?}"),
        }
    }

    pub(crate) fn scroll_to(&mut self, id: NodeId, x: Points, y: Points) {
        self.scroll_jump(id, x, y);
    }

    fn clamp_scroll(&mut self, id: NodeId) {
        self.clamp_scroll_state(id);
    }

    pub(crate) fn back(&mut self) {
        self.navigation_back();
    }

    /// Advances native animations and polls completed image/canvas jobs.
    /// `now` is a monotonic timestamp in seconds.
    pub fn tick(&mut self, now: f64) -> bool {
        self.now = now;
        let mut finished = Vec::new();
        let mut changed = self.animation.tick(now, &mut finished);
        changed |= self.navigation_tick();
        changed |= self.tick_motion();
        changed |= self.tick_scroll(now);
        changed |= self.input_tick();
        if !finished.is_empty() {
            self.events.push(SurfaceEvent::AnimationsFinished(finished));
        }
        if self.toast.as_ref().is_some_and(|(_, until)| now >= *until) {
            self.toast = None;
            changed = true;
        }
        changed |= self.tick_media();
        changed |= self.poll_graphics();
        let revision = self.fonts.revision();
        if revision != self.fonts_revision {
            self.fonts_revision = revision;
            let ids: Vec<_> = self
                .nodes
                .iter()
                .enumerate()
                .filter_map(|(id, n)| {
                    n.as_ref()
                        .filter(|n| n.drawing.is_some())
                        .map(|_| id as NodeId)
                })
                .collect();
            for id in ids {
                self.dirty_canvas(id);
            }
            changed = true;
        }
        changed |= self.tick_images();
        changed |= self.update_component_props();
        self.update_canvas_args();
        self.schedule_graphics();
        changed
    }

    /// Whether an animation or a temporary overlay needs another frame.
    pub fn animating(&self) -> bool {
        self.animation.is_animating()
            || self.navigation_animating()
            || self.scroll_animating()
            || self.composites.borrow().pending()
            || self.input_pending()
            || self.toast.is_some()
            || !self.canvas_pending.is_empty()
            || !self.pending_images.is_empty()
            || !self.pending_blurs.is_empty()
            || self.protocol.pending()
            || self.nodes.iter().flatten().any(|n| {
                n.media.as_ref().is_some_and(|media| media.active())
                    || n.motion.as_ref().is_some_and(|m| m.active())
                    || n.image.animating(self.now)
                    || n.drawing.as_ref().is_some_and(|drawing| {
                        drawing.images().any(|image| {
                            self.image_cache
                                .get(image.uri.as_ref())
                                .is_some_and(|cached| {
                                    !cached.animation.finished(
                                        ((self.now - cached.started).max(0.0) * 1000.0) as u64,
                                    )
                                })
                        })
                    })
            })
    }

    pub(crate) fn is_dying(&self, id: NodeId) -> bool {
        let id = self.focus_owner(id).unwrap_or(id);
        if self.navigation_retains(id) {
            return true;
        }
        let mut current = Some(id);
        while let Some(id) = current {
            let Some(node) = self.node(id) else {
                break;
            };
            if node.motion.as_ref().is_some_and(|motion| motion.dying()) {
                return true;
            }
            if node.kind == ViewKind::Modal {
                break;
            }
            current = node.parent;
        }
        false
    }

    fn tick_motion(&mut self) -> bool {
        let mut due = Vec::new();
        let mut changed = false;
        for (id, node) in self.nodes.iter_mut().enumerate() {
            let Some(node) = node else {
                continue;
            };
            if let Some(motion) = &mut node.motion {
                changed |= motion.active();
                if motion.advance(self.now) {
                    due.push(id as NodeId);
                } else if !motion.active() {
                    node.motion = None;
                }
            }
        }
        for id in due {
            self.finish_retained_removal(id);
        }
        if changed {
            self.reconcile_focus(false);
        }
        changed
    }

    pub(crate) fn finish_retained_removal(&mut self, id: NodeId) {
        self.detach(id);
        let mut descendants = vec![id];
        let mut index = 0;
        while index < descendants.len() {
            if let Some(node) = self.node(descendants[index]) {
                descendants.extend(node.children.iter().copied());
            }
            index += 1;
        }
        for id in descendants.into_iter().rev() {
            if self.node(id).is_some_and(|node| node.delete_pending) {
                self.forget_text_links(id);
                self.nodes[id as usize] = None;
                self.composites.borrow_mut().invalidate(id);
                self.canvas_pending.retain(|pending| *pending != id);
                self.autofocus_seen.retain(|seen| *seen != id);
                self.canvas_dirty.retain(|dirty| *dirty != id);
            } else if let Some(node) = self.node_mut(id) {
                node.motion = None;
            }
        }
    }

    pub(crate) fn animated_style(&self, id: NodeId) -> ViewStyle {
        let Some(node) = self.node(id) else {
            return ViewStyle::default();
        };
        let mut style = node.motion.as_ref().map_or_else(
            || (*node.style).clone(),
            |motion| {
                motion
                    .sample(node.frame, &node.style, self.now)
                    .style
                    .into_owned()
            },
        );
        let mut transform = Transform::IDENTITY;
        for (index, op) in style.transform.ops().iter().enumerate() {
            let value = node
                .bindings
                .iter()
                .find_map(|(prop, value)| {
                    (*prop == AnimationProp::Transform(index as u8))
                        .then(|| self.animation.eval(*value).number())
                })
                .unwrap_or(op.value);
            transform.push(op.kind, value);
        }
        style.transform = transform;
        for &(prop, value) in &node.bindings {
            let value = self.animation.eval(value);
            let color = match value {
                AnimationValue::Color(color) => Color(color),
                value => Color(value.number() as u32),
            };
            match prop {
                AnimationProp::Opacity => style.opacity = value.number(),
                AnimationProp::BackgroundColor => style.background_color = color,
                AnimationProp::BorderColor => style.borders.colors = [color; 4],
                _ => {}
            }
        }
        if let Some(motion) = &node.motion {
            style.opacity *= motion.appearance(self.now).0;
        }
        style.opacity *= self.navigation_values(id).2;
        style
    }

    /// Nodes in drawing order, including the scenes below a modal.
    pub(crate) fn paint_ids(&self) -> Vec<NodeId> {
        let mut result = Vec::new();
        let mut modals = Vec::new();
        self.collect_layer(ROOT_ID, &mut result, &mut modals, true);
        let mut index = 0;
        while index < modals.len() {
            self.navigation_order_modals(&mut modals[index..]);
            self.collect_layer(modals[index], &mut result, &mut modals, true);
            index += 1;
        }
        result
    }

    fn collect_layer(
        &self,
        id: NodeId,
        result: &mut Vec<NodeId>,
        modals: &mut Vec<NodeId>,
        layer_root: bool,
    ) {
        let Some(node) = self.node(id) else {
            return;
        };
        if (node.popped && !self.navigation_draws_screen(node.parent.unwrap_or(ROOT_ID), id))
            || node.style.hidden
        {
            return;
        }
        if node.kind == ViewKind::Modal && !layer_root {
            modals.push(id);
            return;
        }
        result.push(id);
        let top = (node.kind == ViewKind::Stack)
            .then(|| {
                node.children.iter().rev().copied().find(|&child| {
                    self.node(child)
                        .is_some_and(|n| n.kind == ViewKind::Screen && !n.popped)
                })
            })
            .flatten();
        // Header slots are independent layout roots, drawn above screen content.
        let mut headers = Vec::new();
        for &child in &node.children {
            if top.is_some_and(|top| {
                top != child
                    && self.node(child).is_some_and(|n| n.kind == ViewKind::Screen)
                    && !self.navigation_draws_screen(id, child)
            }) {
                continue;
            }
            if node.kind == ViewKind::Screen
                && self
                    .node(child)
                    .is_some_and(|n| n.kind == ViewKind::HeaderItem)
            {
                if node.screen.header_view == Some(child) {
                    headers.push(child);
                }
                continue;
            }
            self.collect_layer(child, result, modals, false);
        }
        for child in headers {
            self.collect_layer(child, result, modals, false);
        }
    }

    fn collect_visible(&self, id: NodeId, result: &mut Vec<NodeId>) {
        let Some(node) = self.node(id) else {
            return;
        };
        if node.popped || node.style.hidden || self.is_dying(id) || !self.navigation_accepts(id) {
            return;
        }
        result.push(id);
        let top_screen = if node.kind == ViewKind::Stack {
            node.children.iter().rev().copied().find(|&child| {
                self.node(child)
                    .is_some_and(|n| n.kind == ViewKind::Screen && !n.popped)
            })
        } else {
            None
        };
        let mut header = None;
        for &child in &node.children {
            if node.kind == ViewKind::Screen
                && self
                    .node(child)
                    .is_some_and(|n| n.kind == ViewKind::HeaderItem)
            {
                if node.screen.header_view == Some(child) {
                    header = Some(child);
                }
                continue;
            }
            if top_screen.is_some_and(|top| {
                top != child && self.node(child).is_some_and(|n| n.kind == ViewKind::Screen)
            }) {
                continue;
            }
            self.collect_visible(child, result);
        }
        if let Some(header) = header {
            self.collect_visible(header, result);
        }
    }

    /// The newest modal is the root of the active input scope.
    pub(crate) fn visible_ids(&self) -> Vec<NodeId> {
        let ids = self.paint_ids();
        let active = if let Some(modal) = ids
            .iter()
            .rev()
            .copied()
            .find(|&id| self.node(id).is_some_and(|n| n.kind == ViewKind::Modal))
        {
            let mut active = Vec::new();
            self.collect_visible(modal, &mut active);
            active
        } else {
            ids.into_iter()
                .filter(|&id| !self.is_dying(id) && self.navigation_accepts(id))
                .collect()
        };
        let mut result = Vec::with_capacity(active.len());
        for id in active {
            result.push(id);
            if let Some((text, ..)) = self.node(id).and_then(|node| node.text.as_ref()) {
                result.extend(text.links.iter().map(|link| link.node));
            }
        }
        result
    }

    pub(crate) fn presentation_frame(&self, id: NodeId) -> Option<Bounds<Points>> {
        let node = self.node(id)?;
        let mut frame = node.motion.as_ref().map_or(node.frame, |motion| {
            motion.sample(node.frame, &node.style, self.now).frame
        });
        if node.kind == ViewKind::Modal {
            frame = self.modal_frame(id, frame);
        }
        let (x, y, _) = self.navigation_values(id);
        frame.origin.x += px(x);
        frame.origin.y += px(y);
        Some(frame)
    }

    pub(crate) fn clip_rect(&self, id: NodeId) -> Bounds<Points> {
        let viewport = self.viewport();
        let mut clip = Bounds::new(Point::new(px(0.0), px(0.0)), viewport);
        if self
            .node(id)
            .is_some_and(|node| node.kind == ViewKind::Modal)
        {
            return clip;
        }
        let mut parent = self.node(id).and_then(|node| node.parent);
        while let Some(id) = parent {
            let Some(node) = self.node(id) else {
                break;
            };
            if (matches!(node.kind, ViewKind::Scroll | ViewKind::Stack)
                || node.style.overflow_hidden)
                && let Some(frame) = self.global_frame(id)
            {
                clip = intersect(clip, frame);
            }
            if node.kind == ViewKind::Modal {
                break;
            }
            parent = node.parent;
        }
        clip
    }

    pub(crate) fn hit_test(&self, x: f32, y: f32) -> Option<NodeId> {
        self.hit_snapshot().hit_test(x, y)
    }

    fn dirty_canvas(&mut self, id: NodeId) {
        if self.node(id).is_some_and(|n| n.drawing.is_some()) && !self.canvas_dirty.contains(&id) {
            self.canvas_dirty.push(id);
        }
    }

    fn update_component_props(&mut self) -> bool {
        let mut responses = Vec::new();
        for (id, node) in self.nodes.iter_mut().enumerate() {
            let Some(node) = node else { continue };
            let Some(component) = node.native.as_mut() else {
                continue;
            };
            for &(prop, value_node) in &node.bindings {
                let AnimationProp::ComponentSlot(slot) = prop else {
                    continue;
                };
                let Some((name, previous)) = node.component_slots.get_mut(usize::from(slot)) else {
                    continue;
                };
                let value = AnimatedPropValue::from(self.animation.eval(value_node));
                if *previous == Some(value) {
                    continue;
                }
                let response = match value {
                    AnimatedPropValue::Number(value) => component.set_animated_number(name, value),
                    AnimatedPropValue::Color(argb) => component.set_animated_color(name, argb),
                    _ => continue,
                };
                *previous = Some(value);
                responses.push((id as NodeId, response));
            }
        }
        let changed = !responses.is_empty();
        for (id, response) in responses {
            self.component_response(id, response);
            self.component_size(id);
        }
        changed
    }

    fn update_canvas_args(&mut self) {
        let mut dirty = Vec::new();
        for (id, node) in self.nodes.iter_mut().enumerate() {
            let Some(node) = node else {
                continue;
            };
            if node.drawing.is_none() {
                continue;
            }
            let args: Vec<_> = node
                .bindings
                .iter()
                .filter_map(|(prop, value)| match prop {
                    AnimationProp::CanvasArg(slot) => Some((*slot, self.animation.eval(*value))),
                    _ => None,
                })
                .collect();
            if args != node.canvas_args {
                node.canvas_args = args;
                dirty.push(id as NodeId);
            }
        }
        for id in dirty {
            self.dirty_canvas(id);
        }
    }

    fn schedule_graphics(&mut self) {
        let mut remaining = Vec::new();
        for id in std::mem::take(&mut self.canvas_dirty) {
            if self.canvas_pending.contains(&id) {
                remaining.push(id);
                continue;
            }
            let Some(node) = self.node(id) else {
                continue;
            };
            let Some(drawing) = node.drawing.clone() else {
                continue;
            };
            if node.frame.size.width <= Points::ZERO || node.frame.size.height <= Points::ZERO {
                continue;
            }
            let images = drawing
                .images()
                .filter_map(|image| {
                    self.image_cache.get(image.uri.as_ref()).map(|cached| {
                        (
                            image.uri.clone(),
                            cached.animation.frames[cached.frame].clone(),
                        )
                    })
                })
                .collect();
            self.graphics.canvas(crate::worker::CanvasRequest {
                id,
                generation: node.generation,
                epoch: self.canvas_epoch,
                drawing,
                args: node.canvas_args.clone(),
                size: Size {
                    width: node.frame.size.width,
                    height: node.frame.size.height,
                },
                images,
            });
            self.canvas_pending.push(id);
        }
        self.canvas_dirty = remaining;
    }

    fn request_image(&mut self, uri: String, request: Option<u32>) {
        if !self.access.allows_media(&uri) {
            if let Some(id) = request {
                self.image_answer(id, Err("Image access was denied"));
            }
            return;
        }
        if let Some(animation) = self
            .image_cache
            .get(&uri)
            .map(|cached| cached.animation.clone())
        {
            if let Some(id) = request {
                self.image_answer(id, Ok(&animation.frames[0]));
            }
            return;
        }
        if !self.pending_images.contains_key(&uri) && self.pending_images.len() >= 128 {
            if let Some(id) = request {
                self.image_answer(id, Err("Too many pending terminal images"));
            }
            return;
        }
        let loading = self.pending_images.contains_key(&uri);
        let pending = self.pending_images.entry(uri.clone()).or_default();
        if let Some(id) = request {
            pending.requests.push(id);
        }
        if !loading {
            self.graphics
                .image(uri, None, self.assets.clone(), self.access.clone());
        }
    }

    fn request_view_image(&mut self, id: NodeId, request: crate::image_state::ImageRequest) {
        if !self
            .node(id)
            .is_some_and(|node| node.image.accepts(&request))
        {
            return;
        }
        let uri = request.source.uri.to_string();
        if !self.access.allows_media(&uri) {
            self.fail_view_image(id, &request, "Image access was denied".to_owned());
            return;
        }
        if let Some(animation) = self
            .image_cache
            .get(&uri)
            .map(|cached| cached.animation.clone())
        {
            self.prepare_view_image(id, request, animation, true);
            return;
        }
        if !self.pending_images.contains_key(&uri) && self.pending_images.len() >= 128 {
            self.fail_view_image(id, &request, "Too many pending terminal images".to_owned());
            return;
        }
        let loading = self.pending_images.contains_key(&uri);
        let pending = self.pending_images.entry(uri.clone()).or_default();
        pending
            .views
            .retain(|(node, old)| *node != id || old.role != request.role);
        let main = request.role == crate::image_state::ImageRole::Main;
        let data = request.source.data.clone();
        pending.views.push((id, request));
        if main {
            self.emit(id, EventKind::LoadStart, EventPayload::None);
        }
        if !loading {
            self.graphics
                .image(uri, data, self.assets.clone(), self.access.clone());
        }
    }

    fn prepare_view_image(
        &mut self,
        id: NodeId,
        request: crate::image_state::ImageRequest,
        animation: Arc<AnimatedRaster>,
        cached: bool,
    ) {
        if !self
            .node(id)
            .is_some_and(|node| node.image.accepts(&request))
        {
            return;
        }
        if request.blur_radius > Points::ZERO {
            if !self
                .pending_blurs
                .iter()
                .any(|(node, old)| *node == id && old.role == request.role)
            {
                self.pending_blurs.push((id, request.clone()));
                self.graphics.blur(id, request, animation);
            }
        } else {
            self.install_image(id, &request, animation, cached);
        }
    }

    fn install_image(
        &mut self,
        id: NodeId,
        request: &crate::image_state::ImageRequest,
        animation: Arc<AnimatedRaster>,
        cached: bool,
    ) {
        if !self.access.allows_media(&request.source.uri) {
            return;
        }
        let now = self.now;
        let dimensions = (animation.frames[0].width, animation.frames[0].height);
        let first = self
            .node(id)
            .is_some_and(|node| node.image.presentation(now).main.is_none());
        let installed = self.node_mut(id).is_some_and(|node| {
            if cached {
                node.image.install_cached(request, animation, now)
            } else {
                node.image.install(request, animation, now)
            }
        });
        if installed && first && request.role == crate::image_state::ImageRole::Main {
            self.emit(
                id,
                EventKind::Load,
                EventPayload::Image(Size::new(
                    nsh_core::geometry::DevicePixels(dimensions.0 as i32),
                    nsh_core::geometry::DevicePixels(dimensions.1 as i32),
                )),
            );
            self.emit(id, EventKind::LoadEnd, EventPayload::None);
        }
    }

    fn fail_view_image(
        &mut self,
        id: NodeId,
        request: &crate::image_state::ImageRequest,
        message: String,
    ) {
        if self
            .node_mut(id)
            .is_some_and(|node| node.image.fail(request))
            && request.role == crate::image_state::ImageRole::Main
        {
            self.emit(id, EventKind::Error, EventPayload::Error { message });
            self.emit(id, EventKind::LoadEnd, EventPayload::None);
        }
    }

    fn image_answer(&mut self, id: u32, result: Result<&Raster, &str>) {
        let mut fields = vec![("id", PayloadValue::Number(id as f64))];
        match result {
            Ok(raster) => {
                fields.push(("width", PayloadValue::Number(raster.width as f64)));
                fields.push(("height", PayloadValue::Number(raster.height as f64)));
            }
            Err(error) => fields.push(("error", PayloadValue::Str(error.to_owned()))),
        }
        self.emit(ROOT_ID, EventKind::ImageInfo, EventPayload::Map(fields));
    }

    fn poll_graphics(&mut self) -> bool {
        let mut changed = false;
        while let Some(result) = self.graphics.poll() {
            changed = true;
            match result {
                crate::worker::GraphicsResult::Composite(id, sequence, result) => {
                    self.composites.borrow_mut().complete(id, sequence, result);
                }
                crate::worker::GraphicsResult::Progress(uri, loaded, total) => {
                    let ids: Vec<_> = self
                        .pending_images
                        .get(&uri)
                        .map(|pending| {
                            pending
                                .views
                                .iter()
                                .filter_map(|(id, request)| {
                                    (request.role == crate::image_state::ImageRole::Main
                                        && self.node(*id).is_some_and(|node| {
                                            node.image.accepts(request)
                                                && node.image.accepts_progress(&uri)
                                        }))
                                    .then_some(*id)
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    for id in ids {
                        self.emit(
                            id,
                            EventKind::Progress,
                            EventPayload::Map(vec![
                                ("loaded", PayloadValue::Number(loaded as f64)),
                                ("total", PayloadValue::Number(total as f64)),
                            ]),
                        );
                    }
                }
                crate::worker::GraphicsResult::Blur(id, request, result) => {
                    self.pending_blurs
                        .retain(|(node, pending)| *node != id || pending != &request);
                    match result {
                        Ok(animation) => self.install_image(id, &request, animation, false),
                        Err(message) => self.fail_view_image(id, &request, message),
                    }
                    let requests = self
                        .node(id)
                        .map(|node| node.image.requests())
                        .unwrap_or_default();
                    for request in requests {
                        self.request_view_image(id, request);
                    }
                }
                crate::worker::GraphicsResult::Protocol(id, sequence, result) => {
                    self.protocol.complete(id, sequence, result)
                }
                crate::worker::GraphicsResult::Image(uri, result) => {
                    let PendingImage {
                        views: waiters,
                        requests,
                    } = self.pending_images.remove(&uri).unwrap_or_default();
                    let result = if self.access.allows_media(&uri) {
                        result
                    } else {
                        Err("Image access was denied".to_owned())
                    };
                    match result {
                        Ok(raster) => {
                            let raster = Arc::new(raster);
                            // Decoded pixels are bounded independently from compressed assets.
                            let bytes: usize = self
                                .image_cache
                                .values()
                                .map(|cached| cached.animation.bytes())
                                .sum();
                            if bytes + raster.bytes() > 64 * 1024 * 1024 {
                                self.image_cache.clear();
                            }
                            self.image_cache.insert(
                                uri.clone(),
                                CachedImage {
                                    animation: raster.clone(),
                                    started: self.now,
                                    frame: 0,
                                },
                            );
                            for (id, request) in waiters {
                                self.prepare_view_image(id, request, raster.clone(), false);
                            }
                            for id in requests {
                                self.image_answer(id, Ok(&raster.frames[0]));
                            }
                            let canvases: Vec<_> = self
                                .nodes
                                .iter()
                                .enumerate()
                                .filter_map(|(id, n)| {
                                    n.as_ref()
                                        .and_then(|n| n.drawing.as_ref())
                                        .map(|_| id as NodeId)
                                })
                                .collect();
                            for id in canvases {
                                self.dirty_canvas(id);
                            }
                        }
                        Err(error) => {
                            for (id, request) in waiters {
                                self.fail_view_image(id, &request, error.clone());
                            }
                            for id in requests {
                                self.image_answer(id, Err(&error));
                            }
                        }
                    }
                }
                crate::worker::GraphicsResult::Canvas(id, generation, epoch, result) => {
                    if !self
                        .node(id)
                        .is_some_and(|node| node.generation == generation)
                    {
                        continue;
                    }
                    self.canvas_pending.retain(|&pending| pending != id);
                    if epoch != self.canvas_epoch {
                        continue;
                    }
                    match result {
                        Ok(raster) => {
                            if let Some(node) = self.node_mut(id) {
                                node.canvas_raster = Some(Arc::new(raster));
                            }
                        }
                        Err(message) => {
                            self.emit(id, EventKind::Error, EventPayload::Error { message })
                        }
                    }
                }
            }
        }
        changed
    }

    fn tick_images(&mut self) -> bool {
        let mut changed = false;
        for node in self.nodes.iter_mut().flatten() {
            changed |= node.image.advance(self.now);
        }
        let mut canvas_changed = false;
        for cached in self.image_cache.values_mut() {
            let frame = cached
                .animation
                .frame_index(((self.now - cached.started).max(0.0) * 1000.0) as u64);
            if cached.frame != frame {
                cached.frame = frame;
                canvas_changed = true;
            }
        }
        if canvas_changed {
            let ids: Vec<_> = self
                .nodes
                .iter()
                .enumerate()
                .filter_map(|(id, node)| {
                    node.as_ref()
                        .and_then(|n| n.drawing.as_ref())
                        .map(|_| id as NodeId)
                })
                .collect();
            for id in ids {
                self.dirty_canvas(id);
            }
        }
        changed || canvas_changed
    }
}

pub(crate) fn intersect(a: Bounds<Points>, b: Bounds<Points>) -> Bounds<Points> {
    let x = a.origin.x.max(b.origin.x);
    let y = a.origin.y.max(b.origin.y);
    Bounds::new(
        point(x, y),
        Size::new(
            (a.right().min(b.right()) - x).max(Points::ZERO),
            (a.bottom().min(b.bottom()) - y).max(Points::ZERO),
        ),
    )
}

pub(crate) fn contains(rect: Bounds<Points>, x: f32, y: f32) -> bool {
    x >= rect.origin.x.0 && y >= rect.origin.y.0 && x < rect.right().0 && y < rect.bottom().0
}

#[cfg(test)]
mod tests {
    use nsh_core::{LayoutAnimation, LayoutCurve, LayoutProperty, LayoutTransition};

    use super::*;

    #[test]
    fn an_unsupported_url_open_answers_once_without_launching() {
        let mut surface = Surface::new(10, 5, CellMetrics::default());
        surface.apply(MountBatch {
            items: vec![MountItem::Command {
                id: ROOT_ID,
                command: Command::OpenUrl {
                    id: 42,
                    url: "https://example.com/".into(),
                },
            }],
        });
        let events: Vec<_> = surface.drain_events().collect();
        assert!(matches!(
            events.as_slice(),
            [SurfaceEvent::Event(ROOT_ID, EventKind::OpenUrl, EventPayload::Map(fields))]
                if matches!(fields.as_slice(), [
                    ("id", PayloadValue::Number(42.0)),
                    ("opened", PayloadValue::Bool(false))
                ])
        ));
        surface.tick(1.0);
        assert!(surface.drain_events().next().is_none());
    }

    #[test]
    fn list_cell_retirement_keeps_native_focus_until_it_can_detach() {
        let mut surface = Surface::new(40, 10, CellMetrics::default());
        surface.apply(MountBatch {
            items: vec![
                MountItem::Create {
                    id: 2,
                    kind: ViewKind::View,
                },
                MountItem::Frame {
                    id: 2,
                    frame: Bounds::new(Point::default(), Size::new(px(160.0), px(32.0))),
                },
                MountItem::ProjectRoot {
                    parent: ROOT_ID,
                    id: 2,
                    following: vec![],
                },
                MountItem::Create {
                    id: 4,
                    kind: ViewKind::Input,
                },
                MountItem::Input {
                    id: 4,
                    config: Box::new(InputConfig {
                        auto_focus: true,
                        ..Default::default()
                    }),
                },
                MountItem::InputValue {
                    id: 4,
                    text: "original cell".into(),
                    count: 0,
                },
                MountItem::Frame {
                    id: 4,
                    frame: Bounds::new(Point::default(), Size::new(px(160.0), px(32.0))),
                },
                MountItem::Insert {
                    parent: 2,
                    child: 4,
                    before: None,
                },
                MountItem::Create {
                    id: 6,
                    kind: ViewKind::Scroll,
                },
                MountItem::Frame {
                    id: 6,
                    frame: Bounds::new(point(px(160.0), px(0.0)), Size::new(px(160.0), px(32.0))),
                },
                MountItem::Insert {
                    parent: ROOT_ID,
                    child: 6,
                    before: None,
                },
            ],
        });
        assert_eq!(surface.focused(), Some(4));
        surface.drain_events().for_each(drop);
        surface.apply(MountBatch {
            items: vec![MountItem::RetireListCell {
                id: 2,
                request: 7,
                roots: vec![2],
            }],
        });
        assert_eq!(surface.focused(), Some(4));
        assert_eq!(
            surface.input_context().unwrap().text.as_deref(),
            Some("original cell")
        );
        assert_eq!(
            surface
                .drain_events()
                .filter_map(|event| match event {
                    SurfaceEvent::ListCellRetired(id, request, retired) =>
                        Some((id, request, retired)),
                    _ => None,
                })
                .collect::<Vec<_>>(),
            [(2, 7, false)]
        );

        surface.set_focus(Some(6));
        surface.drain_events().for_each(drop);
        surface.apply(MountBatch {
            items: vec![MountItem::RetireListCell {
                id: 2,
                request: 8,
                roots: vec![2],
            }],
        });
        assert_eq!(surface.focused(), Some(6));
        assert!(!surface.visible_ids().contains(&4));
        assert_eq!(
            surface
                .drain_events()
                .filter_map(|event| match event {
                    SurfaceEvent::ListCellRetired(id, request, retired) =>
                        Some((id, request, retired)),
                    _ => None,
                })
                .collect::<Vec<_>>(),
            [(2, 8, true)]
        );

        surface.apply(MountBatch {
            items: vec![MountItem::ProjectRoot {
                parent: ROOT_ID,
                id: 2,
                following: vec![],
            }],
        });
        surface.set_focus(Some(4));
        surface.apply(MountBatch {
            items: vec![MountItem::Remove { id: 2 }],
        });
        assert_ne!(
            surface.focused(),
            Some(4),
            "source removal must revoke the focused owner"
        );
        assert!(!surface.visible_ids().contains(&4));
    }

    #[test]
    fn list_cell_retirement_parks_and_restores_promoted_modal_roots_together() {
        let mut surface = Surface::new(60, 20, CellMetrics::default());
        let group = vec![2, 8, 12];
        let frame = Bounds::new(Point::default(), Size::new(px(160.0), px(32.0)));
        let roots = [
            (2, ViewKind::View, ROOT_ID),
            (4, ViewKind::Input, 2),
            (8, ViewKind::Modal, ROOT_ID),
            (12, ViewKind::View, 8),
            (14, ViewKind::Input, 12),
        ];
        let mut items = Vec::new();
        for (id, kind, parent) in roots {
            items.push(MountItem::Create { id, kind });
            if kind == ViewKind::Modal {
                items.push(MountItem::ModalConfig {
                    id,
                    config: nsh_core::ModalConfig {
                        animation: nsh_core::ModalAnimation::None,
                        ..Default::default()
                    },
                });
            }
            items.push(MountItem::Frame { id, frame });
            if [2, 8, 12].contains(&id) {
                items.push(MountItem::ProjectRoot {
                    parent,
                    id,
                    following: vec![],
                });
            } else {
                items.push(MountItem::Insert {
                    parent,
                    child: id,
                    before: None,
                });
            }
        }
        surface.apply(MountBatch { items });
        surface.set_focus(Some(14));
        surface.drain_events().for_each(drop);
        surface.apply(MountBatch {
            items: vec![MountItem::RetireListCell {
                id: 2,
                request: 1,
                roots: group.clone(),
            }],
        });
        assert_eq!(surface.focused(), Some(14));
        assert_eq!(surface.node(2).unwrap().parent, Some(ROOT_ID));
        assert_eq!(surface.node(8).unwrap().parent, Some(ROOT_ID));
        assert_eq!(surface.node(12).unwrap().parent, Some(8));
        assert!(
            surface
                .drain_events()
                .any(|event| matches!(event, SurfaceEvent::ListCellRetired(2, 1, false)))
        );

        surface.apply(MountBatch {
            items: vec![
                MountItem::Create {
                    id: 16,
                    kind: ViewKind::Modal,
                },
                MountItem::ModalConfig {
                    id: 16,
                    config: nsh_core::ModalConfig {
                        animation: nsh_core::ModalAnimation::None,
                        ..Default::default()
                    },
                },
                MountItem::ProjectRoot {
                    parent: ROOT_ID,
                    id: 16,
                    following: vec![],
                },
                MountItem::Create {
                    id: 18,
                    kind: ViewKind::Input,
                },
                MountItem::Frame { id: 18, frame },
                MountItem::Insert {
                    parent: 16,
                    child: 18,
                    before: None,
                },
            ],
        });
        surface.set_focus(Some(18));
        surface.drain_events().for_each(drop);
        surface.apply(MountBatch {
            items: vec![MountItem::RetireListCell {
                id: 2,
                request: 2,
                roots: group.clone(),
            }],
        });
        for &id in &group {
            assert_eq!(surface.node(id).unwrap().parent, None);
        }
        assert_eq!(surface.focused(), Some(18));
        assert!(surface.drain_events().all(|event| !matches!(
            event,
            SurfaceEvent::Event(_, EventKind::Show | EventKind::Dismiss, _)
        )));
        surface.apply(MountBatch {
            items: vec![MountItem::ListCellRetired {
                roots: group.clone(),
            }],
        });
        assert_eq!(surface.focused(), Some(18));
        assert!(!surface.paint_ids().contains(&8));
        surface.apply(MountBatch {
            items: vec![
                MountItem::ProjectRoot {
                    parent: ROOT_ID,
                    id: 2,
                    following: vec![16],
                },
                MountItem::ProjectRoot {
                    parent: ROOT_ID,
                    id: 8,
                    following: vec![16],
                },
                MountItem::ProjectRoot {
                    parent: 8,
                    id: 12,
                    following: vec![],
                },
            ],
        });
        assert_eq!(surface.focused(), Some(18));
        assert_eq!(surface.visible_ids().first(), Some(&16));
        assert!(surface.drain_events().all(|event| !matches!(
            event,
            SurfaceEvent::Event(_, EventKind::Show | EventKind::Dismiss, _)
        )));

        surface.apply(MountBatch {
            items: vec![MountItem::Remove { id: 16 }],
        });
        surface.set_focus(Some(14));
        assert_eq!(surface.focused(), Some(14));
        surface.apply(MountBatch {
            items: vec![MountItem::Remove { id: 8 }],
        });
        assert_ne!(surface.focused(), Some(14));
        assert!(!surface.visible_ids().contains(&14));
    }

    #[test]
    fn projected_roots_choose_the_first_surviving_cross_cell_anchor() {
        let frame = Bounds::new(Point::default(), Size::new(px(160.0), px(32.0)));
        for parked in [vec![], vec![4], vec![6], vec![4, 6]] {
            let mut surface = Surface::new(60, 20, CellMetrics::default());
            for id in [2, 4, 6] {
                create(&mut surface, id, ViewKind::View, ROOT_ID, frame);
                create(&mut surface, id + 10, ViewKind::Input, id, frame);
            }
            create(&mut surface, 20, ViewKind::Input, ROOT_ID, frame);
            surface.apply(MountBatch {
                items: vec![
                    MountItem::ProjectRoot {
                        parent: ROOT_ID,
                        id: 6,
                        following: vec![],
                    },
                    MountItem::ProjectRoot {
                        parent: ROOT_ID,
                        id: 4,
                        following: vec![6],
                    },
                    MountItem::ProjectRoot {
                        parent: ROOT_ID,
                        id: 2,
                        following: vec![4, 6],
                    },
                ],
            });
            surface.set_focus(Some(20));
            let mut items = vec![MountItem::RetireListCell {
                id: 2,
                request: 1,
                roots: vec![2],
            }];
            for &id in &parked {
                items.push(MountItem::RetireListCell {
                    id,
                    request: 1,
                    roots: vec![id],
                });
            }
            surface.apply(MountBatch { items });
            surface.apply(MountBatch {
                items: vec![MountItem::ProjectRoot {
                    parent: ROOT_ID,
                    id: 2,
                    following: vec![4, 6],
                }],
            });
            let order = |surface: &Surface| {
                surface
                    .node(ROOT_ID)
                    .unwrap()
                    .children
                    .iter()
                    .copied()
                    .filter(|id| [2, 4, 6].contains(id))
                    .collect::<Vec<_>>()
            };
            let expected: Vec<_> = [2, 4, 6]
                .into_iter()
                .filter(|id| !parked.contains(id))
                .collect();
            assert_eq!(order(&surface), expected, "parked {parked:?}");
            let mut items = Vec::new();
            for &id in &parked {
                items.push(MountItem::ProjectRoot {
                    parent: ROOT_ID,
                    id,
                    following: if id == 4 { vec![6] } else { vec![] },
                });
            }
            surface.apply(MountBatch { items });
            assert_eq!(order(&surface), vec![2, 4, 6]);

            surface.set_focus(Some(14));
            surface.apply(MountBatch {
                items: vec![
                    MountItem::RetireListCell {
                        id: 2,
                        request: 2,
                        roots: vec![2],
                    },
                    MountItem::RetireListCell {
                        id: 4,
                        request: 2,
                        roots: vec![4],
                    },
                ],
            });
            assert_eq!(surface.focused(), Some(14));
            assert_eq!(order(&surface), vec![4, 6]);
            surface.apply(MountBatch {
                items: vec![MountItem::ProjectRoot {
                    parent: ROOT_ID,
                    id: 2,
                    following: vec![4, 6],
                }],
            });
            assert_eq!(order(&surface), vec![2, 4, 6]);
            assert_eq!(surface.focused(), Some(14));
        }
    }

    #[test]
    fn an_unsupported_image_pick_answers_once_with_no_files() {
        let mut surface = Surface::new(10, 5, CellMetrics::default());
        surface.set_access(Access::all());
        assert!(surface.access.allows_picker());
        surface.apply(MountBatch {
            items: vec![MountItem::Command {
                id: ROOT_ID,
                command: Command::PickImages {
                    id: 42,
                    request: nsh_core::picker::PickRequest::new(true, 2),
                },
            }],
        });
        let events: Vec<_> = surface.drain_events().collect();
        assert!(matches!(
            events.as_slice(),
            [SurfaceEvent::Event(
                ROOT_ID,
                EventKind::Pick,
                EventPayload::Picked { id: 42, files }
            )] if files.is_empty()
        ));
        surface.tick(1.0);
        assert!(surface.drain_events().next().is_none());
    }

    fn create(
        surface: &mut Surface,
        id: NodeId,
        kind: ViewKind,
        parent: NodeId,
        frame: Bounds<Points>,
    ) {
        surface.apply(MountBatch {
            items: vec![
                MountItem::Create { id, kind },
                MountItem::Insert {
                    parent,
                    child: id,
                    before: None,
                },
                MountItem::Frame { id, frame },
            ],
        });
    }

    #[test]
    fn canvas_only_image_animation_keeps_embedding_awake_until_done_or_removed() {
        use nsh_core::canvas::{CanvasImage, CanvasOp, Drawing, Num};

        let mut surface = Surface::new(10, 5, CellMetrics::default());
        create(
            &mut surface,
            2,
            ViewKind::Canvas,
            ROOT_ID,
            Bounds::new(Point::new(px(0.0), px(0.0)), Size::new(px(16.0), px(16.0))),
        );
        let uri: Arc<str> = "asset:/animated.gif".into();
        let animation = Arc::new(AnimatedRaster {
            frames: vec![
                Arc::new(Raster {
                    width: 1,
                    height: 1,
                    rgba: vec![255, 0, 0, 255],
                }),
                Arc::new(Raster {
                    width: 1,
                    height: 1,
                    rgba: vec![0, 0, 255, 255],
                }),
            ],
            delays: vec![40, 60],
            plays: 1,
        });
        surface.image_cache.insert(
            uri.to_string(),
            CachedImage {
                animation,
                started: 1.0,
                frame: 0,
            },
        );
        // Install the retained drawing as after its first completed graphics
        // job: no mounted Image or pending work can keep the host awake.
        surface.node_mut(2).unwrap().drawing = Some(Arc::new(Drawing {
            ops: vec![CanvasOp::DrawImage {
                image: CanvasImage { uri: uri.clone() },
                source: None,
                dest: [0.0, 0.0, 16.0, 16.0].map(Num::Const),
            }],
            ..Drawing::default()
        }));
        assert!(surface.pending_images.is_empty() && surface.canvas_pending.is_empty());
        assert!(
            surface
                .node(2)
                .unwrap()
                .image
                .presentation(surface.now)
                .main
                .is_none()
        );
        surface.now = 1.0;
        assert!(surface.animating());
        surface.now = 1.2;
        assert!(
            !surface.animating(),
            "a completed finite image should let the host idle"
        );

        surface.image_cache.get_mut(uri.as_ref()).unwrap().started = 2.0;
        surface.now = 2.01;
        assert!(surface.animating());
        surface.apply(MountBatch {
            items: vec![MountItem::Delete { id: 2 }],
        });
        assert!(surface.node(2).is_none());
        assert!(surface.image_cache.contains_key(uri.as_ref()));
        assert!(
            !surface.animating(),
            "cached images without live drawing consumers should let the host idle"
        );
    }

    #[test]
    fn shrinking_content_and_growing_viewports_clamp_reported_scrolls() {
        let mut surface = Surface::new(20, 10, CellMetrics::default());
        create(
            &mut surface,
            2,
            ViewKind::Scroll,
            ROOT_ID,
            Bounds::new(Point::new(px(0.0), px(0.0)), Size::new(px(160.0), px(80.0))),
        );
        surface.apply(MountBatch {
            items: vec![MountItem::ScrollContent {
                id: 2,
                size: Size::new(px(160.0), px(800.0)),
            }],
        });
        surface.scroll_to(2, px(0.0), px(600.0));
        surface.events.clear();
        surface.apply(MountBatch {
            items: vec![MountItem::ScrollContent {
                id: 2,
                size: Size::new(px(160.0), px(112.0)),
            }],
        });
        assert_eq!(surface.node(2).unwrap().scroll.y, px(32.0));
        assert!(
            surface
                .events
                .iter()
                .any(|event| matches!(event, SurfaceEvent::Scroll(2, position, 0) if *position == point(px(0.0), px(32.0))))
        );
        surface.apply(MountBatch {
            items: vec![MountItem::Frame {
                id: 2,
                frame: Bounds::new(
                    Point::new(px(0.0), px(0.0)),
                    Size::new(px(160.0), px(160.0)),
                ),
            }],
        });
        assert_eq!(surface.node(2).unwrap().scroll.y, px(0.0));
    }

    #[test]
    fn a_list_follows_appends_after_an_unacknowledged_viewport_growth() {
        use nsh_core::{CellSlot, Core, Op, Prop, Style, StylePatch, StyleValue, Tag};
        use ratatui::{buffer::Buffer, layout::Rect};

        fn height(id: NodeId, value: f32) -> Op {
            let mut style = Box::<Style>::default();
            let mut patch = StylePatch::default();
            patch
                .set(&mut style, "height", StyleValue::Number(value))
                .unwrap();
            Op::SetStyle { id, style, patch }
        }

        // Play the existing JS List protocol: bind native cells, provide their
        // real four-line contents, then confirm each cell's item index.
        fn commit(
            core: &mut Core<crate::TerminalTextEngine>,
            surface: &mut Surface,
            cells: &mut Vec<NodeId>,
        ) {
            for _ in 0..8 {
                if let Some(batch) = core.commit() {
                    surface.apply(batch);
                }
                let mut binds = Vec::new();
                core.take_list_binds(&mut binds);
                core.take_paced_list_binds(usize::MAX, &mut binds);
                if binds.is_empty() {
                    return;
                }
                for bind in binds {
                    for (slot, index) in bind.binds {
                        while cells.len() <= slot as usize {
                            let cell = 100 + cells.len() as u32 * 3;
                            for op in [
                                Op::Create {
                                    id: cell,
                                    tag: Tag::Cell,
                                },
                                Op::SetProp {
                                    id: cell,
                                    prop: Prop::Slot(CellSlot::Item(cells.len() as u32)),
                                },
                                height(cell, 64.0),
                                Op::Create {
                                    id: cell + 1,
                                    tag: Tag::Text,
                                },
                                Op::CreateText {
                                    id: cell + 2,
                                    text: "".into(),
                                },
                                Op::Insert {
                                    parent: cell + 1,
                                    child: cell + 2,
                                    before: None,
                                },
                                Op::Insert {
                                    parent: cell,
                                    child: cell + 1,
                                    before: None,
                                },
                                Op::Insert {
                                    parent: bind.list,
                                    child: cell,
                                    before: None,
                                },
                            ] {
                                core.apply(op).unwrap();
                            }
                            cells.push(cell);
                        }
                        let cell = cells[slot as usize];
                        core.apply(Op::SetText {
                            id: cell + 2,
                            text: format!("ROW {index:02}\na\nb\nTAIL {index:02}"),
                        })
                        .unwrap();
                        core.apply(Op::SetProp {
                            id: cell,
                            prop: Prop::CellIndex(index),
                        })
                        .unwrap();
                    }
                }
            }
            panic!("the fixed-height List did not finish its native cell bindings");
        }

        fn acknowledge(core: &mut Core<crate::TerminalTextEngine>, surface: &mut Surface) {
            for event in surface.drain_events() {
                if let SurfaceEvent::Scroll(id, offset, applied) = event {
                    core.set_scroll_offset(id, offset, applied);
                }
            }
        }

        // A reader away from the end must keep the same content. A reader at
        // the end must see the complete new final line, even before the native
        // clamp caused by the first commit has been acknowledged by the core.
        for (initial, expected, sees_tail) in [(400.0, 400.0, false), (1200.0, 1216.0, true)] {
            let metrics = CellMetrics::default();
            let mut core = Core::new(
                crate::TerminalTextEngine::new(metrics),
                Size::new(px(160.0), px(640.0)),
            );
            let mut surface = Surface::new(20, 40, metrics);
            let mut cells = Vec::new();
            for op in [
                Op::Create {
                    id: 2,
                    tag: Tag::List,
                },
                height(2, 400.0),
                Op::SetProp {
                    id: 2,
                    prop: Prop::EstimatedItemSize(px(64.0)),
                },
                Op::SetProp {
                    id: 2,
                    prop: Prop::FollowEnd(Some(px(32.0))),
                },
                Op::SetProp {
                    id: 2,
                    prop: Prop::Count(25),
                },
                Op::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
            ] {
                core.apply(op).unwrap();
            }
            commit(&mut core, &mut surface, &mut cells);
            surface.scroll_to(2, px(0.0), px(initial));
            acknowledge(&mut core, &mut surface);
            commit(&mut core, &mut surface, &mut cells);
            acknowledge(&mut core, &mut surface);
            assert_eq!(surface.node(2).unwrap().scroll.content.height, px(1600.0));
            assert_eq!(surface.node(2).unwrap().scroll.y, px(initial));

            // A footer disappears: the physical viewport grows by three rows.
            core.apply(height(2, 448.0)).unwrap();
            commit(&mut core, &mut surface, &mut cells);
            assert_eq!(surface.node(2).unwrap().frame.size.height, px(448.0));
            assert_eq!(surface.node(2).unwrap().scroll.y, px(initial.min(1152.0)));
            // Deliberately leave that real SurfaceEvent::Scroll queued while
            // the engine receives the next item's content in a second commit.
            core.apply(Op::SetProp {
                id: 2,
                prop: Prop::Count(26),
            })
            .unwrap();
            commit(&mut core, &mut surface, &mut cells);
            assert_eq!(surface.node(2).unwrap().scroll.content.height, px(1664.0));
            assert_eq!(surface.node(2).unwrap().scroll.y, px(expected));
            let area = Rect::new(0, 0, 20, 40);
            let mut buffer = Buffer::empty(area);
            surface.render_plain(area, &mut buffer);
            let painted = buffer
                .content()
                .iter()
                .map(|cell| cell.symbol())
                .collect::<String>();
            assert_eq!(painted.contains("TAIL 25"), sees_tail);

            // Late reports and another append cannot undo the chosen reading
            // position or turn a programmatic clamp into a user scroll away.
            acknowledge(&mut core, &mut surface);
            commit(&mut core, &mut surface, &mut cells);
            core.apply(Op::SetProp {
                id: 2,
                prop: Prop::Count(27),
            })
            .unwrap();
            commit(&mut core, &mut surface, &mut cells);
            assert_eq!(
                surface.node(2).unwrap().scroll.y,
                px(if sees_tail { 1280.0 } else { 400.0 })
            );
        }
    }

    #[test]
    fn list_follow_preserves_a_valid_offset_inside_the_content_inset() {
        use nsh_core::{
            Core, EdgeInsets, Op, Prop, ScrollProp, Style, StylePatch, StyleValue, Tag,
        };

        fn height(value: f32) -> Op {
            let mut style = Box::<Style>::default();
            let mut patch = StylePatch::default();
            patch
                .set(&mut style, "height", StyleValue::Number(value))
                .unwrap();
            Op::SetStyle {
                id: 2,
                style,
                patch,
            }
        }

        let metrics = CellMetrics::default();
        let mut core = Core::new(
            crate::TerminalTextEngine::new(metrics),
            Size::new(px(160.0), px(640.0)),
        );
        let mut surface = Surface::new(20, 40, metrics);
        for op in [
            Op::Create {
                id: 2,
                tag: Tag::List,
            },
            height(400.0),
            Op::SetProp {
                id: 2,
                prop: Prop::EstimatedItemSize(px(64.0)),
            },
            Op::SetProp {
                id: 2,
                prop: Prop::FollowEnd(Some(px(32.0))),
            },
            Op::SetProp {
                id: 2,
                prop: Prop::Count(25),
            },
            Op::SetProp {
                id: 2,
                prop: Prop::Scroll(ScrollProp::ContentInset(EdgeInsets {
                    bottom: px(64.0),
                    ..Default::default()
                })),
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ] {
            core.apply(op).unwrap();
        }
        surface.apply(core.commit().unwrap());
        surface.scroll_to(2, px(0.0), px(1248.0));
        for event in surface.drain_events() {
            if let SurfaceEvent::Scroll(id, offset, applied) = event {
                core.set_scroll_offset(id, offset, applied);
            }
        }
        if let Some(batch) = core.commit() {
            surface.apply(batch);
        }
        surface.events.clear();

        // The trailing inset keeps 1248 valid when the viewport grows. The
        // native view does not clamp it, so the core must not invent a clamp.
        core.apply(height(416.0)).unwrap();
        surface.apply(core.commit().unwrap());
        assert_eq!(surface.node(2).unwrap().scroll.y, px(1248.0));
        core.apply(Op::SetProp {
            id: 2,
            prop: Prop::Count(26),
        })
        .unwrap();
        surface.apply(core.commit().unwrap());
        assert_eq!(surface.node(2).unwrap().scroll.content.height, px(1664.0));
        assert_eq!(surface.node(2).unwrap().scroll.y, px(1248.0));
    }

    #[test]
    fn app_header_and_mirrored_cells_share_paint_and_hit_geometry() {
        let mut surface = Surface::new(20, 10, CellMetrics::default());
        create(
            &mut surface,
            2,
            ViewKind::Screen,
            ROOT_ID,
            Bounds::new(
                Point::new(px(0.0), px(0.0)),
                Size::new(px(160.0), px(160.0)),
            ),
        );
        create(
            &mut surface,
            4,
            ViewKind::HeaderItem,
            2,
            Bounds::new(Point::new(px(0.0), px(0.0)), Size::new(px(160.0), px(16.0))),
        );
        create(
            &mut surface,
            6,
            ViewKind::View,
            4,
            Bounds::new(
                Point::new(px(128.0), px(0.0)),
                Size::new(px(24.0), px(16.0)),
            ),
        );
        surface.apply(MountBatch {
            items: vec![MountItem::ScreenConfig {
                id: 2,
                config: Box::new(ScreenConfig {
                    header_view: Some(4),
                    header_height: px(32.0),
                    ..ScreenConfig::default()
                }),
            }],
        });
        assert_eq!(surface.global_frame(4).unwrap().origin.x, px(0.0));
        assert_eq!(surface.global_frame(6).unwrap().origin.x, px(128.0));
        assert_eq!(surface.hit_test(132.0, 12.0), Some(6));
        create(
            &mut surface,
            8,
            ViewKind::Scroll,
            ROOT_ID,
            Bounds::new(
                Point::new(px(0.0), px(48.0)),
                Size::new(px(160.0), px(64.0)),
            ),
        );
        create(
            &mut surface,
            10,
            ViewKind::View,
            8,
            Bounds::new(Point::new(px(32.0), px(0.0)), Size::new(px(24.0), px(32.0))),
        );
        create(
            &mut surface,
            12,
            ViewKind::View,
            10,
            Bounds::new(Point::new(px(8.0), px(0.0)), Size::new(px(8.0), px(16.0))),
        );
        surface.node_mut(8).unwrap().scroll.mirrored = true;
        surface.node_mut(8).unwrap().scroll.x = px(16.0);
        assert_eq!(surface.global_frame(10).unwrap().origin.x, px(120.0));
        assert_eq!(surface.global_frame(12).unwrap().origin.x, px(128.0));
        assert_eq!(surface.hit_test(129.0, 49.0), Some(12));
    }

    #[test]
    fn a_dialog_page_hits_its_app_header_above_later_content() {
        let mut surface = Surface::new(20, 10, CellMetrics::default());
        let frame = Bounds::new(point(px(0.0), px(0.0)), Size::new(px(160.0), px(160.0)));
        create(&mut surface, 2, ViewKind::Modal, ROOT_ID, frame);
        create(&mut surface, 4, ViewKind::Screen, 2, frame);
        create(&mut surface, 6, ViewKind::HeaderItem, 4, frame);
        create(&mut surface, 8, ViewKind::View, 4, frame);
        create(&mut surface, 10, ViewKind::HeaderItem, 4, frame);
        surface.apply(MountBatch {
            items: vec![MountItem::ScreenConfig {
                id: 4,
                config: Box::new(ScreenConfig {
                    header_view: Some(6),
                    left: Some(10),
                    ..ScreenConfig::default()
                }),
            }],
        });
        surface.tick(1.0);
        assert_eq!(surface.hit_test(4.0, 8.0), Some(6));
        assert!(!surface.visible_ids().contains(&10));
        assert!(!surface.paint_ids().contains(&10));
    }

    #[test]
    fn layout_motion_retains_direct_deletes_and_uses_presented_hit_frames() {
        let mut surface = Surface::new(30, 10, CellMetrics::default());
        create(
            &mut surface,
            2,
            ViewKind::View,
            ROOT_ID,
            Bounds::new(Point::new(px(0.0), px(0.0)), Size::new(px(32.0), px(32.0))),
        );
        let transition = LayoutTransition {
            curve: LayoutCurve::Linear,
            property: LayoutProperty::Opacity,
            duration_ms: 1000.0,
            delay_ms: 0.0,
        };
        surface.apply(MountBatch {
            items: vec![
                MountItem::LayoutAnimation(LayoutAnimation {
                    update: Some(transition),
                    ..LayoutAnimation::default()
                }),
                MountItem::Frame {
                    id: 2,
                    frame: Bounds::new(
                        Point::new(px(80.0), px(0.0)),
                        Size::new(px(32.0), px(32.0)),
                    ),
                },
            ],
        });
        surface.tick(0.5);
        assert_eq!(surface.global_frame(2).unwrap().origin.x, px(40.0));
        assert_eq!(surface.hit_test(45.0, 8.0), Some(2));
        surface.apply(MountBatch {
            items: vec![
                MountItem::LayoutAnimation(LayoutAnimation {
                    delete: Some(transition),
                    ..LayoutAnimation::default()
                }),
                MountItem::Delete { id: 2 },
            ],
        });
        assert!(surface.node(2).is_some());
        assert!(!surface.visible_ids().contains(&2));
        surface.tick(1.0);
        assert!((surface.animated_style(2).opacity - 0.5).abs() < 0.001);
        surface.tick(1.6);
        assert!(surface.node(2).is_none());
        assert!(!surface.animating());
    }
}

#[cfg(test)]
mod image_ownership_tests {
    use std::time::{Duration, Instant};

    use nsh_core::{ImageSource, ResizeMode};

    use super::*;

    struct Assets {
        ready: crossbeam_channel::Receiver<()>,
        png: Vec<u8>,
    }
    impl nsh_engine::Assets for Assets {
        fn read(&self, uri: &str) -> Result<Vec<u8>, String> {
            if uri == "asset:/old" {
                self.ready.recv().map_err(|e| e.to_string())?;
                Err("old request failed".into())
            } else {
                Ok(self.png.clone())
            }
        }
    }

    #[test]
    fn inline_sources_share_decodes_and_revoked_blobs_keep_their_placeholder() {
        use ::image::ImageEncoder as _;
        use base64::Engine as _;

        let png = |pixel: [u8; 4]| {
            let mut bytes = Vec::new();
            ::image::codecs::png::PngEncoder::new(&mut bytes)
                .write_image(&pixel, 1, 1, ::image::ExtendedColorType::Rgba8)
                .unwrap();
            bytes
        };
        let red = png([255, 0, 0, 255]);
        let inline = ImageSource {
            uri: format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(&red)
            )
            .into(),
            ..Default::default()
        }
        .inline();
        let blob = ImageSource {
            uri: "blob:main".into(),
            ..Default::default()
        }
        .with_bytes("image/png", red.into());
        let placeholder = ImageSource {
            uri: "blob:placeholder".into(),
            ..Default::default()
        }
        .with_bytes("image/png", png([0, 0, 255, 255]).into());
        assert_eq!(inline.uri, blob.uri);
        assert!(inline.uri.starts_with("data:image/png;nsh-key="));
        assert_ne!(inline.data, blob.data);

        // No asset provider: neither source may fall back to reading its key.
        let mut surface = Surface::new(10, 5, CellMetrics::default());
        let mut items = Vec::new();
        for (id, source, placeholder) in [
            (2, inline, None),
            (4, blob, None),
            (
                6,
                ImageSource {
                    uri: "blob:revoked".into(),
                    ..Default::default()
                },
                Some(placeholder),
            ),
        ] {
            items.extend([
                MountItem::Create {
                    id,
                    kind: ViewKind::Image,
                },
                MountItem::Insert {
                    parent: ROOT_ID,
                    child: id,
                    before: None,
                },
                MountItem::Image {
                    id,
                    source: Some(source),
                    resize_mode: ResizeMode::Contain,
                    options: nsh_core::ImageOptions {
                        placeholder,
                        ..Default::default()
                    },
                },
            ]);
        }
        surface.apply(MountBatch { items });
        let end = Instant::now() + Duration::from_secs(3);
        while !surface.pending_images.is_empty() {
            assert!(Instant::now() < end, "inline images did not finish");
            surface.tick(0.0);
            std::thread::sleep(Duration::from_millis(1));
        }
        for id in [2, 4] {
            let layers = surface.node(id).unwrap().image.presentation(surface.now);
            assert_eq!(layers.main.unwrap().raster.rgba, [255, 0, 0, 255]);
            assert!(surface.events.iter().any(|event| matches!(
                event,
                SurfaceEvent::Event(node, EventKind::Load, _) if *node == id
            )));
        }
        let layers = surface.node(6).unwrap().image.presentation(surface.now);
        assert!(layers.main.is_none());
        assert_eq!(layers.placeholder.unwrap().raster.rgba, [0, 0, 255, 255]);
        assert!(
            surface
                .events
                .iter()
                .any(|event| matches!(event, SurfaceEvent::Event(6, EventKind::Error, _)))
        );
        assert_eq!(surface.image_cache.len(), 2);
        assert_eq!(
            surface
                .events
                .iter()
                .filter(|event| matches!(event, SurfaceEvent::Event(_, EventKind::LoadEnd, _)))
                .count(),
            3
        );
    }

    #[test]
    fn placeholder_paints_while_main_read_waits_then_main_reports_progress_and_fades() {
        use ::image::ImageEncoder as _;
        struct DelayedAssets {
            release: crossbeam_channel::Receiver<()>,
            main: Vec<u8>,
            placeholder: Vec<u8>,
        }
        impl nsh_engine::Assets for DelayedAssets {
            fn read(&self, uri: &str) -> Result<Vec<u8>, String> {
                if uri == "asset:/main" {
                    self.release
                        .recv_timeout(Duration::from_secs(5))
                        .map_err(|e| e.to_string())?;
                    Ok(self.main.clone())
                } else {
                    Ok(self.placeholder.clone())
                }
            }
        }
        let png = |pixel: [u8; 4]| {
            let mut bytes = Vec::new();
            ::image::codecs::png::PngEncoder::new(&mut bytes)
                .write_image(&pixel, 1, 1, ::image::ExtendedColorType::Rgba8)
                .unwrap();
            bytes
        };
        let (release, wait) = crossbeam_channel::bounded(1);
        let mut surface = Surface::new(10, 5, CellMetrics::default());
        surface.set_assets(Some(Arc::new(DelayedAssets {
            release: wait,
            main: png([255, 0, 0, 255]),
            placeholder: png([0, 0, 255, 255]),
        })));
        surface.apply(MountBatch {
            items: vec![
                MountItem::Create {
                    id: 2,
                    kind: ViewKind::Image,
                },
                MountItem::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
                MountItem::Frame {
                    id: 2,
                    frame: Bounds::new(Point::new(px(0.0), px(0.0)), Size::new(px(32.0), px(32.0))),
                },
                MountItem::Image {
                    id: 2,
                    source: Some(ImageSource {
                        uri: Arc::from("asset:/main"),
                        scales: nsh_core::ImageScales::NONE,
                        data: None,
                        size: None,
                    }),
                    resize_mode: ResizeMode::Contain,
                    options: nsh_core::ImageOptions {
                        placeholder: Some(ImageSource {
                            uri: Arc::from("asset:/placeholder"),
                            scales: nsh_core::ImageScales::NONE,
                            data: None,
                            size: None,
                        }),
                        fade_ms: Some(500.0),
                        ..Default::default()
                    },
                },
            ],
        });
        let end = Instant::now() + Duration::from_secs(3);
        while surface
            .node(2)
            .unwrap()
            .image
            .presentation(0.0)
            .placeholder
            .is_none()
        {
            assert!(
                Instant::now() < end,
                "placeholder was blocked by the main image read"
            );
            surface.tick(0.0);
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(
            surface
                .node(2)
                .unwrap()
                .image
                .presentation(0.0)
                .main
                .is_none()
        );
        release.send(()).unwrap();
        while surface
            .node(2)
            .unwrap()
            .image
            .presentation(0.0)
            .main
            .is_none()
        {
            assert!(Instant::now() < end, "main image did not finish");
            surface.tick(0.0);
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(
            surface
                .events
                .iter()
                .any(|event| matches!(event, SurfaceEvent::Event(2, EventKind::Progress, _)))
        );
        surface.tick(0.25);
        let layers = surface.node(2).unwrap().image.presentation(surface.now);
        assert!(layers.placeholder.is_some());
        assert!((layers.main.unwrap().opacity - 0.5).abs() < 0.001);
        surface.tick(0.5);
        assert!(
            surface
                .node(2)
                .unwrap()
                .image
                .presentation(surface.now)
                .placeholder
                .is_none()
        );
    }

    #[test]
    fn a_late_failure_does_not_reach_the_replacement_image() {
        use ::image::ImageEncoder as _;
        let mut png = Vec::new();
        ::image::codecs::png::PngEncoder::new(&mut png)
            .write_image(&[255, 0, 0, 255], 1, 1, ::image::ExtendedColorType::Rgba8)
            .unwrap();
        let (ready, wait) = crossbeam_channel::bounded(1);
        let mut surface = Surface::new(10, 5, CellMetrics::default());
        surface.set_assets(Some(Arc::new(Assets { ready: wait, png })));
        surface.apply(MountBatch {
            items: vec![
                MountItem::Create {
                    id: 2,
                    kind: ViewKind::Image,
                },
                MountItem::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
                MountItem::Image {
                    id: 2,
                    source: Some(ImageSource {
                        uri: Arc::from("asset:/old"),
                        scales: nsh_core::ImageScales::NONE,
                        data: None,
                        size: None,
                    }),
                    resize_mode: ResizeMode::Contain,
                    options: Default::default(),
                },
                MountItem::Image {
                    id: 2,
                    source: Some(ImageSource {
                        uri: Arc::from("asset:/new"),
                        scales: nsh_core::ImageScales::NONE,
                        data: None,
                        size: None,
                    }),
                    resize_mode: ResizeMode::Contain,
                    options: Default::default(),
                },
            ],
        });
        ready.send(()).unwrap();
        let end = Instant::now() + Duration::from_secs(3);
        while surface
            .node(2)
            .unwrap()
            .image
            .presentation(surface.now)
            .main
            .is_none()
        {
            assert!(Instant::now() < end, "replacement image did not finish");
            surface.tick(0.0);
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(
            !surface
                .events
                .iter()
                .any(|event| matches!(event, SurfaceEvent::Event(2, EventKind::Error, _)))
        );
        assert_eq!(
            surface
                .events
                .iter()
                .filter(|event| matches!(event, SurfaceEvent::Event(2, EventKind::LoadEnd, _)))
                .count(),
            1
        );
        assert_eq!(
            surface
                .node(2)
                .unwrap()
                .image
                .presentation(surface.now)
                .main
                .unwrap()
                .raster
                .rgba,
            [255, 0, 0, 255]
        );
    }
}

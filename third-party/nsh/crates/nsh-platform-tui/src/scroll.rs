//! Terminal scroll motion, shared by commands, scroll bars and content
//! dragging. Offsets stay in virtual points; terminal cells only determine
//! pointer hit areas and the minimum useful movement.

use nsh_core::{
    EventKind, EventPayload, KeyboardDismissMode, Matrix, NodeId, PayloadValue, Point, Points,
    Size, ViewKind,
};

use crate::surface::{Node, Surface, SurfaceEvent};

const DURATION: f64 = 0.3;
const REFRESH_SPACE: f32 = 48.0;
const MIN_GLIDE: f32 = 0.05;
const STOP: f32 = 0.01;

/// Immutable scroll-bar geometry shared by live and queued pointer input.
#[derive(Clone, Debug)]
pub(crate) struct ScrollbarGeometry {
    matrix: Matrix,
    frame: Size<Points>,
    content: Size<Points>,
    zoom: f32,
    horizontal: bool,
    enabled: bool,
    shows_indicator: bool,
    cell: (f32, f32),
}

impl ScrollbarGeometry {
    pub(crate) fn contains(&self, x: f32, y: f32) -> bool {
        let Some((x, y)) = crate::geometry::unproject(&self.matrix, x, y) else {
            return false;
        };
        if !self.enabled || (!self.shows_indicator && !self.horizontal) {
            return false;
        }
        let frame = self.frame;
        let (cell_width, cell_height) = self.cell;
        let horizontal = self.horizontal;
        let content = if horizontal {
            self.content.width.0
        } else {
            self.content.height.0
        } * self.zoom;
        let viewport = if horizontal {
            frame.width.0
        } else {
            frame.height.0
        };
        if content <= viewport {
            return false;
        }
        if horizontal {
            x >= 0.0 && x < frame.width.0 && y >= frame.height.0 - cell_height && y < frame.height.0
        } else {
            y >= 0.0 && y < frame.height.0 && x >= frame.width.0 - cell_width && x < frame.width.0
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Target {
    x: f32,
    y: f32,
    zoom: f32,
}

#[derive(Clone, Copy, Debug)]
enum Motion {
    Timed {
        from: Target,
        to: Target,
        started: f64,
        duration: f64,
        momentum: bool,
    },
    Glide {
        from: Target,
        velocity: (f32, f32),
        rate: f32,
        started: f64,
    },
}

impl Motion {
    fn momentum(self) -> bool {
        matches!(
            self,
            Self::Timed { momentum: true, .. } | Self::Glide { .. }
        )
    }

    fn shift(&mut self, dx: f32, dy: f32) {
        match self {
            Self::Timed { from, to, .. } => {
                from.x += dx;
                from.y += dy;
                to.x += dx;
                to.y += dy;
            }
            Self::Glide { from, .. } => {
                from.x += dx;
                from.y += dy;
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Drag {
    origin: (f32, f32),
    from: (f32, f32),
    last: (f32, f32),
    sample: f64,
    velocity: (f32, f32),
    thumb: bool,
}

/// Per-scroll retained physics; a surface never shares it with another app.
#[derive(Clone, Debug)]
pub(crate) struct Physics {
    pub(crate) zoom: f32,
    pub(crate) refreshing: bool,
    pull: f32,
    keyboard_dismiss: KeyboardDismissMode,
    motion: Option<Motion>,
    drag: Option<Drag>,
}

impl Default for Physics {
    fn default() -> Self {
        Self {
            zoom: 1.0,
            refreshing: false,
            pull: 0.0,
            keyboard_dismiss: KeyboardDismissMode::None,
            motion: None,
            drag: None,
        }
    }
}

impl Physics {
    pub(crate) fn retire_input(&mut self) {
        self.motion = None;
        self.drag = None;
        self.pull = 0.0;
    }

    pub(crate) fn refresh_progress(&self) -> f32 {
        self.pull.clamp(0.0, 1.0)
    }
}

fn target(node: &Node) -> Target {
    Target {
        x: node.scroll.x.0,
        y: node.scroll.y.0,
        zoom: node.scroll.physics.zoom,
    }
}

fn refresh_space(node: &Node) -> f32 {
    node.scroll
        .behavior
        .refresh_indicator
        .map_or(REFRESH_SPACE, |height| height.0)
}

fn limits(node: &Node, zoom: f32, refreshing: bool) -> ((f32, f32), (f32, f32)) {
    let inset = node.scroll.behavior.content_inset;
    let min_x = -inset.left.0;
    let min_y = -inset.top.0
        - if refreshing && !node.scroll.horizontal {
            refresh_space(node)
        } else {
            0.0
        };
    (
        (
            min_x,
            (node.scroll.content.width.0 * zoom - node.frame.size.width.0 + inset.right.0)
                .max(min_x),
        ),
        (
            min_y,
            (node.scroll.content.height.0 * zoom - node.frame.size.height.0 + inset.bottom.0)
                .max(min_y),
        ),
    )
}

pub(crate) fn selection_limits(node: &Node) -> ((f32, f32), (f32, f32)) {
    limits(
        node,
        node.scroll.physics.zoom,
        node.scroll.physics.refreshing,
    )
}

fn clamp(node: &Node, value: Target, refreshing: bool) -> Target {
    let ((min_x, max_x), (min_y, max_y)) = limits(node, value.zoom, refreshing);
    Target {
        x: value.x.clamp(min_x, max_x),
        y: value.y.clamp(min_y, max_y),
        ..value
    }
}

fn rubber(value: f32, min: f32, max: f32, dimension: f32, bounces: bool) -> f32 {
    let bounded = value.clamp(min, max);
    if !bounces {
        return bounded;
    }
    let over = value - bounded;
    let dim = dimension.max(1.0);
    bounded + over.signum() * (1.0 - 1.0 / (over.abs() * 0.55 / dim + 1.0)) * dim
}

fn rate(node: &Node) -> f32 {
    let rate = node.scroll.behavior.deceleration;
    if rate > 0.0 && rate < 1.0 {
        rate
    } else if node.scroll.behavior.snaps() || node.scroll.behavior.paging {
        0.99
    } else {
        0.998
    }
}

fn glide(velocity: f32, rate: f32, ms: f32) -> (f32, f32) {
    let decay = rate.powf(ms);
    (velocity * (decay - 1.0) / rate.ln(), velocity * decay)
}

impl Surface {
    pub(crate) fn scroll_intent(&mut self, id: NodeId, intent: &str) {
        if self
            .node(id)
            .is_some_and(|node| node.events.contains(EventKind::ScrollIntent))
        {
            self.emit(
                id,
                EventKind::ScrollIntent,
                EventPayload::Map(vec![("intent", PayloadValue::Str(intent.into()))]),
            );
        }
    }

    fn scroll_emit(&mut self, id: NodeId, kind: EventKind) {
        if kind == EventKind::ScrollEnd {
            self.scroll_settled(id);
        }
        if let Some(node) = self.node(id)
            && node.events.contains(kind)
        {
            let value = clamp(node, target(node), false);
            self.emit(
                id,
                kind,
                EventPayload::Scroll(Point::new(Points(value.x), Points(value.y))),
            );
        }
    }

    /// Native values settle even when no app callback listens for the end.
    pub(crate) fn scroll_settled(&mut self, id: NodeId) {
        if let Some(value) = self.node(id).and_then(|node| node.scroll.scroll_value) {
            // Surface::animating keeps terminal ticks alive until the graph rests.
            self.animation.settle(value);
        }
    }

    fn write_scroll(&mut self, id: NodeId, value: Target, clamped: bool) {
        if !value.x.is_finite()
            || !value.y.is_finite()
            || !value.zoom.is_finite()
            || value.zoom <= 0.0
        {
            return;
        }
        let Some(node) = self.node_mut(id) else {
            return;
        };
        let value = if clamped {
            clamp(node, value, node.scroll.physics.refreshing)
        } else {
            value
        };
        let zoom_changed = (node.scroll.physics.zoom - value.zoom).abs() > f32::EPSILON;
        node.scroll.x = Points(value.x);
        node.scroll.y = Points(value.y);
        node.scroll.physics.zoom = value.zoom;
        let reported = clamp(node, value, false);
        let (count, binding, horizontal) = (
            node.scroll.count,
            node.scroll.scroll_value,
            node.scroll.horizontal,
        );
        let pull = node.scroll.pull_value.map(|binding| {
            (
                binding,
                (-node.scroll.behavior.content_inset.top.0 - value.y).max(0.0),
            )
        });
        if zoom_changed {
            self.events.push(SurfaceEvent::Zoom(id, value.zoom));
        }
        if let Some(binding) = binding {
            let mut finished = Vec::new();
            self.animation.set(
                binding,
                if horizontal { reported.x } else { reported.y },
                &mut finished,
            );
            if !finished.is_empty() {
                self.events.push(SurfaceEvent::AnimationsFinished(finished));
            }
        }
        if let Some((binding, distance)) = pull {
            let mut finished = Vec::new();
            self.animation.set(binding, distance, &mut finished);
            if !finished.is_empty() {
                self.events.push(SurfaceEvent::AnimationsFinished(finished));
            }
        }
        self.events.push(SurfaceEvent::Scroll(
            id,
            Point::new(Points(reported.x), Points(reported.y)),
            count,
        ));
    }

    fn interrupt_scroll(&mut self, id: NodeId) {
        let previous = self
            .node_mut(id)
            .and_then(|node| node.scroll.physics.motion.take());
        if previous.is_some_and(Motion::momentum) {
            self.scroll_emit(id, EventKind::MomentumEnd);
        }
    }

    /// Immediate local scrolling does not acknowledge a core command.
    pub(crate) fn scroll_jump(&mut self, id: NodeId, x: Points, y: Points) {
        let (x, y) = (x.0, y.0);
        self.interrupt_scroll(id);
        let Some(node) = self.node(id) else { return };
        self.write_scroll(
            id,
            Target {
                x,
                y,
                zoom: node.scroll.physics.zoom,
            },
            true,
        );
    }

    /// Core corrections move the current gesture and its destination with
    /// the content, rather than ending a list's animated follow operation.
    pub(crate) fn adjust_scroll(&mut self, id: NodeId, dx: Points, dy: Points) {
        let (dx, dy) = (dx.0, dy.0);
        let Some(node) = self.node_mut(id) else {
            return;
        };
        node.scroll.count = node.scroll.count.wrapping_add(1);
        if let Some(motion) = &mut node.scroll.physics.motion {
            motion.shift(dx, dy);
        }
        if let Some(drag) = &mut node.scroll.physics.drag {
            drag.from.0 += dx;
            drag.from.1 += dy;
        }
        let value = Target {
            x: node.scroll.x.0 + dx,
            y: node.scroll.y.0 + dy,
            zoom: node.scroll.physics.zoom,
        };
        self.write_scroll(id, value, false);
    }

    pub(crate) fn scroll_command(&mut self, id: NodeId, x: Points, y: Points, animated: bool) {
        let (x, y) = (x.0, y.0);
        if !x.is_finite() || !y.is_finite() {
            return;
        }
        let Some(node) = self.node_mut(id) else {
            return;
        };
        node.scroll.count = node.scroll.count.wrapping_add(1);
        node.scroll.physics.drag = None;
        let value = clamp(
            node,
            Target {
                x,
                y,
                zoom: node.scroll.physics.zoom,
            },
            node.scroll.physics.refreshing,
        );
        self.interrupt_scroll(id);
        if animated {
            self.animate_scroll(id, value, false, DURATION);
        } else {
            self.write_scroll(id, value, true);
            self.scroll_emit(id, EventKind::ScrollEnd);
        }
    }

    fn animate_scroll(&mut self, id: NodeId, to: Target, momentum: bool, duration: f64) {
        let now = self.now;
        let Some(node) = self.node_mut(id) else {
            return;
        };
        let from = target(node);
        if (from.x - to.x).abs() < 0.01
            && (from.y - to.y).abs() < 0.01
            && (from.zoom - to.zoom).abs() < 0.0001
        {
            self.write_scroll(id, to, true);
            self.scroll_emit(id, EventKind::ScrollEnd);
            return;
        }
        node.scroll.physics.motion = Some(Motion::Timed {
            from,
            to,
            started: now,
            duration,
            momentum,
        });
        if momentum {
            self.scroll_emit(id, EventKind::MomentumStart);
        }
    }

    pub(crate) fn set_scroll_keyboard_dismiss(&mut self, id: NodeId, mode: KeyboardDismissMode) {
        if let Some(node) = self.node_mut(id) {
            node.scroll.physics.keyboard_dismiss = mode;
        }
    }

    pub(crate) fn set_refreshing(&mut self, id: NodeId, refreshing: bool) {
        let Some(node) = self.node_mut(id) else {
            return;
        };
        if node.scroll.horizontal || node.scroll.physics.refreshing == refreshing {
            return;
        }
        node.scroll.physics.refreshing = refreshing;
        if node.scroll.physics.drag.is_some() {
            return;
        }
        let mut value = target(node);
        let lead = -node.scroll.behavior.content_inset.top.0;
        if refreshing && value.y <= lead + 0.5 {
            value.y = lead - refresh_space(node);
        } else if !refreshing && value.y < lead {
            value.y = lead;
        } else {
            return;
        }
        self.interrupt_scroll(id);
        self.animate_scroll(id, value, false, DURATION);
    }

    pub(crate) fn refresh_inset_changed(&mut self, id: NodeId) {
        let Some(node) = self.node(id) else { return };
        if node.scroll.horizontal
            || !node.scroll.physics.refreshing
            || node.scroll.physics.drag.is_some()
        {
            return;
        }
        let lead = -node.scroll.behavior.content_inset.top.0;
        if node.scroll.y.0 > lead + 0.5 {
            return;
        }
        let mut value = target(node);
        value.y = lead - refresh_space(node);
        self.interrupt_scroll(id);
        self.animate_scroll(id, value, false, DURATION);
    }

    pub(crate) fn clamp_scroll_state(&mut self, id: NodeId) {
        let Some(node) = self.node(id) else { return };
        let min = node.scroll.behavior.min_zoom.max(0.01);
        let max = node.scroll.behavior.max_zoom.max(min);
        let zoom = node.scroll.physics.zoom.clamp(min, max);
        if (zoom - node.scroll.physics.zoom).abs() > f32::EPSILON {
            if node.scroll.physics.drag.is_some() {
                self.end_scroll_drag(id, true);
            }
            self.zoom_scroll(id, zoom, None, false);
            return;
        }
        if let Some(Motion::Timed {
            mut to,
            started,
            duration,
            momentum,
            ..
        }) = node.scroll.physics.motion
        {
            let scale = to.zoom.clamp(min, max);
            if (scale - to.zoom).abs() > f32::EPSILON {
                to.x = (to.x + node.frame.size.width.0 * 0.5) / to.zoom * scale
                    - node.frame.size.width.0 * 0.5;
                to.y = (to.y + node.frame.size.height.0 * 0.5) / to.zoom * scale
                    - node.frame.size.height.0 * 0.5;
                to.zoom = scale;
                let to = clamp(node, to, node.scroll.physics.refreshing);
                let from = target(node);
                let now = self.now;
                let duration = (duration - (now - started)).max(0.001);
                if let Some(node) = self.node_mut(id) {
                    node.scroll.physics.motion = Some(Motion::Timed {
                        from,
                        to,
                        started: now,
                        duration,
                        momentum,
                    });
                }
            }
            return;
        }
        if node.scroll.physics.drag.is_some() || node.scroll.physics.motion.is_some() {
            return;
        }
        let current = target(node);
        let bounded = clamp(node, current, node.scroll.physics.refreshing);
        if (current.x, current.y) != (bounded.x, bounded.y) {
            self.write_scroll(id, bounded, true);
        }
    }

    /// Scale and additional content-centering translations, before the
    /// physical scroll offset and right-to-left mirroring are applied.
    pub(crate) fn scroll_content_transform(&self, id: NodeId) -> (f32, f32, f32) {
        let Some(node) = self.node(id) else {
            return (1.0, 0.0, 0.0);
        };
        let zoom = node.scroll.physics.zoom;
        if node.scroll.behavior.center_content {
            (
                zoom,
                ((node.frame.size.width.0 - node.scroll.content.width.0 * zoom) * 0.5).max(0.0),
                ((node.frame.size.height.0 - node.scroll.content.height.0 * zoom) * 0.5).max(0.0),
            )
        } else {
            (zoom, 0.0, 0.0)
        }
    }

    pub(crate) fn zoom_scroll(
        &mut self,
        id: NodeId,
        scale: f32,
        center: Option<Point<Points>>,
        animated: bool,
    ) {
        let Some(node) = self.node(id) else { return };
        if !scale.is_finite() {
            return;
        }
        let min = node.scroll.behavior.min_zoom.max(0.01);
        let max = node.scroll.behavior.max_zoom.max(min);
        let scale = scale.clamp(min, max);
        let (_, cx, cy) = self.scroll_content_transform(id);
        let center = center.map(|point| (point.x.0, point.y.0)).unwrap_or((
            (node.scroll.x.0 + node.frame.size.width.0 * 0.5 - cx) / node.scroll.physics.zoom,
            (node.scroll.y.0 + node.frame.size.height.0 * 0.5 - cy) / node.scroll.physics.zoom,
        ));
        let value = clamp(
            node,
            Target {
                x: center.0 * scale - node.frame.size.width.0 * 0.5,
                y: center.1 * scale - node.frame.size.height.0 * 0.5,
                zoom: scale,
            },
            node.scroll.physics.refreshing,
        );
        self.interrupt_scroll(id);
        if animated {
            self.animate_scroll(id, value, false, DURATION);
        } else {
            self.write_scroll(id, value, true);
            self.scroll_emit(id, EventKind::ScrollEnd);
        }
    }

    pub(crate) fn zoom_scroll_at(&mut self, id: NodeId, factor: f32, x: f32, y: f32) -> bool {
        let Some((x, y)) = self.surface_to_local(id, x, y) else {
            return false;
        };
        let Some(node) = self.node(id) else {
            return false;
        };
        if !node.scroll.enabled || !node.scroll.behavior.pinch || !node.scroll.behavior.zooms() {
            return false;
        }
        let min = node.scroll.behavior.min_zoom.max(0.01);
        let max = node.scroll.behavior.max_zoom.max(min);
        let old = node.scroll.physics.zoom;
        let scale = (old * factor).clamp(min, max);
        let (_, cx, cy) = self.scroll_content_transform(id);
        let px = if node.scroll.mirrored {
            node.frame.size.width.0 - x
        } else {
            x
        };
        let py = y;
        let content = (
            (node.scroll.x.0 + px - cx) / old,
            (node.scroll.y.0 + py - cy) / old,
        );
        let new_cx = if node.scroll.behavior.center_content {
            ((node.frame.size.width.0 - node.scroll.content.width.0 * scale) * 0.5).max(0.0)
        } else {
            0.0
        };
        let new_cy = if node.scroll.behavior.center_content {
            ((node.frame.size.height.0 - node.scroll.content.height.0 * scale) * 0.5).max(0.0)
        } else {
            0.0
        };
        let value = clamp(
            node,
            Target {
                x: content.0 * scale - px + new_cx,
                y: content.1 * scale - py + new_cy,
                zoom: scale,
            },
            node.scroll.physics.refreshing,
        );
        self.interrupt_scroll(id);
        self.write_scroll(id, value, true);
        self.scroll_emit(id, EventKind::ScrollEnd);
        true
    }

    pub(crate) fn scrollbar_geometry(&self, id: NodeId) -> Option<ScrollbarGeometry> {
        let node = self.node(id)?;
        if node.kind != ViewKind::Scroll {
            return None;
        }
        Some(ScrollbarGeometry {
            matrix: self.local_to_surface(id)?,
            frame: node.frame.size,
            content: node.scroll.content,
            zoom: node.scroll.physics.zoom,
            horizontal: node.scroll.horizontal,
            enabled: node.scroll.enabled,
            shows_indicator: node.scroll.shows_indicator,
            cell: self.scroll_local_cell(id),
        })
    }

    pub(crate) fn scrollbar_hit(&self, id: NodeId, x: f32, y: f32) -> bool {
        self.scrollbar_geometry(id)
            .is_some_and(|geometry| geometry.contains(x, y))
    }

    fn scroll_local_cell(&self, id: NodeId) -> (f32, f32) {
        let Some(matrix) = self.local_to_surface(id) else {
            return (self.metrics.width().0, self.metrics.height().0);
        };
        let (Some(a), Some(b), Some(c)) = (
            crate::geometry::project(&matrix, 0.0, 0.0),
            crate::geometry::project(&matrix, 1.0, 0.0),
            crate::geometry::project(&matrix, 0.0, 1.0),
        ) else {
            return (self.metrics.width().0, self.metrics.height().0);
        };
        (
            self.metrics.width().0 / (b.0 - a.0).hypot(b.1 - a.1).max(0.001),
            self.metrics.height().0 / (c.0 - a.0).hypot(c.1 - a.1).max(0.001),
        )
    }

    pub(crate) fn begin_scroll_drag(&mut self, id: NodeId, x: f32, y: f32, thumb: bool) -> bool {
        let Some((x, y)) = self.surface_to_local(id, x, y) else {
            return false;
        };
        let Some(node) = self.node(id) else {
            return false;
        };
        if !node.scroll.enabled {
            return false;
        }
        let dismiss = node.scroll.physics.keyboard_dismiss != KeyboardDismissMode::None;
        let mut page = target(node);
        if thumb {
            let frame = node.frame;
            let (cell_width, cell_height) = self.scroll_local_cell(id);
            let horizontal = node.scroll.horizontal;
            let ((min_x, max_x), (min_y, max_y)) = limits(node, page.zoom, false);
            let (position, min, max, viewport, physical, local, cell) = if horizontal {
                (
                    page.x,
                    min_x,
                    max_x,
                    node.frame.size.width.0,
                    frame.size.width.0,
                    x,
                    cell_width,
                )
            } else {
                (
                    page.y,
                    min_y,
                    max_y,
                    node.frame.size.height.0,
                    frame.size.height.0,
                    y,
                    cell_height,
                )
            };
            let range = max - min;
            let length = viewport + range;
            let thumb = (physical * viewport / length.max(1.0))
                .max(cell)
                .min(physical);
            let mut fraction = ((position - min) / range.max(1.0)).clamp(0.0, 1.0);
            if horizontal && node.scroll.mirrored {
                fraction = 1.0 - fraction;
            }
            let start = fraction * (physical - thumb);
            let mut direction = if local < start {
                -1.0
            } else if local >= start + thumb {
                1.0
            } else {
                0.0
            };
            if horizontal && node.scroll.mirrored {
                direction = -direction;
            }
            if horizontal {
                page.x = (position + direction * viewport).clamp(min, max);
            } else {
                page.y = (position + direction * viewport).clamp(min, max);
            }
        }
        self.scroll_intent(id, "scroll");
        self.interrupt_scroll(id);
        self.scroll_emit(id, EventKind::ScrollDragStart);
        self.write_scroll(id, page, true);
        let now = self.now;
        let Some(node) = self.node_mut(id) else {
            return false;
        };
        node.scroll.physics.drag = Some(Drag {
            origin: (x, y),
            from: (node.scroll.x.0, node.scroll.y.0),
            last: (x, y),
            sample: now,
            velocity: (0.0, 0.0),
            thumb,
        });
        if dismiss {
            self.set_focus(None);
        }
        true
    }

    pub(crate) fn move_scroll_drag(&mut self, id: NodeId, x: f32, y: f32) {
        let Some((x, y)) = self.surface_to_local(id, x, y) else {
            return;
        };
        let now = self.now;
        let Some(node) = self.node(id) else { return };
        if !node.scroll.enabled {
            self.end_scroll_drag(id, true);
            return;
        }
        let Some(mut drag) = node.scroll.physics.drag else {
            return;
        };
        let frame = node.frame;
        let (cell_width, cell_height) = self.scroll_local_cell(id);
        let horizontal = node.scroll.horizontal;
        let mirrored = node.scroll.mirrored;
        let both = node.scroll.physics.zoom > 1.0;
        let ((min_x, max_x), (min_y, max_y)) = limits(node, node.scroll.physics.zoom, false);
        let (dx, dy) = (x - drag.origin.0, y - drag.origin.1);
        let (mut sx, mut sy) = (drag.from.0, drag.from.1);
        if drag.thumb {
            let (length, viewport, range, delta) = if horizontal {
                (
                    node.scroll.content.width.0 * node.scroll.physics.zoom,
                    frame.size.width.0,
                    max_x - min_x,
                    if mirrored { -dx } else { dx },
                )
            } else {
                (
                    node.scroll.content.height.0 * node.scroll.physics.zoom,
                    frame.size.height.0,
                    max_y - min_y,
                    dy,
                )
            };
            let thumb = (viewport * viewport / length.max(1.0))
                .max(if horizontal { cell_width } else { cell_height })
                .min(viewport);
            let shift = delta * range / (viewport - thumb).max(1.0);
            if horizontal {
                sx = (drag.from.0 + shift).clamp(min_x, max_x);
            } else {
                sy = (drag.from.1 + shift).clamp(min_y, max_y);
            }
        } else {
            if horizontal || both {
                sx = rubber(
                    drag.from.0 + if mirrored { dx } else { -dx },
                    min_x,
                    max_x,
                    frame.size.width.0,
                    node.scroll.behavior.bounces,
                );
            }
            if !horizontal || both {
                sy = rubber(
                    drag.from.1 - dy,
                    min_y,
                    max_y,
                    frame.size.height.0,
                    node.scroll.behavior.bounces,
                );
            }
            let dt = ((now - drag.sample) * 1000.0).max(1.0) as f32;
            drag.velocity = (
                if horizontal || both {
                    (x - drag.last.0) / dt * if mirrored { 1.0 } else { -1.0 }
                } else {
                    0.0
                },
                if !horizontal || both {
                    -(y - drag.last.1) / dt
                } else {
                    0.0
                },
            );
        }
        drag.last = (x, y);
        drag.sample = now;
        let value = Target {
            x: sx,
            y: sy,
            zoom: node.scroll.physics.zoom,
        };
        if let Some(node) = self.node_mut(id) {
            node.scroll.physics.drag = Some(drag);
            node.scroll.physics.pull = if horizontal {
                0.0
            } else {
                ((min_y - sy) / node.scroll.behavior.refresh_threshold().0).max(0.0)
            };
        }
        self.write_scroll(id, value, false);
    }

    pub(crate) fn end_scroll_drag(&mut self, id: NodeId, cancelled: bool) {
        let now = self.now;
        let Some(node) = self.node_mut(id) else {
            return;
        };
        let Some(drag) = node.scroll.physics.drag.take() else {
            return;
        };
        let refresh = !cancelled
            && !node.scroll.horizontal
            && !node.scroll.physics.refreshing
            && node.scroll.physics.pull >= 1.0
            && node.events.contains(EventKind::Refresh);
        if refresh {
            node.scroll.physics.refreshing = true;
        }
        node.scroll.physics.pull = 0.0;
        let current = target(node);
        let bounded = clamp(node, current, node.scroll.physics.refreshing);
        let velocity = if cancelled || drag.thumb || now - drag.sample > 0.15 {
            (0.0, 0.0)
        } else {
            drag.velocity
        };
        let r = rate(node);
        let horizontal = node.scroll.horizontal;
        let projected = if horizontal {
            current.x - velocity.0 / r.ln()
        } else {
            current.y - velocity.1 / r.ln()
        };
        let snap = node.scroll.behavior.snap_target(
            Points(if horizontal { current.x } else { current.y }),
            Points(projected),
            if horizontal { velocity.0 } else { velocity.1 },
            if horizontal {
                node.frame.size.width
            } else {
                node.frame.size.height
            },
            (if horizontal {
                node.scroll.content.width
            } else {
                node.scroll.content.height
            }) * current.zoom,
        );
        self.scroll_emit(id, EventKind::ScrollDragEnd);
        if refresh {
            self.emit(id, EventKind::Refresh, EventPayload::None);
        }
        if (current.x - bounded.x).abs() > 0.01 || (current.y - bounded.y).abs() > 0.01 || refresh {
            let to = if refresh {
                Target {
                    y: self.node(id).map_or(0.0, |n| {
                        -n.scroll.behavior.content_inset.top.0 - refresh_space(n)
                    }),
                    ..bounded
                }
            } else {
                bounded
            };
            self.animate_scroll(id, to, !cancelled, DURATION);
        } else if let Some(snap) = snap {
            let to = if horizontal {
                Target {
                    x: snap.0,
                    ..bounded
                }
            } else {
                Target {
                    y: snap.0,
                    ..bounded
                }
            };
            self.animate_scroll(id, to, !cancelled, DURATION);
        } else if velocity.0.abs().max(velocity.1.abs()) >= MIN_GLIDE {
            if let Some(node) = self.node_mut(id) {
                node.scroll.physics.motion = Some(Motion::Glide {
                    from: current,
                    velocity,
                    rate: r,
                    started: now,
                });
            }
            self.scroll_emit(id, EventKind::MomentumStart);
        } else {
            self.scroll_emit(id, EventKind::ScrollEnd);
        }
    }

    pub(crate) fn tick_scroll(&mut self, now: f64) -> bool {
        let ids: Vec<_> = self
            .nodes
            .iter()
            .enumerate()
            .filter_map(|(id, node)| {
                node.as_ref()
                    .and_then(|n| n.scroll.physics.motion.map(|_| id as NodeId))
            })
            .collect();
        let mut changed = false;
        for id in ids {
            let Some(node) = self.node_mut(id) else {
                continue;
            };
            let Some(motion) = node.scroll.physics.motion.take() else {
                continue;
            };
            if !node.scroll.enabled && motion.momentum() {
                let value = clamp(node, target(node), node.scroll.physics.refreshing);
                self.write_scroll(id, value, true);
                self.scroll_emit(id, EventKind::MomentumEnd);
                self.scroll_emit(id, EventKind::ScrollEnd);
                changed = true;
                continue;
            }
            match motion {
                Motion::Timed {
                    from,
                    to,
                    started,
                    duration,
                    momentum,
                } => {
                    let t = ((now - started) / duration.max(0.001)).clamp(0.0, 1.0) as f32;
                    let eased = 1.0 - (1.0 - t).powi(3);
                    let value = Target {
                        x: from.x + (to.x - from.x) * eased,
                        y: from.y + (to.y - from.y) * eased,
                        zoom: from.zoom + (to.zoom - from.zoom) * eased,
                    };
                    if t < 1.0 {
                        node.scroll.physics.motion = Some(motion);
                    }
                    self.write_scroll(id, value, false);
                    if t >= 1.0 {
                        self.clamp_scroll_state(id);
                        if momentum {
                            self.scroll_emit(id, EventKind::MomentumEnd);
                        }
                        self.scroll_emit(id, EventKind::ScrollEnd);
                    }
                }
                Motion::Glide {
                    from,
                    velocity,
                    rate,
                    started,
                } => {
                    let dt = ((now - started).max(0.0) * 1000.0).min(10000.0) as f32;
                    let (dx, vx) = glide(velocity.0, rate, dt);
                    let (dy, vy) = glide(velocity.1, rate, dt);
                    let value = Target {
                        x: from.x + dx,
                        y: from.y + dy,
                        ..from
                    };
                    let bounded = clamp(node, value, node.scroll.physics.refreshing);
                    let outside =
                        (value.x - bounded.x).abs() > 0.01 || (value.y - bounded.y).abs() > 0.01;
                    if outside {
                        let value = if node.scroll.behavior.bounces {
                            Target {
                                x: rubber(
                                    value.x,
                                    bounded.x,
                                    bounded.x,
                                    node.frame.size.width.0,
                                    true,
                                ),
                                y: rubber(
                                    value.y,
                                    bounded.y,
                                    bounded.y,
                                    node.frame.size.height.0,
                                    true,
                                ),
                                ..value
                            }
                        } else {
                            bounded
                        };
                        self.write_scroll(id, value, false);
                        if (value.x - bounded.x).abs() < 0.01 && (value.y - bounded.y).abs() < 0.01
                        {
                            self.scroll_emit(id, EventKind::MomentumEnd);
                            self.scroll_emit(id, EventKind::ScrollEnd);
                        } else {
                            self.animate_scroll(id, bounded, false, DURATION);
                            // The bounce continues the same momentum phase.
                            if let Some(Motion::Timed { momentum, .. }) = self
                                .node_mut(id)
                                .and_then(|n| n.scroll.physics.motion.as_mut())
                            {
                                *momentum = true;
                            }
                        }
                    } else {
                        let done = vx.abs().max(vy.abs()) < STOP || dt >= 10000.0;
                        if !done {
                            node.scroll.physics.motion = Some(motion);
                        }
                        self.write_scroll(id, value, true);
                        if done {
                            self.scroll_emit(id, EventKind::MomentumEnd);
                            self.scroll_emit(id, EventKind::ScrollEnd);
                        }
                    }
                }
            }
            changed = true;
        }
        changed
    }

    pub(crate) fn scroll_animating(&self) -> bool {
        if self
            .nodes
            .iter()
            .flatten()
            .any(|node| node.scroll.physics.motion.is_some())
        {
            return true;
        }
        if !self.nodes.iter().flatten().any(|node| {
            node.scroll.physics.refreshing && node.scroll.behavior.refresh_indicator.is_none()
        }) {
            return false;
        }
        self.paint_ids().into_iter().any(|id| {
            self.node(id).is_some_and(|node| {
                node.scroll.physics.refreshing && node.scroll.behavior.refresh_indicator.is_none()
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scroll() -> Surface {
        use nsh_core::{Bounds, MountBatch, MountItem, Size};
        let mut surface = Surface::new(40, 20, crate::CellMetrics::default());
        surface.apply(MountBatch {
            items: vec![
                MountItem::Create {
                    id: 2,
                    kind: ViewKind::Scroll,
                },
                MountItem::Frame {
                    id: 2,
                    frame: Bounds::new(Point::default(), Size::new(Points(160.0), Points(160.0))),
                },
                MountItem::ScrollContent {
                    id: 2,
                    size: Size::new(Points(320.0), Points(1600.0)),
                },
                MountItem::Insert {
                    parent: nsh_core::ROOT_ID,
                    child: 2,
                    before: None,
                },
            ],
        });
        surface.events.clear();
        surface
    }

    #[test]
    fn animated_command_acknowledges_once_and_core_correction_retargets_motion() {
        let mut surface = scroll();
        surface.scroll_command(2, Points(0.0), Points(300.0), true);
        assert_eq!(surface.node(2).unwrap().scroll.y.0, 0.0);
        assert_eq!(surface.node(2).unwrap().scroll.count, 1);
        surface.tick_scroll(0.15);
        let midway = surface.node(2).unwrap().scroll.y.0;
        assert!(midway > 0.0 && midway < 300.0);
        surface.adjust_scroll(2, Points(0.0), Points(32.0));
        assert_eq!(surface.node(2).unwrap().scroll.count, 2);
        surface.tick_scroll(0.3);
        assert_eq!(surface.node(2).unwrap().scroll.y.0, 332.0);
    }

    #[test]
    fn scroll_ends_settle_native_values_without_changing_offsets_or_callbacks() {
        use crossterm::event::{
            Event, KeyCode, KeyEvent, KeyModifiers, MouseEvent, MouseEventKind,
        };
        use nsh_core::{MountBatch, MountItem, animation::AnimationOp};

        for listens in [false, true] {
            for action in ["command", "animated", "key", "wheel"] {
                let mut surface = scroll();
                surface.apply(MountBatch {
                    items: vec![
                        MountItem::Animation(AnimationOp::CreateValue {
                            node: 10,
                            value: 0.0,
                        }),
                        MountItem::Animation(AnimationOp::CreateDiffClamp {
                            node: 11,
                            input: 10,
                            min: 0.0,
                            max: 50.0,
                            snap: true,
                        }),
                        MountItem::ScrollConfig {
                            id: 2,
                            horizontal: false,
                            scrollbar_visible: true,
                            scroll_value: Some(10),
                            pull_value: None,
                            keyboard_dismiss: Default::default(),
                            mirrored: false,
                        },
                    ],
                });
                surface
                    .node_mut(2)
                    .unwrap()
                    .events
                    .set(EventKind::ScrollEnd, listens);
                assert_eq!(surface.animation.eval(11).number(), 0.0);
                surface.events.clear();
                match action {
                    "command" | "animated" => {
                        surface.scroll_command(2, Points(0.0), Points(16.0), action == "animated");
                        if action == "animated" {
                            assert!(!surface.animation.is_animating());
                            surface.tick(0.3);
                        }
                    }
                    "key" => {
                        assert!(surface.handle_event(Event::Key(KeyEvent::new(
                            KeyCode::Down,
                            KeyModifiers::NONE,
                        ))));
                    }
                    "wheel" => {
                        assert_eq!(
                            surface.handle_wheel(
                                MouseEvent {
                                    kind: MouseEventKind::ScrollDown,
                                    column: 2,
                                    row: 2,
                                    modifiers: KeyModifiers::NONE,
                                },
                                1
                            ),
                            1
                        );
                    }
                    _ => unreachable!(),
                }
                let offset = surface.node(2).unwrap().scroll.y;
                assert_eq!(offset.0, if action == "wheel" { 48.0 } else { 16.0 });
                assert_eq!(surface.animation.eval(11).number(), offset.0);
                assert!(surface.animating(), "{action}, listens={listens}");
                let count = u32::from(matches!(action, "command" | "animated"));
                assert_eq!(surface.node(2).unwrap().scroll.count, count);
                assert_eq!(
                    surface
                        .drain_events()
                        .filter(|event| matches!(
                            event,
                            SurfaceEvent::Event(2, EventKind::ScrollEnd, _)
                        ))
                        .count(),
                    usize::from(listens)
                );

                surface.tick(1.0);
                surface.tick(1.1);
                let midway = surface.animation.eval(11).number();
                assert!(midway > 0.0 && midway < offset.0);
                surface.tick(1.3);
                assert_eq!(surface.animation.eval(11).number(), 0.0);
                assert_eq!(surface.animation.eval(10).number(), offset.0);
                assert_eq!(surface.node(2).unwrap().scroll.y, offset);
                assert_eq!(surface.node(2).unwrap().scroll.count, count);
                assert!(!surface.animating());
                assert!(surface.drain_events().next().is_none());
            }
        }
    }

    #[test]
    fn source_removal_stops_owned_scroll_motion_but_insert_only_moves_continue() {
        use nsh_core::{Bounds, MountBatch, MountItem, ROOT_ID, Size};

        for removed in [false, true] {
            let mut surface = scroll();
            surface.apply(MountBatch {
                items: vec![
                    MountItem::Create {
                        id: 4,
                        kind: ViewKind::View,
                    },
                    MountItem::Frame {
                        id: 4,
                        frame: Bounds::new(
                            Point::default(),
                            Size::new(Points(160.0), Points(160.0)),
                        ),
                    },
                    MountItem::Insert {
                        parent: ROOT_ID,
                        child: 4,
                        before: None,
                    },
                    MountItem::Insert {
                        parent: 4,
                        child: 2,
                        before: None,
                    },
                ],
            });
            surface
                .node_mut(2)
                .unwrap()
                .events
                .set(EventKind::ScrollEnd, true);
            surface.scroll_command(2, Points(0.0), Points(300.0), true);
            surface.events.clear();
            let mut items = Vec::new();
            if removed {
                items.push(MountItem::Remove { id: 4 });
            }
            items.push(MountItem::Insert {
                parent: ROOT_ID,
                child: 4,
                before: None,
            });
            surface.apply(MountBatch { items });
            surface.tick_scroll(1.0);
            assert_eq!(
                surface.node(2).unwrap().scroll.y.0,
                if removed { 0.0 } else { 300.0 }
            );
            assert_eq!(
                surface
                    .drain_events()
                    .filter(|event| matches!(
                        event,
                        SurfaceEvent::Event(2, EventKind::ScrollEnd, _)
                    ))
                    .count(),
                usize::from(!removed)
            );

            surface.now = 1.0;
            surface.scroll_command(2, Points(0.0), Points(400.0), true);
            surface.tick_scroll(2.0);
            assert_eq!(surface.node(2).unwrap().scroll.y.0, 400.0);
            assert_eq!(
                surface
                    .drain_events()
                    .filter(|event| matches!(
                        event,
                        SurfaceEvent::Event(2, EventKind::ScrollEnd, _)
                    ))
                    .count(),
                1
            );
        }
    }

    #[test]
    fn dragging_rubber_bands_and_reports_refresh_before_bouncing_to_spinner() {
        let mut surface = scroll();
        surface
            .node_mut(2)
            .unwrap()
            .events
            .set(EventKind::Refresh, true);
        surface.begin_scroll_drag(2, 40.0, 40.0, false);
        surface.now = 0.1;
        surface.move_scroll_drag(2, 40.0, 300.0);
        assert!(surface.node(2).unwrap().scroll.y.0 < -64.0);
        surface.end_scroll_drag(2, false);
        assert!(surface.node(2).unwrap().scroll.physics.refreshing);
        assert!(
            surface
                .events
                .iter()
                .any(|event| matches!(event, SurfaceEvent::Event(2, EventKind::Refresh, _)))
        );
        surface.tick_scroll(0.4);
        assert!((surface.node(2).unwrap().scroll.y.0 + REFRESH_SPACE).abs() < 0.01);
        surface.set_refreshing(2, false);
        surface.tick_scroll(0.7);
        assert_eq!(surface.node(2).unwrap().scroll.y.0, 0.0);
    }

    #[test]
    fn custom_refresh_keeps_its_height_and_reports_native_pull_value() {
        use nsh_core::{MountBatch, MountItem, animation::AnimationOp};
        let mut surface = scroll();
        surface.apply(MountBatch {
            items: vec![
                MountItem::Animation(AnimationOp::CreateValue {
                    node: 10,
                    value: 0.0,
                }),
                MountItem::ScrollConfig {
                    id: 2,
                    horizontal: false,
                    scrollbar_visible: true,
                    scroll_value: None,
                    pull_value: Some(10),
                    keyboard_dismiss: Default::default(),
                    mirrored: false,
                },
            ],
        });
        let node = surface.node_mut(2).unwrap();
        node.events.set(EventKind::Refresh, true);
        node.scroll.behavior.refresh_indicator = Some(Points(100.0));
        surface.begin_scroll_drag(2, 40.0, 40.0, false);
        surface.now = 0.1;
        surface.move_scroll_drag(2, 40.0, 150.0);
        assert!(-surface.node(2).unwrap().scroll.y.0 < 100.0);
        surface.end_scroll_drag(2, false);
        assert!(!surface.node(2).unwrap().scroll.physics.refreshing);
        surface.tick_scroll(0.5);
        surface.now = 0.5;
        surface.begin_scroll_drag(2, 40.0, 40.0, false);
        surface.now = 0.6;
        surface.move_scroll_drag(2, 40.0, 1000.0);
        let distance = -surface.node(2).unwrap().scroll.y.0;
        assert!(distance > 100.0);
        assert!((surface.animation.eval(10).number() - distance).abs() < 0.01);
        surface.end_scroll_drag(2, false);
        surface.tick_scroll(1.0);
        assert!(surface.node(2).unwrap().scroll.physics.refreshing);
        assert!((surface.node(2).unwrap().scroll.y.0 + 100.0).abs() < 0.01);
        assert!((surface.animation.eval(10).number() - 100.0).abs() < 0.01);
        assert!(
            !surface.scroll_animating(),
            "an app indicator needs no native spinner ticks"
        );
        for (at, height, expected) in [
            (1.0, Some(200.0), 200.0),
            (1.4, Some(80.0), 80.0),
            (1.8, None, REFRESH_SPACE),
        ] {
            surface.now = at;
            surface.apply(MountBatch {
                items: vec![MountItem::ScrollBehavior {
                    id: 2,
                    behavior: Box::new(nsh_core::ScrollBehavior {
                        refresh_indicator: height.map(Points),
                        ..Default::default()
                    }),
                }],
            });
            surface.tick_scroll(at + 0.4);
            assert!((surface.node(2).unwrap().scroll.y.0 + expected).abs() < 0.01);
            assert!((surface.animation.eval(10).number() - expected).abs() < 0.01);
        }
        surface.now = 2.2;
        surface.set_refreshing(2, false);
        surface.tick_scroll(2.6);
        assert_eq!(surface.animation.eval(10).number(), 0.0);
    }

    #[test]
    fn inertia_decelerates_and_ends_with_balanced_lifecycle() {
        let mut surface = scroll();
        for kind in [
            EventKind::ScrollIntent,
            EventKind::ScrollDragStart,
            EventKind::ScrollDragEnd,
            EventKind::MomentumStart,
            EventKind::MomentumEnd,
            EventKind::ScrollEnd,
        ] {
            surface.node_mut(2).unwrap().events.set(kind, true);
        }
        surface.scroll_jump(2, Points(0.0), Points(500.0));
        surface.events.clear();
        surface.begin_scroll_drag(2, 40.0, 100.0, false);
        assert!(
            matches!(surface.events.first(), Some(SurfaceEvent::Event(2, EventKind::ScrollIntent, EventPayload::Map(fields))) if fields.contains(&("intent", PayloadValue::Str("scroll".into()))))
        );
        assert!(matches!(
            surface.events.get(1),
            Some(SurfaceEvent::Event(2, EventKind::ScrollDragStart, _))
        ));
        surface.now = 0.1;
        surface.move_scroll_drag(2, 40.0, 50.0);
        surface.end_scroll_drag(2, false);
        surface.tick_scroll(0.2);
        let first = surface.node(2).unwrap().scroll.y.0;
        surface.tick_scroll(0.3);
        let second = surface.node(2).unwrap().scroll.y.0;
        surface.tick_scroll(10.0);
        assert!(first > 550.0 && second > first);
        for kind in [
            EventKind::ScrollIntent,
            EventKind::ScrollDragStart,
            EventKind::ScrollDragEnd,
            EventKind::MomentumStart,
            EventKind::MomentumEnd,
            EventKind::ScrollEnd,
        ] {
            assert_eq!(
                surface
                    .events
                    .iter()
                    .filter(|event| matches!(event,SurfaceEvent::Event(2,event,_) if *event==kind))
                    .count(),
                1
            );
        }
    }

    #[test]
    fn zoom_obeys_limits_and_reports_scale_before_offset() {
        let mut surface = scroll();
        surface.node_mut(2).unwrap().scroll.behavior.max_zoom = 3.0;
        surface.events.clear();
        surface.zoom_scroll(2, 8.0, Some(Point::new(Points(80.0), Points(80.0))), false);
        assert_eq!(surface.node(2).unwrap().scroll.physics.zoom, 3.0);
        assert_eq!(
            (
                surface.node(2).unwrap().scroll.x.0,
                surface.node(2).unwrap().scroll.y.0
            ),
            (160.0, 160.0)
        );
        assert!(matches!(
            surface.events.first(),
            Some(SurfaceEvent::Zoom(2, 3.0))
        ));
        assert!(matches!(
            surface.events.get(1),
            Some(SurfaceEvent::Scroll(2, point, _)) if *point == Point::new(Points(160.0), Points(160.0))
        ));
    }

    #[test]
    fn pointer_drag_and_zoom_use_inverse_transformed_local_coordinates() {
        let mut surface = scroll();
        let node = surface.node_mut(2).unwrap();
        node.style
            .transform
            .push(nsh_core::TransformKind::Scale, 2.0);
        node.style
            .transform
            .push(nsh_core::TransformKind::Rotate, 20.0);
        node.scroll.behavior.max_zoom = 3.0;
        surface.scroll_jump(2, Points(0.0), Points(500.0));
        let matrix = surface.local_to_surface(2).unwrap();
        let from = crate::geometry::project(&matrix, 50.0, 100.0).unwrap();
        let to = crate::geometry::project(&matrix, 50.0, 50.0).unwrap();
        assert!(surface.begin_scroll_drag(2, from.0, from.1, false));
        surface.now = 0.1;
        surface.move_scroll_drag(2, to.0, to.1);
        assert!((surface.node(2).unwrap().scroll.y.0 - 550.0).abs() < 0.001);
        surface.end_scroll_drag(2, true);
        surface.scroll_jump(2, Points(0.0), Points(500.0));
        let focal = crate::geometry::project(&matrix, 80.0, 40.0).unwrap();
        assert!(surface.zoom_scroll_at(2, 2.0, focal.0, focal.1));
        let scroll = &surface.node(2).unwrap().scroll;
        assert!((scroll.x.0 - 80.0).abs() < 0.001);
        assert!((scroll.y.0 - 1040.0).abs() < 0.001);
    }

    #[test]
    fn mounted_zoom_limits_constrain_current_and_animated_scales() {
        let mut surface = scroll();
        surface.node_mut(2).unwrap().scroll.behavior.max_zoom = 3.0;
        surface.zoom_scroll(2, 2.0, None, false);
        surface.node_mut(2).unwrap().scroll.behavior.max_zoom = 1.0;
        surface.events.clear();
        surface.clamp_scroll_state(2);
        assert_eq!(surface.node(2).unwrap().scroll.physics.zoom, 1.0);
        assert!(matches!(
            surface.events.first(),
            Some(SurfaceEvent::Zoom(2, 1.0))
        ));
        let behavior = &mut surface.node_mut(2).unwrap().scroll.behavior;
        behavior.min_zoom = 2.0;
        behavior.max_zoom = 3.0;
        surface.clamp_scroll_state(2);
        assert_eq!(surface.node(2).unwrap().scroll.physics.zoom, 2.0);
        surface.zoom_scroll(2, 3.0, None, true);
        surface.node_mut(2).unwrap().scroll.behavior.max_zoom = 2.5;
        surface.clamp_scroll_state(2);
        surface.tick_scroll(0.3);
        assert_eq!(surface.node(2).unwrap().scroll.physics.zoom, 2.5);
    }

    #[test]
    fn mouse_release_keeps_fling_velocity_and_scrollbar_drag_is_clamped() {
        use crossterm::event::{Event, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
        let mut surface = scroll();
        let mouse = |kind, row, column| {
            Event::Mouse(MouseEvent {
                kind,
                row,
                column,
                modifiers: KeyModifiers::NONE,
            })
        };
        surface.scroll_jump(2, Points(0.0), Points(500.0));
        surface.handle_event(mouse(MouseEventKind::Down(MouseButton::Middle), 6, 4));
        surface.now = 0.1;
        surface.handle_event(mouse(MouseEventKind::Drag(MouseButton::Middle), 3, 4));
        surface.now = 0.11;
        surface.handle_event(mouse(MouseEventKind::Up(MouseButton::Middle), 3, 4));
        let released = surface.node(2).unwrap().scroll.y.0;
        surface.tick_scroll(0.2);
        assert!(surface.node(2).unwrap().scroll.y.0 > released);
        surface.scroll_jump(2, Points(0.0), Points(0.0));
        surface.handle_event(mouse(MouseEventKind::Down(MouseButton::Left), 0, 19));
        surface.handle_event(mouse(MouseEventKind::Drag(MouseButton::Left), 5, 19));
        assert!((surface.node(2).unwrap().scroll.y.0 - 800.0).abs() < 0.01);
        surface.handle_event(mouse(MouseEventKind::Up(MouseButton::Left), 5, 19));
        assert!(!surface.scroll_animating());
    }
}

//! Compose transforms before bounding them, so nested rotations preserve
//! their shape and use the same coordinates for drawing and interaction.

use std::cell::RefCell;

use nsh_core::{
    Bounds, CornerRadii, EdgeInsets, Matrix, NodeId, Point, PointerEvents, Points, Size,
    TransformKind, ViewKind,
    geometry::{REM_SIZE, Radians, px},
};

use crate::surface::Surface;

#[derive(Default)]
pub(crate) struct GeometryCache {
    active: bool,
    transforms: Vec<Option<Matrix>>,
}

pub(crate) struct GeometryPass<'a>(&'a RefCell<GeometryCache>);

impl GeometryCache {
    pub(crate) fn begin(cache: &RefCell<Self>) -> GeometryPass<'_> {
        let mut state = cache.borrow_mut();
        debug_assert!(!state.active);
        state.transforms.fill(None);
        state.active = true;
        GeometryPass(cache)
    }
}

impl Drop for GeometryPass<'_> {
    fn drop(&mut self) {
        self.0.borrow_mut().active = false;
    }
}

fn translate(x: f32, y: f32) -> Matrix {
    let mut matrix = Matrix::IDENTITY;
    matrix.0[12] = x as f64;
    matrix.0[13] = y as f64;
    matrix
}

pub(crate) fn project(matrix: &Matrix, x: f32, y: f32) -> Option<(f32, f32)> {
    let m = matrix.0;
    let (x, y) = (x as f64, y as f64);
    let w = x * m[3] + y * m[7] + m[15];
    if !w.is_finite() || w.abs() < 1e-9 {
        return None;
    }
    let point = (
        ((x * m[0] + y * m[4] + m[12]) / w) as f32,
        ((x * m[1] + y * m[5] + m[13]) / w) as f32,
    );
    (point.0.is_finite() && point.1.is_finite()).then_some(point)
}

/// Invert the projected z=0 plane, including perspective.
pub(crate) fn unproject(matrix: &Matrix, x: f32, y: f32) -> Option<(f32, f32)> {
    let m = matrix.0;
    let (x, y) = (x as f64, y as f64);
    let (a, b, c, d) = (
        m[0] - x * m[3],
        m[4] - x * m[7],
        m[1] - y * m[3],
        m[5] - y * m[7],
    );
    let (e, f) = (x * m[15] - m[12], y * m[15] - m[13]);
    let determinant = a * d - b * c;
    if !determinant.is_finite() || determinant.abs() < 1e-9 {
        return None;
    }
    let point = (
        ((e * d - b * f) / determinant) as f32,
        ((a * f - e * c) / determinant) as f32,
    );
    (point.0.is_finite() && point.1.is_finite()).then_some(point)
}

/// One immutable geometry sample for live pointer hit testing.
/// Only visible nodes are candidates; their ancestors are retained once for
/// pointer gates and exact rounded clipping, without cloning a chain per hit.
#[derive(Clone, Debug)]
pub(crate) struct HitSnapshot {
    order: Vec<NodeId>,
    records: Vec<HitRecord>,
    index_by_id: Vec<Option<usize>>,
}

#[derive(Clone, Debug)]
struct HitRecord {
    parent: Option<NodeId>,
    geometry: Option<(Matrix, Size<Points>)>,
    opacity: f32,
    pointer_events: PointerEvents,
    clips_children: bool,
    radii: CornerRadii,
    modal: bool,
    hit_slop: EdgeInsets,
    clip: Bounds<Points>,
}

impl HitSnapshot {
    fn record(&self, id: NodeId) -> Option<&HitRecord> {
        let index = self.index_by_id.get(id as usize).copied().flatten()?;
        self.records.get(index)
    }

    /// The same reverse paint order, pointer gates and clip tests as live input.
    pub(crate) fn hit_test(&self, x: f32, y: f32) -> Option<NodeId> {
        self.order.iter().rev().copied().find(|&id| {
            let Some(node) = self.record(id) else {
                return false;
            };
            if node.opacity <= 0.0
                || node.pointer_events == PointerEvents::None
                || node.pointer_events == PointerEvents::BoxNone
            {
                return false;
            }
            let mut parent = node.parent;
            while let Some(id) = parent {
                let Some(ancestor) = self.record(id) else {
                    return false;
                };
                if matches!(
                    ancestor.pointer_events,
                    PointerEvents::None | PointerEvents::BoxOnly
                ) {
                    return false;
                }
                if ancestor.clips_children
                    && !ancestor.geometry.is_some_and(|(matrix, size)| {
                        unproject(&matrix, x, y).is_some_and(|(x, y)| {
                            crate::composite::rounded_contains(size, ancestor.radii, x, y)
                        })
                    })
                {
                    return false;
                }
                if ancestor.modal {
                    break;
                }
                parent = ancestor.parent;
            }
            let Some((matrix, size)) = node.geometry else {
                return false;
            };
            let Some((local_x, local_y)) = unproject(&matrix, x, y) else {
                return false;
            };
            let frame = Bounds::new(
                Point::new(-node.hit_slop.left, -node.hit_slop.top),
                Size::new(
                    size.width + (node.hit_slop.left + node.hit_slop.right),
                    size.height + (node.hit_slop.top + node.hit_slop.bottom),
                ),
            );
            crate::surface::contains(frame, local_x, local_y)
                && crate::surface::contains(node.clip, x, y)
        })
    }
}

impl Surface {
    /// Captures only immutable geometry and input gates, never scene owners.
    pub(crate) fn hit_snapshot(&self) -> HitSnapshot {
        // A render pass already samples one instant. Outside rendering, reuse
        // its bounded matrix cache only for the duration of this capture.
        let cache_active = self.geometry.borrow().active;
        let _pass = (!cache_active).then(|| GeometryCache::begin(&self.geometry));
        let order = self.visible_ids();
        let mut pending = order.clone();
        let mut snapshot = HitSnapshot {
            records: Vec::with_capacity(order.len()),
            index_by_id: vec![None; self.nodes.len()],
            order,
        };
        while let Some(id) = pending.pop() {
            if snapshot.record(id).is_some() {
                continue;
            }
            let Some(node) = self.node(id) else {
                continue;
            };
            let style = self.animated_style(id);
            let geometry = self
                .presentation_frame(id)
                .and_then(|frame| self.local_to_surface(id).map(|matrix| (matrix, frame.size)));
            snapshot.index_by_id[id as usize] = Some(snapshot.records.len());
            snapshot.records.push(HitRecord {
                parent: node.parent,
                geometry,
                opacity: style.opacity,
                pointer_events: node.props.pointer_events,
                clips_children: matches!(node.kind, ViewKind::Scroll | ViewKind::Stack)
                    || node.style.overflow_hidden,
                radii: style.radii(),
                modal: node.kind == ViewKind::Modal,
                hit_slop: node.props.hit_slop,
                clip: self.clip_rect(id),
            });
            if let Some(parent) = node.parent {
                pending.push(parent);
            }
        }
        snapshot
    }

    /// Maps an untransformed local point to surface points. No intermediate
    /// axis-aligned bounds enter the matrix composition.
    pub(crate) fn local_to_surface(&self, id: NodeId) -> Option<Matrix> {
        {
            let cache = self.geometry.borrow();
            if cache.active
                && let Some(Some(matrix)) = cache.transforms.get(id as usize)
            {
                return Some(*matrix);
            }
        }
        let matrix = self.compute_local_to_surface(id)?;
        let mut cache = self.geometry.borrow_mut();
        if cache.active {
            let index = id as usize;
            if index >= cache.transforms.len() {
                cache.transforms.resize(index + 1, None);
            }
            cache.transforms[index] = Some(matrix);
        }
        Some(matrix)
    }

    fn compute_local_to_surface(&self, id: NodeId) -> Option<Matrix> {
        let mut result = Matrix::IDENTITY;
        let mut current = id;
        loop {
            let node = self.node(current)?;
            let frame = self.presentation_frame(current)?;
            let style = self.animated_style(current);
            let origin = (
                style
                    .transform_origin
                    .x
                    .to_points(frame.size.width.into(), REM_SIZE)
                    .0,
                style
                    .transform_origin
                    .y
                    .to_points(frame.size.height.into(), REM_SIZE)
                    .0,
            );
            let mut transform = style.transform.matrix(|_| None);
            if let Some(motion) = &node.motion {
                let extra = motion.appearance(self.now).1;
                if extra.shift_y_fraction != 0.0 {
                    transform = transform.mul(&translate(
                        0.0,
                        extra.shift_y_fraction * frame.size.height.0,
                    ));
                }
                if extra.rotate != Radians::ZERO {
                    transform = transform.mul(&Matrix::of(
                        TransformKind::Rotate,
                        extra.rotate.to_degrees() as f64,
                    ));
                }
                if extra.scale != 1.0 {
                    transform =
                        transform.mul(&Matrix::of(TransformKind::Scale, extra.scale as f64));
                }
            }
            let step = translate(-origin.0, -origin.1)
                .mul(&transform)
                .mul(&translate(
                    origin.0 + frame.origin.x.0,
                    origin.1 + frame.origin.y.0,
                ));
            result = result.mul(&step);
            if node.kind == ViewKind::Modal {
                break;
            }
            let Some(parent_id) = node.parent else { break };
            let parent = self.node(parent_id)?;
            let parent_frame = self.presentation_frame(parent_id)?;
            let (zoom, center_x, center_y) = self.scroll_content_transform(parent_id);
            let sticky = parent
                .scroll
                .sticky
                .iter()
                .filter(|sticky| {
                    // Sticky cells can live below a plain container (a
                    // parent-viewport list, or a nested position: sticky
                    // view). Move its subtree, not its siblings. Empty
                    // sticky sets do no extra walking or allocation.
                    let mut descendant = id;
                    loop {
                        if descendant == sticky.cell {
                            return true;
                        }
                        if descendant == current {
                            return false;
                        }
                        let Some(parent) = self.node(descendant).and_then(|node| node.parent)
                        else {
                            return false;
                        };
                        descendant = parent;
                    }
                })
                .map(|sticky| {
                    let offset = if parent.scroll.horizontal {
                        parent.scroll.x.0
                    } else {
                        parent.scroll.y.0
                    };
                    // Sample on each presentation pass so a moving sticky
                    // inset updates drawing and hits without a scroll event.
                    let extra = sticky
                        .offset
                        .map_or(0.0, |value| self.animation.eval(value).number());
                    (offset + (extra - sticky.start.0) * zoom)
                        .clamp(0.0, ((sticky.end.0 - sticky.start.0) * zoom).max(0.0))
                })
                .sum::<f32>();
            if zoom != 1.0 {
                result = result.mul(&Matrix::of(TransformKind::Scale, zoom as f64));
            }
            let mirror = if parent.scroll.mirrored {
                parent_frame.size.width.0
                    - 2.0 * frame.origin.x.0 * zoom
                    - frame.size.width.0 * zoom
                    + 2.0 * parent.scroll.x.0
            } else {
                0.0
            };
            result = result.mul(&translate(
                center_x - parent.scroll.x.0
                    + mirror
                    + if parent.scroll.horizontal {
                        sticky
                    } else {
                        0.0
                    },
                center_y - parent.scroll.y.0
                    + if parent.scroll.horizontal {
                        0.0
                    } else {
                        sticky
                    },
            ));
            current = parent_id;
        }
        Some(result)
    }

    pub(crate) fn global_frame(&self, id: NodeId) -> Option<Bounds<Points>> {
        let (origin, size, transform) = if let Some((owner, bounds)) = self.text_link_bounds(id) {
            (bounds.origin, bounds.size, self.local_to_surface(owner)?)
        } else {
            let frame = self.presentation_frame(id)?;
            (Point::default(), frame.size, self.local_to_surface(id)?)
        };
        let points = [
            (origin.x.0, origin.y.0),
            (origin.x.0 + size.width.0, origin.y.0),
            (origin.x.0, origin.y.0 + size.height.0),
            (origin.x.0 + size.width.0, origin.y.0 + size.height.0),
        ];
        let mut bounds = (
            f32::INFINITY,
            f32::INFINITY,
            f32::NEG_INFINITY,
            f32::NEG_INFINITY,
        );
        for (x, y) in points {
            let (x, y) = project(&transform, x, y)?;
            bounds = (
                bounds.0.min(x),
                bounds.1.min(y),
                bounds.2.max(x),
                bounds.3.max(y),
            );
        }
        Some(Bounds::new(
            Point::new(px(bounds.0), px(bounds.1)),
            Size::new(px(bounds.2 - bounds.0), px(bounds.3 - bounds.1)),
        ))
    }

    pub(crate) fn surface_to_local(&self, id: NodeId, x: f32, y: f32) -> Option<(f32, f32)> {
        unproject(&self.local_to_surface(id)?, x, y)
    }
}

#[cfg(test)]
mod tests {
    use nsh_core::{MountBatch, MountItem, ROOT_ID, StickyCell, ViewStyle};

    use super::*;
    use crate::CellMetrics;

    fn sticky_cell(cell: NodeId, start: f32, end: f32) -> StickyCell {
        let mut sticky = StickyCell::default();
        sticky.cell = cell;
        sticky.start = px(start);
        sticky.end = px(end);
        sticky
    }

    #[test]
    fn descendant_sticky_cells_move_their_subtree_on_both_axes() {
        for horizontal in [false, true] {
            let mut surface = Surface::new(40, 20, CellMetrics::default());
            let at = |main| {
                if horizontal {
                    Point::new(px(main), px(0.0))
                } else {
                    Point::new(px(0.0), px(main))
                }
            };
            let mut items = Vec::new();
            for (id, parent, kind, main, extent) in [
                (2, ROOT_ID, ViewKind::Scroll, 8.0, 160.0),
                (4, 2, ViewKind::View, 40.0, 160.0),
                (6, 4, ViewKind::View, 20.0, 32.0),
                (8, 6, ViewKind::View, 3.0, 8.0),
                (10, 4, ViewKind::View, 70.0, 16.0),
                (12, 2, ViewKind::View, 30.0, 16.0),
            ] {
                items.extend([
                    MountItem::Create { id, kind },
                    MountItem::Insert {
                        parent,
                        child: id,
                        before: None,
                    },
                    MountItem::Frame {
                        id,
                        frame: Bounds::new(at(main), Size::new(px(extent), px(extent))),
                    },
                ]);
            }
            items.push(MountItem::StickyCells {
                id: 2,
                cells: vec![sticky_cell(6, 60.0, 140.0)],
            });
            surface.apply(MountBatch { items });
            surface.node_mut(2).unwrap().scroll.horizontal = horizontal;
            let origin = |surface: &Surface, id| {
                let frame = surface.global_frame(id).unwrap();
                if horizontal {
                    frame.origin.x.0
                } else {
                    frame.origin.y.0
                }
            };
            // Origin = unscrolled origin - offset + clamp(offset - 60, 0, 80).
            // At offset 200 the sticky travel ends: 68 - 200 + 80 = -52.
            for (offset, sticky, child, sibling) in [
                (0.0, 68.0, 71.0, 118.0),
                (100.0, 8.0, 11.0, 18.0),
                (200.0, -52.0, -49.0, -82.0),
            ] {
                let scroll = &mut surface.node_mut(2).unwrap().scroll;
                if horizontal {
                    scroll.x = px(offset);
                } else {
                    scroll.y = px(offset);
                }
                assert_eq!(origin(&surface, 6), sticky);
                assert_eq!(origin(&surface, 8), child);
                assert_eq!(origin(&surface, 10), sibling);
            }
            // Preserve native zoom and horizontal mirroring. Both a direct
            // sticky child and a nested one shift in the owner's coordinates.
            // At 2x, shifts are clamp(200 - 120, 0, 160) = 80 for the
            // nested cell, and clamp(200 - 60, 0, 120) = 120 for the direct
            // cell. The unchanged mirror translation cancels in the deltas.
            let scroll = &mut surface.node_mut(2).unwrap().scroll;
            scroll.physics.zoom = 2.0;
            scroll.mirrored = horizontal;
            scroll.sticky.clear();
            let before = [6, 8, 10, 12].map(|id| origin(&surface, id));
            surface.apply(MountBatch {
                items: vec![MountItem::StickyCells {
                    id: 2,
                    cells: vec![sticky_cell(6, 60.0, 140.0), sticky_cell(12, 30.0, 90.0)],
                }],
            });
            for (index, id) in [6, 8, 10, 12].into_iter().enumerate() {
                assert_eq!(
                    origin(&surface, id) - before[index],
                    [80.0, 80.0, 0.0, 120.0][index]
                );
            }
            surface.apply(MountBatch {
                items: vec![MountItem::StickyCells {
                    id: 2,
                    cells: Vec::new(),
                }],
            });
            for (index, id) in [6, 8, 10, 12].into_iter().enumerate() {
                assert_eq!(origin(&surface, id), before[index]);
            }
        }
    }

    #[test]
    fn animated_sticky_offsets_update_paint_and_hits_without_scrolling() {
        use nsh_core::animation::{AnimationOp, Driver, Easing};
        use ratatui::{buffer::Buffer, layout::Rect, style::Color};

        for horizontal in [false, true] {
            let mut surface = Surface::new(20, 10, CellMetrics::default());
            let at = |main| {
                if horizontal {
                    Point::new(px(main), px(0.0))
                } else {
                    Point::new(px(0.0), px(main))
                }
            };
            let mut items = Vec::new();
            for (id, parent, kind, main, extent) in [
                (2, ROOT_ID, ViewKind::Scroll, 0.0, 160.0),
                (4, 2, ViewKind::View, 32.0, 160.0),
                (6, 4, ViewKind::View, 16.0, 32.0),
                (8, 6, ViewKind::View, 0.0, 16.0),
                (10, 4, ViewKind::View, 96.0, 16.0),
            ] {
                items.extend([
                    MountItem::Create { id, kind },
                    MountItem::Insert {
                        parent,
                        child: id,
                        before: None,
                    },
                    MountItem::Frame {
                        id,
                        frame: Bounds::new(at(main), Size::new(px(extent), px(extent))),
                    },
                ]);
            }
            let mut sticky = sticky_cell(6, 48.0, 144.0);
            sticky.offset = Some(1);
            items.extend([
                MountItem::ScrollContent {
                    id: 2,
                    size: Size::new(px(320.0), px(320.0)),
                },
                MountItem::ViewStyle {
                    id: 8,
                    style: Box::new(ViewStyle {
                        background_color: nsh_core::Color(0xff0000ff),
                        ..Default::default()
                    }),
                },
                MountItem::StickyCells {
                    id: 2,
                    cells: vec![sticky],
                },
                MountItem::Animation(AnimationOp::CreateValue {
                    node: 1,
                    value: 0.0,
                }),
                MountItem::Animation(AnimationOp::Start {
                    node: 1,
                    animation: 1,
                    driver: Driver::Timing {
                        to: 32.0,
                        duration_ms: 1000.0,
                        easing: Easing::Linear,
                        delay_ms: 0.0,
                    },
                }),
            ]);
            surface.apply(MountBatch { items });
            let scroll = &mut surface.node_mut(2).unwrap().scroll;
            scroll.horizontal = horizontal;
            if horizontal {
                scroll.x = px(80.0);
            } else {
                scroll.y = px(80.0);
            }
            let sibling = surface.global_frame(10).unwrap();
            let area = Rect::new(0, 0, 20, 10);
            for (now, inset) in [(0.0, 0.0), (0.5, 16.0), (1.0, 32.0)] {
                assert!(surface.tick(now) || now == 0.0);
                assert_eq!(surface.global_frame(6).unwrap().origin, at(inset));
                assert_eq!(surface.global_frame(8).unwrap().origin, at(inset));
                assert_eq!(surface.global_frame(10).unwrap(), sibling);
                let point = at(inset) + Point::new(px(8.0), px(8.0));
                assert_eq!(surface.hit_test(point.x.0, point.y.0), Some(8));
                assert_eq!(
                    surface.hit_snapshot().hit_test(point.x.0, point.y.0),
                    Some(8)
                );
                let mut buffer = Buffer::empty(area);
                surface.render(area, &mut buffer);
                let cell = if horizontal {
                    ((inset / 8.0) as u16, 0)
                } else {
                    (0, (inset / 16.0) as u16)
                };
                assert_eq!(buffer[cell].bg, Color::Rgb(255, 0, 0));
            }
            // Animated insets use the same content-point scale and travel
            // bounds as numeric insets, including negative values.
            surface.node_mut(2).unwrap().scroll.physics.zoom = 2.0;
            for (value, expected) in [(-100.0, 16.0), (32.0, 64.0), (200.0, 208.0)] {
                surface.apply(MountBatch {
                    items: vec![MountItem::Animation(AnimationOp::Set { node: 1, value })],
                });
                assert_eq!(surface.global_frame(6).unwrap().origin, at(expected));
            }
        }
    }

    #[test]
    fn render_cache_never_reuses_geometry_after_a_mount_or_outside_rendering() {
        let mut surface = Surface::new(40, 20, CellMetrics::default());
        surface.apply(MountBatch {
            items: vec![
                MountItem::Create {
                    id: 2,
                    kind: ViewKind::View,
                },
                MountItem::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
                MountItem::Frame {
                    id: 2,
                    frame: Bounds::new(Point::new(px(8.0), px(0.0)), Size::new(px(16.0), px(16.0))),
                },
            ],
        });
        {
            let _pass = GeometryCache::begin(&surface.geometry);
            assert_eq!(surface.global_frame(2).unwrap().origin.x.0, 8.0);
        }
        surface.apply(MountBatch {
            items: vec![MountItem::Frame {
                id: 2,
                frame: Bounds::new(Point::new(px(24.0), px(0.0)), Size::new(px(16.0), px(16.0))),
            }],
        });
        assert_eq!(surface.global_frame(2).unwrap().origin.x.0, 24.0);
        let _pass = GeometryCache::begin(&surface.geometry);
        assert_eq!(surface.global_frame(2).unwrap().origin.x.0, 24.0);
    }

    #[test]
    fn inverse_includes_rotation_and_perspective() {
        let mut matrix = Matrix::of(TransformKind::Rotate, 33.0).mul(&translate(20.0, 8.0));
        matrix.0[3] = 0.001;
        matrix.0[7] = 0.002;
        let point = project(&matrix, 13.0, 27.0).unwrap();
        let restored = unproject(&matrix, point.0, point.1).unwrap();
        assert!((restored.0 - 13.0).abs() < 0.001 && (restored.1 - 27.0).abs() < 0.001);
    }

    #[test]
    fn opposing_nested_rotations_are_bounded_after_composition() {
        let mut parent = ViewStyle::default();
        parent.transform.push(TransformKind::Rotate, 45.0);
        let mut child = ViewStyle::default();
        child.transform.push(TransformKind::Rotate, -45.0);
        let mut surface = Surface::new(40, 20, CellMetrics::default());
        surface.apply(MountBatch {
            items: vec![
                MountItem::Create {
                    id: 2,
                    kind: ViewKind::View,
                },
                MountItem::Create {
                    id: 4,
                    kind: ViewKind::View,
                },
                MountItem::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
                MountItem::Insert {
                    parent: 2,
                    child: 4,
                    before: None,
                },
                MountItem::Frame {
                    id: 2,
                    frame: Bounds::new(
                        Point::new(px(40.0), px(40.0)),
                        Size::new(px(100.0), px(100.0)),
                    ),
                },
                MountItem::Frame {
                    id: 4,
                    frame: Bounds::new(
                        Point::new(px(20.0), px(20.0)),
                        Size::new(px(20.0), px(10.0)),
                    ),
                },
                MountItem::ViewStyle {
                    id: 2,
                    style: Box::new(parent),
                },
                MountItem::ViewStyle {
                    id: 4,
                    style: Box::new(child),
                },
            ],
        });
        let frame = surface.global_frame(4).unwrap();
        assert!((frame.size.width.0 - 20.0).abs() < 0.001);
        assert!((frame.size.height.0 - 10.0).abs() < 0.001);
        let center = project(&surface.local_to_surface(4).unwrap(), 10.0, 5.0).unwrap();
        assert_eq!(surface.hit_test(center.0, center.1), Some(4));
    }

    #[test]
    fn rounded_ancestor_mask_excludes_child_pointer_hits() {
        let style = ViewStyle {
            overflow_hidden: true,
            border_radius: px(32.0),
            ..ViewStyle::default()
        };
        let mut surface = Surface::new(10, 5, CellMetrics::default());
        let frame = Bounds::new(Point::new(px(0.0), px(0.0)), Size::new(px(64.0), px(64.0)));
        surface.apply(MountBatch {
            items: vec![
                MountItem::Create {
                    id: 2,
                    kind: ViewKind::View,
                },
                MountItem::Create {
                    id: 4,
                    kind: ViewKind::View,
                },
                MountItem::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
                MountItem::Insert {
                    parent: 2,
                    child: 4,
                    before: None,
                },
                MountItem::Frame { id: 2, frame },
                MountItem::Frame { id: 4, frame },
                MountItem::ViewStyle {
                    id: 2,
                    style: Box::new(style),
                },
            ],
        });
        assert_ne!(surface.hit_test(1.0, 1.0), Some(4));
        assert_eq!(surface.hit_test(32.0, 32.0), Some(4));
    }
}

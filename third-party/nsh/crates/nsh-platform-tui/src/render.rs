//! Cell painting for a retained terminal surface. Geometry stays in
//! points until the final conversion, including ancestor clipping and
//! scrolling, so the renderer and hit testing share the same coordinate
//! system.

use nsh_core::{
    AccessibilityRole, BlendMode, BorderStyle, Bounds, Color, Dialog, DialogButtonStyle, EventKind,
    Gradient, GradientKind, GradientSize, NodeId, ObjectPosition, Point, Points, ResizeMode, Size,
    TextAlign, ViewKind, ViewStyle,
    geometry::{Percentage, px},
};
use ratatui::{
    buffer::{Buffer, CellDiffOption},
    layout::{Position as CellPosition, Rect as CellRect},
    style::{Color as CellColor, Modifier, Style},
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::{
    CellMetrics,
    surface::{Node, Surface},
};

const FOCUS: Color = Color(0x388b_fdff);

struct CompositePlan {
    id: NodeId,
    bounds: Bounds<Points>,
}

impl Surface {
    /// The focused editor's visible caret cell, for terminal input methods.
    /// The host may keep its physical cursor hidden while positioning it here.
    pub fn input_cursor_position(&self, area: CellRect) -> Option<CellPosition> {
        if self.dialog.is_some() || self.service_overlay_open() {
            return None;
        }
        let id = self.focus?;
        let node = self.node(id)?;
        if node.kind != ViewKind::Input
            || !node.input.editable
            || node.props.accessibility.state.disabled
            || !self.navigation_accepts(id)
            || self.paint_opacity(id) <= 0.0
        {
            return None;
        }
        let geometry = self.input_hit_geometry(id)?;
        let columns = if node.input.multiline {
            geometry.columns
        } else {
            usize::MAX
        };
        let (row, column) = node.editor.cursor_cell(columns, node.input.secure);
        let (scroll_row, scroll_col) = input_scroll(node, true, geometry.columns, geometry.rows);
        let visible_row = row.checked_sub(scroll_row)?;
        let visible_column = column.checked_sub(scroll_col)?;
        if visible_row >= geometry.rows {
            return None;
        }
        let alignment = if matches!(node.input.align, TextAlign::Center | TextAlign::Right)
            || (node.input.align == TextAlign::Auto && node.input.rtl)
        {
            input_line_offsets(node, true, geometry.columns)
                .get(row)
                .copied()
                .unwrap_or(0)
        } else {
            0
        };
        let column = geometry
            .column
            .saturating_add(visible_column as i64)
            .saturating_add(alignment as i64)
            .min(
                geometry
                    .column
                    .saturating_add(geometry.columns.saturating_sub(1) as i64),
            );
        let row = geometry.row.saturating_add(visible_row as i64);
        let local = CellPosition::new(column.try_into().ok()?, row.try_into().ok()?);
        if !geometry.visible.contains(local) {
            return None;
        }
        let (x, y) = (
            column as f32 * self.metrics.width().0,
            row as f32 * self.metrics.height().0,
        );
        let mut caret = Bounds::new(Point::new(px(x), px(y)), self.metrics.viewport(1, 1));
        if self.composite_ancestor(id) {
            let transform = self.local_to_surface(id)?;
            let (mut left, mut top, mut right, mut bottom) = (
                f32::INFINITY,
                f32::INFINITY,
                f32::NEG_INFINITY,
                f32::NEG_INFINITY,
            );
            for (x, y) in [
                (x, y),
                (x + self.metrics.width().0, y),
                (x, y + self.metrics.height().0),
                (x + self.metrics.width().0, y + self.metrics.height().0),
            ] {
                let (x, y) = crate::geometry::project(&transform, x, y)?;
                left = left.min(x);
                top = top.min(y);
                right = right.max(x);
                bottom = bottom.max(y);
            }
            caret = Bounds::new(
                Point::new(px(left), px(top)),
                Size::new(px(right - left), px(bottom - top)),
            );
        }
        let visible = cells(caret, self.metrics, area)
            .intersection(cells(self.clip_rect(id), self.metrics, area))
            .intersection(area);
        (!visible.is_empty()).then(|| CellPosition::new(visible.x, visible.y))
    }

    /// Paints the surface inside `area`, leaving cells outside it intact.
    ///
    /// The embedding application owns terminal IO and may render several
    /// independent surfaces into one Ratatui frame.
    pub fn render(&self, area: CellRect, buffer: &mut Buffer) {
        self.render_scene(area, buffer, true);
    }

    /// Paints the surface using Unicode image and canvas blocks for this pass.
    ///
    /// The configured image protocol and its retained encodings remain
    /// available to later [`Self::render`] calls. This pass neither requests
    /// protocol encodings nor consumes protocol uploads. It does not undo an
    /// earlier render's state: hosts must not use it to roll back a Kitty upload.
    pub fn render_plain(&self, area: CellRect, buffer: &mut Buffer) {
        self.render_scene(area, buffer, false);
    }

    fn render_scene(&self, area: CellRect, buffer: &mut Buffer, use_protocols: bool) {
        let area = area.intersection(buffer.area);
        if area.is_empty() {
            return;
        }
        // Occlusion and clipping revisit the same ancestors for each image.
        // Reuse transforms for this immutable pass, never across animation ticks.
        let _geometry = crate::geometry::GeometryCache::begin(&self.geometry);
        let background = if self.dark {
            Color(0x181b_22ff)
        } else {
            Color(0xffff_ffff)
        };
        let foreground = if self.dark {
            Color(0xe6e9_efff)
        } else {
            Color::BLACK
        };
        for y in area.y..area.bottom() {
            for x in area.x..area.right() {
                buffer[(x, y)].reset();
                buffer[(x, y)]
                    .set_bg(cell_color(background))
                    .set_fg(cell_color(foreground));
            }
        }

        let use_protocols = use_protocols && !self.service_overlay_open();
        let ids = self.paint_ids();
        let plans = self.composite_plans(&ids, area);
        self.composites
            .borrow_mut()
            .retain(&plans.iter().map(|plan| plan.id).collect::<Vec<_>>());
        if use_protocols {
            self.protocol.retain(&ids);
        }
        let mut overlays = Vec::new();
        let mut composed = None;
        for &id in &ids {
            while overlays
                .last()
                .is_some_and(|&scroll| !self.is_paint_descendant(id, scroll))
            {
                if let Some(node) = overlays.pop() {
                    self.paint_node_overlay(node, area, buffer);
                }
            }
            if composed.is_some_and(|root| self.is_paint_descendant(id, root)) {
                continue;
            }
            composed = None;
            let (Some(node), Some(frame)) = (self.node(id), self.global_frame(id)) else {
                continue;
            };
            let style = self.animated_style(id);
            let opacity = self.paint_opacity(id);
            if style.hidden || opacity <= 0.0 || !finite_rect(frame) {
                continue;
            }
            let clip = self.clip_rect(id);
            if let Some(plan) = plans.iter().find(|plan| plan.id == id)
                && let Some(scene) = self.composite_scene(plan, &ids, area, buffer)
                && let Some(frame) = self
                    .composites
                    .borrow_mut()
                    .request(id, scene, &self.graphics)
            {
                let protocol = use_protocols
                    && self.try_composite_protocol(id, &frame, area, buffer, &ids, &plans);
                if !protocol {
                    crate::image::paint(
                        &frame.raster,
                        frame.bounds,
                        clip,
                        ResizeMode::Stretch,
                        None,
                        1.0,
                        self.metrics,
                        area,
                        buffer,
                    );
                }
                composed = Some(id);
                continue;
            }
            // Screens cover their presenter while sliding; Dialog layers
            // remain transparent and let the app provide its own backdrop.
            if node.kind == ViewKind::Screen {
                fill(
                    buffer,
                    cells(frame, self.metrics, area),
                    cells(clip, self.metrics, area),
                    background,
                    opacity,
                    BlendMode::Normal,
                    true,
                );
            }
            self.paint_decor(frame, clip, &style, opacity, area, buffer);
            let foreground = node.bindings.iter().find_map(|(property, value)| {
                if *property != nsh_core::animation::AnimationProp::Color {
                    return None;
                }
                Some(match self.animation.eval(*value) {
                    nsh_core::animation::AnimationValue::Color(color) => Color(color),
                    value => Color(value.number() as u32),
                })
            });
            match node.kind {
                ViewKind::Input => paint_input(
                    node,
                    self.focus == Some(id),
                    frame,
                    clip,
                    opacity,
                    foreground,
                    self.metrics,
                    area,
                    buffer,
                ),
                ViewKind::Image => {
                    let presentation = node.image.presentation(self.now);
                    let both = presentation.placeholder.is_some() && presentation.main.is_some();
                    for layer in presentation
                        .placeholder
                        .into_iter()
                        .chain(presentation.main)
                    {
                        let raster = layer.raster;
                        let (image_frame, image_clip, mode) = image_geometry(
                            layer.source,
                            raster,
                            node.image.mode(),
                            node.image.position(),
                            node.frame.size,
                            frame,
                            clip,
                        );
                        let opacity = opacity * layer.opacity;
                        let protocol = use_protocols
                            && !both
                            && self.try_image_protocol(
                                id,
                                raster,
                                image_frame,
                                image_clip,
                                mode,
                                style.tint_color,
                                opacity,
                                area,
                                buffer,
                                &ids,
                                &plans,
                            );
                        if !protocol {
                            crate::image::paint(
                                raster,
                                image_frame,
                                image_clip,
                                mode,
                                style.tint_color,
                                opacity,
                                self.metrics,
                                area,
                                buffer,
                            );
                        }
                    }
                }
                ViewKind::Canvas => {
                    if let Some(raster) = &node.canvas_raster {
                        let protocol = use_protocols
                            && self.try_image_protocol(
                                id,
                                raster,
                                frame,
                                clip,
                                ResizeMode::Stretch,
                                None,
                                opacity,
                                area,
                                buffer,
                                &ids,
                                &plans,
                            );
                        if !protocol {
                            crate::image::paint(
                                raster,
                                frame,
                                clip,
                                ResizeMode::Stretch,
                                None,
                                opacity,
                                self.metrics,
                                area,
                                buffer,
                            );
                        }
                    }
                }
                ViewKind::Native => {
                    if let Some(component) = &node.native {
                        component.render(&self.component_context(id, area), buffer);
                    }
                }
                ViewKind::WebView | ViewKind::Video => {
                    let rect = cells(frame, self.metrics, area);
                    if let Some(media) = &node.media
                        && let Some(raster) = media.raster()
                    {
                        let protocol = use_protocols
                            && self.try_image_protocol(
                                id,
                                raster,
                                frame,
                                clip,
                                media.resize_mode(),
                                None,
                                opacity,
                                area,
                                buffer,
                                &ids,
                                &plans,
                            );
                        if !protocol {
                            crate::image::paint(
                                raster,
                                frame,
                                clip,
                                media.resize_mode(),
                                None,
                                opacity,
                                self.metrics,
                                area,
                                buffer,
                            );
                        }
                    }
                    self.paint_media_text(
                        id,
                        rect,
                        cells(clip, self.metrics, area).intersection(area),
                        opacity,
                        buffer,
                    );
                }
                _ => {}
            }
            if let Some((text, layout, content)) = &node.text {
                let content = relative_frame(frame, node.frame, *content);
                let area_range = self.selection_area_range(id);
                let focused_link = text.links.iter().find(|link| {
                    area_range.is_none()
                        && self.dialog.is_none()
                        && self.focus == Some(link.node)
                        && link.is_enabled()
                });
                let selection = focused_link.map_or_else(
                    || area_range.unwrap_or_else(|| node.editor.selection()),
                    |link| (link.start, link.end),
                );
                if (area_range.is_some()
                    || (self.focus == Some(id) && text.is_selectable())
                    || focused_link.is_some())
                    && selection.0 < selection.1
                    && let Some(terminal) = layout.0.downcast_ref::<crate::text::TerminalLayout>()
                {
                    let color = if focused_link.is_some() {
                        Color(0x388b_fd66)
                    } else {
                        text.selection_color.unwrap_or(Color(0x388b_fd66))
                    };
                    for run in terminal
                        .runs
                        .iter()
                        .filter(|run| run.start < selection.1 && run.end > selection.0)
                    {
                        let rect = Bounds::new(
                            Point::new(content.origin.x + run.x, content.origin.y + run.y),
                            Size::new(
                                f32::from(run.width) * self.metrics.width(),
                                self.metrics.height(),
                            ),
                        );
                        fill(
                            buffer,
                            cells(rect, self.metrics, area),
                            cells(clip, self.metrics, area),
                            color,
                            opacity,
                            BlendMode::Normal,
                            false,
                        );
                    }
                }
                let filter = style
                    .effects
                    .as_ref()
                    .and_then(|effects| nsh_core::compose_color_matrices(&effects.filters));
                if foreground.is_some() || filter.is_some() {
                    crate::text::render_text_filtered(
                        layout,
                        content.origin,
                        clip,
                        opacity,
                        foreground,
                        filter.as_ref(),
                        self.metrics,
                        area,
                        buffer,
                    );
                } else {
                    crate::text::render_text(
                        layout,
                        content.origin,
                        clip,
                        opacity,
                        self.metrics,
                        area,
                        buffer,
                    );
                }
                if let Some(link) = focused_link
                    && let Some(terminal) = layout.downcast::<crate::text::TerminalLayout>()
                {
                    for run in terminal
                        .runs
                        .iter()
                        .filter(|run| run.start < link.end && run.end > link.start)
                    {
                        let rect = cells(
                            Bounds::new(
                                Point::new(content.origin.x + run.x, content.origin.y + run.y),
                                Size::new(
                                    f32::from(run.width) * self.metrics.width(),
                                    self.metrics.height(),
                                ),
                            ),
                            self.metrics,
                            area,
                        )
                        .intersection(cells(clip, self.metrics, area))
                        .intersection(buffer.area);
                        for y in rect.y..rect.bottom() {
                            for x in rect.x..rect.right() {
                                let cell = &mut buffer[(x, y)];
                                if focus_text_cell(cell) {
                                    cell.set_style(Style::new().add_modifier(Modifier::UNDERLINED));
                                }
                            }
                        }
                    }
                }
            }
            if (node.kind == ViewKind::Scroll
                && (node.scroll.shows_indicator
                    || node.scroll.physics.refreshing
                    || node.scroll.physics.refresh_progress() > 0.0))
                || style.borders.is_visible()
                || style.outline.is_visible()
            {
                overlays.push(id);
            }
        }

        // Native adornments follow the content, just as scroll indicators
        // and a keyboard focus ring sit above child views in GUI backends.
        while let Some(id) = overlays.pop() {
            self.paint_node_overlay(id, area, buffer);
        }
        if let Some(id) = self.focus.filter(|_| self.dialog.is_none())
            && let (Some(node), Some(frame)) = (self.node(id), self.global_frame(id))
            && !node.props.accessibility.state.disabled
        {
            let rect = cells(frame, self.metrics, area);
            let clip = cells(self.clip_rect(id), self.metrics, area).intersection(area);
            if focus_uses_text_indicator(node, rect) {
                let rect = rect.intersection(clip).intersection(buffer.area);
                for y in rect.y..rect.bottom() {
                    for x in rect.x..rect.right() {
                        let cell = &mut buffer[(x, y)];
                        if focus_text_cell(cell) {
                            cell.set_style(Style::new().add_modifier(Modifier::UNDERLINED));
                        }
                    }
                }
            } else {
                let text_cells = capture_border_text(buffer, rect, clip);
                stroke_frame(
                    buffer,
                    frame,
                    self.metrics,
                    area,
                    clip,
                    [true; 4],
                    [FOCUS; 4],
                    BorderStyle::Solid,
                    [true; 4],
                    1.0,
                );
                // Point padding may be smaller than a terminal cell. A
                // focus indicator must preserve the label and caret when
                // their cell overlaps the snapped border.
                for (position, mut cell) in text_cells {
                    cell.set_style(Style::new().add_modifier(Modifier::UNDERLINED));
                    buffer[position] = cell;
                }
            }
        }
        self.render_service_overlay(area, buffer);
        if let Some((message, until)) = &self.toast
            && *until > self.now
        {
            paint_toast(message, self.dark, area, buffer);
        }
        if let Some(dialog) = &self.dialog {
            paint_dialog(dialog, self.dialog_selection, self.dark, area, buffer);
        }
    }

    pub(crate) fn composite_ancestor(&self, id: NodeId) -> bool {
        let mut current = Some(id);
        while let Some(id) = current {
            if self.composite_required(id) {
                return true;
            }
            let Some(node) = self.node(id) else { break };
            if node.kind == ViewKind::Modal {
                break;
            }
            current = node.parent;
        }
        false
    }

    fn composite_required(&self, id: NodeId) -> bool {
        let Some(node) = self.node(id) else {
            return false;
        };
        let style = self.animated_style(id);
        let radii = style.radii();
        let rounded = [
            radii.top_left,
            radii.top_right,
            radii.bottom_right,
            radii.bottom_left,
        ]
        .iter()
        .any(|r| *r > Points::ZERO);
        let effects = style.effects.as_ref().is_some_and(|effects| {
            !effects.filters.is_empty() || !effects.backdrop_filters.is_empty()
        });
        let opacity = style.opacity;
        let grouped_alpha = opacity < 0.999
            && opacity > 0.0
            && (!node.children.is_empty()
                || (!style.background_color.is_transparent()
                    && matches!(
                        node.kind,
                        ViewKind::Image | ViewKind::Text | ViewKind::Input | ViewKind::Canvas
                    )));
        let transformed = self
            .local_to_surface(id)
            .is_some_and(|matrix| !translation_only(&matrix));
        let image = node.image.presentation(self.now);
        let image_fade = image.main.is_some_and(|image| image.opacity < 0.999)
            || (image.main.is_some() && image.placeholder.is_some());
        effects
            || grouped_alpha
            || transformed
            || style.blend_mode != BlendMode::Normal
            || ((style.overflow_hidden
                || matches!(
                    node.kind,
                    ViewKind::Image | ViewKind::Scroll | ViewKind::Stack | ViewKind::Input
                ))
                && rounded)
            || (matches!(node.kind, ViewKind::Image | ViewKind::Canvas) && rounded)
            || image_fade
            || (node.kind == ViewKind::Scroll
                && (self.scroll_content_transform(id).0 - 1.0).abs() > 0.001)
    }

    fn composite_plans(&self, ids: &[NodeId], area: CellRect) -> Vec<CompositePlan> {
        let mut plans: Vec<CompositePlan> = Vec::new();
        for &id in ids {
            if plans
                .iter()
                .any(|plan| self.is_paint_descendant(id, plan.id))
                || !self.composite_required(id)
            {
                continue;
            }
            let Some(mut bounds) = self.global_frame(id) else {
                continue;
            };
            for &child in ids
                .iter()
                .filter(|&&child| self.is_paint_descendant(child, id))
            {
                let Some(frame) = self.global_frame(child) else {
                    continue;
                };
                let style = self.animated_style(child);
                let mut spread = if style.shadow.is_visible() {
                    style.shadow.radius.max(Points::ZERO) * 3.0
                        + style.shadow.offset_x.abs().max(style.shadow.offset_y.abs())
                } else {
                    Points::ZERO
                };
                if style.outline.is_visible() {
                    spread =
                        spread.max((style.outline.offset + style.outline.width).max(Points::ZERO));
                }
                if let Some(effects) = &style.effects {
                    for filter in effects.filters.iter().chain(&effects.backdrop_filters) {
                        spread = spread.max(match *filter {
                            nsh_core::Filter::Blur(radius) => radius.max(Points::ZERO) * 3.0,
                            nsh_core::Filter::DropShadow {
                                offset_x,
                                offset_y,
                                blur,
                                ..
                            } => offset_x.abs().max(offset_y.abs()) + blur.max(Points::ZERO) * 2.0,
                            _ => Points::ZERO,
                        });
                    }
                    for shadow in &effects.box_shadows {
                        spread = spread.max(
                            shadow.spread.max(Points::ZERO)
                                + shadow.blur.max(Points::ZERO) * 2.0
                                + shadow.offset_x.abs().max(shadow.offset_y.abs()),
                        );
                    }
                }
                let frame = Bounds::new(
                    Point::new(frame.origin.x - spread, frame.origin.y - spread),
                    Size::new(
                        frame.size.width + spread * 2.0,
                        frame.size.height + spread * 2.0,
                    ),
                );
                bounds = bounds.union(&frame);
            }
            bounds = crate::surface::intersect(bounds, self.clip_rect(id));
            let rect = cells(bounds, self.metrics, area);
            if rect.is_empty() {
                continue;
            }
            let bounds = Bounds::new(
                Point::new(
                    f32::from(rect.x - area.x) * self.metrics.width(),
                    f32::from(rect.y - area.y) * self.metrics.height(),
                ),
                Size::new(
                    f32::from(rect.width) * self.metrics.width(),
                    f32::from(rect.height) * self.metrics.height(),
                ),
            );
            plans.push(CompositePlan { id, bounds });
        }
        plans
    }

    fn composite_scene(
        &self,
        plan: &CompositePlan,
        ids: &[NodeId],
        area: CellRect,
        buffer: &Buffer,
    ) -> Option<crate::composite::Scene> {
        let rect = cells(plan.bounds, self.metrics, area);
        let mut backdrop = Buffer::empty(rect);
        for y in rect.y..rect.bottom() {
            for x in rect.x..rect.right() {
                backdrop[(x, y)] = buffer[(x, y)].clone();
            }
        }
        let root = self.composite_layer(plan.id, ids, 0)?;
        let opacity = root.style.opacity;
        let inherited_opacity = if opacity > 0.0 {
            self.paint_opacity(plan.id) / opacity
        } else {
            0.0
        };
        Some(crate::composite::Scene {
            bounds: plan.bounds,
            root,
            backdrop,
            metrics: self.metrics,
            font_revision: self.fonts.revision(),
            inherited_opacity,
        })
    }

    fn composite_layer(
        &self,
        id: NodeId,
        ids: &[NodeId],
        depth: usize,
    ) -> Option<crate::composite::Layer> {
        if depth >= 32 {
            return None;
        }
        let node = self.node(id)?;
        let frame = self.presentation_frame(id)?;
        let size = frame.size;
        let local = Bounds::new(Point::default(), size);
        if !finite_rect(local) {
            return None;
        }
        let mut style = self.animated_style(id);
        if node.kind == ViewKind::Screen {
            let backdrop = if self.dark {
                Color(0x181b_22ff)
            } else {
                Color(0xffff_ffff)
            };
            style.background_color = over_color(style.background_color, backdrop);
        }
        if matches!(
            node.kind,
            ViewKind::Scroll | ViewKind::Image | ViewKind::Stack | ViewKind::Input
        ) {
            style.overflow_hidden = true;
        }
        let foreground = node.bindings.iter().find_map(|(property, value)| {
            (*property == nsh_core::animation::AnimationProp::Color).then(|| {
                match self.animation.eval(*value) {
                    nsh_core::animation::AnimationValue::Color(color) => Color(color),
                    value => Color(value.number() as u32),
                }
            })
        });
        let focus_text = self.focus.is_some_and(|focus| {
            self.is_paint_descendant(id, focus)
                && self
                    .node(focus)
                    .zip(self.global_frame(focus))
                    .is_some_and(|(node, frame)| {
                        focus_uses_text_indicator(
                            node,
                            cells(
                                frame,
                                self.metrics,
                                CellRect::new(0, 0, self.columns, self.rows),
                            ),
                        )
                    })
        });
        let mut layer = crate::composite::Layer {
            id,
            size,
            transform: self.local_to_surface(id)?,
            clip: self.clip_rect(id),
            style,
            images: Vec::new(),
            text: None,
            cells: None,
            overlay: None,
            children: Vec::new(),
        };
        if node.kind == ViewKind::Image {
            let images = node.image.presentation(self.now);
            for image in images.placeholder.into_iter().chain(images.main) {
                let (frame, _, mode) = image_geometry(
                    image.source,
                    image.raster,
                    node.image.mode(),
                    node.image.position(),
                    size,
                    local,
                    local,
                );
                layer.images.push(crate::composite::Image {
                    raster: image.raster.clone(),
                    frame,
                    mode,
                    tint: layer.style.tint_color,
                    opacity: image.opacity,
                });
            }
        }
        if let Some(raster) = &node.canvas_raster {
            layer.images.push(crate::composite::Image {
                raster: raster.clone(),
                frame: local,
                mode: ResizeMode::Stretch,
                tint: None,
                opacity: 1.0,
            });
        }
        if let Some(media) = &node.media
            && let Some(raster) = media.raster()
        {
            layer.images.push(crate::composite::Image {
                raster: raster.clone(),
                frame: local,
                mode: media.resize_mode(),
                tint: None,
                opacity: 1.0,
            });
        }
        if let Some((text, layout, content)) = &node.text {
            let content = relative_frame(local, node.frame, *content);
            let mut selection = Vec::new();
            let area_range = self.selection_area_range(id);
            let focused_link = text.links.iter().find(|link| {
                area_range.is_none()
                    && self.dialog.is_none()
                    && self.focus == Some(link.node)
                    && link.is_enabled()
            });
            let range = focused_link.map_or_else(
                || area_range.unwrap_or_else(|| node.editor.selection()),
                |link| (link.start, link.end),
            );
            if (area_range.is_some()
                || (self.focus == Some(id) && text.is_selectable())
                || focused_link.is_some())
                && range.0 < range.1
                && let Some(terminal) = layout.0.downcast_ref::<crate::text::TerminalLayout>()
            {
                for run in terminal
                    .runs
                    .iter()
                    .filter(|run| run.start < range.1 && run.end > range.0)
                {
                    selection.push((
                        Bounds::new(
                            Point::new(content.origin.x + run.x, content.origin.y + run.y),
                            Size::new(
                                f32::from(run.width) * self.metrics.width(),
                                self.metrics.height(),
                            ),
                        ),
                        if focused_link.is_some() {
                            Color(0x388b_fd66)
                        } else {
                            text.selection_color.unwrap_or(Color(0x388b_fd66))
                        },
                    ));
                }
            }
            layer.text = Some(crate::composite::Text {
                layout: layout.clone(),
                content,
                foreground,
                selection,
                focus: focus_text,
                focus_range: focused_link.map(|link| (link.start, link.end)),
            });
        }
        if matches!(
            node.kind,
            ViewKind::Input | ViewKind::Native | ViewKind::WebView | ViewKind::Video
        ) {
            let columns = (size.width / self.metrics.width())
                .ceil()
                .clamp(1.0, 1024.0) as u16;
            let rows = (size.height / self.metrics.height())
                .ceil()
                .clamp(1.0, 512.0) as u16;
            if u32::from(columns) * u32::from(rows) > 65536 {
                return None;
            }
            let area = CellRect::new(0, 0, columns, rows);
            let mut buffer = Buffer::empty(area);
            match node.kind {
                ViewKind::Input => paint_input(
                    node,
                    self.focus == Some(id),
                    local,
                    local,
                    1.0,
                    foreground,
                    self.metrics,
                    area,
                    &mut buffer,
                ),
                ViewKind::Native => {
                    if let Some(component) = &node.native {
                        component.render(
                            &crate::native::ComponentContext {
                                frame: local,
                                clip: local,
                                area,
                                clip_area: area,
                                metrics: self.metrics,
                                focused: self.focus == Some(id),
                            },
                            &mut buffer,
                        );
                    }
                }
                ViewKind::WebView | ViewKind::Video => {
                    self.paint_media_text(id, area, area, 1.0, &mut buffer)
                }
                _ => {}
            }
            if focus_text {
                for cell in &mut buffer.content {
                    if focus_text_cell(cell) {
                        cell.set_style(Style::new().add_modifier(Modifier::UNDERLINED));
                    }
                }
            }
            layer.cells = Some(buffer);
        }
        if node.kind == ViewKind::Scroll
            && (node.scroll.shows_indicator
                || node.scroll.physics.refreshing
                || node.scroll.physics.refresh_progress() > 0.0)
        {
            let columns = (size.width / self.metrics.width())
                .ceil()
                .clamp(1.0, 1024.0) as u16;
            let rows = (size.height / self.metrics.height())
                .ceil()
                .clamp(1.0, 512.0) as u16;
            if u32::from(columns) * u32::from(rows) > 65536 {
                return None;
            }
            let area = CellRect::new(0, 0, columns, rows);
            let mut buffer = Buffer::empty(area);
            paint_scrollbars(
                node,
                local,
                local,
                1.0,
                self.metrics,
                area,
                self.now,
                &mut buffer,
            );
            layer.overlay = Some(buffer);
        }
        let mut children = node
            .children
            .iter()
            .copied()
            .filter(|child| ids.contains(child))
            .collect::<Vec<_>>();
        children.sort_by_key(|child| ids.iter().position(|id| id == child));
        for child in children {
            if !ids.contains(&child)
                || self
                    .node(child)
                    .is_some_and(|child| child.kind == ViewKind::Modal)
            {
                continue;
            }
            layer
                .children
                .push(self.composite_layer(child, ids, depth + 1)?);
        }
        Some(layer)
    }

    fn try_composite_protocol(
        &self,
        id: NodeId,
        frame: &crate::composite::Frame,
        area: CellRect,
        buffer: &mut Buffer,
        ids: &[NodeId],
        plans: &[CompositePlan],
    ) -> bool {
        let Some(config) = self.protocol.config() else {
            return false;
        };
        let capture = Buffer::empty(area);
        let Some(request) = crate::protocol::Request::capture(
            frame.raster.clone(),
            config,
            frame.bounds,
            self.clip_rect(id),
            ResizeMode::Stretch,
            None,
            1.0,
            self.metrics,
            area,
            &capture,
        ) else {
            return false;
        };
        if !self.image_protocol_unobscured_group(id, request.region(), area, ids, Some(id), plans) {
            return false;
        }
        self.paint_image_protocol(id, request, buffer)
    }

    fn paint_media_text(
        &self,
        id: NodeId,
        area: CellRect,
        clip: CellRect,
        opacity: f32,
        buffer: &mut Buffer,
    ) {
        let Some(node) = self.node(id) else { return };
        let lines = node
            .media
            .as_ref()
            .map(|media| media.lines(area.width, area.height))
            .unwrap_or_else(|| {
                vec![if node.kind == ViewKind::WebView {
                    "Loading web content…".to_owned()
                } else {
                    "Loading video…".to_owned()
                }]
            });
        let start = if node.kind == ViewKind::Video {
            area.bottom()
                .saturating_sub(lines.len().min(usize::from(area.height)) as u16)
        } else {
            area.y
        };
        for (row, line) in lines.iter().take(usize::from(area.height)).enumerate() {
            write_text(
                buffer,
                area.x,
                start + row as u16,
                area.width,
                line,
                clip,
                if self.dark {
                    Color(0xe6e9_efff)
                } else {
                    Color::BLACK
                },
                opacity,
                Modifier::empty(),
            );
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn try_image_protocol(
        &self,
        id: NodeId,
        raster: &std::sync::Arc<crate::image::Raster>,
        frame: Bounds<Points>,
        clip: Bounds<Points>,
        mode: ResizeMode,
        tint: Option<Color>,
        opacity: f32,
        area: CellRect,
        buffer: &mut Buffer,
        ids: &[NodeId],
        plans: &[CompositePlan],
    ) -> bool {
        let Some(config) = self.protocol.config() else {
            return false;
        };
        let Some(request) = crate::protocol::Request::capture(
            raster.clone(),
            config,
            frame,
            clip,
            mode,
            tint,
            opacity,
            self.metrics,
            area,
            buffer,
        ) else {
            return false;
        };
        if !self.image_protocol_unobscured(id, request.region(), area, ids, plans) {
            return false;
        }
        self.paint_image_protocol(id, request, buffer)
    }

    /// Protocol escape anchors reserve whole cells. Reject real foreground
    /// ink and native adornments intersecting them; transparent layout-only
    /// containers do not obscure their descendants' images.
    fn image_protocol_unobscured(
        &self,
        id: NodeId,
        region: CellRect,
        area: CellRect,
        ids: &[NodeId],
        plans: &[CompositePlan],
    ) -> bool {
        self.image_protocol_unobscured_group(id, region, area, ids, None, plans)
    }

    fn image_protocol_unobscured_group(
        &self,
        id: NodeId,
        region: CellRect,
        area: CellRect,
        ids: &[NodeId],
        group: Option<NodeId>,
        plans: &[CompositePlan],
    ) -> bool {
        if self.dialog.is_some()
            || self
                .toast
                .as_ref()
                .is_some_and(|(_, until)| *until > self.now)
        {
            return false;
        }
        let position = ids.iter().position(|&other| other == id).unwrap_or(0);
        if plans.iter().any(|plan| {
            Some(plan.id) != group
                && ids
                    .iter()
                    .position(|&other| other == plan.id)
                    .is_some_and(|other| other > position)
                && !cells(plan.bounds, self.metrics, area)
                    .intersection(region)
                    .is_empty()
        }) {
            return false;
        }
        let mut after = false;
        for &other in ids {
            if group.is_some_and(|group| self.is_paint_descendant(other, group)) {
                if other == id {
                    after = true;
                }
                continue;
            }
            let Some(node) = self.node(other) else {
                continue;
            };
            let Some(frame) = self.global_frame(other) else {
                continue;
            };
            let style = self.animated_style(other);
            if style.hidden || self.paint_opacity(other) <= 0.0 {
                continue;
            }
            let clip = cells(self.clip_rect(other), self.metrics, area).intersection(area);
            let rect = cells(frame, self.metrics, area).intersection(clip);
            let hits = |rect: CellRect| !region.intersection(rect.intersection(clip)).is_empty();
            // Borders and scrollbars are painted after their descendants.
            if (style.borders.is_visible() && protocol_border_hits(rect, region))
                || (node.kind == ViewKind::Scroll
                    && node.scroll.shows_indicator
                    && (hits(CellRect::new(
                        rect.right().saturating_sub(1),
                        rect.y,
                        1,
                        rect.height,
                    )) || (node.scroll.horizontal
                        && hits(CellRect::new(
                            rect.x,
                            rect.bottom().saturating_sub(1),
                            rect.width,
                            1,
                        )))))
            {
                return false;
            }
            if style.outline.is_visible() {
                let offset = style.outline.offset + style.outline.width / 2.0;
                let outline = Bounds::new(
                    Point::new(frame.origin.x - offset, frame.origin.y - offset),
                    Size::new(
                        frame.size.width + offset * 2.0,
                        frame.size.height + offset * 2.0,
                    ),
                );
                if protocol_border_hits(
                    cells(outline, self.metrics, area).intersection(clip),
                    region,
                ) {
                    return false;
                }
            }
            if other == id {
                after = true;
                continue;
            }
            // Never layer two independently managed image protocols or mix
            // another raster over their reserved cells.
            if matches!(
                node.kind,
                ViewKind::Image | ViewKind::Canvas | ViewKind::Video
            ) && (node.image.presentation(self.now).main.is_some()
                || node.image.presentation(self.now).placeholder.is_some()
                || node.canvas_raster.is_some()
                || node
                    .media
                    .as_ref()
                    .is_some_and(|media| media.raster().is_some()))
                && hits(rect)
            {
                return false;
            }
            if !after {
                continue;
            }
            if node.kind == ViewKind::Modal {
                return false;
            }
            if let Some((_, _, content)) = &node.text
                && hits(cells(
                    relative_frame(frame, node.frame, *content),
                    self.metrics,
                    area,
                ))
            {
                return false;
            }
            if matches!(
                node.kind,
                ViewKind::Input | ViewKind::Native | ViewKind::WebView | ViewKind::Video
            ) && hits(rect)
            {
                return false;
            }
            if (!style.background_color.is_transparent()
                || style
                    .effects
                    .as_ref()
                    .is_some_and(|e| !e.background_images.is_empty()))
                && hits(rect)
            {
                return false;
            }
            if style.shadow.is_visible() {
                let spread = style.shadow.radius * 2.0;
                let shadow = Bounds::new(
                    Point::new(
                        frame.origin.x + style.shadow.offset_x - spread,
                        frame.origin.y + style.shadow.offset_y - spread,
                    ),
                    Size::new(
                        frame.size.width + spread * 2.0,
                        frame.size.height + spread * 2.0,
                    ),
                );
                if hits(cells(shadow, self.metrics, area)) {
                    return false;
                }
            }
            if let Some(effects) = &style.effects {
                for shadow in effects.box_shadows.iter().filter(|s| s.is_visible()) {
                    let spread = shadow.spread.max(Points::ZERO) + shadow.blur.max(Points::ZERO);
                    let shadow = Bounds::new(
                        Point::new(
                            frame.origin.x + shadow.offset_x - spread,
                            frame.origin.y + shadow.offset_y - spread,
                        ),
                        Size::new(
                            frame.size.width + spread * 2.0,
                            frame.size.height + spread * 2.0,
                        ),
                    );
                    if hits(cells(shadow, self.metrics, area)) {
                        return false;
                    }
                }
            }
        }
        if let Some(focus) = self.focus
            && let (Some(node), Some(frame)) = (self.node(focus), self.global_frame(focus))
            && !node.props.accessibility.state.disabled
            && !focus_uses_text_indicator(node, cells(frame, self.metrics, area))
            && protocol_border_hits(
                cells(frame, self.metrics, area).intersection(cells(
                    self.clip_rect(focus),
                    self.metrics,
                    area,
                )),
                region,
            )
        {
            return false;
        }
        true
    }

    fn is_paint_descendant(&self, id: NodeId, ancestor: NodeId) -> bool {
        let mut parent = Some(id);
        while let Some(id) = parent {
            if id == ancestor {
                return true;
            }
            let Some(node) = self.node(id) else {
                return false;
            };
            if node.kind == ViewKind::Modal {
                return false;
            }
            parent = node.parent;
        }
        false
    }

    fn paint_node_overlay(&self, id: NodeId, area: CellRect, buffer: &mut Buffer) {
        if let (Some(node), Some(frame)) = (self.node(id), self.global_frame(id)) {
            let style = self.animated_style(id);
            let opacity = self.paint_opacity(id);
            let clip = self.clip_rect(id);
            if style.borders.is_visible() || style.outline.is_visible() {
                let saved = capture_border_text(
                    buffer,
                    cells(frame, self.metrics, area),
                    cells(clip, self.metrics, area),
                );
                self.paint_borders(frame, clip, &style, opacity, area, buffer);
                for (position, cell) in saved {
                    buffer[position] = cell;
                }
            }
            if node.kind == ViewKind::Scroll
                && (node.scroll.shows_indicator
                    || node.scroll.physics.refreshing
                    || node.scroll.physics.refresh_progress() > 0.0)
            {
                paint_scrollbars(
                    node,
                    frame,
                    clip,
                    opacity,
                    self.metrics,
                    area,
                    self.now,
                    buffer,
                );
            }
        }
    }

    fn paint_opacity(&self, id: NodeId) -> f32 {
        let mut id = Some(id);
        let mut opacity = 1.0;
        while let Some(current) = id {
            let Some(node) = self.node(current) else {
                break;
            };
            let style = self.animated_style(current);
            if style.hidden {
                return 0.0;
            }
            opacity *= style.opacity.clamp(0.0, 1.0);
            if node.kind == ViewKind::Modal {
                break;
            }
            id = node.parent;
        }
        opacity
    }

    fn paint_decor(
        &self,
        frame: Bounds<Points>,
        clip: Bounds<Points>,
        style: &ViewStyle,
        opacity: f32,
        area: CellRect,
        buffer: &mut Buffer,
    ) {
        let background = background_cells(frame, self.metrics, area)
            .intersection(background_cells(clip, self.metrics, area));
        let rect = cells(frame, self.metrics, area);
        let clip = cells(clip, self.metrics, area).intersection(area);
        if rect.is_empty() || clip.is_empty() {
            return;
        }
        let matrix = style
            .effects
            .as_ref()
            .and_then(|effects| nsh_core::compose_color_matrices(&effects.filters));
        let filtered = |c| filter_color(c, matrix.as_ref());
        if style.shadow.is_visible() {
            paint_shadow(
                frame,
                clip,
                style.shadow.offset_x,
                style.shadow.offset_y,
                style.shadow.radius * 2.0,
                Points::ZERO,
                style.shadow.color,
                opacity * style.shadow.opacity,
                self.metrics,
                area,
                buffer,
            );
        }
        if let Some(effects) = &style.effects {
            for shadow in effects
                .box_shadows
                .iter()
                .rev()
                .filter(|s| !s.inset && s.is_visible())
            {
                paint_shadow(
                    frame,
                    clip,
                    shadow.offset_x,
                    shadow.offset_y,
                    shadow.blur,
                    shadow.spread,
                    filtered(shadow.color),
                    opacity,
                    self.metrics,
                    area,
                    buffer,
                );
            }
        }
        let gradients: Vec<_> = style
            .effects
            .iter()
            .flat_map(|e| e.background_images.iter())
            .filter(|g| g.stops.len() >= 2)
            .map(|g| (g, g.resolved_stops(frame.size)))
            .collect();
        for y in background.y..background.bottom() {
            for x in background.x..background.right() {
                let mut color = filtered(style.background_color);
                for (gradient, stops) in gradients.iter().rev() {
                    let px = (f32::from(x - area.x) + 0.5) * self.metrics.width() - frame.origin.x;
                    let py = (f32::from(y - area.y) + 0.5) * self.metrics.height() - frame.origin.y;
                    color = over_color(
                        filtered(gradient_color(
                            gradient,
                            stops,
                            px.0,
                            py.0,
                            frame.size.width.0,
                            frame.size.height.0,
                        )),
                        color,
                    );
                }
                if !color.is_transparent() {
                    let cell = &mut buffer[(x, y)];
                    let alpha = alpha(color) * opacity;
                    cell.set_bg(blend(color, cell.bg, opacity, style.blend_mode));
                    if alpha >= 0.999 {
                        cell.set_symbol(" ")
                            .set_style(Style::new().remove_modifier(Modifier::all()));
                    } else {
                        cell.set_fg(blend(color, cell.fg, opacity, style.blend_mode));
                    }
                }
            }
        }
        if let Some(effects) = &style.effects {
            for shadow in effects
                .box_shadows
                .iter()
                .rev()
                .filter(|s| s.inset && s.is_visible())
            {
                paint_inset_shadow(frame, clip, shadow, opacity, self.metrics, area, buffer);
            }
        }
    }

    fn paint_borders(
        &self,
        frame: Bounds<Points>,
        clip: Bounds<Points>,
        style: &ViewStyle,
        opacity: f32,
        area: CellRect,
        buffer: &mut Buffer,
    ) {
        let clip = cells(clip, self.metrics, area).intersection(area);
        let matrix = style
            .effects
            .as_ref()
            .and_then(|effects| nsh_core::compose_color_matrices(&effects.filters));
        let filtered = |color| filter_color(color, matrix.as_ref());
        let radii = style.radii();
        let rounded = [
            radii.top_left > Points::ZERO,
            radii.top_right > Points::ZERO,
            radii.bottom_right > Points::ZERO,
            radii.bottom_left > Points::ZERO,
        ];
        let sides = std::array::from_fn(|i| {
            style.borders.width(i) > Points::ZERO && !style.borders.colors[i].is_transparent()
        });
        if style.borders.is_visible() {
            stroke_frame(
                buffer,
                frame,
                self.metrics,
                area,
                clip,
                sides,
                style.borders.colors.map(filtered),
                style.borders.style,
                rounded,
                opacity,
            );
        }
        if style.outline.is_visible() {
            let offset = style.outline.offset + style.outline.width / 2.0;
            let outline = Bounds::new(
                Point::new(frame.origin.x - offset, frame.origin.y - offset),
                Size::new(
                    frame.size.width + offset * 2.0,
                    frame.size.height + offset * 2.0,
                ),
            );
            stroke_frame(
                buffer,
                outline,
                self.metrics,
                area,
                clip,
                [true; 4],
                [filtered(style.outline.color); 4],
                style.outline.style,
                rounded,
                opacity,
            );
        }
    }
}

fn focus_uses_text_indicator(node: &Node, rect: CellRect) -> bool {
    rect.height == 1
        || (rect.height <= 2
            && node.kind == ViewKind::View
            && (node.props.accessibility.role == AccessibilityRole::Button
                || [
                    EventKind::Press,
                    EventKind::LongPress,
                    EventKind::PressDown,
                    EventKind::PressUp,
                ]
                .into_iter()
                .any(|event| node.events.contains(event))))
}

fn focus_text_cell(cell: &ratatui::buffer::Cell) -> bool {
    // Image protocols reserve their cells and may encode an image ID in
    // the foreground color. Focus only decorates ordinary text glyphs.
    cell.diff_option == CellDiffOption::None
        && !border_symbol(cell.symbol())
        && cell.symbol().chars().any(|c| !c.is_whitespace())
        && !cell.symbol().chars().any(|c| {
            c.is_control()
                || matches!(c,'\u{2580}'..='\u{259f}'|'\u{2800}'..='\u{28ff}'|'\u{10eeee}')
        })
}

fn border_symbol(symbol: &str) -> bool {
    matches!(
        symbol,
        " " | "─"
            | "│"
            | "┌"
            | "┐"
            | "┘"
            | "└"
            | "╭"
            | "╮"
            | "╯"
            | "╰"
            | "╌"
            | "╎"
            | "┈"
            | "┊"
    )
}

fn translation_only(matrix: &nsh_core::Matrix) -> bool {
    let m = matrix.0;
    let w = m[15];
    w.abs() > 1e-9
        && (m[0] / w - 1.0).abs() < 1e-6
        && (m[5] / w - 1.0).abs() < 1e-6
        && [m[1], m[4], m[3], m[7]].iter().all(|v| v.abs() < 1e-6)
}

fn capture_border_text(
    buffer: &Buffer,
    rect: CellRect,
    clip: CellRect,
) -> Vec<((u16, u16), ratatui::buffer::Cell)> {
    let painted = rect.intersection(clip).intersection(buffer.area);
    let mut saved = Vec::new();
    for y in painted.y..painted.bottom() {
        let mut start = painted.right();
        let mut end = painted.x;
        for x in painted.x..painted.right() {
            let cell = &buffer[(x, y)];
            if !border_symbol(cell.symbol()) || cell.modifier.contains(Modifier::REVERSED) {
                start = start.min(x);
                end =
                    end.max(x.saturating_add(UnicodeWidthStr::width(cell.symbol()).max(1) as u16));
            }
        }
        for x in painted.x..painted.right() {
            if (x == rect.x || x == rect.right() - 1 || y == rect.y || y == rect.bottom() - 1)
                && (start..end).contains(&x)
            {
                saved.push(((x, y), buffer[(x, y)].clone()));
            }
        }
    }
    saved
}

fn image_geometry(
    source: &nsh_core::ImageSource,
    raster: &crate::image::Raster,
    mode: ResizeMode,
    position: ObjectPosition,
    size: Size<Points>,
    frame: Bounds<Points>,
    clip: Bounds<Points>,
) -> (Bounds<Points>, Bounds<Points>, ResizeMode) {
    let content = if matches!(mode, ResizeMode::Center | ResizeMode::ScaleDown)
        && let Some(Size { width, height }) = source.size
        && width.is_finite()
        && height.is_finite()
        && width > Points::ZERO
        && height > Points::ZERO
    {
        let width = width
            * if size.width > Points::ZERO {
                frame.size.width / size.width
            } else {
                1.0
            };
        let height = height
            * if size.height > Points::ZERO {
                frame.size.height / size.height
            } else {
                1.0
            };
        mode.fit(Size::new(width, height), frame.size, ObjectPosition::CENTER)
            .size
    } else {
        crate::image::fitted_frame(raster, frame, mode).size
    };
    let scale = |drawn: Points, local: Points| {
        if local > Points::ZERO && drawn > Points::ZERO {
            drawn / local
        } else {
            1.0
        }
    };
    let sx = scale(frame.size.width, size.width);
    let sy = scale(frame.size.height, size.height);
    // Length offsets are local points, so zoom/presentation scaling applies
    // to them just as it does to the image. Percentages use the free space.
    let origin = if mode == ResizeMode::Stretch {
        Point::default()
    } else {
        Point::new(
            position.x.resolve((frame.size.width - content.width) / sx) * sx,
            position
                .y
                .resolve((frame.size.height - content.height) / sy)
                * sy,
        )
    };
    (
        Bounds::new(
            Point::new(frame.origin.x + origin.x, frame.origin.y + origin.y),
            content,
        ),
        crate::surface::intersect(frame, clip),
        ResizeMode::Stretch,
    )
}

fn finite_rect(rect: Bounds<Points>) -> bool {
    [
        rect.origin.x,
        rect.origin.y,
        rect.size.width,
        rect.size.height,
    ]
    .iter()
    .all(|v| v.is_finite())
        && rect.size.width > Points::ZERO
        && rect.size.height > Points::ZERO
}

fn protocol_border_hits(rect: CellRect, region: CellRect) -> bool {
    if rect.is_empty() {
        return false;
    }
    [
        CellRect::new(rect.x, rect.y, rect.width, 1),
        CellRect::new(rect.x, rect.bottom() - 1, rect.width, 1),
        CellRect::new(rect.x, rect.y, 1, rect.height),
        CellRect::new(rect.right() - 1, rect.y, 1, rect.height),
    ]
    .into_iter()
    .any(|border| !border.intersection(region).is_empty())
}

fn cells(rect: Bounds<Points>, metrics: CellMetrics, area: CellRect) -> CellRect {
    if !finite_rect(rect) {
        return CellRect::default();
    }
    // Clamp each edge separately: saturating a negative origin before
    // finding the far edge incorrectly moves clipped views to the right.
    let x = (rect.origin.x / metrics.width())
        .floor()
        .max(0.0)
        .min(f32::from(area.width));
    let y = (rect.origin.y / metrics.height())
        .floor()
        .max(0.0)
        .min(f32::from(area.height));
    let right = ((rect.origin.x + rect.size.width) / metrics.width())
        .ceil()
        .max(0.0)
        .min(f32::from(area.width));
    let bottom = ((rect.origin.y + rect.size.height) / metrics.height())
        .ceil()
        .max(0.0)
        .min(f32::from(area.height));
    CellRect::new(
        area.x + x as u16,
        area.y + y as u16,
        (right - x).max(0.0) as u16,
        (bottom - y).max(0.0) as u16,
    )
}

// Whole-cell backgrounds use the same center ownership as text and input.
// Images and borders keep their conservative partial-cell coverage in `cells`.
fn background_cells(rect: Bounds<Points>, metrics: CellMetrics, area: CellRect) -> CellRect {
    if !finite_rect(rect) {
        return CellRect::default();
    }
    let x = metrics
        .column_at(rect.origin.x)
        .clamp(0.0, f32::from(area.width));
    let y = metrics
        .row_at(rect.origin.y)
        .clamp(0.0, f32::from(area.height));
    let right = metrics
        .column_at(rect.origin.x + rect.size.width)
        .clamp(0.0, f32::from(area.width));
    let bottom = metrics
        .row_at(rect.origin.y + rect.size.height)
        .clamp(0.0, f32::from(area.height));
    CellRect::new(
        area.x + x as u16,
        area.y + y as u16,
        (right - x).max(0.0) as u16,
        (bottom - y).max(0.0) as u16,
    )
}

fn relative_frame(
    global: Bounds<Points>,
    local: Bounds<Points>,
    content: Bounds<Points>,
) -> Bounds<Points> {
    let sx = if local.size.width > Points::ZERO {
        global.size.width / local.size.width
    } else {
        1.0
    };
    let sy = if local.size.height > Points::ZERO {
        global.size.height / local.size.height
    } else {
        1.0
    };
    Bounds::new(
        Point::new(
            global.origin.x + content.origin.x * sx,
            global.origin.y + content.origin.y * sy,
        ),
        Size::new(content.size.width * sx, content.size.height * sy),
    )
}

fn fill(
    buffer: &mut Buffer,
    rect: CellRect,
    clip: CellRect,
    color: Color,
    opacity: f32,
    mode: BlendMode,
    clear: bool,
) {
    let rect = rect.intersection(clip).intersection(buffer.area);
    for y in rect.y..rect.bottom() {
        for x in rect.x..rect.right() {
            let cell = &mut buffer[(x, y)];
            cell.set_bg(blend(color, cell.bg, opacity, mode));
            if clear && alpha(color) * opacity >= 0.999 {
                cell.set_symbol(" ");
            } else {
                cell.set_fg(blend(color, cell.fg, opacity, mode));
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn stroke(
    buffer: &mut Buffer,
    rect: CellRect,
    clip: CellRect,
    sides: [bool; 4],
    colors: [Color; 4],
    style: BorderStyle,
    rounded: [bool; 4],
    opacity: f32,
) {
    if rect.is_empty() {
        return;
    }
    let clip = clip.intersection(buffer.area);
    let [top, right, bottom, left] = sides;
    let mut put = |x: u16, y: u16, symbol: &str, color: Color| {
        if clip.contains((x, y).into()) {
            let cell = &mut buffer[(x, y)];
            let fg = blend(color, cell.bg, opacity, BlendMode::Normal);
            cell.set_symbol(symbol).set_fg(fg);
        }
    };
    let horizontal = match style {
        BorderStyle::Solid => "─",
        BorderStyle::Dashed => "╌",
        BorderStyle::Dotted => "┈",
    };
    let vertical = match style {
        BorderStyle::Solid => "│",
        BorderStyle::Dashed => "╎",
        BorderStyle::Dotted => "┊",
    };
    for x in rect.x..rect.right() {
        if top {
            put(x, rect.y, horizontal, colors[0])
        }
        if bottom && rect.height > 1 {
            put(x, rect.bottom() - 1, horizontal, colors[2])
        }
    }
    for y in rect.y..rect.bottom() {
        if left {
            put(rect.x, y, vertical, colors[3])
        }
        if right && rect.width > 1 {
            put(rect.right() - 1, y, vertical, colors[1])
        }
    }
    if rect.width > 1 && rect.height > 1 {
        if top && left {
            put(
                rect.x,
                rect.y,
                if rounded[0] { "╭" } else { "┌" },
                colors[0],
            )
        }
        if top && right {
            put(
                rect.right() - 1,
                rect.y,
                if rounded[1] { "╮" } else { "┐" },
                colors[0],
            )
        }
        if bottom && right {
            put(
                rect.right() - 1,
                rect.bottom() - 1,
                if rounded[2] { "╯" } else { "┘" },
                colors[2],
            )
        }
        if bottom && left {
            put(
                rect.x,
                rect.bottom() - 1,
                if rounded[3] { "╰" } else { "└" },
                colors[2],
            )
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn stroke_frame(
    buffer: &mut Buffer,
    frame: Bounds<Points>,
    metrics: CellMetrics,
    area: CellRect,
    clip: CellRect,
    mut sides: [bool; 4],
    colors: [Color; 4],
    style: BorderStyle,
    rounded: [bool; 4],
    opacity: f32,
) {
    // Clipping a box must not move its border to the clipping edge.
    sides[0] &= frame.origin.y >= Points::ZERO;
    sides[1] &= frame.origin.x + frame.size.width <= f32::from(area.width) * metrics.width();
    sides[2] &= frame.origin.y + frame.size.height <= f32::from(area.height) * metrics.height();
    sides[3] &= frame.origin.x >= Points::ZERO;
    stroke(
        buffer,
        cells(frame, metrics, area),
        clip,
        sides,
        colors,
        style,
        rounded,
        opacity,
    );
}

#[allow(clippy::too_many_arguments)]
fn paint_input(
    node: &Node,
    focused: bool,
    frame: Bounds<Points>,
    clip: Bounds<Points>,
    opacity: f32,
    foreground: Option<Color>,
    metrics: CellMetrics,
    area: CellRect,
    buffer: &mut Buffer,
) {
    let geometry = input_geometry(node, frame, metrics, area);
    let rect = geometry.visible;
    let clip = cells(clip, metrics, area)
        .intersection(rect)
        .intersection(area);
    if clip.is_empty() {
        return;
    }
    let actual_columns = geometry.columns;
    let actual_rows = geometry.rows;
    let origin_x = geometry.column;
    let origin_y = geometry.row;
    let columns = if node.input.multiline {
        actual_columns
    } else {
        usize::MAX
    };
    let (scroll_row, scroll_col) = input_scroll(node, focused, actual_columns, actual_rows);
    let selection = node.editor.selected_range();
    let placeholder = node.editor.text().is_empty();
    let text = if placeholder {
        node.input.placeholder.as_str()
    } else {
        node.editor.text()
    };
    let color = if placeholder {
        node.input.placeholder_color.unwrap_or(Color(0x8080_80ff))
    } else {
        foreground.unwrap_or(node.input.style.color)
    };
    let modifiers = text_modifiers(node.input.style);
    let selected_color = node.input.selection_color.unwrap_or(Color(0x388b_fdcc));
    let mut tokens = node.editor.token_spans().iter().peekable();
    let (mut row, mut column) = (0usize, 0usize);
    let alignments = input_line_offsets(node, focused, actual_columns);
    for (offset, grapheme) in text.grapheme_indices(true) {
        while tokens.peek().is_some_and(|span| span.range.end <= offset) {
            tokens.next();
        }
        let token_style = if !placeholder && !node.input.secure {
            tokens
                .peek()
                .filter(|span| span.range.contains(&offset))
                .map(|span| span.style)
        } else {
            None
        };
        if matches!(grapheme, "\n" | "\r" | "\r\n") {
            row += 1;
            column = 0;
            continue;
        }
        let secure = !placeholder && node.input.secure;
        let width = if secure {
            1
        } else if grapheme == "\t" {
            4 - column % 4
        } else {
            UnicodeWidthStr::width(grapheme)
        };
        if column > 0 && column.saturating_add(width) > columns {
            row += 1;
            column = 0
        }
        if let (Some(y), Some(x)) = (row.checked_sub(scroll_row), column.checked_sub(scroll_col)) {
            let x = origin_x
                .saturating_add(x as i64)
                .saturating_add(alignments.get(row).copied().unwrap_or(0) as i64);
            let y = origin_y.saturating_add(y as i64);
            if (0..=i64::from(u16::MAX)).contains(&x) && (0..=i64::from(u16::MAX)).contains(&y) {
                let selected =
                    focused && !placeholder && selection.start <= offset && offset < selection.end;
                let symbol = if secure {
                    "•"
                } else if grapheme == "\t" {
                    " "
                } else {
                    grapheme
                };
                paint_grapheme(
                    buffer,
                    x as u16,
                    y as u16,
                    width,
                    symbol,
                    clip,
                    token_style.and_then(|style| style.color).unwrap_or(color),
                    selected
                        .then_some(selected_color)
                        .or(token_style.and_then(|style| style.background_color)),
                    opacity,
                    modifiers,
                );
            }
        }
        column = column.saturating_add(width);
    }
    if focused && !node.input.caret_hidden && node.input.editable {
        let (row, column) = node.editor.cursor_cell(columns, node.input.secure);
        let Some(visible_row) = row.checked_sub(scroll_row).filter(|row| *row < actual_rows) else {
            return;
        };
        let Some(visible_column) = column.checked_sub(scroll_col) else {
            return;
        };
        let y = origin_y.saturating_add(visible_row as i64);
        let x = origin_x
            .saturating_add(visible_column as i64)
            .saturating_add(alignments.get(row).copied().unwrap_or(0) as i64)
            .min(origin_x.saturating_add(actual_columns.saturating_sub(1) as i64));
        if (0..=i64::from(u16::MAX)).contains(&x)
            && (0..=i64::from(u16::MAX)).contains(&y)
            && clip.contains((x as u16, y as u16).into())
        {
            buffer[(x as u16, y as u16)].set_style(Style::new().add_modifier(Modifier::REVERSED));
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct InputGeometry {
    pub(crate) column: i64,
    pub(crate) row: i64,
    pub(crate) columns: usize,
    pub(crate) rows: usize,
    pub(crate) visible: CellRect,
}

pub(crate) fn input_geometry(
    node: &Node,
    frame: Bounds<Points>,
    metrics: CellMetrics,
    area: CellRect,
) -> InputGeometry {
    let inner = if node.input_content.size.width > Points::ZERO
        && node.input_content.size.height > Points::ZERO
    {
        relative_frame(frame, node.frame, node.input_content)
    } else {
        frame
    };
    InputGeometry {
        column: i64::from(area.x) + (inner.origin.x / metrics.width()).floor() as i64,
        row: i64::from(area.y) + (inner.origin.y / metrics.height()).floor() as i64,
        columns: (inner.size.width / metrics.width()).floor().max(1.0) as usize,
        rows: (inner.size.height / metrics.height()).ceil().max(1.0) as usize,
        visible: cells(inner, metrics, area),
    }
}

pub(crate) fn input_line_offsets(node: &Node, focused: bool, columns: usize) -> Vec<usize> {
    let columns = columns.max(1);
    let text = if node.editor.text().is_empty() {
        node.input.placeholder.as_str()
    } else {
        node.editor.text()
    };
    let secure = !node.editor.text().is_empty() && node.input.secure;
    let wrap = if node.input.multiline {
        columns
    } else {
        usize::MAX
    };
    let mut widths = Vec::new();
    let mut column = 0usize;
    for grapheme in text.graphemes(true) {
        if matches!(grapheme, "\n" | "\r" | "\r\n") {
            widths.push(column);
            column = 0;
            continue;
        }
        let width = if secure {
            1
        } else if grapheme == "\t" {
            4 - column % 4
        } else {
            UnicodeWidthStr::width(grapheme)
        };
        if column > 0 && column.saturating_add(width) > wrap {
            widths.push(column);
            column = 0;
        }
        column = column.saturating_add(width);
    }
    widths.push(column);
    if node.input.multiline && column >= columns {
        widths.extend(std::iter::repeat_n(0, column / columns));
    }
    let cursor = node.editor.cursor_cell(wrap, node.input.secure);
    widths
        .into_iter()
        .enumerate()
        .map(|(row, width)| {
            let free = columns.saturating_sub(width);
            let alignment = match node.input.align {
                TextAlign::Center => free / 2,
                TextAlign::Right => free,
                TextAlign::Auto if node.input.rtl => free,
                _ => 0,
            };
            // Right alignment can put the insertion boundary just outside
            // the field. Keep one cell for its native caret on that row.
            if focused && row == cursor.0 {
                alignment.min(columns.saturating_sub(cursor.1.saturating_add(1)))
            } else {
                alignment
            }
        })
        .collect()
}

pub(crate) fn input_scroll(
    node: &Node,
    focused: bool,
    columns: usize,
    rows: usize,
) -> (usize, usize) {
    let (columns, rows) = (columns.max(1), rows.max(1));
    let mut viewport = node.input_viewport.get();
    if focused && viewport.size != (columns, rows) && viewport.size.0 > 0 && viewport.size.1 > 0 {
        let wrap = if node.input.multiline {
            viewport.size.0
        } else {
            usize::MAX
        };
        let caret = node.editor.cursor_cell(wrap, node.input.secure);
        viewport.reveal |= caret.0 >= viewport.origin.0
            && caret.0 < viewport.origin.0.saturating_add(viewport.size.1)
            && caret.1 >= viewport.origin.1;
    }
    let wrap = if node.input.multiline {
        columns
    } else {
        usize::MAX
    };
    let extent = node.editor.cell_extent(wrap, node.input.secure);
    viewport.size = (columns, rows);
    viewport.origin.0 = if node.input.multiline {
        viewport.origin.0.min(extent.0.saturating_sub(rows - 1))
    } else {
        0
    };
    viewport.origin.1 = if node.input.multiline {
        0
    } else {
        viewport.origin.1.min(extent.1.saturating_sub(columns - 1))
    };
    if viewport.reveal && focused {
        let caret = node.editor.cursor_cell(wrap, node.input.secure);
        if node.input.multiline {
            viewport.origin.0 = viewport
                .origin
                .0
                .min(caret.0)
                .max(caret.0.saturating_sub(rows - 1));
        } else {
            viewport.origin.1 = viewport
                .origin
                .1
                .min(caret.1)
                .max(caret.1.saturating_sub(columns - 1));
        }
        viewport.reveal = false;
    }
    node.input_viewport.set(viewport);
    viewport.origin
}

fn text_modifiers(style: nsh_core::ResolvedTextStyle) -> Modifier {
    let mut modifiers = Modifier::empty();
    if style.font_weight >= 600 {
        modifiers |= Modifier::BOLD
    }
    if style.italic {
        modifiers |= Modifier::ITALIC
    }
    if style.decoration.underline {
        modifiers |= Modifier::UNDERLINED
    }
    if style.decoration.line_through {
        modifiers |= Modifier::CROSSED_OUT
    }
    modifiers
}

#[allow(clippy::too_many_arguments)]
fn paint_grapheme(
    buffer: &mut Buffer,
    x: u16,
    y: u16,
    width: usize,
    symbol: &str,
    clip: CellRect,
    color: Color,
    selected: Option<Color>,
    opacity: f32,
    modifier: Modifier,
) {
    if width == 0
        || symbol.chars().any(|c| c.is_control())
        || !clip.contains((x, y).into())
        || usize::from(x).saturating_add(width) > usize::from(clip.right())
    {
        return;
    }
    for i in 0..width {
        let cell = &mut buffer[(x + i as u16, y)];
        if let Some(selected) = selected {
            cell.set_bg(blend(selected, cell.bg, opacity, BlendMode::Normal));
        }
        let fg = blend(color, cell.bg, opacity, BlendMode::Normal);
        cell.set_style(Style::new().fg(fg).add_modifier(modifier))
            .set_symbol(if i == 0 { symbol } else { " " });
    }
}

#[allow(clippy::too_many_arguments)]
fn paint_scrollbars(
    node: &Node,
    frame: Bounds<Points>,
    clip: Bounds<Points>,
    opacity: f32,
    metrics: CellMetrics,
    area: CellRect,
    now: f64,
    buffer: &mut Buffer,
) {
    let rect = cells(frame, metrics, area);
    let clip = cells(clip, metrics, area)
        .intersection(rect)
        .intersection(area);
    if rect.is_empty() || clip.is_empty() {
        return;
    }
    let progress = node.scroll.physics.refresh_progress();
    if node.scroll.behavior.refresh_indicator.is_none()
        && !node.scroll.horizontal
        && (node.scroll.physics.refreshing || progress > 0.0)
    {
        let label = if node.scroll.physics.refreshing {
            format!(
                "{} Refreshing",
                ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
                    [((now.max(0.0) * 10.0) as usize) % 10]
            )
        } else if progress >= 1.0 {
            "↑ Release to refresh".to_owned()
        } else {
            "↓ Pull to refresh".to_owned()
        };
        let width = UnicodeWidthStr::width(label.as_str()).min(usize::from(rect.width)) as u16;
        let rows = ((-node.scroll.y).max(metrics.height()) / metrics.height())
            .ceil()
            .min(f32::from(rect.height)) as u16;
        write_text(
            buffer,
            rect.x + (rect.width - width) / 2,
            rect.y + rows.saturating_sub(1) / 2,
            width,
            &label,
            clip,
            FOCUS,
            opacity,
            Modifier::empty(),
        );
    }
    if !node.scroll.shows_indicator {
        return;
    }
    let content_height = node.scroll.content.height * node.scroll.physics.zoom;
    let content_width = node.scroll.content.width * node.scroll.physics.zoom;
    let color = Color(0x8080_80b0);
    if content_height > frame.size.height + px(0.5) {
        let length = usize::from(rect.height);
        let thumb = ((frame.size.height / content_height) * length as f32)
            .ceil()
            .max(1.0) as usize;
        let offset = (node.scroll.y / (content_height - frame.size.height)).clamp(0.0, 1.0);
        let start = (offset * length.saturating_sub(thumb) as f32).round() as usize;
        let x = rect.right() - 1;
        for i in start..start.saturating_add(thumb).min(length) {
            let y = rect.y + i as u16;
            if clip.contains((x, y).into()) {
                let cell = &mut buffer[(x, y)];
                let fg = blend(color, cell.bg, opacity, BlendMode::Normal);
                cell.set_symbol("▐").set_fg(fg);
            }
        }
    }
    if content_width > frame.size.width + px(0.5) {
        let length = usize::from(rect.width);
        let thumb = ((frame.size.width / content_width) * length as f32)
            .ceil()
            .max(1.0) as usize;
        let offset = (node.scroll.x / (content_width - frame.size.width)).clamp(0.0, 1.0);
        let offset = if node.scroll.mirrored {
            1.0 - offset
        } else {
            offset
        };
        let start = (offset * length.saturating_sub(thumb) as f32).round() as usize;
        let y = rect.bottom() - 1;
        for i in start..start.saturating_add(thumb).min(length) {
            let x = rect.x + i as u16;
            if clip.contains((x, y).into()) {
                let cell = &mut buffer[(x, y)];
                let fg = blend(color, cell.bg, opacity, BlendMode::Normal);
                cell.set_symbol("▁").set_fg(fg);
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn write_text(
    buffer: &mut Buffer,
    mut x: u16,
    y: u16,
    width: u16,
    text: &str,
    clip: CellRect,
    color: Color,
    opacity: f32,
    modifier: Modifier,
) {
    let end = x.saturating_add(width).min(clip.right());
    for grapheme in text.graphemes(true) {
        let width = UnicodeWidthStr::width(grapheme);
        if grapheme.chars().any(|c| c.is_control()) {
            continue;
        }
        if usize::from(x).saturating_add(width) > usize::from(end) {
            break;
        }
        paint_grapheme(
            buffer, x, y, width, grapheme, clip, color, None, opacity, modifier,
        );
        x = x.saturating_add(width as u16);
    }
}

fn wrapped_lines(text: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    let mut lines = vec![String::new()];
    let mut column = 0;
    for grapheme in text.graphemes(true) {
        if grapheme == "\n" {
            lines.push(String::new());
            column = 0;
            continue;
        }
        if grapheme.chars().any(|c| c.is_control()) {
            continue;
        }
        let w = UnicodeWidthStr::width(grapheme);
        if column + w > width && column > 0 {
            lines.push(String::new());
            column = 0
        }
        lines.last_mut().expect("one line").push_str(grapheme);
        column += w;
    }
    lines
}

fn paint_toast(text: &str, dark: bool, area: CellRect, buffer: &mut Buffer) {
    if area.width < 4 || area.height < 2 {
        return;
    }
    let width = (UnicodeWidthStr::width(text)
        .saturating_add(4)
        .min(usize::from(area.width.saturating_sub(2)))) as u16;
    let lines = wrapped_lines(text, usize::from(width.saturating_sub(4)));
    let height = (lines.len() as u16).saturating_add(2).min(area.height);
    let rect = CellRect::new(
        area.x + (area.width - width) / 2,
        area.bottom().saturating_sub(height + 1).max(area.y),
        width,
        height,
    );
    let background = if dark {
        Color(0xe6e9_efff)
    } else {
        Color(0x2428_32ff)
    };
    let foreground = if dark {
        Color(0x181b_22ff)
    } else {
        Color(0xffff_ffff)
    };
    fill(buffer, rect, area, background, 1.0, BlendMode::Normal, true);
    for (i, line) in lines
        .iter()
        .take(usize::from(height.saturating_sub(2)))
        .enumerate()
    {
        write_text(
            buffer,
            rect.x + 2,
            rect.y + 1 + i as u16,
            rect.width.saturating_sub(4),
            line,
            area,
            foreground,
            1.0,
            Modifier::empty(),
        );
    }
}

fn paint_dialog(dialog: &Dialog, selected: usize, dark: bool, area: CellRect, buffer: &mut Buffer) {
    if area.width < 3 || area.height < 3 {
        return;
    }
    fill(
        buffer,
        area,
        area,
        Color(0x0000_0080),
        1.0,
        BlendMode::Normal,
        false,
    );
    let (mut rect, actions) = dialog_geometry(area.width, area.height, dialog, selected);
    rect.x += area.x;
    rect.y += area.y;
    let width = rect.width;
    let text_width = width.saturating_sub(4).max(1);
    let title = dialog
        .title
        .as_deref()
        .map(|s| wrapped_lines(s, usize::from(text_width)))
        .unwrap_or_default();
    let message = dialog
        .message
        .as_deref()
        .map(|s| wrapped_lines(s, usize::from(text_width)))
        .unwrap_or_default();
    let background = if dark {
        Color(0x2428_32ff)
    } else {
        Color(0xffff_ffff)
    };
    let foreground = if dark {
        Color(0xe6e9_efff)
    } else {
        Color::BLACK
    };
    fill(buffer, rect, area, background, 1.0, BlendMode::Normal, true);
    stroke(
        buffer,
        rect,
        area,
        [true; 4],
        [Color(0x8080_80ff); 4],
        BorderStyle::Solid,
        [true; 4],
        1.0,
    );
    let actions_start = actions
        .first()
        .map_or(rect.bottom().saturating_sub(1), |(_, r)| r.y + area.y);
    let mut y = rect.y + 1;
    for line in &title {
        if y >= actions_start {
            break;
        }
        write_text(
            buffer,
            rect.x + 2,
            y,
            text_width,
            line,
            rect,
            foreground,
            1.0,
            Modifier::BOLD,
        );
        y += 1;
    }
    if !title.is_empty() && !message.is_empty() {
        y += 1
    }
    for line in &message {
        if y >= actions_start {
            break;
        }
        write_text(
            buffer,
            rect.x + 2,
            y,
            text_width,
            line,
            rect,
            foreground,
            1.0,
            Modifier::empty(),
        );
        y += 1;
    }
    if dialog.buttons.is_empty() {
        write_text(
            buffer,
            rect.x + 2,
            actions_start,
            text_width,
            "› OK",
            rect,
            FOCUS,
            1.0,
            Modifier::BOLD,
        );
    } else {
        for (i, action) in actions {
            let button = &dialog.buttons[i];
            let y = action.y + area.y;
            let color = if button.style == DialogButtonStyle::Destructive {
                Color(0xe548_4dff)
            } else {
                FOCUS
            };
            let label = format!("{} {}", if i == selected { "›" } else { " " }, button.text);
            if i == selected {
                fill(
                    buffer,
                    CellRect::new(rect.x + 1, y, width.saturating_sub(2), 1),
                    rect,
                    Color(0x388b_fd30),
                    1.0,
                    BlendMode::Normal,
                    false,
                )
            }
            write_text(
                buffer,
                rect.x + 2,
                y,
                text_width,
                &label,
                rect,
                color,
                1.0,
                if i == selected {
                    Modifier::BOLD
                } else {
                    Modifier::empty()
                },
            );
        }
    }
}

/// Geometry shared by native dialog drawing and mouse hit testing.
pub(crate) fn dialog_geometry(
    columns: u16,
    rows: u16,
    dialog: &Dialog,
    selected: usize,
) -> (CellRect, Vec<(usize, CellRect)>) {
    if columns < 3 || rows < 3 {
        return (CellRect::default(), Vec::new());
    }
    let width = columns.saturating_sub(4).clamp(3, 64).min(columns);
    let text_width = usize::from(width.saturating_sub(4).max(1));
    let title = dialog
        .title
        .as_deref()
        .map(|s| wrapped_lines(s, text_width).len())
        .unwrap_or(0);
    let message = dialog
        .message
        .as_deref()
        .map(|s| wrapped_lines(s, text_width).len())
        .unwrap_or(0);
    let desired = 3usize
        .saturating_add(title)
        .saturating_add(message)
        .saturating_add(usize::from(title > 0 && message > 0))
        .saturating_add(dialog.buttons.len().max(1));
    let height = desired.min(usize::from(rows)) as u16;
    let rect = CellRect::new(
        (columns - width) / 2,
        if dialog.sheet {
            rows - height
        } else {
            (rows - height) / 2
        },
        width,
        height,
    );
    let count = dialog
        .buttons
        .len()
        .max(1)
        .min(usize::from(height.saturating_sub(2)));
    let start = selected.saturating_sub(count.saturating_sub(1));
    let y = rect.bottom().saturating_sub(1 + count as u16);
    let actions = (start..dialog.buttons.len().max(1))
        .take(count)
        .enumerate()
        .map(|(row, i)| {
            (
                i,
                CellRect::new(rect.x + 1, y + row as u16, rect.width.saturating_sub(2), 1),
            )
        })
        .collect();
    (rect, actions)
}

#[allow(clippy::too_many_arguments)]
fn paint_shadow(
    frame: Bounds<Points>,
    clip: CellRect,
    dx: Points,
    dy: Points,
    blur: Points,
    spread: Points,
    color: Color,
    opacity: f32,
    metrics: CellMetrics,
    area: CellRect,
    buffer: &mut Buffer,
) {
    let radius = (blur * 0.5).max(Points::ZERO);
    let shadow = Bounds::new(
        Point::new(frame.origin.x + dx - spread, frame.origin.y + dy - spread),
        Size::new(
            frame.size.width + spread * 2.0,
            frame.size.height + spread * 2.0,
        ),
    );
    let outer = Bounds::new(
        Point::new(shadow.origin.x - radius, shadow.origin.y - radius),
        Size::new(
            shadow.size.width + radius * 2.0,
            shadow.size.height + radius * 2.0,
        ),
    );
    let rect = cells(outer, metrics, area).intersection(clip);
    for y in rect.y..rect.bottom() {
        for x in rect.x..rect.right() {
            let px = (f32::from(x - area.x) + 0.5) * metrics.width();
            let py = (f32::from(y - area.y) + 0.5) * metrics.height();
            if px >= frame.origin.x
                && px < frame.origin.x + frame.size.width
                && py >= frame.origin.y
                && py < frame.origin.y + frame.size.height
            {
                continue;
            }
            let distance = (shadow.origin.x - px)
                .max(px - shadow.origin.x - shadow.size.width)
                .max(Points::ZERO)
                .0
                .hypot(
                    (shadow.origin.y - py)
                        .max(py - shadow.origin.y - shadow.size.height)
                        .max(Points::ZERO)
                        .0,
                );
            let factor = if radius > Points::ZERO {
                (1.0 - distance / radius.0).clamp(0.0, 1.0)
            } else {
                f32::from(distance == 0.0)
            };
            let cell = &mut buffer[(x, y)];
            cell.set_bg(blend(color, cell.bg, opacity * factor, BlendMode::Normal));
        }
    }
}

fn paint_inset_shadow(
    frame: Bounds<Points>,
    clip: CellRect,
    shadow: &nsh_core::BoxShadow,
    opacity: f32,
    metrics: CellMetrics,
    area: CellRect,
    buffer: &mut Buffer,
) {
    let rect = cells(frame, metrics, area).intersection(clip);
    let radius = (shadow.blur * 0.5).max(metrics.width().min(metrics.height()));
    for y in rect.y..rect.bottom() {
        for x in rect.x..rect.right() {
            let px = (f32::from(x - area.x) + 0.5) * metrics.width() - frame.origin.x;
            let py = (f32::from(y - area.y) + 0.5) * metrics.height() - frame.origin.y;
            let distance = (px - shadow.offset_x - shadow.spread)
                .min(frame.size.width - px + shadow.offset_x - shadow.spread)
                .min(py - shadow.offset_y - shadow.spread)
                .min(frame.size.height - py + shadow.offset_y - shadow.spread);
            let factor = (1.0 - distance / radius).clamp(0.0, 1.0);
            let cell = &mut buffer[(x, y)];
            cell.set_bg(blend(
                shadow.color,
                cell.bg,
                opacity * factor,
                BlendMode::Normal,
            ));
        }
    }
}

pub(crate) fn gradient_color(
    gradient: &Gradient,
    stops: &[(Color, Percentage)],
    x: f32,
    y: f32,
    width: f32,
    height: f32,
) -> Color {
    if stops.is_empty() {
        return Color::TRANSPARENT;
    }
    let mut t = if let Some(angle) = gradient.kind.linear_angle(Size::new(px(width), px(height))) {
        let angle = angle.0;
        let (dx, dy) = (angle.sin(), -angle.cos());
        let length = (width * dx).abs() + (height * dy).abs();
        0.5 + ((x - width * 0.5) * dx + (y - height * 0.5) * dy) / length.max(f32::EPSILON)
    } else {
        match gradient.kind {
            GradientKind::Conic { from, x: cx, y: cy } => {
                ((x - cx.0 * width).atan2(-(y - cy.0 * height)) - from.0)
                    .rem_euclid(std::f32::consts::TAU)
                    / std::f32::consts::TAU
            }
            GradientKind::Radial {
                circle,
                size,
                x: cx,
                y: cy,
            } => {
                let (cx, cy) = (cx.0 * width, cy.0 * height);
                let near = matches!(
                    size,
                    GradientSize::ClosestSide | GradientSize::ClosestCorner
                );
                let rx = if near {
                    cx.min(width - cx)
                } else {
                    cx.max(width - cx)
                }
                .abs();
                let ry = if near {
                    cy.min(height - cy)
                } else {
                    cy.max(height - cy)
                }
                .abs();
                if circle {
                    let radius = match size {
                        GradientSize::ClosestSide => rx.min(ry),
                        GradientSize::FarthestSide => rx.max(ry),
                        _ => rx.hypot(ry),
                    };
                    (x - cx).hypot(y - cy) / radius.max(f32::EPSILON)
                } else {
                    let factor = if matches!(
                        size,
                        GradientSize::ClosestCorner | GradientSize::FarthestCorner
                    ) {
                        std::f32::consts::SQRT_2
                    } else {
                        1.0
                    };
                    ((x - cx) / (rx * factor).max(f32::EPSILON))
                        .hypot((y - cy) / (ry * factor).max(f32::EPSILON))
                }
            }
            _ => 0.0,
        }
    };
    if gradient.repeating {
        let start = stops[0].1.0;
        let length = stops.last().map_or(1.0, |s| s.1.0) - start;
        if length > 0.0 {
            t = (t - start).rem_euclid(length) + start
        }
    }
    if t <= stops[0].1.0 {
        return stops[0].0;
    }
    for pair in stops.windows(2) {
        let [(a, start), (b, end)] = pair else {
            unreachable!()
        };
        if t <= end.0 {
            return interpolate(
                *a,
                *b,
                ((t - start.0) / (end.0 - start.0).max(f32::EPSILON)).clamp(0.0, 1.0),
            );
        }
    }
    stops.last().map_or(Color::TRANSPARENT, |s| s.0)
}

fn interpolate(a: Color, b: Color, t: f32) -> Color {
    let a = components(a);
    let b = components(b);
    let values: [u8; 4] =
        std::array::from_fn(|i| (a[i] + (b[i] - a[i]) * t).round().clamp(0.0, 255.0) as u8);
    Color::rgba(values[0], values[1], values[2], values[3])
}

fn filter_color(color: Color, matrix: Option<&[f32; 20]>) -> Color {
    let Some(matrix) = matrix else { return color };
    let c = components(color).map(|v| v / 255.0);
    let c: [u8; 4] = std::array::from_fn(|r| {
        ((c.iter()
            .enumerate()
            .map(|(i, v)| matrix[r * 5 + i] * v)
            .sum::<f32>()
            + matrix[r * 5 + 4])
            .clamp(0.0, 1.0)
            * 255.0)
            .round() as u8
    });
    Color::rgba(c[0], c[1], c[2], c[3])
}

fn components(color: Color) -> [f32; 4] {
    [
        (color.0 >> 24) as f32,
        ((color.0 >> 16) & 255) as f32,
        ((color.0 >> 8) & 255) as f32,
        (color.0 & 255) as f32,
    ]
}
fn alpha(color: Color) -> f32 {
    (color.0 & 255) as f32 / 255.0
}
fn cell_color(color: Color) -> CellColor {
    CellColor::Rgb(
        (color.0 >> 24) as u8,
        (color.0 >> 16) as u8,
        (color.0 >> 8) as u8,
    )
}

fn over_color(foreground: Color, background: Color) -> Color {
    let a = alpha(foreground);
    let b = alpha(background);
    let out = a + b * (1.0 - a);
    if out <= 0.0 {
        return Color::TRANSPARENT;
    }
    let foreground = components(foreground);
    let background = components(background);
    let c: [u8; 3] = std::array::from_fn(|i| {
        ((foreground[i] * a + background[i] * b * (1.0 - a)) / out)
            .round()
            .clamp(0.0, 255.0) as u8
    });
    Color::rgba(c[0], c[1], c[2], (out * 255.0).round() as u8)
}

fn blend(source: Color, destination: CellColor, opacity: f32, mode: BlendMode) -> CellColor {
    let source = components(source);
    let destination = rgb(destination);
    let alpha = source[3] / 255.0 * opacity.clamp(0.0, 1.0);
    let c: [u8; 3] = std::array::from_fn(|i| {
        let (s, d) = (source[i] / 255.0, f32::from(destination[i]) / 255.0);
        let mixed = match mode {
            BlendMode::Multiply => s * d,
            BlendMode::Screen => 1.0 - (1.0 - s) * (1.0 - d),
            BlendMode::Overlay => {
                if d < 0.5 {
                    2.0 * s * d
                } else {
                    1.0 - 2.0 * (1.0 - s) * (1.0 - d)
                }
            }
            BlendMode::Darken => s.min(d),
            BlendMode::Lighten => s.max(d),
            BlendMode::Difference => (s - d).abs(),
            BlendMode::Exclusion => s + d - 2.0 * s * d,
            BlendMode::PlusLighter => (s + d).min(1.0),
            BlendMode::PlusDarker => (s + d - 1.0).max(0.0),
            _ => s,
        };
        ((mixed * alpha + d * (1.0 - alpha)) * 255.0)
            .round()
            .clamp(0.0, 255.0) as u8
    });
    CellColor::Rgb(c[0], c[1], c[2])
}

fn rgb(color: CellColor) -> [u8; 3] {
    match color {
        CellColor::Rgb(r, g, b) => [r, g, b],
        CellColor::Black => [0, 0, 0],
        CellColor::Red => [128, 0, 0],
        CellColor::Green => [0, 128, 0],
        CellColor::Yellow => [128, 128, 0],
        CellColor::Blue => [0, 0, 128],
        CellColor::Magenta => [128, 0, 128],
        CellColor::Cyan => [0, 128, 128],
        CellColor::Gray => [192, 192, 192],
        CellColor::DarkGray => [128, 128, 128],
        CellColor::LightRed => [255, 0, 0],
        CellColor::LightGreen => [0, 255, 0],
        CellColor::LightYellow => [255, 255, 0],
        CellColor::LightBlue => [0, 0, 255],
        CellColor::LightMagenta => [255, 0, 255],
        CellColor::LightCyan => [0, 255, 255],
        CellColor::White => [255, 255, 255],
        CellColor::Indexed(i) => {
            const BASE: [[u8; 3]; 16] = [
                [0, 0, 0],
                [128, 0, 0],
                [0, 128, 0],
                [128, 128, 0],
                [0, 0, 128],
                [128, 0, 128],
                [0, 128, 128],
                [192, 192, 192],
                [128, 128, 128],
                [255, 0, 0],
                [0, 255, 0],
                [255, 255, 0],
                [0, 0, 255],
                [255, 0, 255],
                [0, 255, 255],
                [255, 255, 255],
            ];
            if i < 16 {
                BASE[usize::from(i)]
            } else if i >= 232 {
                [8 + (i - 232) * 10; 3]
            } else {
                let i = i - 16;
                [i / 36, (i / 6) % 6, i % 6].map(|v| if v == 0 { 0 } else { 55 + v * 40 })
            }
        }
        CellColor::Reset => [255, 255, 255],
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use nsh_core::{Edges, MountBatch, MountItem, ROOT_ID, ResolvedTextStyle, TextEngine};

    use super::*;

    fn mount_node(
        id: NodeId,
        kind: ViewKind,
        parent: NodeId,
        frame: Bounds<Points>,
    ) -> Vec<MountItem> {
        let mut items = vec![
            MountItem::Create { id, kind },
            MountItem::Frame { id, frame },
        ];
        if kind == ViewKind::Modal {
            items.push(MountItem::ModalConfig {
                id,
                config: nsh_core::ModalConfig {
                    animation: nsh_core::ModalAnimation::None,
                    ..nsh_core::ModalConfig::default()
                },
            });
        }
        items.push(MountItem::Insert {
            parent,
            child: id,
            before: None,
        });
        items
    }

    fn protocol_scene(kind: crate::ProtocolType) -> Surface {
        let mut surface = Surface::new(20, 8, CellMetrics::default());
        let mut items = mount_node(
            2,
            ViewKind::View,
            ROOT_ID,
            Bounds::new(
                Point::new(Points::ZERO, Points::ZERO),
                Size::new(px(160.0), px(128.0)),
            ),
        );
        items.extend(mount_node(
            4,
            ViewKind::Image,
            2,
            Bounds::new(Point::new(px(8.0), px(16.0)), Size::new(px(16.0), px(32.0))),
        ));
        items.extend(mount_node(
            6,
            ViewKind::Canvas,
            2,
            Bounds::new(
                Point::new(px(40.0), px(16.0)),
                Size::new(px(32.0), px(32.0)),
            ),
        ));
        surface.apply(MountBatch { items });
        let raster = Arc::new(crate::image::Raster {
            width: 1,
            height: 1,
            rgba: vec![255, 0, 0, 128],
        });
        let state = &mut surface.node_mut(4).unwrap().image;
        let request = state
            .update(
                Some(nsh_core::ImageSource {
                    uri: Arc::from("asset:/test.png"),
                    scales: nsh_core::ImageScales::NONE,
                    data: None,
                    size: None,
                }),
                ResizeMode::Stretch,
                nsh_core::ImageOptions::default(),
                0.0,
            )
            .remove(0);
        state.install_cached(
            &request,
            Arc::new(crate::image::AnimatedRaster {
                frames: vec![raster.clone()],
                delays: vec![100],
                plays: 1,
            }),
            0.0,
        );
        surface.node_mut(6).unwrap().canvas_raster = Some(raster);
        surface.set_image_protocol(Some(crate::ImageProtocol::new(kind, 8, 16).unwrap()));
        surface
    }

    fn wait_protocol_encodings(surface: &mut Surface) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while surface.protocol.pending() {
            assert!(
                std::time::Instant::now() < deadline,
                "protocol jobs did not complete"
            );
            surface.tick(0.0);
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }

    #[test]
    fn unicode_images_preserve_directional_edges_and_compose_transparent_layers() {
        use crate::image::Raster;

        let (red, blue, green, yellow) = ([255, 0, 0], [0, 0, 255], [0, 255, 0], [255, 255, 0]);
        let patches = [
            [red, blue, red, blue],
            [red, red, blue, blue],
            [red, blue, blue, red],
            [red, red, red, blue],
            [red, green, blue, yellow],
            [[0; 3], [85; 3], [170; 3], [255; 3]],
            [green, yellow, yellow, green],
            [blue; 4],
        ];
        let mut source = Raster {
            width: 32,
            height: 32,
            rgba: Vec::new(),
        };
        for y in 0..32usize {
            for x in 0..32usize {
                let patch = patches[y / 16 * 4 + x / 8];
                source
                    .rgba
                    .extend_from_slice(&patch[(y % 16 / 8) * 2 + x % 8 / 4]);
                source.rgba.push(255);
            }
        }
        let mut surface = Surface::new(4, 2, CellMetrics::default());
        let frame = Bounds::new(Point::new(px(0.0), px(0.0)), Size::new(px(32.0), px(32.0)));
        surface.apply(MountBatch {
            items: mount_node(2, ViewKind::Canvas, ROOT_ID, frame),
        });
        surface.node_mut(2).unwrap().canvas_raster = Some(Arc::new(source.clone()));
        let area = CellRect::new(0, 0, 4, 2);
        let mut buffer = Buffer::empty(area);
        surface.render(area, &mut buffer);
        let reconstructed =
            crate::text::rasterize_cells(&buffer, surface.metrics, &surface.fonts).unwrap();
        let pixel = |x: usize, y: usize| &reconstructed.rgba[(y * 32 + x) * 4..][..3];
        assert_eq!(pixel(1, 1), red);
        assert_eq!(pixel(6, 1), blue);
        assert_eq!(pixel(1, 12), red);
        assert_eq!(pixel(6, 12), blue);
        assert_eq!(pixel(17, 1), red);
        assert_eq!(pixel(22, 1), blue);
        assert_eq!(pixel(17, 12), blue);
        assert_eq!(pixel(22, 12), red);
        assert_eq!(buffer[(1, 0)].symbol(), "▀");
        assert_eq!(buffer[(3, 1)].symbol(), "▀");

        // Independent baseline: the best RGB mean in each half of this bitmap.
        // Both reconstructions idealize filled blocks, not emulator/font pixels.
        let mut halfblocks = source.clone();
        for cy in 0..2 {
            for cx in 0..4 {
                for half in 0..2 {
                    let mut sum = [0u32; 3];
                    for y in cy * 16 + half * 8..cy * 16 + half * 8 + 8 {
                        for x in cx * 8..cx * 8 + 8 {
                            for (k, channel) in sum.iter_mut().enumerate() {
                                *channel += u32::from(source.rgba[(y * 32 + x) * 4 + k]);
                            }
                        }
                    }
                    let color = sum.map(|value| (value as f32 / 64.0).round() as u8);
                    for y in cy * 16 + half * 8..cy * 16 + half * 8 + 8 {
                        for x in cx * 8..cx * 8 + 8 {
                            halfblocks.rgba[(y * 32 + x) * 4..][..3].copy_from_slice(&color);
                        }
                    }
                }
            }
        }
        let error = |raster: &Raster| -> u64 {
            source
                .rgba
                .iter()
                .zip(&raster.rgba)
                .enumerate()
                .filter(|(i, _)| i % 4 != 3)
                .map(|(_, (a, b))| (i64::from(*a) - i64::from(*b)).pow(2) as u64)
                .sum()
        };
        let (half_error, block_error) = (error(&halfblocks), error(&reconstructed));
        assert!(block_error * 2 < half_error);
        assert!(
            block_error > 0,
            "four source colors still cannot fit in a two-color cell"
        );
        if let Some(path) = std::env::var_os("NSH_UNICODE_IMAGE_EVIDENCE") {
            let path = std::path::PathBuf::from(path);
            std::fs::create_dir_all(&path).unwrap();
            for (name, raster) in [
                ("source.png", &source),
                ("halfblock-ideal.png", &halfblocks),
                ("unicode-ideal.png", &reconstructed),
            ] {
                raster.pixmap().unwrap().save_png(path.join(name)).unwrap();
            }
            std::fs::write(
                path.join("comparison.txt"),
                format!(
                    "RGB squared error: halfblock={half_error}, Unicode={block_error}\n\
                 Source bitmap -> real Surface buffer -> ideal filled-block reconstruction.\n\
                 This is not an emulator screenshot or a font/palette fidelity measurement.\n"
                ),
            )
            .unwrap();
        }

        // A second real surface layer must compose over both halves of ▌.
        surface.apply(MountBatch {
            items: mount_node(
                4,
                ViewKind::Canvas,
                ROOT_ID,
                Bounds::new(frame.origin, Size::new(px(8.0), px(16.0))),
            ),
        });
        surface.node_mut(4).unwrap().canvas_raster = Some(Arc::new(Raster {
            width: 1,
            height: 1,
            rgba: vec![255, 255, 255, 128],
        }));
        surface.render(area, &mut buffer);
        let cell = &buffer[(0, 0)];
        assert_eq!(cell.symbol(), "▌");
        assert_eq!(cell.fg, CellColor::Rgb(255, 128, 128));
        assert_eq!(cell.bg, CellColor::Rgb(128, 128, 255));
    }

    #[test]
    fn image_and_canvas_prefer_protocols_through_transparent_layout_containers() {
        let mut surface = protocol_scene(crate::ProtocolType::Iterm2);
        let area = CellRect::new(0, 0, 20, 8);
        let mut buffer = Buffer::empty(area);
        surface.render(area, &mut buffer);
        assert!(
            !buffer
                .content
                .iter()
                .any(|cell| cell.symbol().contains('\u{1b}'))
        );
        assert!(
            surface.animating(),
            "embedded hosts must poll while encoding is pending"
        );
        wait_protocol_encodings(&mut surface);
        surface.render(area, &mut buffer);
        assert!(buffer[(1, 1)].symbol().contains("1337;File"));
        assert!(buffer[(5, 1)].symbol().contains("1337;File"));
        assert!(!surface.snapshot().contains('\u{1b}'));

        let mut items = mount_node(
            8,
            ViewKind::Text,
            ROOT_ID,
            Bounds::new(Point::new(px(8.0), px(16.0)), Size::new(px(8.0), px(16.0))),
        );
        let mut text = nsh_core::AttributedText::default();
        text.push("X", ResolvedTextStyle::default());
        let engine = crate::TerminalTextEngine::default();
        let layout = engine.layout(&engine.prepare(&text), Size::new(px(8.0), px(16.0)));
        items.push(MountItem::Text {
            id: 8,
            text: Arc::new(text),
            layout,
            content: Bounds::new(
                Point::new(Points::ZERO, Points::ZERO),
                Size::new(px(8.0), px(16.0)),
            ),
        });
        surface.apply(MountBatch { items });
        surface.render(area, &mut buffer);
        assert_eq!(
            buffer[(1, 1)].symbol(),
            "X",
            "foreground text must restore the half-block path"
        );
        assert!(buffer[(5, 1)].symbol().contains("1337;File"));
        surface.apply(MountBatch {
            items: vec![MountItem::Delete { id: 8 }],
        });
        surface.render(area, &mut buffer);
        assert!(buffer[(1, 1)].symbol().contains("1337;File"));

        surface.apply(MountBatch {
            items: mount_node(
                10,
                ViewKind::Modal,
                ROOT_ID,
                Bounds::new(
                    Point::new(Points::ZERO, Points::ZERO),
                    Size::new(px(160.0), px(128.0)),
                ),
            ),
        });
        surface.render(area, &mut buffer);
        assert!(
            !buffer
                .content
                .iter()
                .any(|cell| cell.symbol().contains('\u{1b}'))
        );
        surface.apply(MountBatch {
            items: vec![MountItem::Delete { id: 10 }],
        });
        surface.render(area, &mut buffer);
        assert!(buffer[(1, 1)].symbol().contains("1337;File"));
    }

    #[test]
    fn a_plain_pass_replaces_sixel_cells_without_disabling_later_protocol_renders() {
        let mut surface = protocol_scene(crate::ProtocolType::Sixel);
        let area = CellRect::new(0, 0, 20, 8);
        let mut buffer = Buffer::empty(area);
        surface.render_plain(area, &mut buffer);
        assert!(!surface.protocol.pending());
        assert_eq!(buffer[(1, 1)].symbol(), "▀");
        assert_eq!(buffer[(1, 1)].fg, CellColor::Rgb(255, 127, 127));
        assert_eq!(buffer[(1, 1)].bg, CellColor::Rgb(255, 127, 127));

        surface.render(area, &mut buffer);
        wait_protocol_encodings(&mut surface);
        surface.render(area, &mut buffer);
        assert!(buffer[(1, 1)].symbol().contains("\u{1b}P"));
        assert!(buffer[(5, 1)].symbol().contains("\u{1b}P"));

        surface.render_plain(area, &mut buffer);
        assert_eq!(buffer[(1, 1)].symbol(), "▀");
        assert_eq!(buffer[(1, 1)].fg, CellColor::Rgb(255, 127, 127));
        assert_eq!(buffer[(5, 1)].symbol(), "▀");
        assert!(buffer.content.iter().all(|cell| {
            !cell.symbol().contains('\u{1b}') && cell.diff_option == CellDiffOption::None
        }));
        surface.render(area, &mut buffer);
        assert!(buffer[(1, 1)].symbol().contains("\u{1b}P"));
        assert!(!surface.protocol.pending());
    }

    #[test]
    fn kitty_cells_restore_native_modal_text_after_a_fade() {
        let mut surface = protocol_scene(crate::ProtocolType::Kitty);
        let area = CellRect::new(0, 0, 20, 8);
        let mut previous = Buffer::empty(area);
        surface.render(area, &mut previous);
        wait_protocol_encodings(&mut surface);
        surface.render(area, &mut previous);
        assert!(previous[(1, 1)].symbol().contains("a=T,U=1"));

        let mut items = vec![
            MountItem::Create {
                id: 8,
                kind: ViewKind::Modal,
            },
            MountItem::Frame {
                id: 8,
                frame: Bounds::new(
                    Point::new(Points::ZERO, Points::ZERO),
                    Size::new(px(160.0), px(128.0)),
                ),
            },
            MountItem::ModalConfig {
                id: 8,
                config: nsh_core::ModalConfig {
                    animation: nsh_core::ModalAnimation::Fade,
                    ..nsh_core::ModalConfig::default()
                },
            },
            MountItem::Insert {
                parent: ROOT_ID,
                child: 8,
                before: None,
            },
        ];
        items.extend(mount_node(
            10,
            ViewKind::Text,
            8,
            Bounds::new(
                Point::new(px(8.0), px(16.0)),
                Size::new(px(112.0), px(16.0)),
            ),
        ));
        let mut text = nsh_core::AttributedText::default();
        text.push("Deploy service", ResolvedTextStyle::default());
        let engine = crate::TerminalTextEngine::default();
        items.push(MountItem::Text {
            id: 10,
            layout: engine.layout(&engine.prepare(&text), Size::new(px(112.0), px(16.0))),
            text: Arc::new(text),
            content: Bounds::new(
                Point::new(Points::ZERO, Points::ZERO),
                Size::new(px(112.0), px(16.0)),
            ),
        });
        surface.apply(MountBatch { items });
        let mut current = Buffer::empty(area);
        surface.tick(0.1);
        surface.render(area, &mut current);
        surface.tick(0.21);
        surface.render(area, &mut current);
        let title: String = (1..15).map(|x| current[(x, 1)].symbol()).collect();
        assert_eq!(title, "Deploy service");
        assert!(
            current
                .content
                .iter()
                .all(|cell| cell.diff_option == CellDiffOption::None)
        );
        let changed = previous.diff(&current);
        assert!(
            changed
                .iter()
                .any(|(x, y, cell)| *x == 1 && *y == 1 && cell.symbol() == "D")
        );
    }

    #[test]
    fn snapshots_do_not_consume_kitty_uploads_or_request_protocol_encodings() {
        let mut surface = protocol_scene(crate::ProtocolType::Kitty);
        assert!(!surface.snapshot().contains('\u{1b}'));
        assert!(!surface.protocol.pending());
        let area = CellRect::new(0, 0, 20, 8);
        let mut buffer = Buffer::empty(area);
        surface.render(area, &mut buffer);
        wait_protocol_encodings(&mut surface);
        assert!(!surface.snapshot().contains('\u{1b}'));
        surface.render(area, &mut buffer);
        assert!(buffer[(1, 1)].symbol().contains("a=T,U=1"));
        assert!(buffer[(5, 1)].symbol().contains("a=T,U=1"));
        let cleanup = surface.image_protocol_cleanup();
        let mut next = Surface::new(20, 8, CellMetrics::default());
        next.inherit_image_protocol(&mut surface);
        assert_eq!(next.image_protocol_cleanup(), cleanup);
        assert!(!next.protocol.pending());
    }

    #[test]
    fn focusing_short_rows_keeps_kitty_images_and_canvas_tiles_intact() {
        for height in [px(16.0), px(32.0)] {
            let mut surface = protocol_scene(crate::ProtocolType::Kitty);
            surface.node_mut(2).unwrap().frame.size.height = height;
            surface.node_mut(2).unwrap().props.accessibility.role = AccessibilityRole::Button;
            surface
                .node_mut(2)
                .unwrap()
                .events
                .set(EventKind::Press, true);
            for id in [4, 6] {
                let node = surface.node_mut(id).unwrap();
                node.frame.origin.y = Points::ZERO;
                node.frame.size.height = height;
            }
            let mut items = mount_node(
                8,
                ViewKind::Text,
                2,
                Bounds::new(Point::new(px(88.0), px(0.0)), Size::new(px(48.0), px(16.0))),
            );
            let mut text = nsh_core::AttributedText::default();
            text.push("Row", ResolvedTextStyle::default());
            let engine = crate::TerminalTextEngine::default();
            let layout = engine.layout(&engine.prepare(&text), Size::new(px(48.0), px(16.0)));
            items.push(MountItem::Text {
                id: 8,
                text: Arc::new(text),
                layout,
                content: Bounds::new(
                    Point::new(Points::ZERO, Points::ZERO),
                    Size::new(px(48.0), px(16.0)),
                ),
            });
            surface.apply(MountBatch { items });
            surface.focus = None;
            let area = CellRect::new(0, 0, 20, 8);
            let mut buffer = Buffer::empty(area);
            surface.render(area, &mut buffer);
            wait_protocol_encodings(&mut surface);
            surface.render(area, &mut buffer);
            assert!(buffer[(1, 0)].symbol().contains("a=T,U=1"));
            assert!(buffer[(5, 0)].symbol().contains("a=T,U=1"));
            let graphics = buffer
                .content
                .iter()
                .enumerate()
                .filter(|(_, cell)| cell.symbol().contains('\u{10eeee}'))
                .map(|(i, cell)| (i, cell.fg, cell.diff_option))
                .collect::<Vec<_>>();
            assert!(!graphics.is_empty());
            surface.focus = Some(2);
            surface.render(area, &mut buffer);
            assert!(buffer[(11, 0)].modifier.contains(Modifier::UNDERLINED));
            for (i, color, diff) in graphics {
                let cell = &buffer.content[i];
                assert!(
                    cell.symbol().contains('\u{10eeee}'),
                    "row focus must keep the Kitty placement"
                );
                assert_eq!(cell.fg, color, "Kitty image IDs use foreground colors");
                assert_eq!(cell.diff_option, diff);
                assert!(
                    cell.modifier.is_empty(),
                    "row focus must leave graphic tile attributes intact"
                );
            }
            surface.apply(MountBatch {
                items: mount_node(
                    10,
                    ViewKind::Modal,
                    ROOT_ID,
                    Bounds::new(
                        Point::new(Points::ZERO, Points::ZERO),
                        Size::new(px(160.0), px(128.0)),
                    ),
                ),
            });
            surface.render(area, &mut buffer);
            assert!(
                buffer
                    .content
                    .iter()
                    .all(|cell| !cell.symbol().contains('\u{10eeee}')
                        && !cell.symbol().contains('\u{1b}')),
                "a later modal must still disable protocol placements"
            );
        }
    }

    #[test]
    fn fractional_two_line_rows_keep_titles_in_recycled_paint_order() {
        // A recycled cell's tree order may differ from its current visual order.
        // Both orders must paint the same two non-overlapping 32pt rows.
        for reversed in [false, true] {
            let mut surface = Surface::new(16, 5, CellMetrics::default());
            let engine = crate::TerminalTextEngine::default();
            let rows = if reversed {
                [
                    (8, 40.0, "TITLE_B", "PATH_B"),
                    (2, 8.0, "TITLE_A", "PATH_A"),
                ]
            } else {
                [
                    (2, 8.0, "TITLE_A", "PATH_A"),
                    (8, 40.0, "TITLE_B", "PATH_B"),
                ]
            };
            let mut items = Vec::new();
            for (id, y, title, path) in rows {
                items.extend(mount_node(
                    id,
                    ViewKind::View,
                    ROOT_ID,
                    Bounds::new(Point::new(px(0.0), px(y)), Size::new(px(128.0), px(32.0))),
                ));
                items.push(MountItem::ViewStyle {
                    id,
                    style: Box::new(ViewStyle {
                        background_color: Color(0x2020_20ff),
                        ..ViewStyle::default()
                    }),
                });
                for (child, text_y, value) in [(id + 1, 0.0, title), (id + 2, 16.0, path)] {
                    items.extend(mount_node(
                        child,
                        ViewKind::Text,
                        id,
                        Bounds::new(
                            Point::new(px(0.0), px(text_y)),
                            Size::new(px(128.0), px(16.0)),
                        ),
                    ));
                    let mut text = nsh_core::AttributedText::default();
                    text.push(
                        value,
                        ResolvedTextStyle {
                            color: Color(0xffff_ffff),
                            ..ResolvedTextStyle::default()
                        },
                    );
                    items.push(MountItem::Text {
                        id: child,
                        layout: engine
                            .layout(&engine.prepare(&text), Size::new(px(128.0), px(16.0))),
                        text: Arc::new(text),
                        content: Bounds::new(
                            Point::new(px(0.0), px(0.0)),
                            Size::new(px(128.0), px(16.0)),
                        ),
                    });
                }
            }
            surface.apply(MountBatch { items });
            surface.focus = None;
            let order: Vec<_> = surface
                .paint_ids()
                .into_iter()
                .filter(|id| [2, 8].contains(id))
                .collect();
            assert_eq!(order, if reversed { vec![8, 2] } else { vec![2, 8] });
            let area = CellRect::new(0, 0, 16, 5);
            let mut buffer = Buffer::empty(area);
            surface.render_plain(area, &mut buffer);
            let lines: Vec<_> = (0..5)
                .map(|y| {
                    (0..16)
                        .map(|x| buffer[(x, y)].symbol())
                        .collect::<String>()
                        .trim_end()
                        .to_owned()
                })
                .collect();
            assert_eq!(
                lines,
                ["TITLE_A", "PATH_A", "TITLE_B", "PATH_B", ""],
                "reversed={reversed}; screen=\n{}",
                lines.join("\n")
            );
        }
    }

    #[test]
    fn fractional_background_edges_and_clip_preserve_neighbor_text() {
        let surface = Surface::new(5, 1, CellMetrics::default());
        let area = CellRect::new(0, 0, 5, 1);
        let style = ViewStyle {
            background_color: Color(0x2020_20ff),
            ..ViewStyle::default()
        };
        // Cell centers are x=4,12,20,28,36. A start center belongs to
        // the background; an end center belongs to its neighboring text.
        for (frame_x, frame_width, clip_x, clip_width, expected) in [
            (4.0, 16.0, 0.0, 40.0, "  CDE"),
            (0.0, 40.0, 12.0, 8.0, "A CDE"),
        ] {
            let mut buffer = Buffer::empty(area);
            buffer.set_string(0, 0, "ABCDE", Style::default());
            surface.paint_decor(
                Bounds::new(
                    Point::new(px(frame_x), px(0.0)),
                    Size::new(px(frame_width), px(16.0)),
                ),
                Bounds::new(
                    Point::new(px(clip_x), px(0.0)),
                    Size::new(px(clip_width), px(16.0)),
                ),
                &style,
                1.0,
                area,
                &mut buffer,
            );
            let actual: String = (0..5).map(|x| buffer[(x, 0)].symbol()).collect();
            assert_eq!(
                actual, expected,
                "frame=({frame_x},{frame_width}) clip=({clip_x},{clip_width})"
            );
        }
    }

    #[test]
    fn text_focus_skips_half_blocks_and_protocol_cells() {
        let mut text = ratatui::buffer::Cell::default();
        text.set_symbol("中");
        assert!(focus_text_cell(&text));
        for symbol in [" ", "▀", "▄", "█", "⣿", "\u{10eeee}", "\u{1b}_Gdata"] {
            text.set_symbol(symbol);
            assert!(!focus_text_cell(&text));
        }
        text.set_symbol("x").set_diff_option(CellDiffOption::Skip);
        assert!(!focus_text_cell(&text));
    }

    fn white_buffer(area: CellRect) -> Buffer {
        let mut buffer = Buffer::empty(area);
        for cell in &mut buffer.content {
            cell.set_bg(CellColor::Rgb(255, 255, 255));
        }
        buffer
    }

    #[test]
    fn raster_groups_apply_resolved_opacity_once_and_keep_scroll_indicators() {
        let mut surface = Surface::new(8, 4, CellMetrics::default());
        let mut items = mount_node(
            2,
            ViewKind::View,
            ROOT_ID,
            Bounds::new(
                Point::new(Points::ZERO, Points::ZERO),
                Size::new(px(64.0), px(64.0)),
            ),
        );
        items.push(MountItem::ViewStyle {
            id: 2,
            style: Box::new(ViewStyle {
                opacity: 0.5,
                ..ViewStyle::default()
            }),
        });
        items.extend(mount_node(
            4,
            ViewKind::View,
            2,
            Bounds::new(
                Point::new(Points::ZERO, Points::ZERO),
                Size::new(px(32.0), px(32.0)),
            ),
        ));
        items.push(MountItem::ViewStyle {
            id: 4,
            style: Box::new(ViewStyle {
                background_color: Color(0x0000_ffff),
                ..ViewStyle::default()
            }),
        });
        surface.apply(MountBatch { items });
        let area = CellRect::new(0, 0, 8, 4);
        let plans = surface.composite_plans(&surface.paint_ids(), area);
        let scene = surface
            .composite_scene(&plans[0], &surface.paint_ids(), area, &white_buffer(area))
            .unwrap();
        assert_eq!(scene.root.style.opacity, 0.5);
        assert_eq!(scene.inherited_opacity, 1.0);
        let raster = crate::composite::rasterize(&scene, &surface.fonts).unwrap();
        assert_eq!(
            &raster.rgba[(8 * raster.width as usize + 8) * 4..][..4],
            &[128, 128, 255, 255]
        );

        let mut scroll = Surface::new(4, 4, CellMetrics::default());
        let mut items = mount_node(
            2,
            ViewKind::Scroll,
            ROOT_ID,
            Bounds::new(
                Point::new(Points::ZERO, Points::ZERO),
                Size::new(px(32.0), px(64.0)),
            ),
        );
        items.push(MountItem::ScrollContent {
            id: 2,
            size: Size::new(px(32.0), px(256.0)),
        });
        items.push(MountItem::ViewStyle {
            id: 2,
            style: Box::new(ViewStyle {
                border_radius: px(8.0),
                overflow_hidden: true,
                ..ViewStyle::default()
            }),
        });
        scroll.apply(MountBatch { items });
        let area = CellRect::new(0, 0, 4, 4);
        let ids = scroll.paint_ids();
        let plans = scroll.composite_plans(&ids, area);
        let scene = scroll
            .composite_scene(&plans[0], &ids, area, &white_buffer(area))
            .unwrap();
        let raster = crate::composite::rasterize(&scene, &scroll.fonts).unwrap();
        assert!(
            (0..16)
                .any(|y| (28..32).any(|x| raster.rgba[(y * raster.width as usize + x) * 4] < 250)),
            "scroll indicators must survive subtree rasterization"
        );
    }

    #[test]
    fn rounded_images_clip_their_pixels_and_deep_groups_keep_the_plain_fallback() {
        let mut surface = protocol_scene(crate::ProtocolType::Halfblocks);
        surface.node_mut(4).unwrap().style.border_radius = px(8.0);
        let area = CellRect::new(0, 0, 20, 8);
        let ids = surface.paint_ids();
        let plans = surface.composite_plans(&ids, area);
        let scene = surface
            .composite_scene(
                plans.iter().find(|p| p.id == 4).unwrap(),
                &ids,
                area,
                &white_buffer(area),
            )
            .unwrap();
        assert!(scene.root.style.overflow_hidden);
        let raster = crate::composite::rasterize(&scene, &surface.fonts).unwrap();
        assert_eq!(&raster.rgba[..4], &[255, 255, 255, 255]);
        assert!(
            raster
                .rgba
                .as_chunks::<4>()
                .0
                .iter()
                .any(|pixel| pixel[0] > pixel[1])
        );

        let mut deep = Surface::new(8, 2, CellMetrics::default());
        let mut items = Vec::new();
        for index in 0..34 {
            let id = 2 + index * 2;
            items.extend(mount_node(
                id,
                ViewKind::View,
                if index == 0 { ROOT_ID } else { id - 2 },
                Bounds::new(
                    Point::new(Points::ZERO, Points::ZERO),
                    Size::new(px(64.0), px(32.0)),
                ),
            ));
        }
        items.push(MountItem::ViewStyle {
            id: 2,
            style: Box::new(ViewStyle {
                opacity: 0.5,
                ..ViewStyle::default()
            }),
        });
        items.extend(mount_node(
            72,
            ViewKind::Text,
            68,
            Bounds::new(
                Point::new(Points::ZERO, Points::ZERO),
                Size::new(px(32.0), px(16.0)),
            ),
        ));
        let mut text = nsh_core::AttributedText::default();
        text.push("Deep", ResolvedTextStyle::default());
        let engine = crate::TerminalTextEngine::default();
        items.push(MountItem::Text {
            id: 72,
            layout: engine.layout(&engine.prepare(&text), Size::new(px(32.0), px(16.0))),
            text: Arc::new(text),
            content: Bounds::new(
                Point::new(Points::ZERO, Points::ZERO),
                Size::new(px(32.0), px(16.0)),
            ),
        });
        deep.apply(MountBatch { items });
        deep.focus = None;
        let area = CellRect::new(0, 0, 8, 2);
        let ids = deep.paint_ids();
        let plans = deep.composite_plans(&ids, area);
        assert!(
            deep.composite_scene(&plans[0], &ids, area, &white_buffer(area))
                .is_none()
        );
        let mut buffer = Buffer::empty(area);
        deep.render(area, &mut buffer);
        assert_eq!(buffer[(0, 0)].symbol(), "D");
    }

    #[test]
    fn backdrop_capture_includes_neighboring_pixels_outside_the_filtered_box() {
        let mut surface = Surface::new(8, 4, CellMetrics::default());
        let mut items = mount_node(
            2,
            ViewKind::View,
            ROOT_ID,
            Bounds::new(
                Point::new(px(24.0), px(16.0)),
                Size::new(px(16.0), px(16.0)),
            ),
        );
        items.push(MountItem::ViewStyle {
            id: 2,
            style: Box::new(ViewStyle {
                overflow_hidden: true,
                border_radius: px(4.0),
                effects: Some(Arc::new(nsh_core::Effects {
                    backdrop_filters: vec![nsh_core::Filter::Blur(px(8.0))],
                    ..nsh_core::Effects::default()
                })),
                ..ViewStyle::default()
            }),
        });
        surface.apply(MountBatch { items });
        let area = CellRect::new(0, 0, 8, 4);
        let ids = surface.paint_ids();
        let plans = surface.composite_plans(&ids, area);
        assert!(plans[0].bounds.origin.x.0 <= 16.0);
        let mut background = Buffer::empty(area);
        for cell in &mut background.content {
            cell.set_bg(CellColor::Rgb(0, 0, 0));
        }
        for y in 0..4 {
            background[(2, y)].set_bg(CellColor::Rgb(255, 255, 255));
        }
        let scene = surface
            .composite_scene(&plans[0], &ids, area, &background)
            .unwrap();
        let raster = crate::composite::rasterize(&scene, &surface.fonts).unwrap();
        let x = (24.0 - scene.bounds.origin.x.0) as usize;
        let y = (24.0 - scene.bounds.origin.y.0) as usize;
        assert!(
            raster.rgba[(y * raster.width as usize + x) * 4] > 0,
            "rounded clipped backdrops must include the bright strip outside the box"
        );
    }

    #[test]
    fn rounded_group_bounds_preserve_outer_shadow_and_outline_pixels() {
        for outline in [false, true] {
            let mut surface = Surface::new(8, 4, CellMetrics::default());
            let mut items = mount_node(
                2,
                ViewKind::View,
                ROOT_ID,
                Bounds::new(
                    Point::new(px(24.0), px(16.0)),
                    Size::new(px(16.0), px(16.0)),
                ),
            );
            let mut style = ViewStyle {
                overflow_hidden: true,
                border_radius: px(4.0),
                background_color: Color(0xff00_00ff),
                ..ViewStyle::default()
            };
            let (x, expected) = if outline {
                style.outline = nsh_core::Outline {
                    width: px(2.0),
                    offset: px(2.0),
                    color: Color(0x0000_ffff),
                    ..nsh_core::Outline::default()
                };
                (21.0, [0, 0, 255, 255])
            } else {
                style.shadow = nsh_core::Shadow {
                    color: Color::BLACK,
                    offset_x: px(8.0),
                    offset_y: px(0.0),
                    radius: px(0.0),
                    opacity: 1.0,
                };
                (45.0, [0, 0, 0, 255])
            };
            items.push(MountItem::ViewStyle {
                id: 2,
                style: Box::new(style),
            });
            surface.apply(MountBatch { items });
            let area = CellRect::new(0, 0, 8, 4);
            let ids = surface.paint_ids();
            let plans = surface.composite_plans(&ids, area);
            let scene = surface
                .composite_scene(&plans[0], &ids, area, &white_buffer(area))
                .unwrap();
            assert!(
                x >= scene.bounds.origin.x.0
                    && x < scene.bounds.origin.x.0 + scene.bounds.size.width.0
            );
            let raster = crate::composite::rasterize(&scene, &surface.fonts).unwrap();
            let x = (x - scene.bounds.origin.x.0) as usize;
            let y = (24.0 - scene.bounds.origin.y.0) as usize;
            assert_eq!(
                &raster.rgba[(y * raster.width as usize + x) * 4..][..4],
                &expected
            );
        }
    }

    #[test]
    fn short_composited_buttons_keep_a_visible_text_focus_indicator() {
        let mut surface = Surface::new(10, 2, CellMetrics::default());
        let mut items = mount_node(
            2,
            ViewKind::View,
            ROOT_ID,
            Bounds::new(
                Point::new(Points::ZERO, Points::ZERO),
                Size::new(px(80.0), px(32.0)),
            ),
        );
        items.push(MountItem::ViewProps {
            id: 2,
            props: Box::new(nsh_core::ViewProps {
                accessibility: nsh_core::Accessibility {
                    role: AccessibilityRole::Button,
                    ..nsh_core::Accessibility::default()
                },
                ..nsh_core::ViewProps::default()
            }),
        });
        items.push(MountItem::ViewStyle {
            id: 2,
            style: Box::new(ViewStyle {
                effects: Some(Arc::new(nsh_core::Effects {
                    filters: vec![nsh_core::Filter::Brightness(1.0)],
                    ..nsh_core::Effects::default()
                })),
                ..ViewStyle::default()
            }),
        });
        items.extend(mount_node(
            4,
            ViewKind::Text,
            2,
            Bounds::new(
                Point::new(Points::ZERO, Points::ZERO),
                Size::new(px(40.0), px(16.0)),
            ),
        ));
        let mut text = nsh_core::AttributedText::default();
        text.push("Focus", ResolvedTextStyle::default());
        let engine = crate::TerminalTextEngine::default();
        items.push(MountItem::Text {
            id: 4,
            layout: engine.layout(&engine.prepare(&text), Size::new(px(40.0), px(16.0))),
            text: Arc::new(text),
            content: Bounds::new(
                Point::new(Points::ZERO, Points::ZERO),
                Size::new(px(40.0), px(16.0)),
            ),
        });
        surface.apply(MountBatch { items });
        let area = CellRect::new(0, 0, 10, 2);
        let ids = surface.paint_ids();
        let plans = surface.composite_plans(&ids, area);
        surface.focus = None;
        let plain = surface
            .composite_scene(&plans[0], &ids, area, &white_buffer(area))
            .unwrap();
        surface.focus = Some(2);
        let focused = surface
            .composite_scene(&plans[0], &ids, area, &white_buffer(area))
            .unwrap();
        let plain = crate::composite::rasterize(&plain, &surface.fonts).unwrap();
        let focused = crate::composite::rasterize(&focused, &surface.fonts).unwrap();
        let column = (0..40)
            .find(|&x| plain.rgba[(15 * plain.width as usize + x) * 4..][..3] == [255; 3])
            .expect("the plain label has a gap on its last pixel row");
        let index = (15 * focused.width as usize + column) * 4;
        assert_eq!(&focused.rgba[index..index + 3], &[0; 3]);
    }

    #[test]
    fn refresh_feedback_stays_visible_without_indicators() {
        let mut refresh = Surface::new(20, 6, CellMetrics::default());
        refresh.apply(MountBatch {
            items: mount_node(
                2,
                ViewKind::Scroll,
                ROOT_ID,
                Bounds::new(
                    Point::new(Points::ZERO, Points::ZERO),
                    Size::new(px(160.0), px(96.0)),
                ),
            ),
        });
        let scroll = &mut refresh.node_mut(2).unwrap().scroll;
        scroll.shows_indicator = false;
        scroll.physics.refreshing = true;
        scroll.y = px(-48.0);
        refresh.focus = None;
        assert!(refresh.snapshot().contains("Refreshing"));
        refresh
            .node_mut(2)
            .unwrap()
            .scroll
            .behavior
            .refresh_indicator = Some(px(100.0));
        assert!(!refresh.snapshot().contains("Refreshing"));
    }

    #[test]
    fn embedded_surface_preserves_host_cells_and_clips_scrolled_text() {
        let mut surface = Surface::new(8, 3, CellMetrics::default());
        let mut items = mount_node(
            2,
            ViewKind::Scroll,
            ROOT_ID,
            Bounds::new(Point::new(px(8.0), px(16.0)), Size::new(px(32.0), px(16.0))),
        );
        items.push(MountItem::ScrollContent {
            id: 2,
            size: Size::new(px(64.0), px(16.0)),
        });
        items.extend(mount_node(
            4,
            ViewKind::Text,
            2,
            Bounds::new(Point::new(px(0.0), px(0.0)), Size::new(px(64.0), px(16.0))),
        ));
        let mut text = nsh_core::AttributedText::default();
        text.push("abcdefgh", ResolvedTextStyle::default());
        let engine = crate::TerminalTextEngine::default();
        let layout = engine.layout(&engine.prepare(&text), Size::new(px(64.0), px(16.0)));
        items.push(MountItem::Text {
            id: 4,
            text: Arc::new(text),
            layout,
            content: Bounds::new(Point::new(px(0.0), px(0.0)), Size::new(px(64.0), px(16.0))),
        });
        surface.apply(MountBatch { items });
        surface.node_mut(2).unwrap().scroll.shows_indicator = false;
        surface.scroll_to(2, px(8.0), px(0.0));
        surface.focus = None;
        let mut buffer = Buffer::empty(CellRect::new(0, 0, 12, 5));
        for cell in &mut buffer.content {
            cell.set_symbol("#");
        }
        surface.render(CellRect::new(2, 1, 8, 3), &mut buffer);
        assert_eq!(buffer[(0, 0)].symbol(), "#");
        assert_eq!(buffer[(10, 2)].symbol(), "#");
        assert_eq!(buffer[(2, 2)].symbol(), " ");
        assert_eq!(buffer[(3, 2)].symbol(), "b");
        assert_eq!(buffer[(6, 2)].symbol(), "e");
        assert_eq!(buffer[(7, 2)].symbol(), " ");
    }

    #[test]
    fn input_keeps_caret_visible_and_masks_selected_password_graphemes() {
        let mut surface = Surface::new(6, 1, CellMetrics::default());
        let mut items = mount_node(
            2,
            ViewKind::Input,
            ROOT_ID,
            Bounds::new(Point::new(px(0.0), px(0.0)), Size::new(px(48.0), px(16.0))),
        );
        items.push(MountItem::InputValue {
            id: 2,
            text: "ab中cdef".into(),
            count: 0,
        });
        surface.apply(MountBatch { items });
        surface.focus = Some(2);
        let mut buffer = Buffer::empty(CellRect::new(0, 0, 6, 1));
        surface.render(buffer.area, &mut buffer);
        assert_eq!(buffer[(1, 0)].symbol(), "c");
        assert_eq!(buffer[(4, 0)].symbol(), "f");
        assert!(buffer[(5, 0)].modifier.contains(Modifier::REVERSED));
        assert_eq!(
            surface.input_cursor_position(buffer.area),
            Some(CellPosition::new(5, 0))
        );
        assert_eq!(
            surface.input_cursor_position(CellRect::new(7, 3, 6, 1)),
            Some(CellPosition::new(12, 3))
        );
        surface.selection(2, 0, 0);
        surface.render(buffer.area, &mut buffer);
        let node = surface.node_mut(2).unwrap();
        node.input.secure = true;
        node.input.selection_color = Some(Color(0xff00_00ff));
        surface.selection(2, 2, 3);
        surface.render(buffer.area, &mut buffer);
        assert_eq!(buffer[(2, 0)].symbol(), "•");
        assert_eq!(buffer[(2, 0)].bg, CellColor::Rgb(255, 0, 0));
        assert!(buffer[(3, 0)].modifier.contains(Modifier::REVERSED));
        assert!(buffer.content.iter().all(|c| !c.symbol().contains('中')));
        assert_eq!(
            surface.input_cursor_position(buffer.area),
            Some(CellPosition::new(3, 0))
        );
        surface.node_mut(2).unwrap().input.caret_hidden = true;
        assert_eq!(
            surface.input_cursor_position(buffer.area),
            Some(CellPosition::new(3, 0))
        );
        surface.node_mut(2).unwrap().input.editable = false;
        assert_eq!(surface.input_cursor_position(buffer.area), None);
    }

    #[test]
    fn input_cursor_follows_the_composed_editor_and_ancestor_clip() {
        let mut surface = Surface::new(12, 6, CellMetrics::default());
        let mut items = mount_node(
            2,
            ViewKind::Scroll,
            ROOT_ID,
            Bounds::new(
                Point::new(px(16.0), px(16.0)),
                Size::new(px(48.0), px(32.0)),
            ),
        );
        items.extend(mount_node(
            4,
            ViewKind::Input,
            2,
            Bounds::new(Point::default(), Size::new(px(48.0), px(32.0))),
        ));
        items.push(MountItem::Input {
            id: 4,
            config: Box::new(nsh_core::InputConfig {
                multiline: true,
                ..nsh_core::InputConfig::default()
            }),
        });
        items.push(MountItem::InputValue {
            id: 4,
            text: "one\ntwo\n三四\nfive".into(),
            count: 0,
        });
        surface.apply(MountBatch { items });
        surface.focus = Some(4);
        let input = surface.node_mut(4).unwrap();
        input.style.border_radius = px(4.0);
        input
            .style
            .transform
            .push(nsh_core::TransformKind::TranslateX, 8.0);
        let area = CellRect::new(0, 0, 12, 6);
        let mut buffer = Buffer::empty(area);
        surface.render(area, &mut buffer);
        assert_eq!(
            surface.input_cursor_position(area),
            Some(CellPosition::new(7, 2))
        );
        surface.node_mut(2).unwrap().scroll.y = px(16.0);
        assert_eq!(
            surface.input_cursor_position(area),
            Some(CellPosition::new(7, 1))
        );
        surface.node_mut(2).unwrap().scroll.y = px(48.0);
        assert_eq!(surface.input_cursor_position(area), None);
        surface.node_mut(2).unwrap().scroll.y = px(0.0);
        surface.resize(6, 3);
        assert_eq!(
            surface.input_cursor_position(CellRect::new(0, 0, 6, 3)),
            None
        );
        surface.resize(12, 6);
        let input = surface.node_mut(4).unwrap();
        input.style.transform = nsh_core::Transform::IDENTITY;
        input
            .style
            .transform
            .push(nsh_core::TransformKind::ScaleX, -1.0);
        assert_eq!(
            surface.input_cursor_position(area),
            Some(CellPosition::new(3, 2))
        );
        surface.focus = None;
        assert_eq!(surface.input_cursor_position(area), None);
    }

    #[test]
    fn screens_cover_presenters_while_dialog_layers_preserve_their_pixels() {
        for (kind, expected) in [
            (ViewKind::Screen, CellColor::Rgb(255, 255, 255)),
            (ViewKind::Modal, CellColor::Rgb(0, 0, 255)),
        ] {
            let mut surface = Surface::new(8, 4, CellMetrics::default());
            let frame = Bounds::new(Point::default(), Size::new(px(64.0), px(64.0)));
            let mut items = mount_node(2, ViewKind::View, ROOT_ID, frame);
            items.push(MountItem::ViewStyle {
                id: 2,
                style: Box::new(ViewStyle {
                    background_color: Color(0x0000_ffff),
                    ..ViewStyle::default()
                }),
            });
            items.extend(mount_node(4, kind, ROOT_ID, frame));
            surface.apply(MountBatch { items });
            surface.focus = None;
            let area = CellRect::new(0, 0, 8, 4);
            let mut buffer = Buffer::empty(area);
            surface.render(area, &mut buffer);
            assert!(buffer.content.iter().all(|cell| cell.bg == expected));
        }
    }

    #[test]
    fn a_modal_covers_presenter_scroll_indicators() {
        let mut surface = Surface::new(8, 4, CellMetrics::default());
        let mut items = mount_node(
            2,
            ViewKind::Scroll,
            ROOT_ID,
            Bounds::new(Point::new(px(0.0), px(0.0)), Size::new(px(64.0), px(64.0))),
        );
        items.push(MountItem::ScrollContent {
            id: 2,
            size: Size::new(px(64.0), px(640.0)),
        });
        items.extend(mount_node(
            4,
            ViewKind::Modal,
            ROOT_ID,
            Bounds::new(Point::new(px(0.0), px(0.0)), Size::new(px(64.0), px(64.0))),
        ));
        items.push(MountItem::ViewStyle {
            id: 4,
            style: Box::new(ViewStyle {
                background_color: Color(0x00ff_00ff),
                ..ViewStyle::default()
            }),
        });
        surface.apply(MountBatch { items });
        surface.focus = None;
        let mut buffer = Buffer::empty(CellRect::new(0, 0, 8, 4));
        surface.render(buffer.area, &mut buffer);
        assert!(
            buffer
                .content
                .iter()
                .all(|c| c.symbol() == " " && c.bg == CellColor::Rgb(0, 255, 0))
        );
    }

    #[test]
    fn right_aligned_multiline_input_draws_and_hits_each_visual_line() {
        use crossterm::event::{Event, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
        let mut surface = Surface::new(10, 3, CellMetrics::default());
        let mut items = mount_node(
            2,
            ViewKind::Input,
            ROOT_ID,
            Bounds::new(Point::new(px(0.0), px(0.0)), Size::new(px(80.0), px(48.0))),
        );
        items.push(MountItem::Input {
            id: 2,
            config: Box::new(nsh_core::InputConfig {
                multiline: true,
                align: TextAlign::Right,
                ..nsh_core::InputConfig::default()
            }),
        });
        items.push(MountItem::InputValue {
            id: 2,
            text: "ab\n中".into(),
            count: 0,
        });
        surface.apply(MountBatch { items });
        surface.focus = Some(2);
        let mut buffer = Buffer::empty(CellRect::new(0, 0, 10, 3));
        surface.render(buffer.area, &mut buffer);
        assert_eq!(buffer[(8, 0)].symbol(), "a");
        assert_eq!(buffer[(9, 0)].symbol(), "b");
        assert_eq!(buffer[(7, 1)].symbol(), "中");
        assert!(buffer[(9, 1)].modifier.contains(Modifier::REVERSED));
        assert_eq!(
            surface.input_cursor_position(buffer.area),
            Some(CellPosition::new(9, 1))
        );
        for kind in [
            MouseEventKind::Down(MouseButton::Left),
            MouseEventKind::Up(MouseButton::Left),
        ] {
            surface.handle_event(Event::Mouse(MouseEvent {
                kind,
                column: 9,
                row: 0,
                modifiers: KeyModifiers::NONE,
            }));
        }
        assert_eq!(surface.node(2).unwrap().editor.selection(), (1, 1));
        surface.render(buffer.area, &mut buffer);
        assert!(buffer[(9, 0)].modifier.contains(Modifier::REVERSED));
        assert_eq!(
            surface.input_cursor_position(buffer.area),
            Some(CellPosition::new(9, 0))
        );
        for kind in [
            MouseEventKind::Down(MouseButton::Left),
            MouseEventKind::Up(MouseButton::Left),
        ] {
            assert!(surface.handle_event(Event::Mouse(MouseEvent {
                kind,
                column: 9,
                row: 1,
                modifiers: KeyModifiers::NONE,
            })));
        }
        assert_eq!(surface.node(2).unwrap().editor.selection(), (3, 3));
    }

    #[test]
    fn nested_modal_uses_viewport_scene_above_later_presenter_siblings() {
        let mut surface = Surface::new(12, 6, CellMetrics::default());
        let viewport = Bounds::new(Point::new(px(0.0), px(0.0)), Size::new(px(96.0), px(96.0)));
        let mut items = mount_node(
            2,
            ViewKind::Scroll,
            ROOT_ID,
            Bounds::new(
                Point::new(px(16.0), px(16.0)),
                Size::new(px(32.0), px(32.0)),
            ),
        );
        items.push(MountItem::ScrollContent {
            id: 2,
            size: Size::new(px(160.0), px(160.0)),
        });
        items.extend(mount_node(
            4,
            ViewKind::View,
            2,
            Bounds::new(Point::new(px(8.0), px(8.0)), Size::new(px(16.0), px(16.0))),
        ));
        items.push(MountItem::ViewStyle {
            id: 4,
            style: Box::new(ViewStyle {
                overflow_hidden: true,
                opacity: 0.5,
                ..ViewStyle::default()
            }),
        });
        items.extend(mount_node(6, ViewKind::Modal, 4, viewport));
        items.push(MountItem::ViewStyle {
            id: 6,
            style: Box::new(ViewStyle {
                background_color: Color(0x00ff_00ff),
                ..ViewStyle::default()
            }),
        });
        items.extend(mount_node(
            8,
            ViewKind::Text,
            6,
            Bounds::new(Point::new(px(8.0), px(16.0)), Size::new(px(80.0), px(16.0))),
        ));
        let mut text = nsh_core::AttributedText::default();
        text.push("Modal", ResolvedTextStyle::default());
        let engine = crate::TerminalTextEngine::default();
        let layout = engine.layout(&engine.prepare(&text), Size::new(px(80.0), px(16.0)));
        items.push(MountItem::Text {
            id: 8,
            text: Arc::new(text),
            layout,
            content: Bounds::new(Point::new(px(0.0), px(0.0)), Size::new(px(80.0), px(16.0))),
        });
        items.extend(mount_node(10, ViewKind::View, ROOT_ID, viewport));
        items.push(MountItem::ViewStyle {
            id: 10,
            style: Box::new(ViewStyle {
                background_color: Color(0xff00_00ff),
                ..ViewStyle::default()
            }),
        });
        surface.apply(MountBatch { items });
        surface.scroll_to(2, px(8.0), px(16.0));
        surface.focus = None;
        let mut buffer = Buffer::empty(CellRect::new(0, 0, 12, 6));
        surface.render(buffer.area, &mut buffer);
        assert_eq!(surface.global_frame(6), Some(viewport));
        assert_eq!(surface.clip_rect(6), viewport);
        assert_eq!(buffer[(1, 1)].symbol(), "M");
        assert!(
            buffer
                .content
                .iter()
                .all(|cell| cell.bg == CellColor::Rgb(0, 255, 0))
        );
        assert_eq!(surface.visible_ids(), vec![6, 8]);
        assert_eq!(surface.hit_test(12.0, 24.0), Some(8));
    }

    #[test]
    fn focus_ring_preserves_labels_that_share_a_snapped_border_cell() {
        let mut surface = Surface::new(10, 4, CellMetrics::default());
        let mut items = mount_node(
            2,
            ViewKind::View,
            ROOT_ID,
            Bounds::new(Point::new(px(0.0), px(0.0)), Size::new(px(80.0), px(64.0))),
        );
        items.push(MountItem::ViewStyle {
            id: 2,
            style: Box::new(ViewStyle {
                border_radius: px(8.0),
                borders: nsh_core::Borders {
                    widths: Edges::all(px(1.0)),
                    colors: [Color::BLACK; 4],
                    style: BorderStyle::Solid,
                },
                ..ViewStyle::default()
            }),
        });
        items.extend(mount_node(
            6,
            ViewKind::View,
            2,
            Bounds::new(Point::new(px(1.0), px(1.0)), Size::new(px(78.0), px(62.0))),
        ));
        items.push(MountItem::ViewStyle {
            id: 6,
            style: Box::new(ViewStyle {
                background_color: Color(0x00ff_00ff),
                ..ViewStyle::default()
            }),
        });
        items.extend(mount_node(
            4,
            ViewKind::Text,
            2,
            Bounds::new(Point::new(px(0.0), px(4.0)), Size::new(px(80.0), px(16.0))),
        ));
        let mut text = nsh_core::AttributedText::default();
        text.push("中 press", ResolvedTextStyle::default());
        let engine = crate::TerminalTextEngine::default();
        let layout = engine.layout(&engine.prepare(&text), Size::new(px(80.0), px(16.0)));
        items.push(MountItem::Text {
            id: 4,
            text: Arc::new(text),
            layout,
            content: Bounds::new(Point::new(px(0.0), px(0.0)), Size::new(px(80.0), px(16.0))),
        });
        surface.apply(MountBatch { items });
        surface.focus = Some(2);
        let mut buffer = Buffer::empty(CellRect::new(0, 0, 10, 4));
        surface.focus = None;
        surface.render(buffer.area, &mut buffer);
        assert_eq!(buffer[(9, 2)].symbol(), "│");
        assert_eq!(buffer[(5, 3)].symbol(), "─");
        surface.focus = Some(2);
        surface.render(buffer.area, &mut buffer);
        assert_eq!(buffer[(0, 0)].symbol(), "中");
        assert_eq!(buffer[(1, 0)].symbol(), " ");
        assert_eq!(buffer[(2, 0)].symbol(), " ");
        assert_eq!(buffer[(3, 0)].symbol(), "p");
        assert!(buffer[(0, 0)].modifier.contains(Modifier::UNDERLINED));
    }

    #[test]
    fn center_images_use_logical_asset_size_and_keep_the_nodes_clip() {
        let mut surface = Surface::new(10, 4, CellMetrics::default());
        surface.apply(MountBatch {
            items: mount_node(
                2,
                ViewKind::Image,
                ROOT_ID,
                Bounds::new(Point::new(px(8.0), px(0.0)), Size::new(px(64.0), px(64.0))),
            ),
        });
        let source = nsh_core::ImageSource {
            uri: Arc::from("asset:/photo@2x.png"),
            scales: nsh_core::ImageScales::NONE,
            data: None,
            size: Some(Size::new(px(16.0), px(32.0))),
        };
        let frame = Bounds::new(Point::new(px(8.0), px(0.0)), Size::new(px(64.0), px(64.0)));
        let (image, clip, mode) = image_geometry(
            &source,
            &crate::image::Raster {
                width: 32,
                height: 64,
                rgba: Vec::new(),
            },
            ResizeMode::Center,
            ObjectPosition::CENTER,
            Size::new(px(64.0), px(64.0)),
            frame,
            Bounds::new(Point::new(px(0.0), px(0.0)), Size::new(px(80.0), px(64.0))),
        );
        assert_eq!(
            image,
            Bounds::new(
                Point::new(px(32.0), px(16.0)),
                Size::new(px(16.0), px(32.0))
            )
        );
        assert_eq!(clip, frame);
        assert_eq!(mode, ResizeMode::Stretch);
        for (natural, expected) in [
            (Size::new(px(16.0), px(32.0)), Size::new(px(16.0), px(32.0))),
            (
                Size::new(px(128.0), px(64.0)),
                Size::new(px(64.0), px(32.0)),
            ),
        ] {
            let source = nsh_core::ImageSource {
                size: Some(natural),
                ..source.clone()
            };
            let (image, clip, mode) = image_geometry(
                &source,
                &crate::image::Raster {
                    width: 256,
                    height: 128,
                    rgba: Vec::new(),
                },
                ResizeMode::ScaleDown,
                ObjectPosition::CENTER,
                frame.size,
                frame,
                frame,
            );
            assert_eq!(image.size, expected);
            assert_eq!(clip, frame);
            assert_eq!(mode, ResizeMode::Stretch);
        }
    }

    #[test]
    fn image_positions_keep_default_fits_and_crop_covering_pixels() {
        let source = nsh_core::ImageSource::default();
        let raster = Arc::new(crate::image::Raster {
            width: 8,
            height: 32,
            rgba: (0..32)
                .flat_map(|y| {
                    std::iter::repeat_n(
                        if y < 16 {
                            [255, 0, 0, 255]
                        } else {
                            [0, 0, 255, 255]
                        },
                        8,
                    )
                    .flatten()
                })
                .collect(),
        });
        let frame = Bounds::new(Point::default(), Size::new(px(8.0), px(16.0)));
        for mode in [
            ResizeMode::Cover,
            ResizeMode::Contain,
            ResizeMode::Center,
            ResizeMode::ScaleDown,
            ResizeMode::Stretch,
        ] {
            let (image, clip, fitted) = image_geometry(
                &source,
                &raster,
                mode,
                ObjectPosition::CENTER,
                frame.size,
                frame,
                frame,
            );
            assert_eq!(image, crate::image::fitted_frame(&raster, frame, mode));
            assert_eq!(clip, frame);
            assert_eq!(fitted, ResizeMode::Stretch);
        }
        let area = CellRect::new(0, 0, 1, 1);
        let buffer = Buffer::empty(area);
        let mut requests = Vec::new();
        for (position, y, color) in [("top", 0.0, [255, 0, 0]), ("bottom", -16.0, [0, 0, 255])] {
            let (image, clip, mode) = image_geometry(
                &source,
                &raster,
                ResizeMode::Cover,
                ObjectPosition::parse(position).unwrap(),
                frame.size,
                frame,
                frame,
            );
            assert_eq!(image.origin.y, px(y));
            assert_eq!(clip, frame);
            let mut painted = buffer.clone();
            crate::image::paint(
                &raster,
                image,
                clip,
                mode,
                None,
                1.0,
                CellMetrics::default(),
                area,
                &mut painted,
            );
            let pixels = crate::text::rasterize_cells(
                &painted,
                CellMetrics::default(),
                &crate::fonts::FontCatalog::default(),
            )
            .unwrap();
            assert!(
                pixels
                    .rgba
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .all(|pixel| pixel[..3] == color)
            );
            requests.push(
                crate::protocol::Request::capture(
                    raster.clone(),
                    crate::ImageProtocol::new(crate::ProtocolType::Kitty, 8, 16).unwrap(),
                    image,
                    clip,
                    mode,
                    None,
                    1.0,
                    CellMetrics::default(),
                    area,
                    &buffer,
                )
                .unwrap(),
            );
        }
        // Both crops cover the same cells but must produce different cached encodings.
        assert!(requests[0] != requests[1]);
        let frame = Bounds::new(Point::default(), Size::new(px(32.0), px(32.0)));
        for (position, x) in [("left", 0.0), ("right", 24.0)] {
            let (image, clip, _) = image_geometry(
                &source,
                &raster,
                ResizeMode::Contain,
                ObjectPosition::parse(position).unwrap(),
                frame.size,
                frame,
                frame,
            );
            assert_eq!(image.origin.x, px(x));
            assert_eq!(image.size, Size::new(px(8.0), px(32.0)));
            assert_eq!(clip, frame);
        }
        let zoomed = Bounds::new(Point::default(), Size::new(px(64.0), px(64.0)));
        let (image, clip, _) = image_geometry(
            &source,
            &raster,
            ResizeMode::Contain,
            ObjectPosition::parse("right 2px bottom 0px").unwrap(),
            frame.size,
            zoomed,
            zoomed,
        );
        assert_eq!(image.origin.x, px(44.0));
        assert_eq!(clip, zoomed);
    }

    #[test]
    fn image_position_updates_reuse_loaded_layers_and_reposition_composite_snapshots() {
        let mut surface = Surface::new(10, 4, CellMetrics::default());
        let frame = Bounds::new(Point::default(), Size::new(px(32.0), px(32.0)));
        surface.apply(MountBatch {
            items: mount_node(2, ViewKind::Image, ROOT_ID, frame),
        });
        let source = nsh_core::ImageSource {
            uri: "asset:/main".into(),
            ..Default::default()
        };
        let mut options = nsh_core::ImageOptions {
            placeholder: Some(nsh_core::ImageSource {
                uri: "asset:/placeholder".into(),
                ..Default::default()
            }),
            fade_ms: Some(200.0),
            ..Default::default()
        };
        let state = &mut surface.node_mut(2).unwrap().image;
        let requests = state.update(
            Some(source.clone()),
            ResizeMode::Contain,
            options.clone(),
            0.0,
        );
        for request in requests.iter().rev() {
            assert!(state.install(
                request,
                Arc::new(crate::image::AnimatedRaster {
                    frames: vec![Arc::new(crate::image::Raster {
                        width: 8,
                        height: 32,
                        rgba: vec![255; 8 * 32 * 4],
                    })],
                    delays: Vec::new(),
                    plays: 1,
                }),
                0.0
            ));
        }
        let before = surface.composite_layer(2, &[2], 0).unwrap();
        assert_eq!(before.images.len(), 2);
        options.position = ObjectPosition::parse("right").unwrap();
        assert!(
            surface
                .node_mut(2)
                .unwrap()
                .image
                .update(Some(source), ResizeMode::Contain, options, 0.1,)
                .is_empty()
        );
        let after = surface.composite_layer(2, &[2], 0).unwrap();
        assert_eq!(after.images.len(), 2);
        assert!(after.style.overflow_hidden);
        for (before, after) in before.images.iter().zip(&after.images) {
            assert_eq!(before.frame.origin.x, px(12.0));
            assert_eq!(after.frame.origin.x, px(24.0));
            assert!(Arc::ptr_eq(&before.raster, &after.raster));
            assert!(before != after);
        }
    }

    #[test]
    fn partially_offscreen_geometry_does_not_move_its_far_edge() {
        let metrics = CellMetrics::default();
        let area = CellRect::new(7, 3, 10, 4);
        assert_eq!(
            cells(
                Bounds::new(
                    Point::new(px(-16.0), px(0.0)),
                    Size::new(px(24.0), px(16.0))
                ),
                metrics,
                area
            ),
            CellRect::new(7, 3, 1, 1)
        );
        assert_eq!(
            cells(
                Bounds::new(Point::new(px(0.0), px(-32.0)), Size::new(px(8.0), px(16.0))),
                metrics,
                area
            )
            .height,
            0
        );
    }

    #[test]
    fn borders_preserve_per_side_colors_and_clip() {
        let mut buffer = Buffer::empty(CellRect::new(0, 0, 8, 4));
        stroke(
            &mut buffer,
            CellRect::new(0, 0, 8, 4),
            CellRect::new(1, 0, 6, 4),
            [true; 4],
            [
                Color(0xff00_00ff),
                Color::BLACK,
                Color(0x0000_ffff),
                Color::BLACK,
            ],
            BorderStyle::Solid,
            [true; 4],
            1.0,
        );
        assert_eq!(buffer[(0, 0)].symbol(), " ");
        assert_eq!(buffer[(1, 0)].symbol(), "─");
        assert_eq!(buffer[(1, 0)].fg, CellColor::Rgb(255, 0, 0));
        assert_eq!(buffer[(1, 3)].fg, CellColor::Rgb(0, 0, 255));
    }

    #[test]
    fn nested_alpha_and_color_filters_are_finite() {
        assert_eq!(
            blend(
                Color(0xff00_0080),
                CellColor::Rgb(0, 0, 255),
                0.5,
                BlendMode::Normal
            ),
            CellColor::Rgb(64, 0, 191)
        );
        let matrix = nsh_core::compose_color_matrices(&[nsh_core::Filter::Invert(1.0)]).unwrap();
        assert_eq!(
            filter_color(Color(0xff00_00ff), Some(&matrix)),
            Color(0x00ff_ffff)
        );
        assert_eq!(
            over_color(Color(0xff00_0080), Color(0x0000_ffff)),
            Color(0x8000_7fff)
        );
    }

    #[test]
    fn gradient_samples_follow_css_direction() {
        let gradient = Gradient {
            kind: GradientKind::Linear {
                angle: nsh_core::geometry::deg(90.0),
            },
            stops: vec![
                nsh_core::ColorStop {
                    color: Color(0xff00_00ff),
                    position: None,
                },
                nsh_core::ColorStop {
                    color: Color(0x0000_ffff),
                    position: None,
                },
            ],
            repeating: false,
        };
        let stops = gradient.resolved_stops(Size::new(px(80.0), px(16.0)));
        assert_eq!(
            gradient_color(&gradient, &stops, 0.0, 8.0, 80.0, 16.0),
            Color(0xff00_00ff)
        );
        assert_eq!(
            gradient_color(&gradient, &stops, 80.0, 8.0, 80.0, 16.0),
            Color(0x0000_ffff)
        );
    }

    #[test]
    fn wide_graphemes_are_never_half_drawn_or_allowed_to_escape_clip() {
        let mut buffer = Buffer::empty(CellRect::new(0, 0, 8, 2));
        write_text(
            &mut buffer,
            0,
            0,
            3,
            "中中",
            CellRect::new(0, 0, 3, 1),
            Color::BLACK,
            1.0,
            Modifier::empty(),
        );
        assert_eq!(buffer[(0, 0)].symbol(), "中");
        assert_eq!(buffer[(2, 0)].symbol(), " ");
        write_text(
            &mut buffer,
            0,
            1,
            8,
            "a\x1b[31m",
            CellRect::new(0, 0, 8, 2),
            Color::BLACK,
            1.0,
            Modifier::empty(),
        );
        assert!(
            buffer
                .content
                .iter()
                .all(|cell| !cell.symbol().contains('\x1b'))
        );
    }

    #[test]
    fn dialog_layout_survives_small_embedding_areas() {
        let mut buffer = Buffer::empty(CellRect::new(0, 0, 12, 6));
        let dialog = Dialog {
            id: 1,
            title: Some("Delete 中文?".into()),
            message: Some("Confirm\nthis operation".into()),
            buttons: vec![
                nsh_core::DialogButton {
                    text: "Cancel".into(),
                    style: DialogButtonStyle::Cancel,
                },
                nsh_core::DialogButton {
                    text: "Delete".into(),
                    style: DialogButtonStyle::Destructive,
                },
            ],
            cancelable: true,
            sheet: false,
        };
        paint_dialog(&dialog, 1, false, CellRect::new(2, 1, 8, 4), &mut buffer);
        assert_eq!(buffer[(0, 0)].symbol(), " ");
        assert!(buffer.content.iter().any(|c| c.symbol() == "›"));
    }
}

#[cfg(test)]
mod native_color_tests {
    use std::sync::Arc;

    use nsh_core::{
        MountBatch, MountItem, ROOT_ID, ResolvedTextStyle, TextEngine,
        animation::{AnimationOp, AnimationProp, Easing, Extrapolate, Output},
    };

    use super::*;

    #[test]
    fn native_text_colors_repaint_without_new_text_or_layout() {
        let mut surface = Surface::new(4, 2, CellMetrics::default());
        let mut text = nsh_core::AttributedText::default();
        text.push("color", ResolvedTextStyle::default());
        let engine = crate::TerminalTextEngine::default();
        let layout = engine.layout(&engine.prepare(&text), Size::new(px(40.0), px(16.0)));
        surface.apply(MountBatch {
            items: vec![
                MountItem::Create {
                    id: 2,
                    kind: ViewKind::Text,
                },
                MountItem::Frame {
                    id: 2,
                    frame: Bounds::new(
                        Point::new(Points::ZERO, Points::ZERO),
                        Size::new(px(40.0), px(16.0)),
                    ),
                },
                MountItem::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
                MountItem::Text {
                    id: 2,
                    text: Arc::new(text),
                    layout,
                    content: Bounds::new(
                        Point::new(Points::ZERO, Points::ZERO),
                        Size::new(px(40.0), px(16.0)),
                    ),
                },
                MountItem::Animation(AnimationOp::CreateValue {
                    node: 1,
                    value: 0.0,
                }),
                MountItem::Animation(AnimationOp::CreateInterpolate {
                    node: 2,
                    input: 1,
                    input_range: vec![0.0, 1.0],
                    output: Output::Colors(vec![0xff0000ff, 0x0000ffff]),
                    extrapolate_left: Extrapolate::Clamp,
                    extrapolate_right: Extrapolate::Clamp,
                    easing: Easing::Linear,
                }),
                MountItem::AnimationBindings {
                    id: 2,
                    bindings: vec![(AnimationProp::Color, 2)],
                },
            ],
        });
        let mut buffer = Buffer::empty(CellRect::new(0, 0, 4, 2));
        surface.render(buffer.area, &mut buffer);
        assert_eq!(buffer[(0, 0)].symbol(), "c");
        assert_eq!(buffer[(0, 0)].fg, CellColor::Rgb(255, 0, 0));
        surface.apply(MountBatch {
            items: vec![MountItem::Animation(AnimationOp::Set {
                node: 1,
                value: 1.0,
            })],
        });
        surface.render(buffer.area, &mut buffer);
        assert_eq!(buffer[(0, 0)].symbol(), "c");
        assert_eq!(buffer[(0, 0)].fg, CellColor::Rgb(0, 0, 255));
    }
}

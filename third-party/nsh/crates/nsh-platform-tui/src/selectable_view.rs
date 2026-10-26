/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Cross-view mouse selection, using the same model as the desktop backend.

use std::collections::HashMap;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use nsh_core::{
    Bounds, EventKind, NodeId, Point, Points, Size, ViewKind,
    geometry::px,
    selection::{SelectionModel, SelectionTexts},
};

use crate::surface::Surface;

pub(crate) struct SelectableView {
    area: NodeId,
    generation: u64,
    model: SelectionModel,
    ranges: HashMap<NodeId, (u32, u32)>,
    ticked: f64,
    dragging: bool,
}

struct Texts<'a> {
    surface: &'a Surface,
    texts: Vec<(NodeId, Bounds<Points>)>,
}

impl<'a> Texts<'a> {
    fn of(surface: &'a Surface, area: NodeId) -> Self {
        let mut texts = Vec::new();
        let mut pending = vec![area];
        while let Some(id) = pending.pop() {
            let Some(node) = surface.node(id) else {
                continue;
            };
            if node.style.hidden || node.delete_pending {
                continue;
            }
            if let Some((text, _, content)) = &node.text
                && text.selectable != Some(false)
                && let Some(matrix) = surface.local_to_surface(id)
            {
                let corners = [
                    (content.left().0, content.top().0),
                    (content.right().0, content.top().0),
                    (content.left().0, content.bottom().0),
                    (content.right().0, content.bottom().0),
                ];
                let points: Option<Vec<_>> = corners
                    .into_iter()
                    .map(|(x, y)| crate::geometry::project(&matrix, x, y))
                    .collect();
                if let Some(points) = points {
                    let left = points.iter().map(|p| p.0).fold(f32::INFINITY, f32::min);
                    let top = points.iter().map(|p| p.1).fold(f32::INFINITY, f32::min);
                    let right = points.iter().map(|p| p.0).fold(f32::NEG_INFINITY, f32::max);
                    let bottom = points.iter().map(|p| p.1).fold(f32::NEG_INFINITY, f32::max);
                    texts.push((
                        id,
                        Bounds::new(
                            Point::new(px(left), px(top)),
                            Size::new(px(right - left), px(bottom - top)),
                        ),
                    ));
                }
            }
            pending.extend(node.children.iter().rev().copied());
        }
        Self { surface, texts }
    }
}

impl SelectionTexts for Texts<'_> {
    fn len(&self) -> usize {
        self.texts.len()
    }
    fn content(&self, i: usize) -> &str {
        &self
            .surface
            .node(self.texts[i].0)
            .unwrap()
            .text
            .as_ref()
            .unwrap()
            .0
            .text
    }
    fn frame(&self, i: usize) -> Bounds<Points> {
        self.texts[i].1
    }
    fn offset_at(&self, i: usize, at: Point<Points>) -> u32 {
        self.surface
            .text_offset_at(self.texts[i].0, at.x.0, at.y.0)
            .unwrap_or(0)
    }
    fn key(&self, i: usize) -> u64 {
        self.surface.node(self.texts[i].0).unwrap().generation
    }
}

impl SelectableView {
    fn update(&mut self, texts: &Texts<'_>) {
        self.ranges = self
            .model
            .ranges(texts)
            .into_iter()
            .map(|(i, range)| (texts.texts[i].0, (range.start, range.end)))
            .collect();
    }
}

impl Surface {
    fn selectable_view_at(&self, target: NodeId) -> Option<NodeId> {
        let node = self.node(target)?;
        if node.kind == ViewKind::Input
            || node.native.is_some()
            || node.media.is_some()
            || node
                .text
                .as_ref()
                .is_some_and(|(text, ..)| text.selectable == Some(false))
        {
            return None;
        }
        let path = self.ancestors(target);
        let area = path
            .iter()
            .rev()
            .copied()
            .find(|&id| self.node(id).is_some_and(|n| n.props.selectable_view))?;
        for id in path {
            let node = self.node(id)?;
            if node.gestures.pan_x.is_some()
                || node.gestures.pan_y.is_some()
                || [EventKind::Touch, EventKind::PanStart, EventKind::PanEnd]
                    .into_iter()
                    .any(|kind| node.events.contains(kind))
            {
                return None;
            }
            if id == area {
                break;
            }
        }
        Some(area)
    }

    pub(crate) fn selectable_view_window_press(&mut self, target: Option<NodeId>) {
        if self.area_selection.as_ref().is_some_and(|active| {
            target.and_then(|target| self.selectable_view_at(target)) != Some(active.area)
        }) {
            self.area_selection = None;
        }
    }

    pub(crate) fn selectable_view_dragging(&self) -> bool {
        self.area_selection
            .as_ref()
            .is_some_and(|active| active.dragging)
    }

    pub(crate) fn selectable_view_press(
        &mut self,
        target: NodeId,
        x: f32,
        y: f32,
        extend: bool,
    ) -> bool {
        let Some(area) = self.selectable_view_at(target) else {
            self.area_selection = None;
            return false;
        };
        let generation = self.node(area).unwrap().generation;
        let mut active = self
            .area_selection
            .take()
            .filter(|active| active.area == area && active.generation == generation)
            .unwrap_or_else(|| SelectableView {
                area,
                generation,
                model: SelectionModel::default(),
                ranges: HashMap::new(),
                ticked: self.now,
                dragging: false,
            });
        let texts = Texts::of(self, area);
        active.model.texts_changed(&texts);
        active
            .model
            .press(&texts, Point::new(px(x), px(y)), 1, extend);
        active.update(&texts);
        active.ticked = self.now;
        active.dragging = true;
        self.area_selection = Some(active);
        true
    }

    pub(crate) fn selectable_view_drag(&mut self, x: f32, y: f32) -> bool {
        let Some(mut active) = self.area_selection.take() else {
            return false;
        };
        if !active.dragging {
            self.area_selection = Some(active);
            return false;
        }
        let texts = Texts::of(self, active.area);
        active.model.texts_changed(&texts);
        active.model.drag(&texts, Point::new(px(x), px(y)));
        active.update(&texts);
        let selected = !active.model.is_empty();
        self.area_selection = Some(active);
        selected
    }

    pub(crate) fn selectable_view_release(&mut self) {
        if let Some(active) = &mut self.area_selection {
            active.dragging = false;
        }
    }

    pub(crate) fn selectable_view_range(&self, id: NodeId) -> Option<(u32, u32)> {
        self.area_selection.as_ref()?.ranges.get(&id).copied()
    }

    pub(crate) fn selectable_view_owner(&self) -> Option<NodeId> {
        Some(self.area_selection.as_ref()?.area)
    }

    pub(crate) fn selectable_view_sync(&mut self) {
        let Some(mut active) = self.area_selection.take() else {
            return;
        };
        if !self
            .node(active.area)
            .is_some_and(|node| node.generation == active.generation && node.props.selectable_view)
        {
            return;
        }
        if !active.model.is_empty() {
            let texts = Texts::of(self, active.area);
            active.model.texts_changed(&texts);
            active.update(&texts);
        }
        self.area_selection = Some(active);
    }

    pub(crate) fn selectable_view_key(&mut self, key: KeyEvent) -> bool {
        let Some(mut active) = self.area_selection.take() else {
            return false;
        };
        let command = key
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::SUPER)
            && !key.modifiers.contains(KeyModifiers::ALT);
        let texts = Texts::of(self, active.area);
        let mut copy = None;
        let handled = match key.code {
            KeyCode::Char('c' | 'C') | KeyCode::Insert if command => {
                if !active.model.is_empty() {
                    copy = Some(active.model.text(&texts));
                    true
                } else {
                    self.empty_copy_consumed(key)
                }
            }
            KeyCode::Char('a' | 'A') if command => {
                active.model.select_all(&texts);
                active.update(&texts);
                true
            }
            KeyCode::Esc if !active.model.is_empty() => {
                active.model.clear();
                active.ranges.clear();
                active.dragging = false;
                true
            }
            _ => false,
        };
        self.area_selection = Some(active);
        if let Some(text) = copy {
            self.write_clipboard(text);
        }
        handled
    }

    fn selectable_view_scroll(&self) -> Option<(NodeId, f32, f32)> {
        let _active = self
            .area_selection
            .as_ref()
            .filter(|active| active.dragging)?;
        let pointer = self.pointer.as_ref().filter(|pointer| pointer.moved)?;
        for id in self.ancestors(pointer.target) {
            let Some(node) = self
                .node(id)
                .filter(|node| node.kind == ViewKind::Scroll && node.scroll.enabled)
            else {
                continue;
            };
            let frame = crate::surface::intersect(self.global_frame(id)?, self.clip_rect(id));
            let (x, y) = pointer.last;
            let outside = |at: f32, start: f32, end: f32| {
                if at < start {
                    at - start
                } else {
                    (at - end).max(0.0)
                }
            };
            let ((min_x, max_x), (min_y, max_y)) = crate::scroll::selection_limits(node);
            let delta = if node.scroll.horizontal {
                (outside(x, frame.left().0, frame.right().0), 0.0)
            } else {
                (0.0, outside(y, frame.top().0, frame.bottom().0))
            };
            let dx = if (delta.0 < 0.0 && node.scroll.x.0 > min_x)
                || (delta.0 > 0.0 && node.scroll.x.0 < max_x)
            {
                delta.0
            } else {
                0.0
            };
            let dy = if (delta.1 < 0.0 && node.scroll.y.0 > min_y)
                || (delta.1 > 0.0 && node.scroll.y.0 < max_y)
            {
                delta.1
            } else {
                0.0
            };
            if dx != 0.0 || dy != 0.0 {
                return Some((id, dx, dy));
            }
        }
        None
    }

    pub(crate) fn selectable_view_pending(&self) -> bool {
        self.selectable_view_scroll().is_some()
    }

    pub(crate) fn selectable_view_tick(&mut self) -> bool {
        let now = self.now;
        let elapsed = self
            .area_selection
            .as_mut()
            .map(|active| {
                let elapsed = (now - active.ticked).max(0.0) as f32;
                active.ticked = now;
                elapsed
            })
            .unwrap_or(0.0);
        let Some((id, dx, dy)) = self.selectable_view_scroll() else {
            return false;
        };
        let Some(node) = self.node(id) else {
            return false;
        };
        // Match desktop's half-distance every 16ms, independent of frame rate.
        let speed = elapsed * (0.5 / 0.016);
        self.scroll_to(
            id,
            px(node.scroll.x.0 + dx * speed),
            px(node.scroll.y.0 + dy * speed),
        );
        let Some(pointer) = &self.pointer else {
            return false;
        };
        self.selectable_view_drag(pointer.last.0, pointer.last.1);
        true
    }
}

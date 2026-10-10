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

//! The terminal's scrollbar: the kit's [`Scrollbar`] over the terminal's
//! box, driven by a handle that maps the scrollback to pixels. The content is
//! the scrollback over the screen, a line per row: at the bottom (display
//! offset 0) the thumb is at the end of its track, at the top of the
//! scrollback at its start. Dragging asks the terminal to scroll to the line
//! under the thumb; until a picture shows it, the thumb stays where it was
//! dragged.
//!
//! [`Scrollbar`]: gpui_kit::component::scroll::Scrollbar

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use gpui_kit::component::scroll::ScrollbarHandle;
use gpui_kit::{Bounds, Pixels, Point, Size, point, px, size};

use crate::TerminalContent;

#[derive(Debug, Default)]
struct ScrollState {
    /// The box the scrollbar overlays.
    viewport: Bounds<Pixels>,
    line_height: Pixels,
    /// Lines of scrollback, and how many of them are below the screen, as
    /// the last picture painted had them.
    history: usize,
    display_offset: usize,
    /// A display offset the scrollbar asked for, not sent yet.
    requested: Option<usize>,
    /// One sent, and the picture it was sent over: it shows until another
    /// picture arrives.
    awaiting: Option<(usize, usize)>,
}

/// The scrollbar's handle on the active terminal's scrollback. Clones share
/// one state: the view keeps one, the scrollbar another, the element writes
/// what it painted.
#[derive(Debug, Clone, Default)]
pub(crate) struct TerminalScroll(Rc<RefCell<ScrollState>>);

impl TerminalScroll {
    /// The box the scrollbar overlays, as laid out.
    pub(crate) fn set_viewport(&self, bounds: Bounds<Pixels>) {
        self.0.borrow_mut().viewport = bounds;
    }

    /// The picture being painted, with its line height. Returns the display
    /// offset the scrollbar was dragged to since the last picture, which the
    /// terminal is then asked to scroll to.
    pub(crate) fn painted(
        &self,
        content: &Arc<TerminalContent>,
        line_height: Pixels,
    ) -> Option<usize> {
        let picture = Arc::as_ptr(content) as usize;
        let mut state = self.0.borrow_mut();
        state.history = content.history_size;
        state.display_offset = content.display_offset;
        state.line_height = line_height;
        if state.awaiting.is_some_and(|(_, over)| over != picture) {
            state.awaiting = None;
        }
        let requested = state.requested.take()?;
        state.awaiting = Some((requested, picture));
        Some(requested)
    }

    /// The display offset the thumb shows: the one dragged to while it is on
    /// its way, or the painted one.
    pub(crate) fn display_offset(&self) -> usize {
        let state = self.0.borrow();
        state
            .requested
            .or(state.awaiting.map(|(offset, _)| offset))
            .unwrap_or(state.display_offset)
            .min(state.history)
    }
}

impl ScrollbarHandle for TerminalScroll {
    fn viewport_bounds(&self) -> Bounds<Pixels> {
        self.0.borrow().viewport
    }

    /// Scrolled from the top of the scrollback: 0 at its top, the whole
    /// scrollback's height (negative) at the bottom.
    fn offset(&self) -> Point<Pixels> {
        let shown = self.display_offset();
        let state = self.0.borrow();
        point(px(0.), -(state.line_height * (state.history - shown) as f32))
    }

    fn set_offset(&self, offset: Point<Pixels>) {
        let mut state = self.0.borrow_mut();
        if state.line_height <= px(0.) {
            return;
        }
        let from_top = (f32::from(-offset.y) / f32::from(state.line_height)).round().max(0.);
        let from_top = (from_top as usize).min(state.history);
        state.requested = Some(state.history - from_top);
    }

    fn content_size(&self) -> Size<Pixels> {
        let state = self.0.borrow();
        let scrollback = state.line_height * state.history as f32;
        size(state.viewport.size.width, state.viewport.size.height + scrollback)
    }
}

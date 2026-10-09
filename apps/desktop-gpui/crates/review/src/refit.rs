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

//! Keeps the kit's Diff scrollable to its end.
//!
//! The Diff draws its rows in GPUI's `list`, which knows a row's height only
//! once it has drawn the row; for the rest the Diff's state gives the list a
//! code row's height as a hint, so the scroll range covers the whole file.
//! But the list drops every hint whenever its width changes (its first
//! paint, a drag of the panel's edge, a window resize, a file whose longest
//! line is wider), and the state gives them back only when it rebuilds its
//! rows. Until then the rows below the first screen count no height, the
//! wheel and the scrollbar stop at the last row drawn, and the list never
//! draws the next one: past its first screen the diff cannot be scrolled.
//! This is what left F21's panel unable to show its later files.
//!
//! So after the diff's column changes width, and after files are put in the
//! Diff, [`DiffRefit`] has the state rebuild its rows (it has no call for
//! that alone; moving its fold threshold away and back is one that changes
//! nothing else), at the end of that frame and of the next one, as the list
//! takes the column's new width a frame late (through the state's viewport).

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use gpui_kit::component::diff::DiffState;
use gpui_kit::{App, Entity, IntoElement, Pixels, SharedString, Styled as _, canvas};

/// Frames whose end rebuilds the Diff's rows after a change: the change's
/// and the next.
const FRAMES: u8 = 2;

#[derive(Debug, Default)]
pub(crate) struct DiffRefit {
    /// The diff column's width at its last paint.
    width: Cell<Option<Pixels>>,
    /// Frame ends left to rebuild at.
    frames: Cell<u8>,
    /// The file of the files just put in the Diff whose top the rebuild
    /// keeps in view (a rebuild keeps the row at the top, which on fresh
    /// files is a hunk's line rather than the file's start).
    fresh: RefCell<Option<SharedString>>,
}

impl DiffRefit {
    /// The Diff was given new files, of which the one named `top` shows
    /// from its header.
    pub(crate) fn files_changed(&self, top: SharedString) {
        self.frames.set(FRAMES);
        self.fresh.replace(Some(top));
    }

    /// The Diff's new files keep the position they were scrolled to rather
    /// than a file's top (the rest of a file shown where its cut was).
    pub(crate) fn keep_position(&self) {
        self.fresh.take();
    }

    /// An element filling the diff's column that watches its width and
    /// rebuilds `diff`'s rows when they may have lost their heights. Put it
    /// after the Diff in the column.
    pub(crate) fn probe(self: &Rc<Self>, diff: &Entity<DiffState>) -> impl IntoElement {
        let refit = self.clone();
        let diff = diff.clone();
        canvas(
            move |bounds, _, cx| {
                let width = bounds.size.width;
                if refit.width.replace(Some(width)) != Some(width) {
                    refit.frames.set(FRAMES);
                }
                let left = refit.frames.get();
                if left == 0 {
                    return;
                }
                refit.frames.set(left - 1);
                let fresh =
                    if left == 1 { refit.fresh.take() } else { refit.fresh.borrow().clone() };
                let diff = diff.clone();
                cx.defer(move |cx| rebuild(&diff, fresh, cx));
            },
            |_, _, _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
    }
}

/// Has `diff` rebuild its rows, which gives every row not drawn yet its
/// height hint again, and back at the top of `fresh`, a file just given.
fn rebuild(diff: &Entity<DiffState>, fresh: Option<SharedString>, cx: &mut App) {
    diff.update(cx, |state, cx| {
        let lines = state.min_collapsed_lines();
        state.set_min_collapsed_lines(lines + 1, cx);
        state.set_min_collapsed_lines(lines, cx);
        if let Some(path) = fresh {
            state.scroll_to_file(&path, cx);
        }
    });
}

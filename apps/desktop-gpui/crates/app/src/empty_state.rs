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

//! The main pane while there is nothing to read: no task is selected, or the
//! selected task has no turn yet.

use gpui_kit::component::v_flex;
use gpui_kit::{
    App, InteractiveElement as _, IntoElement, ParentElement as _, RenderOnce, Role, SharedString,
    StatefulInteractiveElement as _, Styled as _, TestSupportExt as _, Window, div, rems,
};
use shared::copy;
use shared::layout::COLUMN_MAX_WIDTH_REMS;
use shared::theme::{ActiveMakaPalette as _, DISPLAY_LINE_REMS, DISPLAY_TEXT_REMS};

/// DESIGN.md's chat first-run hero, in type only (§10 keeps brand marks
/// out of empty states): one display line, "What should we work on?",
/// centred over the reading column (no illustration, no avatar). The
/// header already names the task, so the line never repeats its title, and
/// the composer's project chip says where a new task runs.
#[derive(IntoElement)]
pub(crate) struct EmptyState;

impl RenderOnce for EmptyState {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let maka = cx.maka();
        let title: SharedString = copy::EMPTY_STATE_TITLE.get(cx).into();
        v_flex()
            .id("empty-state")
            .test_support()
            .flex_1()
            .min_h_0()
            .w_full()
            .items_center()
            .justify_center()
            .px_6()
            .py_8()
            .child(
                div()
                    .id("empty-state-title")
                    .test_support()
                    .role(Role::Heading)
                    .aria_label(title.clone())
                    .max_w(rems(COLUMN_MAX_WIDTH_REMS))
                    .text_center()
                    .text_size(rems(DISPLAY_TEXT_REMS))
                    .line_height(rems(DISPLAY_LINE_REMS))
                    .text_color(maka.ink)
                    .child(title),
            )
    }
}

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

//! A task's context menu and the confirmation its Delete opens.

use gpui_kit::assets::IconName as AssetIcon;
use gpui_kit::component::{Icon, WindowExt as _};
use gpui_kit::{ClipboardItem, Entity, SharedString, WeakEntity, Window};
use shared::copy::{self, Locale};
use shared::dialog::{DialogHeader, DialogHeaderExt as _};
use shared::icons::MakaIcon;
use shared::menu::{MenuEntry, MenuItem};
use shared::theme::floating_surface;

use super::{RenameSession, SessionSidebar};
use crate::catalog::SessionCatalog;

/// What the menu needs to know about its task when it opens.
#[derive(Debug, Clone)]
pub(super) struct MenuTask {
    pub id: SharedString,
    pub flagged: bool,
    pub archived: bool,
    /// A command on it is still unanswered: its items are disabled.
    pub busy: bool,
}

/// The menu for `task`: Rename (F2), Flag or Unflag, Copy task ID, then
/// Archive or Unarchive, and for an archived task Delete…. Each item acts on
/// this task, not on the selection.
pub(super) fn entries(
    task: MenuTask,
    sidebar: WeakEntity<SessionSidebar>,
    catalog: Entity<SessionCatalog>,
    locale: Locale,
) -> Vec<MenuEntry> {
    let MenuTask { id, flagged, archived, busy } = task;
    // One glyph for each pair, as Mail flags and unflags with one flag; the
    // label says which way the item goes.
    let flag_label = if flagged {
        copy::TASK_UNFLAG.in_locale(locale)
    } else {
        copy::TASK_FLAG.in_locale(locale)
    };
    let archive_label = if archived {
        copy::TASK_UNARCHIVE.in_locale(locale)
    } else {
        copy::TASK_ARCHIVE.in_locale(locale)
    };
    let rename = {
        let (sidebar, id) = (sidebar.clone(), id.clone());
        move |window: &mut Window, cx: &mut gpui_kit::App| {
            sidebar.update(cx, |sidebar, cx| sidebar.start_rename(&id, window, cx)).ok();
        }
    };
    let flag = {
        let (catalog, id) = (catalog, id.clone());
        move |_: &mut Window, cx: &mut gpui_kit::App| {
            catalog.update(cx, |catalog, cx| catalog.set_flagged(&id, !flagged, cx));
        }
    };
    let copy_id = {
        let id = id.clone();
        move |_: &mut Window, cx: &mut gpui_kit::App| {
            cx.write_to_clipboard(ClipboardItem::new_string(id.to_string()));
        }
    };
    let archive = {
        let (sidebar, id) = (sidebar.clone(), id.clone());
        move |_: &mut Window, cx: &mut gpui_kit::App| {
            sidebar.update(cx, |sidebar, cx| sidebar.set_archived(&id, !archived, cx)).ok();
        }
    };
    let delete = move |window: &mut Window, cx: &mut gpui_kit::App| {
        sidebar.update(cx, |sidebar, cx| sidebar.confirm_delete(id.clone(), window, cx)).ok();
    };
    let mut entries = vec![
        MenuItem::new("rename", copy::TASK_RENAME.in_locale(locale))
            .icon(Icon::new(AssetIcon::Pencil))
            .shortcut(Box::new(RenameSession))
            .disabled(busy)
            .on_select(rename)
            .into(),
        MenuItem::new("flag", flag_label)
            .icon(Icon::new(MakaIcon::Flag))
            .disabled(busy)
            .on_select(flag)
            .into(),
        MenuItem::new("copy-id", copy::TASK_COPY_ID.in_locale(locale))
            .icon(Icon::new(MakaIcon::Copy))
            .on_select(copy_id)
            .into(),
        MenuEntry::Separator,
        MenuItem::new("archive", archive_label)
            .icon(Icon::new(MakaIcon::Archive))
            .disabled(busy)
            .on_select(archive)
            .into(),
    ];
    if archived {
        entries.push(
            MenuItem::new("delete", copy::TASK_DELETE.in_locale(locale))
                .icon(Icon::new(AssetIcon::Trash))
                .disabled(busy)
                .on_select(delete)
                .into(),
        );
    }
    entries
}

/// Asks before deleting task `id` titled `title`: an alert dialog that
/// names it, says the transcript goes too and cannot come back, and how
/// many subtasks move to the archive when the preview could tell. Delete
/// is the destructive result; Cancel and Escape leave everything as is.
pub(super) fn open_delete_dialog(
    catalog: Entity<SessionCatalog>,
    id: SharedString,
    title: SharedString,
    subtasks: Option<u64>,
    window: &mut Window,
    cx: &mut gpui_kit::App,
) {
    let locale = Locale::current(cx);
    let body = copy::DELETE_TASK_BODY.in_locale(locale);
    let body: SharedString = match subtasks.filter(|count| *count > 0) {
        Some(count) => copy::sentences(locale, body, &copy::delete_task_subtasks(locale, count)),
        None => body.to_owned(),
    }
    .into();
    window.open_alert_dialog(cx, move |alert, _, cx| {
        let (catalog, id) = (catalog.clone(), id.clone());
        floating_surface(alert, cx)
            .with_header(DialogHeader::new(copy::delete_task_title(locale, &title)))
            .description(shared::dialog::confirmation_text(body.clone()))
            .footer(shared::dialog::confirmation_answers(
                copy::CANCEL.in_locale(locale),
                copy::DELETE.in_locale(locale),
                true,
                cx,
            ))
            .on_ok(move |_, _, cx| {
                catalog.update(cx, |catalog, cx| catalog.remove(&id, cx));
                true
            })
    });
}

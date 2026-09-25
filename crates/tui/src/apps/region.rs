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

//! What every region showing views shares: text fields painted over their
//! wells, and the typing, pastes and pointer those fields take before the
//! region's surface does. A region is any surface: a page, a panel, a
//! settings pane.

use super::{App, Apps, tree::Well};
use crate::{theme::Palette, ui, view::form};
use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers, MouseEventKind};
use ratatui::Frame;
use serde_json::Value;

/// Paints each field whose whole well the last frame drew; a partly
/// scrolled well stays empty rather than half an editor.
pub(super) fn paint<M: Clone>(
    frame: &mut Frame<'_>,
    apps: &mut Apps,
    surface: &ui::Surface<M>,
    wells: &[Well],
    focused: Option<&str>,
    colors: Palette,
) {
    for well in wells {
        let Some(rect) = surface.rect(&well.path) else {
            continue;
        };
        let rows = if well.multiline {
            super::tree::AREA_ROWS
        } else {
            1
        };
        if rect.height < rows {
            continue;
        }
        let Some(editor) = apps
            .instances
            .get_mut(&well.key)
            .and_then(|instance| instance.editors.get_mut(&well.field))
        else {
            continue;
        };
        let placeholder = (!well.placeholder.is_empty()).then_some(well.placeholder.as_str());
        form::draw(
            frame,
            rect,
            well.label_width,
            form::Row {
                label: &well.label,
                focused: focused == Some(well.path.as_str()),
                masked: well.secret,
                placeholder,
            },
            editor,
            colors,
        );
    }
}

/// The region's fields take their events first: the pointer over an
/// editor, and while the region has the keyboard, typing and pastes into
/// the focused field. Some(redraw) when a field consumed the event.
pub(super) fn input<M: Clone>(
    app: &mut App,
    surface: &mut ui::Surface<M>,
    wells: &[Well],
    event: &Event,
    keyboard: bool,
) -> Option<bool> {
    let ascii = app.chrome.ascii;
    let apps = &mut app.apps;
    if surface.captures() || surface.dragging_split() {
        return None;
    }
    if let Some(redraw) =
        super::transcript::input(&mut apps.readers, surface, event, keyboard, ascii)
    {
        app.checkpoint_input(crate::state::Impact::Reading);
        return Some(redraw);
    }
    let enabled = |apps: &Apps, well: &Well| {
        apps.instances
            .get(&well.key)
            .and_then(|instance| instance.view.as_ref())
            .and_then(|view| view.field(&well.field))
            .is_some_and(|field| field.enabled)
    };
    let editable = |apps: &Apps, well: &Well| {
        apps.instances.get(&well.key).is_some_and(|instance| {
            instance.live.is_some()
                && (instance.idle() || instance.refreshing())
                && !instance.blocked
        })
    };
    if let Event::Mouse(mouse) = event {
        let well = wells.iter().find(|well| {
            enabled(apps, well)
                && apps
                    .instances
                    .get(&well.key)
                    .and_then(|instance| instance.editors.get(&well.field))
                    .is_some_and(|editor| editor.takes(mouse))
        })?;
        let press = matches!(mouse.kind, MouseEventKind::Down(_));
        let changed = editable(apps, well)
            && apps
                .instances
                .get_mut(&well.key)?
                .editors
                .get_mut(&well.field)?
                .mouse(*mouse);
        if press {
            surface.focus(well.path.clone());
        }
        app.checkpoint_input(crate::state::Impact::Reading);
        return Some(changed || press);
    }
    if !keyboard {
        return None;
    }
    let focused = surface.focused()?;
    let well = wells.iter().find(|well| well.path == focused)?;
    if !enabled(apps, well) {
        return None;
    }
    let editable = editable(apps, well);
    let editor = apps.instances.get(&well.key)?.editors.get(&well.field)?;
    let proposed = match event {
        Event::Key(key) if key.kind != KeyEventKind::Release => {
            if key
                .modifiers
                .intersects(KeyModifiers::ALT | KeyModifiers::SUPER | KeyModifiers::META)
                || key.modifiers.contains(KeyModifiers::CONTROL)
                    && !matches!(
                        key.code,
                        KeyCode::Char('a' | 'z' | 'y' | 'u' | 'k')
                            | KeyCode::Left
                            | KeyCode::Right
                            | KeyCode::Backspace
                            | KeyCode::Delete
                    )
            {
                return None;
            }
            match key.code {
                KeyCode::Tab | KeyCode::BackTab | KeyCode::F(_) | KeyCode::Esc => return None,
                KeyCode::Enter | KeyCode::Up | KeyCode::Down if !well.multiline => return None,
                // A field waiting on a request keeps its text; the keys
                // still stay with it rather than reaching the shell.
                _ if !editable => return Some(false),
                _ => editor.preview_key_text(*key),
            }
        }
        Event::Paste(_) if !editable => return Some(false),
        Event::Paste(text) => {
            if well.multiline {
                editor.preview_insert_text(text)
            } else {
                editor.preview_insert_text(&crate::view::safe(text))
            }
        }
        _ => return None,
    };
    let edits_text = proposed.is_some();
    app.checkpoint_input(crate::state::Impact::Reading);
    if let Some(text) = proposed
        && !app.admit_field(&well.key, &well.field, &Value::String(text))
    {
        return Some(true);
    }
    let instance = app.apps.instances.get_mut(&well.key)?;
    let editor = instance.editors.get_mut(&well.field)?;
    let changed = match event {
        Event::Key(key) => editor.key(*key),
        Event::Paste(text) if well.multiline => editor.insert(text),
        Event::Paste(text) => editor.insert(&crate::view::safe(text)),
        _ => return None,
    };
    if changed && edits_text {
        // Selection and cursor keys are handled without changing the draft.
        // Only text edits overtake a read or reserve a new field value.
        if instance.refreshing() {
            instance.overtake();
            instance.stale = true;
        }
        instance.applied = None;
        let text = instance.editors[&well.field].text().to_owned();
        instance
            .drafts
            .insert(well.field.clone(), Value::String(text));
    }
    Some(true)
}

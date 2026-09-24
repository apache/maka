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

use super::{Action, App, Command, Phase};
use crate::{
    ui::{Role, Sheet, Tone},
    view::safe,
};

fn primary(phase: Phase) -> Option<Command> {
    match phase {
        Phase::Confirm => Some(Command::Confirm),
        Phase::Unknown => Some(Command::Query),
        Phase::Ready => Some(Command::Visit),
        _ => None,
    }
}

/// Branching from a turn: the turn, what happens, then Cancel and Create
/// branch; later Check result or Open branch. Each step opens on its
/// dismissal, so Enter alone never creates a session.
pub(crate) fn sheet(app: &App) -> Option<Sheet<Action>> {
    let state = &app.branch;
    if !state.visible {
        return None;
    }
    let step = match state.phase {
        Phase::Confirm => "confirm",
        Phase::Saving | Phase::Pending => "wait",
        Phase::Unknown => "unknown",
        Phase::Ready => "ready",
        Phase::Failed => "failed",
    };
    let mut sheet = Sheet::new(format!("branch:{step}"), app.i18n.text("branch-title"));
    if let Some(basis) = &state.basis {
        sheet = sheet.text("name", &safe(&basis.name), Tone::Normal).text(
            "excerpt",
            &safe(&basis.excerpt),
            Tone::Subtle,
        );
    }
    let note = state.error.unwrap_or(match state.phase {
        Phase::Confirm => "branch-note",
        Phase::Saving | Phase::Pending => "branch-wait",
        Phase::Unknown => "branch-unknown",
        Phase::Ready => "branch-ready",
        Phase::Failed => "branch-unavailable",
    });
    let warning = state.error.is_some() || state.phase == Phase::Unknown;
    sheet = sheet
        .text(
            "note",
            &app.i18n.text(note),
            if warning { Tone::Warning } else { Tone::Subtle },
        )
        .button(
            "close",
            app.i18n.text(if state.phase == Phase::Confirm {
                "session-cancel"
            } else {
                "session-remove-close"
            }),
            Role::Normal,
            Action::Branch(Command::Close),
            true,
        );
    if let Some(command) = primary(state.phase) {
        sheet = sheet.button(
            "primary",
            app.i18n.text(command.label()),
            Role::Primary,
            Action::Branch(command.clone()),
            app.branch_enabled(&command),
        );
    }
    Some(sheet.focus("close"))
}

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

use super::{App, Command};
use crate::{
    app::Action,
    ui::{Role, Sheet, Tone},
    view::safe,
};
use maka_protocol::turn::{TurnResumeParkReason, TurnResumePlan};

/// Resuming a stopped turn: what the Host says about it, then Check again,
/// Resume turn when it can, or Retry the original request after an
/// unresolved one. The sheet opens on Close, since resuming starts work.
pub(crate) fn sheet(app: &App) -> Option<Sheet<Action>> {
    let state = &app.resume;
    if !state.visible {
        return None;
    }
    let session = state
        .target
        .as_ref()
        .map(|target| target.session.as_str())
        .unwrap_or_default();
    let step = if state.saved.is_some() {
        "retry"
    } else {
        "check"
    };
    let mut sheet = Sheet::new(
        format!("resume:{session}:{step}"),
        app.i18n.text("resume-title"),
    );
    if !session.is_empty() {
        sheet = sheet.text("session", &safe(session), Tone::Normal);
    }
    let status = if state.pending.is_some() {
        app.i18n.text("resume-checking")
    } else if state.saved.is_some() {
        app.i18n.text("resume-unresolved")
    } else {
        match &state.plan {
            Some(TurnResumePlan::Ready { source_turn_id, .. }) => app
                .i18n
                .format("resume-ready", &[("turn", &safe(source_turn_id))]),
            Some(TurnResumePlan::Parked { reason, .. }) => format!(
                "{}\n{}",
                app.i18n.text("resume-parked"),
                app.i18n.text(reason_key(*reason))
            ),
            None => app.i18n.text("resume-note"),
        }
    };
    sheet = sheet.text("status", &status, Tone::Subtle);
    if let Some(error) = state.error.as_ref().filter(|error| **error != status) {
        sheet = sheet.text("error", &safe(error), Tone::Warning);
    }
    let button = |sheet: Sheet<Action>, key, command: Command, role| {
        sheet.button(
            key,
            app.i18n.text(command.label()),
            role,
            Action::Resume(command.clone()),
            app.resume_offered(&command),
        )
    };
    sheet = button(sheet, "close", Command::Close, Role::Normal);
    sheet = if state.saved.is_some() {
        button(sheet, "retry", Command::Retry, Role::Primary)
    } else if matches!(state.plan, Some(TurnResumePlan::Ready { .. })) {
        button(
            button(sheet, "check", Command::Query, Role::Normal),
            "start",
            Command::Start,
            Role::Primary,
        )
    } else {
        button(sheet, "check", Command::Query, Role::Normal)
    };
    Some(sheet.focus("close"))
}

fn reason_key(reason: TurnResumeParkReason) -> &'static str {
    match reason {
        TurnResumeParkReason::ResumeCandidateMissing => "resume-reason-missing",
        TurnResumeParkReason::SourceRunUnreadable => "resume-reason-unreadable",
        TurnResumeParkReason::SafetyCheckFailed => "resume-reason-unsafe",
        TurnResumeParkReason::ContinuationAlreadyExists => "resume-reason-existing",
        TurnResumeParkReason::ContinuationRepairRequired => "resume-reason-repair",
        TurnResumeParkReason::ContinuationStartedIndeterminate => "resume-reason-unknown",
        TurnResumeParkReason::ResumeFeatureDisabled => "resume-reason-disabled",
        TurnResumeParkReason::ContinuationAuthorityUnavailable => "resume-reason-authority",
        TurnResumeParkReason::SafetyObservationUnavailable => "resume-reason-observation",
        TurnResumeParkReason::SessionBusy => "resume-reason-busy",
    }
}

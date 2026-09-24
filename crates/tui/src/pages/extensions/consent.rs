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

use super::{Action, App, Command, Input};
use crate::ui::{Role, Sheet, Tone};
use maka_plugins::authorization::{Capability, Request, Target};
use maka_protocol::plugin::TerminalViewProjection;

pub(super) struct Consent {
    pub entry: Box<TerminalViewProjection>,
    pub input: Input,
    pub proposal: Request,
    /// Set only while the terms are on screen: approval needs them seen.
    pub rendered: bool,
}

/// Cancel is the default; authorizing always takes a deliberate move.
pub(crate) fn sheet(app: &App) -> Option<Sheet<Action>> {
    let state = app.extensions.consent.as_ref()?;
    let mut body = format!(
        "{}\n\n{}\n\n",
        visible(&state.entry.package_id),
        target(app, &state.proposal.target)
    );
    for capability in &state.proposal.capabilities {
        body.push_str("• ");
        body.push_str(&app.i18n.text(capability_key(*capability)));
        body.push('\n');
    }
    body.push('\n');
    body.push_str(&app.i18n.text("extensions-consent-duration"));
    Some(
        Sheet::new(
            state.proposal.operation_id.to_string(),
            app.i18n.text("extensions-consent-title"),
        )
        .text("terms", &body, Tone::Normal)
        .button(
            "cancel",
            app.i18n.text("session-cancel"),
            Role::Normal,
            Action::Extension(Command::DismissConsent),
            true,
        )
        .button(
            "authorize",
            app.i18n.text("extensions-authorize"),
            Role::Primary,
            Action::Extension(Command::ApproveConsent),
            app.enabled(&Action::Extension(Command::ApproveConsent)),
        )
        .focus("cancel"),
    )
}

/// An action that asked to be confirmed. The plugin words the question;
/// the shell owns the sheet, and Cancel is where it opens.
pub(crate) fn confirm(app: &App) -> Option<Sheet<Action>> {
    let state = &app.extensions;
    let (action, id) = state.confirmation()?;
    let confirm = action.confirm.as_ref()?;
    let package = state
        .entry
        .as_ref()
        .map_or_else(String::new, |entry| visible(&entry.package_id));
    Some(
        Sheet::new(format!("confirm:{package}:{id}"), confirm.title.clone())
            .text("message", &confirm.message, Tone::Normal)
            .text("source", &package, Tone::Subtle)
            .button(
                "cancel",
                app.i18n.text("session-cancel"),
                Role::Normal,
                Action::Extension(Command::CancelConfirm),
                true,
            )
            .button(
                "confirm",
                action.label.clone(),
                if confirm.destructive {
                    Role::Destructive
                } else {
                    Role::Primary
                },
                Action::Extension(Command::Confirm),
                app.extensions_offered(&Command::Confirm),
            )
            .focus("cancel"),
    )
}

fn visible(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}') {
                c.escape_unicode().to_string()
            } else {
                c.to_string()
            }
        })
        .collect()
}
fn target(app: &App, target: &Target) -> String {
    match target {
        Target::Profile => app.i18n.text("extensions-target-profile"),
        Target::Directory { path } => visible(path),
        Target::Session { session_id } => format!(
            "{} · {}",
            app.i18n.text("extensions-target-session"),
            visible(session_id)
        ),
        Target::PluginWorkspace { sandbox_mode } => format!(
            "{} · {}",
            app.i18n.text("extensions-target-plugin-workspace"),
            mode(app, *sandbox_mode)
        ),
        Target::Workspace {
            workspace,
            sandbox_mode,
        } => {
            let name = match workspace {
                maka_runtime::execution::WorkspaceTarget::Project { project_id } => format!(
                    "{} · {}",
                    app.i18n.text("route-projects"),
                    visible(project_id)
                ),
                maka_runtime::execution::WorkspaceTarget::HostPath { path } => visible(path),
            };
            format!("{name}\n{}", mode(app, *sandbox_mode))
        }
    }
}
fn mode(app: &App, mode: maka_runtime::execution::SandboxMode) -> String {
    use maka_runtime::execution::SandboxMode;
    app.i18n.text(match mode {
        SandboxMode::ReadOnly => "chat-sandbox-read",
        SandboxMode::WorkspaceWrite => "chat-sandbox-workspace",
        SandboxMode::DangerFullAccess => "chat-sandbox-none",
    })
}
fn capability_key(capability: Capability) -> &'static str {
    match capability {
        Capability::ReadFiles => "extensions-cap-read-files",
        Capability::WriteFiles => "extensions-cap-write-files",
        Capability::Network => "extensions-cap-network",
        Capability::Models => "extensions-cap-models",
        Capability::Processes => "extensions-cap-processes",
        Capability::ClientCapabilities => "extensions-cap-client",
        Capability::Executions => "extensions-cap-executions",
        Capability::Notifications => "extensions-cap-notifications",
        Capability::ReadSessions => "extensions-cap-sessions",
        Capability::ReadHistory => "extensions-cap-history",
        Capability::ReadUsage => "extensions-cap-usage",
        Capability::ManagePricing => "extensions-cap-pricing",
    }
}

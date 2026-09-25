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

use super::view::{button_row, link, review, text};
use super::*;
use crate::{
    ui::{Node, Role, Tone},
    view::safe,
};
use maka_protocol::plugin::EntryPhase;

pub(super) fn package(app: &App, snapshot: &Snapshot, id: &str, rows: &mut Vec<Node<Command>>) {
    let Some(package) = snapshot.package(id) else {
        rows.push(text(
            "missing",
            app.i18n.text("plugins-missing"),
            Tone::Warning,
        ));
        return;
    };
    rows.push(text("name", safe(&package.display_name), Tone::Strong));
    if let Some(description) = &package.description {
        rows.push(text("description", safe(description), Tone::Muted));
    }
    rows.push(text(
        "capabilities",
        capabilities(app, package),
        Tone::Subtle,
    ));
    rows.push(
        Node::row(
            "package-actions",
            vec![
                review(app, "restart", Change::Restart),
                review(app, "uninstall", Change::Uninstall),
            ],
        )
        .gap(1),
    );
    rows.push(text(
        "instances",
        app.i18n.text("plugins-instances"),
        Tone::Strong,
    ));
    rows.extend(
        snapshot
            .entries
            .iter()
            .filter(|e| e.package_id.as_deref() == Some(id))
            .enumerate()
            .map(|(i, e)| {
                link(
                    format!("instance-{i}"),
                    format!(
                        "{} · {} · {}",
                        safe(&e.id),
                        String::from(e.root_id.clone()),
                        phase(app, e.status)
                    ),
                    Place::Entry(EntryKey::of(e)),
                )
            }),
    );
    if package.has_runtime {
        rows.push(button_row(
            app,
            "create",
            "plugins-create",
            Command::Visit(Place::New(id.into())),
            Role::Primary,
        ));
    }
    if app.plugins.details {
        rows.push(text("id", safe(id), Tone::Subtle));
        rows.push(text("digest", &package.content_digest, Tone::Subtle));
        for (key, label, values) in [
            (
                "dependencies",
                "plugins-dependencies",
                &package.dependencies,
            ),
            (
                "structural",
                "plugins-structural",
                &package.structural_dependencies,
            ),
            ("required-by", "plugins-required-by", &package.required_by),
        ] {
            rows.push(text(
                key,
                format!("{}: {}", app.i18n.text(label), safe(&values.join(", "))),
                Tone::Subtle,
            ));
        }
    }
}
pub(super) fn instance(
    app: &App,
    snapshot: &Snapshot,
    key: &EntryKey,
    rows: &mut Vec<Node<Command>>,
) {
    let Some(entry) = snapshot.entry(key) else {
        rows.push(text(
            "missing",
            app.i18n.text("plugins-missing"),
            Tone::Warning,
        ));
        return;
    };
    rows.push(text("name", safe(&entry.id), Tone::Strong));
    rows.push(text(
        "scope",
        format!(
            "{}: {}",
            app.i18n.text("plugins-scope"),
            String::from(entry.root_id.clone())
        ),
        Tone::Muted,
    ));
    rows.push(text(
        "state",
        format!(
            "{}: {} · {}: {}",
            app.i18n.text("plugins-desired"),
            app.i18n.text(if entry.local_disabled {
                "plugins-disabled"
            } else {
                "plugins-enabled"
            }),
            app.i18n.text("plugins-effective"),
            phase(app, entry.status)
        ),
        if matches!(entry.status, EntryPhase::Failed) {
            Tone::Warning
        } else {
            Tone::Normal
        },
    ));
    if entry.disabled && !entry.local_disabled {
        rows.push(text(
            "ancestor",
            app.i18n.text("plugins-ancestor-disabled"),
            Tone::Warning,
        ));
    }
    if let Some(diagnostic) = &entry.diagnostic {
        rows.push(text("diagnostic", safe(diagnostic), Tone::Warning));
    }
    if !entry.waiting_for.is_empty() {
        rows.push(text(
            "waiting",
            format!(
                "{}: {}",
                app.i18n.text("plugins-waiting"),
                safe(&entry.waiting_for.join(", "))
            ),
            Tone::Warning,
        ));
    }
    rows.push(
        Node::row(
            "instance-actions",
            vec![
                review(
                    app,
                    "toggle",
                    if entry.local_disabled {
                        Change::Enable
                    } else {
                        Change::Disable
                    },
                ),
                review(app, "remove", Change::Remove),
            ],
        )
        .gap(1),
    );
    rows.push(button_row(
        app,
        "config",
        "plugins-configure",
        Command::Visit(Place::Configure(key.clone())),
        Role::Normal,
    ));
    rows.push(button_row(
        app,
        "services",
        "plugins-services",
        Command::Visit(Place::Services(key.clone())),
        Role::Normal,
    ));
    if app.plugins.details {
        rows.push(text(
            "parent",
            format!(
                "{}: {}",
                app.i18n.text("plugins-parent"),
                entry
                    .parent_id
                    .as_deref()
                    .map(safe)
                    .unwrap_or_else(|| "—".into())
            ),
            Tone::Subtle,
        ));
        if let Some(package) = &entry.package_id {
            rows.push(text("package", safe(package), Tone::Subtle));
        }
        rows.push(text(
            "generation",
            format!("{} / {:?}", entry.base_generation, entry.generation),
            Tone::Subtle,
        ));
    }
}
pub(super) fn capabilities(app: &App, package: &PackageProjection) -> String {
    [
        (package.has_runtime, "plugins-runtime"),
        (package.has_client, "plugins-client"),
        (package.has_composition, "plugins-composition"),
    ]
    .into_iter()
    .filter(|(present, _)| *present)
    .map(|(_, key)| app.i18n.text(key))
    .collect::<Vec<_>>()
    .join(" · ")
}
pub(super) fn phase(app: &App, phase: EntryPhase) -> String {
    app.i18n.text(match phase {
        EntryPhase::Disabled => "plugins-disabled",
        EntryPhase::Active => "plugins-active",
        EntryPhase::Pending => "plugins-pending",
        EntryPhase::Loading => "plugins-loading",
        EntryPhase::Failed => "plugins-failed",
        EntryPhase::Unloading => "plugins-unloading",
        EntryPhase::Disposed => "plugins-disposed",
    })
}

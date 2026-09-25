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

//! Human review text derived only from the frozen typed request.
use super::*;
use crate::view::safe;
use maka_plugins::composition::{EntryPatch, Operation};
use serde_json::Map;

fn field(app: &App, key: &str, value: &str) -> String {
    format!("{}: {}", app.i18n.text(key), safe(value))
}
fn json(app: &App, key: &str, value: &impl Serialize) -> String {
    format!("{}\n{}", app.i18n.text(key), drafts::json_text(value))
}
fn identity(app: &App, request: &Request, id: &str) -> Vec<String> {
    let mut lines = vec![field(app, "plugins-instance-id", id)];
    if let Some((_, place, _)) = request.intent()
        && let Some(key) = place.entry()
    {
        lines.push(field(
            app,
            "plugins-scope",
            &String::from(key.scope.clone()),
        ));
    }
    lines
}
fn patch(app: &App, value: &EntryPatch, lines: &mut Vec<String>) {
    if let Some(package) = &value.package_id {
        lines.push(field(app, "plugins-package", package));
    }
    if let Some(disabled) = value.disabled {
        lines.push(field(
            app,
            "plugins-desired",
            &app.i18n.text(if disabled {
                "plugins-disabled"
            } else {
                "plugins-enabled"
            }),
        ));
    }
    if let Some(config) = &value.config {
        lines.push(json(app, "plugins-proposed-config", config));
    }
    let mut routing = Map::new();
    if let Some(inject) = &value.inject {
        routing.insert(
            "inject".into(),
            serde_json::to_value(inject).expect("typed routing"),
        );
    }
    if let Some(isolate) = &value.isolate {
        routing.insert(
            "isolate".into(),
            serde_json::to_value(isolate).expect("typed routing"),
        );
    }
    if let Some(intercept) = &value.intercept {
        routing.insert(
            "intercept".into(),
            serde_json::to_value(intercept).expect("typed routing"),
        );
    }
    if !routing.is_empty() {
        lines.push(json(app, "plugins-proposed-routing", &routing));
    }
}
pub(super) fn write(app: &App, request: &Request) -> Option<String> {
    let mut lines = vec![];
    match request.mutation()? {
        io::Mutation::Install(input) => {
            let (_, Place::Package(package), _) = request.intent()? else {
                return None;
            };
            lines.push(field(app, "plugins-package", package));
            lines.push(field(app, "plugins-source", &input.source_path));
        }
        io::Mutation::Restart(input) | io::Mutation::Uninstall(input) => {
            lines.push(field(app, "plugins-package", &input.extension_id))
        }
        io::Mutation::Apply(input) => {
            for operation in &input.operations {
                match operation {
                    Operation::Insert {
                        root_id,
                        parent_id,
                        entry,
                        position,
                    } => {
                        lines.push(field(app, "plugins-instance-id", &entry.id));
                        if let Some(scope) = root_id {
                            lines.push(field(app, "plugins-scope", &String::from(scope.clone())));
                        }
                        if let Some(parent) = parent_id {
                            lines.push(field(app, "plugins-parent", parent));
                        }
                        if let Some(position) = position {
                            lines.push(field(app, "plugins-position", &position.to_string()));
                        }
                        patch(
                            app,
                            &EntryPatch {
                                package_id: entry.package_id.clone(),
                                config: Some(entry.config.clone()),
                                disabled: Some(entry.disabled),
                                ..Default::default()
                            },
                            &mut lines,
                        );
                        if entry.inject.names().next().is_some()
                            || !entry.isolate.is_empty()
                            || !entry.intercept.is_empty()
                        {
                            lines.push(json(app,"plugins-proposed-routing",&serde_json::json!({"inject":entry.inject,"isolate":entry.isolate,"intercept":entry.intercept})));
                        }
                        if !entry.children.is_empty() {
                            lines.push(json(app, "plugins-children", &entry.children));
                        }
                    }
                    Operation::Update {
                        entry_id,
                        patch: value,
                    } => {
                        lines.extend(identity(app, request, entry_id));
                        patch(app, value, &mut lines);
                    }
                    Operation::Remove { entry_id } => {
                        lines.extend(identity(app, request, entry_id))
                    }
                    Operation::Move {
                        entry_id,
                        parent_id,
                        position,
                    } => {
                        lines.extend(identity(app, request, entry_id));
                        lines.push(field(
                            app,
                            "plugins-parent",
                            parent_id.as_deref().unwrap_or("—"),
                        ));
                        if let Some(position) = position {
                            lines.push(field(app, "plugins-position", &position.to_string()));
                        }
                    }
                }
            }
        }
    }
    Some(lines.join("\n\n"))
}
pub(super) fn technical(app: &App, request: &Request) -> Option<String> {
    let (_, _, base) = request.intent()?;
    Some(format!(
        "Root: {}\nHost: {}\n{}: {}\n{}: {}\n\n{}",
        safe(&request.binding.root),
        safe(&request.binding.epoch),
        app.i18n.text("plugins-base"),
        base,
        app.i18n.text("plugins-client-request"),
        request.token,
        serde_json::to_string_pretty(request.mutation()?).ok()?
    ))
}
pub(super) fn rebase(
    app: &App,
    current: Option<&EntryProjection>,
    mine: &[String; 3],
    dirty: &[bool; 3],
    scope: &Scope,
) -> String {
    let mut lines = vec![
        field(app, "plugins-instance-id", &mine[0]),
        field(app, "plugins-scope", &String::from(scope.clone())),
    ];
    if let Some(current) = current
        && let Some(package) = &current.package_id
    {
        lines.push(field(app, "plugins-package", package));
    }
    for (index, label) in [(1, "plugins-configure"), (2, "plugins-services-json")] {
        if dirty[index] {
            lines.push(format!(
                "{} · {}\n{}",
                app.i18n.text("plugins-mine"),
                app.i18n.text(label),
                mine[index]
            ));
        }
        if let Some(current) = current {
            let value = if index == 1 {
                drafts::json_text(&current.config)
            } else {
                drafts::routing(current)
            };
            lines.push(format!(
                "{} · {}\n{}",
                app.i18n.text("plugins-current"),
                app.i18n.text(label),
                value
            ));
        }
    }
    lines.join("\n\n")
}

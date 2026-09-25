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

use super::*;

pub(in crate::plugin::terminal::library) fn source(
    route: &Route,
    item: &CatalogItem,
    stamp: &Stamp,
    destination: &str,
    managed: Option<&str>,
    cx: &Cx,
) -> Result<View, Error> {
    let (id, name, description, installed) = match item {
        CatalogItem::Bundled {
            id,
            name,
            description,
            installed,
            ..
        }
        | CatalogItem::ManagedSource {
            id,
            name,
            description,
            installed,
            ..
        } => (id, name, description, *installed),
        _ => return Err(invalid("Invalid Skill source")),
    };
    let mut nodes = vec![
        text(
            "description",
            clipped(description, 8192, true),
            Tone::Normal,
        ),
        text("destination", Copy::Destination.text(cx), Tone::Muted),
        text("path", clean(destination, true), Tone::Normal),
    ];
    if let Some(managed) = managed {
        nodes.extend([
            text("managed-title", Copy::Location.text(cx), Tone::Muted),
            text("managed-path", clean(managed, true), Tone::Normal),
            text("managed-hint", Copy::EditSource.text(cx), Tone::Muted),
        ]);
    }
    nodes.push(if installed {
        link(
            "installed",
            Copy::OpenInstalled.text(cx),
            Route::Skill {
                reference: format!("workspace:legacy:{id}"),
            }
            .value(),
        )
        .into()
    } else {
        button("install", "install", Role::Primary)
    });
    let mut screen = screen(clipped(name, 256, false), stamp, nodes);
    if !installed {
        screen
            .actions
            .push(offered("install", Copy::Install, route, stamp, cx));
    }
    Ok(screen)
}
pub(in crate::plugin::terminal::library) fn import(
    route: &Route,
    stamp: &Stamp,
    destination: &str,
    cx: &Cx,
) -> View {
    let mut screen = screen(
        Copy::Import.text(cx),
        stamp,
        vec![
            text("hint", Copy::ImportHint.text(cx), Tone::Normal),
            text("destination", Copy::Location.text(cx), Tone::Muted),
            text("path", clean(destination, true), Tone::Normal),
            input("source-path", "path", Copy::HostPath.text(cx)),
            button("import", "import", Role::Primary),
        ],
    );
    screen.fields.push(line("path", "", 4096));
    let mut action = offered("import", Copy::Import, route, stamp, cx);
    action.fields = vec!["path".into()];
    screen.actions.push(action);
    screen
}

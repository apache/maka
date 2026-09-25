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
use crate::publication::receipt::{Destination, Outcome};
use terminal_ui::view::{Action, Node, Role, Tone, build::*};

mod detail;
mod source;
pub(super) use detail::{delete, preview, resume, skill};
pub(super) use source::{import, source};

fn screen(title: String, stamp: &Stamp, nodes: Vec<Node>) -> View {
    View {
        version: terminal_ui::VERSION,
        title,
        revision: stamp.encode(),
        fields: vec![],
        actions: vec![],
        root: column("root", nodes),
    }
}
fn navigation(route: &Route, cx: &Cx) -> Node {
    let current = match route {
        Route::Sources {
            source: Source::Bundled,
            ..
        } => "bundled",
        Route::Sources {
            source: Source::Managed,
            ..
        } => "managed",
        _ => "installed",
    };
    tabs(
        "sections",
        current,
        vec![
            (
                "installed".into(),
                Copy::Installed.text(cx),
                Route::default().value(),
            ),
            (
                "bundled".into(),
                Copy::Bundled.text(cx),
                Route::Sources {
                    source: Source::Bundled,
                    page: Page::default(),
                }
                .value(),
            ),
            (
                "managed".into(),
                Copy::Managed.text(cx),
                Route::Sources {
                    source: Source::Managed,
                    page: Page::default(),
                }
                .value(),
            ),
        ],
    )
}
fn offered(id: &str, label: Copy, route: &Route, stamp: &Stamp, cx: &Cx) -> Action {
    let mut action = action(id, label.text(cx));
    action.recovery = Some(
        serde_json::to_value(Recovery {
            route: route.clone(),
            action: id.into(),
            stamp: stamp.encode(),
        })
        .expect("Skill recovery route"),
    );
    action
}
fn clipped(value: &str, max: usize, multiline: bool) -> String {
    super::super::display(value, max, multiline)
}
fn back(reference: &str, cx: &Cx) -> Node {
    link(
        "back",
        Copy::Back.text(cx),
        Route::Skill {
            reference: reference.into(),
        }
        .value(),
    )
    .into()
}

pub(super) fn list(
    route: &Route,
    page: &Page,
    items: &[CatalogItem],
    next: Option<String>,
    stamp: &Stamp,
    cx: &Cx,
) -> Result<View, Error> {
    let mut nodes = vec![navigation(route, cx)];
    for item in items.iter().skip(page.offset).take(WINDOW) {
        let (key, title, description, installed, target) = match item {
            CatalogItem::Skill(item) | CatalogItem::DiscoveryDiagnostic(item) => (
                maka_runtime::artifact::content_digest(item.reference.as_bytes()),
                &item.name,
                &item.description,
                false,
                Route::Skill {
                    reference: item.reference.clone(),
                },
            ),
            CatalogItem::Bundled {
                id,
                name,
                description,
                installed,
                ..
            } => (
                id.clone(),
                name,
                description,
                *installed,
                Route::Source {
                    source: Source::Bundled,
                    id: id.clone(),
                    page: page.clone(),
                },
            ),
            CatalogItem::ManagedSource {
                id,
                name,
                description,
                installed,
                ..
            } => (
                id.clone(),
                name,
                description,
                *installed,
                Route::Source {
                    source: Source::Managed,
                    id: id.clone(),
                    page: page.clone(),
                },
            ),
        };
        nodes.push(
            link(key, clipped(title, 256, false), target.value())
                .detail(clipped(description, 160, false))
                .meta(if installed {
                    Copy::Installed.text(cx)
                } else {
                    String::new()
                })
                .into(),
        );
    }
    if items.is_empty() {
        nodes.push(text("empty", Copy::Empty.text(cx), Tone::Muted));
        if matches!(route, Route::Installed { .. }) {
            nodes.push(
                link(
                    "browse",
                    Copy::Browse.text(cx),
                    Route::Sources {
                        source: Source::Bundled,
                        page: Page::default(),
                    }
                    .value(),
                )
                .into(),
            );
        }
    }
    let next = if page.offset + WINDOW < items.len() {
        Some(Page {
            offset: page.offset + WINDOW,
            ..page.clone()
        })
    } else {
        next.map(|cursor| Page {
            cursor: Some(Cursor {
                revision: stamp.revision.clone(),
                cursor,
            }),
            offset: 0,
        })
    };
    if let Some(page) = next {
        let route = match route {
            Route::Installed { .. } => Route::Installed { page },
            Route::Sources { source, .. } => Route::Sources {
                source: source.clone(),
                page,
            },
            _ => return Err(invalid("Invalid Skill list")),
        };
        nodes.push(link("next", Copy::Next.text(cx), route.value()).into());
    }
    let mut actions = vec![];
    if matches!(route, Route::Installed { .. }) {
        nodes.push(button("starter", "starter", Role::Normal));
        actions.push(offered("starter", Copy::Starter, route, stamp, cx));
    } else if matches!(
        route,
        Route::Sources {
            source: Source::Managed,
            ..
        }
    ) {
        nodes.push(link("import", Copy::Import.text(cx), Route::Import.value()).into());
    }
    let mut screen = screen(Copy::Title.text(cx), stamp, nodes);
    screen.actions = actions;
    Ok(screen)
}

pub(super) fn reply(outcome: Outcome, cx: &Cx) -> Reply {
    match outcome {
        Outcome::Applied { destination } => Reply::Applied {
            route: match destination {
                Destination::Skill { reference } => Route::Skill { reference },
                Destination::Source { .. } => Route::Sources {
                    source: Source::Managed,
                    page: Page::default(),
                },
                Destination::Installed => Route::default(),
            }
            .value(),
        },
        Outcome::Conflict => Reply::Conflict,
        Outcome::Rejected { reason } => Reply::Rejected {
            message: match reason.as_str() {
                "source_changed" | "local_modified" => Copy::Changed,
                "already_exists" => Copy::Duplicate,
                "invalid_skill" | "source_invalid" => Copy::InvalidSkill,
                "blocked_path" => Copy::BlockedPath,
                _ => Copy::Rejected,
            }
            .text(cx),
        },
    }
}

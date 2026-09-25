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
use crate::plugin::remote::failure;

pub(super) async fn route(skills: &Skills, route: Route, cx: &Cx) -> Result<Reply, Error> {
    let session = cx.caller.views.session().await?;
    let context = WorkspaceContext {
        workspace: session.workspace.target.clone(),
    };
    let input = match &route {
        Route::Skill { reference } | Route::Preview { reference } | Route::Delete { reference } => {
            CatalogInput::Lookup {
                context: context.clone(),
                reference: reference.clone(),
            }
        }
        Route::Installed { page } => catalog_input(context.clone(), CatalogView::Governance, page),
        Route::Sources { source, page } | Route::Source { source, page, .. } => {
            catalog_input(context.clone(), source.catalog(), page)
        }
        Route::Import | Route::Resume => CatalogInput::Start {
            context: context.clone(),
            view: CatalogView::ManagedSources,
        },
    };
    let result = skills
        .query(&input, session.workspace.clone(), session.files.clone())
        .await
        .map_err(failure)?;
    let CatalogResult::Page {
        revision,
        items,
        next_cursor,
        user_recovery,
        ..
    } = result
    else {
        return Ok(Reply::Conflict);
    };
    let mut stamp = Stamp::new(revision.clone());
    let mut screen = match &route {
        Route::Installed { page } | Route::Sources { page, .. } => {
            view::list(&route, page, &items, next_cursor, &stamp, cx)?
        }
        Route::Source { source, id, .. } => {
            let item = items.iter().find(|item| match (source, item) {
                (Source::Bundled, CatalogItem::Bundled { id: item, .. })
                | (Source::Managed, CatalogItem::ManagedSource { id: item, .. }) => item == id,
                _ => false,
            });
            let Some(item) = item else {
                return Ok(rejected(Copy::Unavailable, cx));
            };
            let destination = skills
                .data
                .read_only()
                .await
                .map_err(|e| invalid(e.to_string()))?
                .location()
                .join("skills")
                .join(id);
            let managed = if *source == Source::Managed {
                Some(source_location(skills, id)?)
            } else {
                None
            };
            view::source(
                &route,
                item,
                &stamp,
                &destination.to_string_lossy(),
                managed.as_deref(),
                cx,
            )?
        }
        Route::Import => view::import(&route, &stamp, &source_location(skills, "")?, cx),
        Route::Resume => view::resume(&stamp, cx),
        Route::Skill { reference } | Route::Preview { reference } | Route::Delete { reference } => {
            let item = items.iter().find_map(|item| match item {
                CatalogItem::Skill(item) | CatalogItem::DiscoveryDiagnostic(item)
                    if &item.reference == reference =>
                {
                    Some(item)
                }
                _ => None,
            });
            let Some(item) = item else {
                return Ok(rejected(Copy::Unavailable, cx));
            };
            match &route {
                Route::Skill { .. } => view::skill(item, &stamp, cx),
                Route::Preview { .. } => {
                    let result = skills
                        .preview_update(
                            &PreviewInput {
                                context,
                                expected_revision: revision,
                                reference: reference.clone(),
                            },
                            session.workspace,
                            session.files,
                        )
                        .await
                        .map_err(failure)?;
                    match result.outcome {
                        preview @ PreviewOutcome::Preview { .. } => {
                            let PreviewOutcome::Preview {
                                revision,
                                expected_current_sha256,
                                expected_source_sha256,
                                ..
                            } = &preview
                            else {
                                unreachable!()
                            };
                            stamp.revision = revision.clone();
                            stamp.reviewed = Review::Update {
                                current: expected_current_sha256.clone(),
                                source: expected_source_sha256.clone(),
                            };
                            view::preview(&route, item, &stamp, &preview, cx)
                        }
                        PreviewOutcome::RevisionConflict { .. } => return Ok(Reply::Conflict),
                        PreviewOutcome::Rejected { .. } => {
                            return Ok(rejected(Copy::Unavailable, cx));
                        }
                    }
                }
                Route::Delete { .. } => {
                    let (digest, paths) = skills
                        .delete_review(reference, &session.files)
                        .await
                        .map_err(failure)?;
                    stamp.reviewed = Review::Tree(digest);
                    view::delete(&route, item, &stamp, &paths, cx)
                }
                _ => unreachable!(),
            }
        }
    };
    if user_recovery.is_some() && !matches!(route, Route::Resume) {
        use terminal_ui::view::{Tone, build::*};
        screen.root = column(
            "publication-warning",
            vec![
                text("warning", Copy::RecoveryHint.text(cx), Tone::Warning),
                link("resume", Copy::Resume.text(cx), Route::Resume.value()).into(),
                screen.root,
            ],
        );
    }
    Ok(Reply::View { view: screen })
}
fn catalog_input(context: WorkspaceContext, view: CatalogView, page: &Page) -> CatalogInput {
    match &page.cursor {
        Some(cursor) => CatalogInput::Continue {
            context,
            view,
            revision: cursor.revision.clone(),
            cursor: cursor.cursor.clone(),
        },
        None => CatalogInput::Start { context, view },
    }
}
fn source_location(skills: &Skills, id: &str) -> Result<String, Error> {
    let maka_plugins::authorization::Target::Directory { path } =
        skills.user_target().map_err(failure)?
    else {
        return Err(invalid("Invalid user Skill library"));
    };
    Ok(std::path::Path::new(&path)
        .join(".maka/skill-sources")
        .join(id)
        .display()
        .to_string())
}
fn rejected(copy: Copy, cx: &Cx) -> Reply {
    Reply::Rejected {
        message: copy.text(cx),
    }
}

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

use super::authorization::{Consent, authority, consent};
use super::view::reply;
use super::*;
use crate::{
    plugin::remote::{failure, import_view},
    publication::receipt::Operation,
};
use maka_runtime::artifact::content_digest;

pub(super) async fn action(
    skills: &Skills,
    submission: Submission,
    cx: &Cx,
) -> Result<Reply, Error> {
    let route = Route::decode(submission.route.clone())?;
    let stamp = Stamp::decode(&submission.revision)?;
    validate(&route, &submission.action, &stamp)?;
    let expected_fields: &[&str] = match submission.action.as_str() {
        "save" => &["enabled", "pinned"],
        "import" => &["path"],
        _ => &[],
    };
    if submission.fields.len() != expected_fields.len()
        || expected_fields
            .iter()
            .any(|field| !submission.fields.contains_key(*field))
    {
        return Err(invalid("Unexpected Skill action fields"));
    }
    if !route.user_files() && submission.grant.is_some() {
        return Err(invalid("Unexpected Skill authorization"));
    }
    let session = cx.caller.views.session().await?;
    let context = WorkspaceContext {
        workspace: session.workspace.target.clone(),
    };
    let recovery = Recovery {
        route: route.clone(),
        action: submission.action.clone(),
        stamp: submission.revision.clone(),
    };
    let binding = binding(skills, &recovery, &session.workspace.target, cx)?;
    let operation = Operation {
        id: stamp.operation,
        fingerprint: content_digest(
            &serde_json::to_vec(&(&binding, &submission.fields)).map_err(invalid)?,
        ),
        binding,
    };
    // An original result does not confer current foreground authority.
    let grant = if route.user_files() {
        match consent(skills, submission.grant, stamp.operation, cx).await? {
            Consent::Granted(grant) => Some(grant),
            Consent::Needed(request) => return Ok(Reply::Consent { request }),
        }
    } else {
        None
    };
    if submission.action != "save"
        && submission.action != "resume"
        && let Some(record) = skills
            .outcome(operation.id, &operation.binding)
            .await
            .map_err(failure)?
    {
        if record.operation != operation {
            return Err(invalid(
                "Skill operation identity was reused with different input",
            ));
        }
        return Ok(reply(record.outcome, cx));
    }
    if let Route::Skill { reference } = &route {
        let result = skills
            .mutate(
                MutateInput {
                    grant: None,
                    context,
                    expected_revision: stamp.revision,
                    mutation: Mutation::SetPreferences {
                        reference: reference.clone(),
                        enabled: submission.toggle("enabled")?,
                        pinned: submission.toggle("pinned")?,
                    },
                },
                session.workspace,
                session.files,
            )
            .await
            .map_err(failure)?;
        return Ok(match result.outcome {
            MutationOutcome::Committed { .. } | MutationOutcome::Unchanged { .. } => {
                Reply::Applied {
                    route: route.value(),
                }
            }
            MutationOutcome::RevisionConflict { .. } => Reply::Conflict,
            MutationOutcome::Rejected { .. } => Reply::Rejected {
                message: Copy::Rejected.text(cx),
            },
        });
    }
    if matches!(route, Route::Import) {
        let path = submission.text("path")?;
        if path.is_empty() || path.len() > 4096 {
            return Err(invalid("Invalid Skill source path"));
        }
        let caller = cx.caller.clone();
        let source_path = path.to_owned();
        let source = Box::pin(async move {
            import_view(&caller, &source_path)
                .await
                .map_err(|error| crate::plugin::Error::Source(error.to_string()))
        });
        return Ok(reply(
            skills
                .import_operation(
                    ImportSourceInput {
                        source_path: path.into(),
                        grant: grant.expect("user authority"),
                    },
                    source,
                    operation,
                )
                .await
                .map_err(failure)?,
            cx,
        ));
    }
    if matches!(route, Route::Resume) {
        skills
            .resume_user(grant.expect("user authority"))
            .await
            .map_err(failure)?;
        return Ok(Reply::Applied {
            route: Route::default().value(),
        });
    }
    let (mutation, reviewed, source_page) = match route {
        Route::Installed { .. } => (Mutation::CreateStarter, None, None),
        Route::Source { source, id, page } => {
            // Source detail and submit resolve the same bounded domain page.
            let input = match page.cursor {
                Some(cursor) => CatalogInput::Continue {
                    context: context.clone(),
                    view: source.catalog(),
                    revision: cursor.revision,
                    cursor: cursor.cursor,
                },
                None => CatalogInput::Start {
                    context: context.clone(),
                    view: source.catalog(),
                },
            };
            (
                Mutation::Install {
                    source_type: source.install(),
                    source_id: id,
                },
                None,
                Some(input),
            )
        }
        Route::Preview { reference } => {
            let Review::Update { current, source } = stamp.reviewed else {
                return Err(invalid("Missing Skill update review"));
            };
            (
                Mutation::UpdateManaged(ManagedUpdate {
                    reference,
                    confirmation: UpdateConfirmation::Confirmed {
                        current_sha256: current,
                        source_sha256: source,
                    },
                }),
                None,
                None,
            )
        }
        Route::Delete { reference } => {
            let Review::Tree(digest) = stamp.reviewed else {
                return Err(invalid("Missing Skill directory review"));
            };
            (Mutation::Delete { reference }, Some(digest), None)
        }
        _ => return Err(invalid("Unknown Skill file action")),
    };
    Ok(reply(
        skills
            .mutate_operation(
                MutateInput {
                    grant,
                    context,
                    expected_revision: stamp.revision,
                    mutation,
                },
                session.workspace,
                session.files,
                operation,
                reviewed,
                source_page,
            )
            .await
            .map_err(failure)?,
        cx,
    ))
}

pub(super) async fn recover(skills: &Skills, value: Value, cx: &Cx) -> Result<Reply, Error> {
    let recovery: Recovery = serde_json::from_value(value).map_err(invalid)?;
    let stamp = Stamp::decode(&recovery.stamp)?;
    validate(&recovery.route, &recovery.action, &stamp)?;
    if matches!(recovery.action.as_str(), "save" | "resume") {
        return Err(invalid("This Skill action has no operation receipt"));
    }
    let session = cx.caller.views.session().await?;
    let binding = binding(skills, &recovery, &session.workspace.target, cx)?;
    if recovery.route.user_files() {
        authority(skills, stamp.operation, cx).await?;
    }
    Ok(
        match skills
            .outcome(stamp.operation, &binding)
            .await
            .map_err(failure)?
        {
            Some(record) => reply(record.outcome, cx),
            None => Reply::Unrecorded,
        },
    )
}
fn validate(route: &Route, action: &str, stamp: &Stamp) -> Result<(), Error> {
    let valid = matches!(
        (route, action, &stamp.reviewed),
        (Route::Installed { .. }, "starter", Review::None)
            | (Route::Source { .. }, "install", Review::None)
            | (Route::Import, "import", Review::None)
            | (Route::Skill { .. }, "save", Review::None)
            | (Route::Preview { .. }, "apply", Review::Update { .. })
            | (Route::Delete { .. }, "delete", Review::Tree(_))
            | (Route::Resume, "resume", Review::None)
    );
    if valid {
        Ok(())
    } else {
        Err(invalid("Skill action does not match its reviewed route"))
    }
}
fn binding(
    skills: &Skills,
    recovery: &Recovery,
    workspace: &maka_runtime::execution::WorkspaceTarget,
    cx: &Cx,
) -> Result<String, Error> {
    let target = recovery
        .route
        .user_files()
        .then(|| skills.user_target())
        .transpose()
        .map_err(failure)?;
    Ok(content_digest(
        &serde_json::to_vec(&(
            "skills.library.v1",
            cx.session()?,
            workspace,
            recovery,
            target,
        ))
        .map_err(invalid)?,
    ))
}

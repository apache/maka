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

use super::Error;
use crate::{
    SourceCatalog,
    api::*,
    publication::{
        Publisher, Tree,
        receipt::{Destination, Operation},
    },
};
use maka_runtime::artifact::content_digest;
use tokio_util::sync::CancellationToken;

mod update;
pub(super) struct Change {
    pub changed: bool,
    pub reference: Option<String>,
}
pub(super) enum Failure {
    Rejected(MutationRejection),
    Fatal(Error),
}
impl From<Error> for Failure {
    fn from(error: Error) -> Self {
        Self::Fatal(error)
    }
}
impl From<crate::publication::Error> for Failure {
    fn from(error: crate::publication::Error) -> Self {
        use crate::publication::Error as P;
        match error {
            P::Conflict => Self::Rejected(MutationRejection::SourceChanged),
            P::Cancelled => Self::Fatal(Error::Retired),
            P::OutcomeUnknown(message) => Self::Fatal(Error::OutcomeUnknown(message)),
            error => Self::Fatal(Error::Source(error.to_string())),
        }
    }
}
impl From<serde_json::Error> for Failure {
    fn from(error: serde_json::Error) -> Self {
        Self::Fatal(Error::Encoding(error))
    }
}
pub(super) async fn apply(
    publisher: Publisher,
    user: Option<&crate::publication::UserFiles>,
    sources: &SourceCatalog,
    mutation: &Mutation,
    operation: Option<&Operation>,
    reviewed: Option<&str>,
    cancellation: &CancellationToken,
) -> Result<Change, Failure> {
    match mutation {
        Mutation::CreateStarter => starter(&publisher, sources, operation, cancellation).await,
        Mutation::Install {
            source_type,
            source_id,
        } => {
            install(
                &publisher,
                sources,
                *source_type,
                source_id,
                operation,
                cancellation,
            )
            .await
        }
        Mutation::UpdateManaged(update) => {
            update::apply(&publisher, sources, update, operation, cancellation).await
        }
        Mutation::Delete { reference } => {
            let discovery = &sources.publication.discovery;
            if !discovery
                .inventory
                .iter()
                .map(|skill| &skill.location)
                .chain(discovery.rejected.iter().map(|skill| &skill.location))
                .chain(sources.publication.empty.iter())
                .any(|location| location.reference == *reference)
            {
                return Err(Failure::Rejected(MutationRejection::NotFound));
            }
            let (publisher, id) = deletion_target(publisher, user, reference).await?;
            let expected = publisher
                .capture(id, cancellation)
                .await?
                .ok_or(Failure::Rejected(MutationRejection::NotFound))?;
            if let Some(reviewed) = reviewed
                && expected.digest()? != reviewed
            {
                return Err(Failure::Rejected(MutationRejection::SourceChanged));
            }
            publisher
                .publish_operation(
                    id,
                    Some(&expected),
                    None,
                    operation.map(|operation| (operation, Destination::Installed)),
                    cancellation,
                )
                .await?;
            Ok(Change {
                changed: true,
                reference: None,
            })
        }
        _ => unreachable!("file mutation"),
    }
}
pub(super) async fn deletion_target<'a>(
    workspace: Publisher,
    user: Option<&crate::publication::UserFiles>,
    reference: &'a str,
) -> Result<(Publisher, &'a str), Failure> {
    use crate::publication::UserStore;
    if reference.starts_with("workspace:legacy:") {
        return Ok((workspace, workspace_id(reference)?));
    }
    let (store, id) = if let Some(id) = reference.strip_prefix("user:maka:") {
        (UserStore::MakaSkills, id)
    } else if let Some(id) = reference.strip_prefix("user:agents:") {
        (UserStore::AgentSkills, id)
    } else {
        return Err(Failure::Rejected(MutationRejection::BlockedScope));
    };
    if !crate::safe_source_id(id) {
        return Err(Failure::Rejected(MutationRejection::BlockedPath));
    }
    let user = user.ok_or(Failure::Rejected(MutationRejection::BlockedScope))?;
    let publisher = user
        .open(store, workspace, true)
        .await?
        .ok_or(Failure::Rejected(MutationRejection::NotFound))?;
    Ok((publisher, id))
}
fn workspace_id(reference: &str) -> Result<&str, Failure> {
    let id = reference
        .strip_prefix("workspace:legacy:")
        .ok_or(Failure::Rejected(MutationRejection::BlockedScope))?;
    if !crate::safe_source_id(id) {
        return Err(Failure::Rejected(MutationRejection::BlockedPath));
    }
    Ok(id)
}
async fn starter(
    publisher: &Publisher,
    sources: &SourceCatalog,
    operation: Option<&Operation>,
    cancellation: &CancellationToken,
) -> Result<Change, Failure> {
    for ordinal in 1..=99 {
        let id = if ordinal == 1 {
            "starter-skill".into()
        } else {
            format!("starter-skill-{ordinal}")
        };
        let reference = format!("workspace:legacy:{id}");
        if sources
            .publication
            .discovery
            .inventory
            .iter()
            .any(|skill| skill.location.reference == reference)
        {
            return Ok(Change {
                changed: false,
                reference: Some(reference),
            });
        }
    }
    for ordinal in 1..=99 {
        let id = if ordinal == 1 {
            "starter-skill".into()
        } else {
            format!("starter-skill-{ordinal}")
        };
        if sources.publication.occupied.contains(&id.to_lowercase()) {
            continue;
        }
        let name = if ordinal == 1 {
            "示例技能".into()
        } else {
            format!("示例技能 {ordinal}")
        };
        let mut tree = Tree::empty();
        let content = format!(
            "---\nname: {name}\ndescription: 把常用工作流写成可复用的本地指令。\nallowed-tools:\n  - Read\n---\n\n# {name}\n\n先确认目标、输入和交付格式，再阅读必要的上下文并完成任务。\n声明的工具只是需求提示，不会自动获得权限。\n可以编辑或删除 {id} 来替换这个模板。\n"
        );
        tree.insert("SKILL.md", content.into_bytes())?;
        publisher
            .publish_operation(
                &id,
                None,
                Some(&tree),
                operation.map(|operation| {
                    (
                        operation,
                        Destination::Skill {
                            reference: format!("workspace:legacy:{id}"),
                        },
                    )
                }),
                cancellation,
            )
            .await?;
        return Ok(Change {
            changed: true,
            reference: Some(format!("workspace:legacy:{id}")),
        });
    }
    Err(Failure::Rejected(MutationRejection::AlreadyExists))
}
async fn install(
    publisher: &Publisher,
    sources: &SourceCatalog,
    kind: InstallSource,
    id: &str,
    operation: Option<&Operation>,
    cancellation: &CancellationToken,
) -> Result<Change, Failure> {
    if !crate::safe_source_id(id) {
        return Err(Failure::Rejected(MutationRejection::BlockedPath));
    }
    if sources.publication.occupied.contains(&id.to_lowercase()) {
        return Err(Failure::Rejected(MutationRejection::AlreadyExists));
    }
    let content = match kind {
        InstallSource::Bundled => sources
            .bundled
            .iter()
            .find(|source| source.id == id)
            .ok_or(Failure::Rejected(MutationRejection::NotFound))?
            .content
            .as_bytes()
            .to_vec(),
        InstallSource::Managed => source_content(sources, id, cancellation)?,
    };
    let mut tree = Tree::empty();
    artifacts(&mut tree, id, id, kind, content)?;
    publisher
        .publish_operation(
            id,
            None,
            Some(&tree),
            operation.map(|operation| {
                (
                    operation,
                    Destination::Skill {
                        reference: format!("workspace:legacy:{id}"),
                    },
                )
            }),
            cancellation,
        )
        .await?;
    Ok(Change {
        changed: true,
        reference: Some(format!("workspace:legacy:{id}")),
    })
}
fn source_content(
    sources: &SourceCatalog,
    id: &str,
    cancellation: &CancellationToken,
) -> Result<Vec<u8>, Failure> {
    let source = sources
        .managed
        .discovery
        .inventory
        .iter()
        .find(|source| source.location.id == id)
        .ok_or(Failure::Rejected(
            if sources
                .managed
                .discovery
                .rejected
                .iter()
                .any(|source| source.location.id == id)
            {
                MutationRejection::SourceInvalid
            } else {
                MutationRejection::SourceMissing
            },
        ))?;
    if cancellation.is_cancelled() {
        return Err(Failure::Fatal(Error::Retired));
    }
    let bytes = sources
        .managed
        .contents
        .get(&source.location.reference)
        .ok_or(Failure::Rejected(MutationRejection::SourceMissing))?
        .to_vec();
    let content = std::str::from_utf8(&bytes)
        .map_err(|_| Failure::Rejected(MutationRejection::SourceInvalid))?;
    if crate::parse(content).is_err() {
        return Err(Failure::Rejected(MutationRejection::SourceInvalid));
    }
    Ok(bytes)
}
fn artifacts(
    tree: &mut Tree,
    id: &str,
    source_id: &str,
    kind: InstallSource,
    content: Vec<u8>,
) -> Result<(), Failure> {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Lock<'a> {
        schema_version: u32,
        id: &'a str,
        source_type: InstallSource,
        source_name: &'static str,
        source_version: &'static str,
        content_sha256: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        source_id: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        source_content_sha256: Option<&'a str>,
    }
    let hash = content_digest(&content);
    let managed = matches!(kind, InstallSource::Managed);
    let lock = serde_json::to_vec(&Lock {
        schema_version: 1,
        id,
        source_type: kind,
        source_name: if managed {
            "local-library"
        } else {
            "maka-bundled"
        },
        source_version: "1",
        content_sha256: &hash,
        source_id: managed.then_some(source_id),
        source_content_sha256: managed.then_some(hash.as_str()),
    })?;
    tree.insert("SKILL.md", content.clone())?;
    tree.insert(".maka/baseline/SKILL.md", content)?;
    tree.insert("skill.lock.json", lock)?;
    Ok(())
}

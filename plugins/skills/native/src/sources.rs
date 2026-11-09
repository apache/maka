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

//! Explicit standard directories scoped to a checked workspace observation.
use super::*;
use maka_agent_api::contract::Workspace;
use maka_fs_tools::{
    directory,
    workspace::{self, directory::PublishedDirectory},
};
use maka_skills::{LocationId, SkillScope, SkillSource};
use std::path::Path;

#[derive(Clone)]
pub(super) struct CapturedSource {
    pub metadata: Source,
    pub root: ReadRoot,
    pub directory: PathBuf,
    pub prefix: String,
    pub location: Option<LocationId>,
    pub handle: Option<Arc<cap_std::fs::Dir>>,
    scope: SkillScope,
    source: SkillSource,
}
impl CapturedSource {
    pub fn custom(metadata: Source, root: ReadRoot) -> Self {
        Self {
            prefix: format!("source:{}", metadata.id),
            metadata,
            root,
            directory: PathBuf::new(),
            location: None,
            handle: None,
            scope: SkillScope::Custom,
            source: SkillSource::Custom,
        }
    }
    pub fn project(&self) -> bool {
        self.scope == SkillScope::Project
    }
    pub fn contains(&self, reference: &str) -> bool {
        reference.starts_with(&format!("{}:", self.prefix))
    }
    pub fn bind(&self, scope: &Scope) -> maka_skills::Source {
        let access = self.root.bind_scope(scope);
        maka_skills::Source {
            root: access.location(),
            access,
            directory: self.directory.clone(),
            scope: self.scope.clone(),
            source: self.source.clone(),
            reference_prefix: self.prefix.clone(),
        }
    }
}
fn standard(
    root: ReadRoot,
    handle: Arc<cap_std::fs::Dir>,
    path: &Path,
    project: Option<&str>,
) -> Vec<CapturedSource> {
    let ids = if project.is_some() {
        [LocationId::ProjectMaka, LocationId::ProjectAgents]
    } else {
        [LocationId::UserMaka, LocationId::UserAgents]
    };
    ids.into_iter()
        .map(|id| {
            let prefix = project.map_or_else(
                || id.reference().to_owned(),
                |identity| {
                    format!(
                        "project:{identity}:{}",
                        id.reference().split(':').nth(1).unwrap()
                    )
                },
            );
            CapturedSource {
                metadata: Source {
                    id: id.reference().replace(':', "-"),
                    label: format!(
                        "{} {}",
                        if project.is_some() { "Project" } else { "User" },
                        id.directory()
                    ),
                    path: path.join(id.directory()).to_string_lossy().into_owned(),
                },
                root: root.clone(),
                directory: id.directory().into(),
                prefix,
                location: Some(id),
                handle: Some(handle.clone()),
                scope: id.scope(),
                source: id.source(),
            }
        })
        .collect()
}
pub(super) fn home(
    path: &str,
    policy: Arc<maka_sandbox::filesystem::Compiled>,
) -> Result<Vec<CapturedSource>, String> {
    if !Path::new(path).is_absolute() {
        return Err("skills_configuration_invalid".into());
    }
    let (path, identity) =
        directory::capture(Path::new(path)).map_err(|error| error.to_string())?;
    let handle = Arc::new(directory::open(&path, &identity).map_err(|error| error.to_string())?);
    let root = ReadRoot::from_handle(
        handle.try_clone().map_err(|error| error.to_string())?,
        path.clone(),
    )
    .restrict(policy)
    .map_err(|_| "skills_source_unavailable")?;
    Ok(standard(root, handle, &path, None))
}
pub(super) fn projects(
    specs: Vec<maka_host_runtime::DirectoryRootSpec>,
    private: &Path,
) -> Result<Vec<Arc<PublishedDirectory>>, String> {
    maka_host_runtime::DirectoryRootSpec::normalize(specs)
        .map_err(|_| "skills_configuration_invalid")?
        .into_iter()
        .map(|spec| {
            if spec.path.starts_with(private) {
                return Err("skills_configuration_invalid".into());
            }
            PublishedDirectory::open(&spec.path)
                .map(Arc::new)
                .map_err(|_| "skills_configuration_invalid".into())
        })
        .collect()
}
impl Library {
    pub(super) async fn for_workspace(
        &self,
        workspace: Option<Workspace>,
        scope: &Scope,
    ) -> Result<Self, String> {
        if scope.cancellation.is_cancelled() {
            return Err("skills_cancelled".into());
        }
        let mut library = self.clone();
        library.workspace = workspace.clone();
        library.sources.retain(|source| !source.project());
        let Some(workspace) = workspace.filter(|_| !self.projects.is_empty()) else {
            return Ok(library);
        };
        let mut ticket = scope
            .resources
            .reserve()
            .map_err(|_| "skills_call_closed")?;
        let cancellation = scope.cancellation.clone();
        tokio::task::spawn_blocking(move || {
            ticket.start();
            let result = (|| {
                if cancellation.is_cancelled() {
                    return Err("skills_cancelled".into());
                }
                let (path, observed) = directory::capture(Path::new(&workspace.path))
                    .map_err(|_| "skills_workspace_unavailable")?;
                if workspace::project::host_path(&path).ok() != Some(workspace.path.as_str())
                    || observed != workspace.directory_identity
                    || path.starts_with(&library.private)
                {
                    return Err("skills_workspace_unavailable".into());
                }
                let published = library
                    .projects
                    .iter()
                    .find(|root| root.validate(&path).is_ok())
                    .ok_or("skills_workspace_unavailable")?;
                let handle = directory::open(&path, &workspace.directory_identity)
                    .map_err(|_| "skills_workspace_unavailable")?;
                if workspace::read_directory_identity(
                    path.clone(),
                    handle
                        .try_clone()
                        .map_err(|_| "skills_workspace_unavailable")?,
                )
                .map_err(|_| "skills_workspace_unavailable")?
                    != workspace.identity
                {
                    return Err("skills_workspace_unavailable".into());
                }
                published
                    .validate(&path)
                    .map_err(|_| "skills_workspace_unavailable")?;
                let handle = Arc::new(handle);
                let root = ReadRoot::from_handle(
                    handle.try_clone().map_err(|error| error.to_string())?,
                    path.clone(),
                )
                .restrict(library.policy.clone())
                .map_err(|_| "skills_workspace_unavailable")?;
                let identity = maka_agent_facts::artifact::content_digest(
                    &serde_json::to_vec(&workspace).map_err(|_| "skills_workspace_unavailable")?,
                );
                let mut sources = standard(root, handle, &path, Some(&identity[7..]));
                sources.append(&mut library.sources);
                library.sources = sources;
                if cancellation.is_cancelled() {
                    return Err("skills_cancelled".into());
                }
                Ok(library)
            })();
            ticket.complete(Ok(()));
            result
        })
        .await
        .map_err(|_| "skills_workspace_unavailable")?
    }
}

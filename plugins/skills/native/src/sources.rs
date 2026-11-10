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
        let directory = workspace.as_ref().map(|workspace| CandidateDirectory {
            path: workspace.path.clone(),
            directory_identity: workspace.directory_identity.clone(),
        });
        self.for_observation(directory, workspace, scope).await
    }
    pub(super) async fn for_directory(
        &self,
        directory: Option<CandidateDirectory>,
        scope: &Scope,
    ) -> Result<Self, String> {
        self.for_observation(directory, None, scope).await
    }
    async fn for_observation(
        &self,
        directory: Option<CandidateDirectory>,
        workspace: Option<Workspace>,
        scope: &Scope,
    ) -> Result<Self, String> {
        if scope.cancellation.is_cancelled() {
            return Err("skills_cancelled".into());
        }
        let mut library = self.clone();
        library.workspace = workspace.clone();
        library.sources.retain(|source| !source.project());
        let Some(directory) = directory.filter(|_| !self.projects.is_empty()) else {
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
                let (path, observed) = directory::capture(Path::new(&directory.path))
                    .map_err(|_| "skills_workspace_unavailable")?;
                if workspace::project::host_path(&path).ok() != Some(directory.path.as_str())
                    || observed != directory.directory_identity
                    || path.starts_with(&library.private)
                {
                    return Err("skills_workspace_unavailable".into());
                }
                let published = library
                    .projects
                    .iter()
                    .find(|root| root.validate(&path).is_ok())
                    .ok_or("skills_workspace_unavailable")?;
                let handle = directory::open(&path, &directory.directory_identity)
                    .map_err(|_| "skills_workspace_unavailable")?;
                if let Some(workspace) = &workspace
                    && workspace::read_directory_identity(
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
                    &serde_json::to_vec(&directory).map_err(|_| "skills_workspace_unavailable")?,
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

#[cfg(test)]
mod tests {
    use super::*;
    use maka_capabilities::call::{Identity, Issuer};
    use maka_event_log::{
        RootStore,
        root::{RootNamespaces, RootOwner},
    };
    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    fn scope() -> Scope {
        Issuer::default()
            .issue(Identity::Native, CancellationToken::new())
            .unwrap()
    }
    fn write(root: &Path, name: &str, description: &str) {
        let path = root.join(name);
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(
            path.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {description}\n---\nInstructions"),
        )
        .unwrap();
    }
    async fn preferences(base: &Path) -> (preferences::Store, Arc<RootStore>) {
        let root = Arc::new(
            RootOwner::create(
                &base.join("private"),
                &RootNamespaces {
                    ownership: base.join("owners"),
                    control: base.join("control"),
                },
            )
            .unwrap(),
        );
        let log = Arc::new(
            RootStore::open(root, maka_event_log::ROOT_MIGRATIONS)
                .await
                .unwrap(),
        );
        (
            preferences::Store::new(log.clone(), "candidate-test/".into()),
            log,
        )
    }
    pub(crate) async fn workspace(path: &Path) -> Workspace {
        std::fs::create_dir_all(path).unwrap();
        let (path, directory_identity) = directory::capture(path).unwrap();
        let handle = directory::open(&path, &directory_identity).unwrap();
        let private = tempfile::tempdir().unwrap();
        let control = tempfile::tempdir().unwrap();
        let identity = workspace::ensure_directory_identity(
            path.clone(),
            handle,
            private.path().to_owned(),
            control.path().to_owned(),
            None,
        )
        .await
        .unwrap();
        Workspace {
            worktree: None,
            project_id: None,
            path: workspace::project::host_path(&path).unwrap().into(),
            directory_identity,
            identity,
        }
    }

    async fn library(base: &Path) -> (Library, Arc<RootStore>) {
        std::fs::create_dir_all(base.join("home")).unwrap();
        std::fs::create_dir_all(base.join("projects")).unwrap();
        let (preferences, log) = preferences(base).await;
        let library = Library::open(
            Configuration {
                home: Some(base.join("home").to_str().unwrap().into()),
                project_roots: vec![maka_host_runtime::DirectoryRootSpec {
                    label: "Projects".into(),
                    path: base.join("projects"),
                }],
                bundled: false,
                manage: false,
                preferences: true,
                sources: vec![],
            },
            base.canonicalize().unwrap().join("private"),
            preferences,
        )
        .unwrap();
        (library, log)
    }
    #[tokio::test]
    async fn draft_candidates_keep_bound_source_identity_without_initializing_directories() {
        let dir = tempfile::tempdir().unwrap();
        let (library, log) = library(dir.path()).await;
        let call = scope();
        write(
            &dir.path().join("home/.maka/skills"),
            "user-guide",
            "User guidance",
        );
        let project = dir.path().join("projects/new");
        write(
            &project.join(".agents/skills"),
            "project-guide",
            "Project guidance",
        );
        std::fs::write(
            project.join(".agents/skills/project-guide/SKILL.md"),
            "---\nname: project-guide\ndescription: Project guidance\nrequired-tools: FindGuide\n---\nProject instructions",
        )
        .unwrap();
        let global = library
            .candidates(json!({"directory":null,"tools":[],"query":""}), &call)
            .await
            .unwrap();
        assert_eq!(global["totalEligible"], 1);
        assert_eq!(global["matches"][0]["id"], "user-guide");
        let (path, identity) = directory::capture(&project).unwrap();
        let observation = CandidateDirectory {
            path: workspace::project::host_path(&path).unwrap().into(),
            directory_identity: identity,
        };
        let input = json!({"directory":observation,"tools":["FindGuide"],"query":""});
        let local = library.candidates(input.clone(), &call).await.unwrap();
        assert_eq!(local["totalEligible"], 2);
        let selected = local["matches"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == "project-guide")
            .unwrap();
        assert!(selected["ref"].as_str().unwrap().starts_with("project:"));
        let narrowed = library
            .candidates(
                json!({"directory":observation,"tools":[],"query":""}),
                &call,
            )
            .await
            .unwrap();
        assert_eq!(narrowed["totalEligible"], 1);
        assert_eq!(narrowed["matches"][0]["id"], "user-guide");
        assert!(!project.join(workspace::MARKER_FILE).exists());
        let reference = selected["ref"].as_str().unwrap().to_owned();
        let bound = workspace(&project).await;
        let bound_search = library
            .model(
                "search",
                json!({
                    "workspace":bound,"tools":["FindGuide"],"input":{"query":""}
                }),
                &call,
            )
            .await
            .unwrap();
        let bound_project = bound_search["matches"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == "project-guide")
            .unwrap();
        assert_eq!(bound_project["ref"], reference);
        let marker = std::fs::read(project.join(workspace::MARKER_FILE)).unwrap();
        write(
            &project.join(".agents/skills"),
            "aaa-guide",
            "Another project guide",
        );
        let ordinary = library.candidates(input.clone(), &call).await.unwrap();
        assert_eq!(ordinary["matches"][0]["id"], "aaa-guide");
        assert_eq!(
            std::fs::read(project.join(workspace::MARKER_FILE)).unwrap(),
            marker
        );
        log.drain().await;
    }
}

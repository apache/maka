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
fn standard(root: ReadRoot, path: &Path, project: Option<&str>) -> Vec<CapturedSource> {
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
    let root = ReadRoot::capture(path)
        .map_err(|_| "skills_source_unavailable")?
        .restrict(policy)
        .map_err(|_| "skills_source_unavailable")?;
    Ok(standard(root, Path::new(path), None))
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
                let root = ReadRoot::from_handle(handle, path.clone())
                    .restrict(library.policy.clone())
                    .map_err(|_| "skills_workspace_unavailable")?;
                let identity = maka_agent_facts::artifact::content_digest(
                    &serde_json::to_vec(&workspace).map_err(|_| "skills_workspace_unavailable")?,
                );
                let mut sources = standard(root, &path, Some(&identity[7..]));
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
    use crate::tests::{preferences, scope, write};
    use serde_json::json;

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
            path: path.to_str().unwrap().into(),
            directory_identity,
            identity,
        }
    }
    async fn library(base: &Path) -> Library {
        let home = base.join("home");
        let projects = base.join("projects");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&projects).unwrap();
        Library::open(
            Configuration {
                home: Some(home.to_str().unwrap().into()),
                project_roots: vec![maka_host_runtime::DirectoryRootSpec {
                    label: "Projects".into(),
                    path: projects,
                }],
                bundled: false,
                manage: false,
                preferences: true,
                sources: vec![],
            },
            base.canonicalize().unwrap().join("private"),
            preferences(base).await,
        )
        .unwrap()
    }
    #[tokio::test]
    async fn standard_sources_keep_missing_directories_project_precedence_and_preference_identity()
    {
        let dir = tempfile::tempdir().unwrap();
        let library = library(dir.path()).await;
        let call = scope();
        let a = workspace(&dir.path().join("projects/a")).await;
        let b = workspace(&dir.path().join("projects/b")).await;
        assert!(library.snapshot(&call).await.unwrap().entries.is_empty());
        // Parent handles are captured before the optional conventional directories exist.
        write(
            &dir.path().join("home/.maka/skills"),
            "review",
            "home instructions",
        );
        write(
            &dir.path().join("home/.agents/skills"),
            "review",
            "home fallback",
        );
        write(
            &Path::new(&a.path).join(".maka/skills"),
            "review",
            "project A",
        );
        write(
            &Path::new(&a.path).join(".agents/skills"),
            "review",
            "project fallback",
        );
        write(
            &Path::new(&b.path).join(".maka/skills"),
            "review",
            "project B",
        );
        let a_library = library.for_workspace(Some(a.clone()), &call).await.unwrap();
        let a_page = a_library.snapshot(&call).await.unwrap();
        let reference = a_page
            .entries
            .iter()
            .find(|(entry, _, _)| entry.shadowed_by.is_none())
            .unwrap()
            .0
            .reference
            .clone();
        assert_eq!(a_page.entries.len(), 4);
        assert!(
            a_page
                .entries
                .iter()
                .filter(|(entry, _, _)| entry.reference != reference)
                .all(|(entry, _, _)| entry.shadowed_by.as_deref() == Some(reference.as_str()))
        );
        let search = |workspace: &Workspace| json!({"workspace":workspace,"tools":[],"input":{"query":"review"}});
        let a_search = library.model("search", search(&a), &call).await.unwrap();
        let b_search = library.model("search", search(&b), &call).await.unwrap();
        assert_ne!(a_search["revision"], b_search["revision"]);
        assert_ne!(a_search["matches"][0]["ref"], b_search["matches"][0]["ref"]);
        let loaded=library.model("load",json!({"workspace":a,"tools":[],"input":{"name":"review","revision":a_search["revision"]}}),&call).await.unwrap();
        assert_eq!(loaded["instructions"], "project A");
        let crossed=library.model("load",json!({"workspace":b,"tools":[],"input":{"name":"review","revision":a_search["revision"]}}),&call).await.unwrap();
        assert_eq!(crossed["kind"], "changed");
        assert!(matches!(
            library
                .preferences
                .set(
                    SetPreference {
                        reference,
                        revision: 0,
                        preference: maka_skills::Preference {
                            enabled: false,
                            pinned: true
                        }
                    },
                    &call
                )
                .await
                .unwrap(),
            PreferenceResult::Applied { .. }
        ));
        assert_eq!(
            library.model("search", search(&a), &call).await.unwrap()["totalEligible"],
            0
        );
        assert_eq!(
            library.model("search", search(&b), &call).await.unwrap()["totalEligible"],
            1
        );
        assert_eq!(
            library
                .model(
                    "search",
                    json!({"tools":[],"input":{"query":"review"}}),
                    &call
                )
                .await
                .unwrap()["totalEligible"],
            1
        );
        let b_library = library.for_workspace(Some(b.clone()), &call).await.unwrap();
        assert!(matches!(
            b_library
                .snapshot(&call)
                .await
                .unwrap()
                .read(Read {
                    workspace: Some(b),
                    reference: a_page.entries[0].0.reference.clone(),
                    revision: a_page.revision,
                    offset: 0
                })
                .unwrap(),
            Document::Changed
        ));
        std::fs::remove_dir_all(dir.path().join("home/.maka/skills")).unwrap();
        assert_eq!(library.snapshot(&call).await.unwrap().entries.len(), 1);
        call.finish().await.unwrap();
        assert!(library.for_workspace(Some(a), &call).await.is_err());
    }
    #[tokio::test]
    async fn standard_sources_reject_private_aliases_replacements_and_changed_markers() {
        let dir = tempfile::tempdir().unwrap();
        let library = library(dir.path()).await;
        let call = scope();
        let a = workspace(&dir.path().join("projects/a")).await;
        let outside = workspace(&dir.path().join("outside")).await;
        assert!(library.for_workspace(Some(outside), &call).await.is_err());
        let private = workspace(&dir.path().join("private")).await;
        let mut wide = library.clone();
        wide.projects = vec![Arc::new(PublishedDirectory::open(dir.path()).unwrap())];
        assert!(
            wide.for_workspace(Some(private.clone()), &call)
                .await
                .is_err()
        );
        #[cfg(unix)]
        {
            let alias = dir.path().join("projects/alias");
            std::os::unix::fs::symlink(&private.path, &alias).unwrap();
            let mut observation = private;
            observation.path = alias.to_str().unwrap().into();
            assert!(
                library
                    .for_workspace(Some(observation), &call)
                    .await
                    .is_err()
            );
            let escaped = dir.path().join("projects/a/.agents");
            std::os::unix::fs::symlink(dir.path().join("home"), &escaped).unwrap();
            write(
                &dir.path().join("home/skills"),
                "secret",
                "not a project skill",
            );
            let selected = library.for_workspace(Some(a.clone()), &call).await.unwrap();
            let snapshot = selected.snapshot(&call).await.unwrap();
            assert!(snapshot.entries.is_empty());
            assert!(!snapshot.diagnostics.is_empty());
        }
        let mut marker = a.clone();
        marker.identity = workspace(&dir.path().join("projects/b")).await.identity;
        assert!(library.for_workspace(Some(marker), &call).await.is_err());
        std::fs::rename(&a.path, dir.path().join("projects/original")).unwrap();
        let _replacement = workspace(Path::new(&a.path)).await;
        assert!(library.for_workspace(Some(a), &call).await.is_err());
        let b = workspace(&dir.path().join("projects/c")).await;
        std::fs::rename(dir.path().join("projects"), dir.path().join("old-projects")).unwrap();
        std::fs::create_dir_all(dir.path().join("projects")).unwrap();
        assert!(library.for_workspace(Some(b), &call).await.is_err());
        call.finish().await.unwrap();
    }
}

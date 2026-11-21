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
use maka_fs_tools::{directory, workspace};
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
impl Library {
    pub(super) async fn for_workspace(
        &self,
        workspace: Option<Workspace>,
        scope: &Scope,
    ) -> Result<Self, String> {
        let directory = workspace.as_ref().map(|workspace| CandidateDirectory {
            path: workspace.path.clone(),
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
                let (path, handle, _) = directory::capture_directory(Path::new(&directory.path))
                    .map_err(|_| "skills_workspace_unavailable")?;
                if workspace::project::host_path(&path).ok() != Some(directory.path.as_str()) {
                    return Err("skills_workspace_unavailable".into());
                }
                let policy =
                    if let Some(binding) = workspace.as_ref().and_then(|ws| ws.worktree.as_ref()) {
                        if binding.directory() != Path::new(&directory.path) {
                            return Err("skills_workspace_unavailable".into());
                        }
                        maka_fs_tools::worktree::Worktrees::open(
                            &library.private.join("subagent-worktrees"),
                        )
                        .and_then(|worktrees| worktrees.inspect(binding))
                        .map_err(|_| "skills_workspace_unavailable")?;
                        if !library
                            .projects
                            .iter()
                            .any(|root| root.validate(binding.source()).is_ok())
                        {
                            return Err("skills_workspace_unavailable".into());
                        }
                        // Managed subagent worktrees live inside private/subagent-worktrees,
                        // so carve out read-only access for this verified worktree while keeping
                        // the rest of library.private denied.
                        let private_policy = workspace::project::host_path(&library.private)
                            .map_err(|_| "skills_workspace_unavailable")?;
                        Arc::new(
                            Policy {
                                default: Access::Read,
                                rules: vec![
                                    Rule::subtree(private_policy, Access::Deny),
                                    Rule::subtree(directory.path.as_str(), Access::Read),
                                ],
                                deny_globs: vec![],
                            }
                            .compile()
                            .map_err(|_| "skills_workspace_unavailable")?,
                        )
                    } else {
                        if path.starts_with(&library.private)
                            || !library
                                .projects
                                .iter()
                                .any(|root| root.validate(&path).is_ok())
                        {
                            return Err("skills_workspace_unavailable".into());
                        }
                        library.policy.clone()
                    };
                let handle = Arc::new(handle);
                let root = ReadRoot::from_handle(
                    handle.try_clone().map_err(|error| error.to_string())?,
                    path.clone(),
                )
                .restrict(policy)
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
        let (path, _) = directory::capture(path).unwrap();
        Workspace {
            worktree: None,
            project_id: None,
            path: workspace::project::host_path(&path).unwrap().into(),
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
        let (path, _) = directory::capture(&project).unwrap();
        let observation = CandidateDirectory {
            path: workspace::project::host_path(&path).unwrap().into(),
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
        std::fs::remove_dir_all(&project).unwrap();
        write(
            &project.join(".agents/skills"),
            "project-guide",
            "Project guidance",
        );
        write(
            &project.join(".agents/skills"),
            "aaa-guide",
            "Another project guide",
        );
        let rebound_search = library
            .model(
                "search",
                json!({
                    "workspace":bound,"tools":["FindGuide"],"input":{"query":""}
                }),
                &call,
            )
            .await
            .unwrap();
        let rebound_project = rebound_search["matches"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == "project-guide")
            .unwrap();
        assert_eq!(rebound_project["ref"], reference);
        let ordinary = library.candidates(input.clone(), &call).await.unwrap();
        assert_eq!(ordinary["matches"][0]["id"], "aaa-guide");
        assert!(!project.join(".maka-workspace.json").exists());
        log.drain().await;
    }

    #[tokio::test]
    async fn managed_subagent_worktree_allows_project_skills_while_protecting_private_root() {
        use maka_fs_tools::worktree::Worktrees;
        use std::process::Command;
        use std::sync::atomic::AtomicBool;

        let dir = tempfile::tempdir().unwrap();
        let (library, log) = library(dir.path()).await;
        let call = scope();
        let repo = dir.path().join("projects/repo");
        std::fs::create_dir_all(&repo).unwrap();
        write(&repo.join(".agents/skills"), "wt-skill", "Worktree skill");
        for args in [
            &["init", "-q"][..],
            &["config", "user.email", "t@example.com"][..],
            &["config", "user.name", "Test"][..],
            &["add", "."][..],
            &["commit", "-q", "-m", "init"][..],
        ] {
            assert!(
                Command::new("git")
                    .args(args)
                    .current_dir(&repo)
                    .status()
                    .unwrap()
                    .success()
            );
        }

        // Allocate a real managed subagent worktree under private/subagent-worktrees.
        let private = dir.path().canonicalize().unwrap().join("private");
        let manager = Worktrees::open(&private.join("subagent-worktrees")).unwrap();
        let binding = manager
            .plan(&repo, &"a".repeat(64), Arc::new(AtomicBool::new(false)))
            .unwrap();
        manager.ensure(&binding, &AtomicBool::new(false)).unwrap();

        let wt_workspace = Workspace {
            path: workspace::project::host_path(binding.directory())
                .unwrap()
                .into(),
            project_id: None,
            worktree: Some(Box::new(binding.clone())),
        };

        // 1. Both prepare (used by SessionSend) and search succeed on the managed worktree.
        let prepared = library
            .model(
                "prepare",
                json!({
                    "workspace": wt_workspace,
                    "tools": ["Skill", "SkillSearch"],
                    "input": {
                        "language": "en",
                        "message": "Run tests in this worktree",
                        "loadTool": "Skill",
                        "searchTool": "SkillSearch"
                    }
                }),
                &call,
            )
            .await
            .expect("managed worktree should pass skills prepare");
        assert_eq!(prepared["kind"], "ready", "{prepared}");

        let searched = library
            .model(
                "search",
                json!({
                    "workspace": wt_workspace,
                    "tools": [],
                    "input": {"query": ""}
                }),
                &call,
            )
            .await
            .expect("managed worktree should discover project skills");
        assert!(
            searched["matches"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["id"] == "wt-skill"),
            "{searched}"
        );

        // 1b. A symlink inside the managed worktree escaping back into another path under
        //     private must still be denied by the policy.
        #[cfg(unix)]
        {
            write(&private.join("secret-skills"), "leaked-skill", "Secret");
            std::os::unix::fs::symlink(
                private.join("secret-skills/leaked-skill"),
                binding.directory().join(".agents/skills/leaked-skill"),
            )
            .unwrap();
            let after_symlink = library
                .model(
                    "search",
                    json!({"workspace": wt_workspace, "tools": [], "input": {"query": ""}}),
                    &call,
                )
                .await
                .expect("worktree search should remain available");
            assert!(
                !after_symlink["matches"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|entry| entry["id"] == "leaked-skill"),
                "symlink escaping into private root must not be read: {after_symlink}"
            );
        }

        // 2. A plain directory workspace pointing into private/subagent-worktrees without
        //    a verified worktree binding must still be rejected.
        let bare_private = Workspace {
            path: wt_workspace.path.clone(),
            project_id: None,
            worktree: None,
        };
        let bare_err = library
            .model(
                "search",
                json!({"workspace": bare_private, "tools": [], "input": {"query": ""}}),
                &call,
            )
            .await
            .unwrap_err();
        assert_eq!(bare_err, "skills_workspace_unavailable");

        // 3. A managed worktree sourced from a repo outside projects/ must still be rejected.
        let outside = dir.path().join("outside-repo");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("README.md"), "outside").unwrap();
        for args in [
            &["init", "-q"][..],
            &["config", "user.email", "t@example.com"][..],
            &["config", "user.name", "Test"][..],
            &["add", "."][..],
            &["commit", "-q", "-m", "init"][..],
        ] {
            assert!(
                Command::new("git")
                    .args(args)
                    .current_dir(&outside)
                    .status()
                    .unwrap()
                    .success()
            );
        }
        let outside_binding = manager
            .plan(&outside, &"b".repeat(64), Arc::new(AtomicBool::new(false)))
            .unwrap();
        manager
            .ensure(&outside_binding, &AtomicBool::new(false))
            .unwrap();
        let outside_ws = Workspace {
            path: workspace::project::host_path(outside_binding.directory())
                .unwrap()
                .into(),
            project_id: None,
            worktree: Some(Box::new(outside_binding)),
        };
        let outside_err = library
            .model(
                "search",
                json!({"workspace": outside_ws, "tools": [], "input": {"query": ""}}),
                &call,
            )
            .await
            .unwrap_err();
        assert_eq!(outside_err, "skills_workspace_unavailable");

        log.drain().await;
    }
}

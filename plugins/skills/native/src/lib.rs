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

//! Ordinary skill library service, reusing the original capability-scoped discovery/parser.
//! Files are data; neither references nor declared tools authorize execution.
use maka_skills_api::contract;
mod management;
mod model;
pub mod outcomes;
mod preferences;
mod preparation;
use contract::*;
use futures_util::future::BoxFuture;
use maka_capabilities::call::Scope;
use maka_capabilities::filesystem::ReadRoot;
use maka_host_runtime::application::{
    Context, Handler, NativeActivation, NativeContext, NativeOwner, NativeRegistry,
};
use maka_sandbox::filesystem::{Access, Policy, Rule};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::Arc,
};

mod imports;
mod sources;
use sources::CapturedSource;

use maka_skills_api::{EXPORT, IMPLEMENTATION};
// Even maximally escaped control bytes leave room for metadata in the JSON budget.
const TEXT_BYTES: usize = 4096;

pub fn provide(registry: &mut NativeRegistry) -> Result<(), String> {
    registry.insert(
        maka_skills_api::IMPLEMENTATION.into(),
        Arc::new(|context, configuration| Box::pin(activate(context, configuration))),
    )?;
    outcomes::provide(registry)
}
async fn activate(context: NativeContext, configuration: Value) -> NativeActivation {
    let opened = async {
        let persistence = context.persistence().ok_or("skills_require_persistence")?;
        let root = persistence
            .store()
            .owned_root()
            .map_err(|_| "skills_root_unavailable")?;
        let managed = root.canonical_path().to_owned();
        let configuration: Configuration =
            serde_json::from_value(configuration).map_err(|_| "skills_configuration_invalid")?;
        let manage = configuration.manage;
        let namespace = maka_host_runtime::storage::instance_prefix(
            &persistence.source().state_domain,
            persistence.source().deployment,
            context.activation().instance(),
        );
        let preferences = preferences::Store::new(persistence.store().clone(), namespace.clone());
        let mut library =
            tokio::task::spawn_blocking(move || Library::open(configuration, managed, preferences))
                .await
                .map_err(|_| "skills_open_failed")??;
        if manage {
            library.managed = Some(management::Managed::open(root, namespace).await?);
        }
        Ok::<_, String>(library)
    }
    .await;
    match opened {
        Ok(owner) => {
            let owner = Arc::new(owner);
            NativeActivation {
                exports: Ok(BTreeMap::from([(
                    EXPORT.into(),
                    maka_plugin_core::runtime::Published {
                        contract: contract(),
                        value: owner.clone() as Arc<dyn Handler>,
                    },
                )])),
                owner,
            }
        }
        Err(error) => NativeActivation {
            exports: Err(error),
            owner: Arc::new(()),
        },
    }
}
#[derive(Clone)]
struct Library {
    bundled: bool,
    sources: Vec<CapturedSource>,
    projects: Vec<Arc<maka_fs_tools::workspace::directory::PublishedDirectory>>,
    private: PathBuf,
    workspace: Option<maka_agent_api::contract::Workspace>,
    policy: Arc<maka_sandbox::filesystem::Compiled>,
    preferences: preferences::Store,
    preferences_writable: bool,
    managed: Option<Arc<management::Managed>>,
}
impl Library {
    fn open(
        configuration: Configuration,
        managed: PathBuf,
        preferences: preferences::Store,
    ) -> Result<Self, String> {
        if configuration.bundled {
            maka_skills::prepare_bundled().map_err(|_| "skills_bundled_unavailable")?;
        }
        let mut ids = BTreeSet::new();
        let policy = Arc::new(
            Policy {
                default: Access::Read,
                rules: vec![Rule::subtree(&managed, Access::Deny)],
                deny_globs: vec![],
            }
            .compile()
            .map_err(|_| "skills_configuration_invalid")?,
        );
        let mut sources = Vec::new();
        for source in configuration.sources {
            if source.id.is_empty()
                || !source
                    .id
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-')
                || !source.id.as_bytes()[0].is_ascii_alphanumeric()
                || !ids.insert(source.id.clone())
                || source.label.trim().is_empty()
                || !std::path::Path::new(&source.path).is_absolute()
            {
                return Err("skills_configuration_invalid".into());
            }
            let root = ReadRoot::capture(&source.path)
                .map_err(|_| "skills_source_unavailable")?
                .restrict(policy.clone())
                .map_err(|_| "skills_source_unavailable")?;
            sources.push(CapturedSource::custom(source, root));
        }
        if let Some(home) = configuration.home {
            sources.extend(sources::home(&home, policy.clone())?);
        }
        let projects = sources::projects(configuration.project_roots, &managed)?;
        Ok(Self {
            projects,
            private: managed,
            workspace: None,
            policy,
            bundled: configuration.bundled,
            sources,
            preferences,
            preferences_writable: configuration.preferences,
            managed: None,
        })
    }
    async fn discover(&self, scope: &Scope) -> Result<maka_skills::DiscoverySnapshot, String> {
        let mut sources: Vec<_> = self
            .sources
            .iter()
            .map(|source| source.bind(scope))
            .collect();
        if let Some(managed) = &self.managed {
            let access = managed.read.bind_scope(scope);
            sources.insert(
                self.sources.iter().take_while(|s| s.project()).count(),
                maka_skills::Source {
                    root: access.location(),
                    access,
                    directory: PathBuf::from("skills"),
                    scope: maka_skills::SkillScope::Workspace,
                    source: maka_skills::SkillSource::Maka,
                    reference_prefix: "installed".into(),
                },
            );
        }
        let snapshot = if self.bundled {
            maka_skills::scan_with_bundled(&sources, &scope.cancellation).await
        } else {
            maka_skills::scan(&sources, &scope.cancellation).await
        };
        snapshot.map_err(|_| "skills_discovery_unavailable".into())
    }
    async fn snapshot(&self, scope: &Scope) -> Result<Snapshot, String> {
        let mut discovery = self.discover(scope).await?;
        let mut imported_diagnostics = Vec::new();
        if let Some(managed) = &self.managed {
            let imported = managed.imported_snapshot(scope).await?;
            discovery.inventory.extend(imported.inventory);
            discovery.rejected.extend(imported.rejected);
            imported_diagnostics = imported
                .diagnostics
                .iter()
                .map(|diagnostic| format!("Imported: {:?}", diagnostic.reason))
                .collect();
        }
        let preferences = self.preferences.read(scope).await?;
        let label = |reference: &str| {
            if reference.starts_with("imported:") {
                return "Imported";
            }
            if reference.starts_with("bundled:") {
                return "Built-in";
            }
            if reference.starts_with("installed:") {
                return "Installed";
            }
            self.sources
                .iter()
                .find(|source| source.contains(reference))
                .map(|source| source.metadata.label.as_str())
                .unwrap_or("")
        };
        let mut entries = Vec::new();
        for skill in discovery.inventory {
            let entry = entry(
                &skill.location.reference,
                label(&skill.location.reference),
                &skill.document.manifest.name,
                &skill.document.manifest.description,
                true,
                skill.shadowed_by,
                &skill.document.issues,
            );
            entries.push((entry, skill.content_sha256, skill.document.body));
        }
        for skill in discovery.rejected {
            let entry = entry(
                &skill.location.reference,
                label(&skill.location.reference),
                skill
                    .document
                    .manifest
                    .name
                    .as_deref()
                    .unwrap_or(&skill.location.id),
                skill.document.manifest.description.as_deref().unwrap_or(""),
                false,
                None,
                &skill.document.issues,
            );
            entries.push((entry, skill.content_sha256, skill.document.body));
        }
        for (entry, _, _) in &mut entries {
            if entry.imported {
                entry.preference = maka_skills::Preference {
                    enabled: false,
                    pinned: false,
                };
                continue;
            }
            entry.preference = preferences
                .entries
                .get(&entry.reference)
                .copied()
                .unwrap_or_default();
        }
        entries.sort_by(|a, b| a.0.reference.cmp(&b.0.reference));
        let diagnostics: Vec<_> = discovery
            .diagnostics
            .iter()
            .map(|diagnostic| {
                let project_count = self
                    .sources
                    .iter()
                    .take_while(|source| source.project())
                    .count();
                let label = if self.managed.is_some() && diagnostic.precedence == project_count {
                    "Installed"
                } else {
                    &self.sources[diagnostic.precedence
                        - usize::from(
                            self.managed.is_some() && diagnostic.precedence > project_count,
                        )]
                    .metadata
                    .label
                };
                format!("{label}: {:?}", diagnostic.reason)
            })
            .chain(imported_diagnostics)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let revision = maka_agent_facts::artifact::content_digest(
            &serde_json::to_vec(&(
                &self.workspace,
                self.managed.is_some(),
                self.preferences_writable,
                preferences.revision,
                self.sources
                    .iter()
                    .map(|source| (&source.metadata, &source.directory, &source.prefix))
                    .collect::<Vec<_>>(),
                entries
                    .iter()
                    .map(|(entry, digest, _)| (entry, digest))
                    .collect::<Vec<_>>(),
                &diagnostics,
            ))
            .map_err(|_| "skills_encoding_failed")?,
        );
        Ok(Snapshot {
            writable: self.managed.is_some(),
            preferences_writable: self.preferences_writable,
            preference_revision: preferences.revision,
            entries,
            diagnostics,
            revision,
        })
    }
}
struct Snapshot {
    writable: bool,
    preferences_writable: bool,
    preference_revision: u64,
    entries: Vec<(Entry, String, String)>,
    diagnostics: Vec<String>,
    revision: String,
}
fn bound(value: &str, limit: usize) -> String {
    let mut end = value.len().min(limit);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}
fn entry(
    reference: &str,
    source: &str,
    name: &str,
    description: &str,
    valid: bool,
    shadowed_by: Option<String>,
    issues: &[maka_skills::Issue],
) -> Entry {
    Entry {
        bundled: reference.starts_with("bundled:"),
        installed: reference.starts_with("installed:"),
        imported: reference.starts_with("imported:"),
        preference: Default::default(),
        reference: reference.into(),
        source: source.into(),
        name: name.into(),
        description: description.into(),
        valid,
        shadowed_by,
        issues: issues.iter().map(|issue| issue.message.clone()).collect(),
    }
}
impl Snapshot {
    fn list(self, input: List) -> Result<Page, String> {
        let query = input.query.to_lowercase();
        let filtered: Vec<_> = self
            .entries
            .into_iter()
            .filter(|(entry, _, _)| {
                query.split_whitespace().all(|term| {
                    format!(
                        "{} {} {} {}",
                        entry.reference, entry.source, entry.name, entry.description
                    )
                    .to_lowercase()
                    .contains(term)
                })
            })
            .map(|(entry, _, _)| entry)
            .collect();
        let offset = match input.cursor {
            Some(cursor) if cursor.revision != self.revision => return Ok(Page::Changed),
            Some(cursor) if cursor.query != input.query => {
                return Err("skills_cursor_invalid".into());
            }
            Some(cursor) => cursor.offset,
            None => 0,
        };
        if offset > filtered.len() {
            return Err("skills_cursor_invalid".into());
        }
        let mut entries = Vec::new();
        let after = |n| {
            (offset + n < filtered.len()).then(|| Cursor {
                revision: self.revision.clone(),
                query: input.query.clone(),
                offset: offset + n,
            })
        };
        for entry in filtered.iter().skip(offset).take(32) {
            entries.push(entry.clone());
            let page = Page::Page {
                writable: self.writable,
                preferences_writable: self.preferences_writable,
                preference_revision: self.preference_revision,
                revision: self.revision.clone(),
                entries: entries.clone(),
                after: after(entries.len()),
                diagnostics: self.diagnostics.clone(),
            };
            if entries.len() > 1 && !maka_workspace_support::fits(&page) {
                entries.pop();
                break;
            }
        }
        let after = after(entries.len());
        Ok(Page::Page {
            writable: self.writable,
            preferences_writable: self.preferences_writable,
            preference_revision: self.preference_revision,
            revision: self.revision,
            after,
            entries,
            diagnostics: self.diagnostics,
        })
    }
    fn read(self, input: Read) -> Result<Document, String> {
        if input.revision != self.revision {
            return Ok(Document::Changed);
        }
        let Some((entry, _, text)) = self
            .entries
            .into_iter()
            .find(|(entry, _, _)| entry.reference == input.reference)
        else {
            return Ok(Document::Unavailable);
        };
        let start = input.offset;
        if start > text.len() || !text.is_char_boundary(start) {
            return Err("skills_position_invalid".into());
        }
        let mut end = (start + TEXT_BYTES).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        let mut before = start.saturating_sub(TEXT_BYTES);
        while !text.is_char_boundary(before) {
            before += 1;
        }
        Ok(Document::Page {
            writable: self.writable && !entry.bundled,
            preferences_writable: self.preferences_writable,
            preference_revision: self.preference_revision,
            entry: Box::new(entry),
            revision: self.revision,
            text: text[start..end].into(),
            offset: start,
            before: (start > 0).then_some(before),
            after: (end < text.len()).then_some(end),
            total_bytes: text.len(),
        })
    }
}
fn encode(value: impl Serialize) -> Result<Value, String> {
    let value = serde_json::to_value(value).map_err(|_| "skills_encoding_failed")?;
    Ok(value)
}
impl Handler for Library {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, Result<Value, String>> {
        let library = self.clone();
        Box::pin(async move {
            match method.as_str() {
                "prepare" | "search" | "load" => {
                    library.model(&method, input, context.scope()).await
                }
                "list" => {
                    let input =
                        serde_json::from_value(input).map_err(|_| "skills_query_invalid")?;
                    let input: List = input;
                    let library = library
                        .for_workspace(input.workspace.clone(), context.scope())
                        .await?;
                    encode(library.snapshot(context.scope()).await?.list(input)?)
                }
                "read" => {
                    let input =
                        serde_json::from_value(input).map_err(|_| "skills_query_invalid")?;
                    let input: Read = input;
                    let library = library
                        .for_workspace(input.workspace.clone(), context.scope())
                        .await?;
                    encode(library.snapshot(context.scope()).await?.read(input)?)
                }
                "preview" => {
                    let input =
                        serde_json::from_value(input).map_err(|_| "skills_change_invalid")?;
                    let input: Change = input;
                    let library = library
                        .for_workspace(input.workspace.clone(), context.scope())
                        .await?;
                    encode(library.preview(input, context.scope()).await?)
                }
                "setPreference" => {
                    let input =
                        serde_json::from_value(input).map_err(|_| "skills_preference_invalid")?;
                    context.operation().ok_or("skills_mutation_required")?;
                    let input: SetPreference = input;
                    if input.reference.starts_with("imported:") {
                        return encode(PreferenceResult::Rejected {
                            reason: "read_only_source".into(),
                        });
                    }
                    if !library.preferences_writable {
                        return encode(PreferenceResult::Rejected {
                            reason: "read_only_preferences".into(),
                        });
                    }
                    encode(library.preferences.set(input, context.scope()).await?)
                }
                "importSource" => {
                    let input =
                        serde_json::from_value(input).map_err(|_| "skills_change_invalid")?;
                    let operation = context.operation().ok_or("skills_mutation_required")?;
                    encode(
                        library
                            .import_source(
                                input,
                                operation,
                                context.scope(),
                                context.attachments().clone(),
                            )
                            .await?,
                    )
                }
                "apply" | "deleteSource" => {
                    let input =
                        serde_json::from_value(input).map_err(|_| "skills_change_invalid")?;
                    let operation = context.operation().ok_or("skills_mutation_required")?;
                    let input: Review = input;
                    let library = library
                        .for_workspace(input.change.workspace.clone(), context.scope())
                        .await?;
                    encode(if method == "deleteSource" {
                        library
                            .delete_source(
                                input,
                                &management::operation(operation)?,
                                context.scope(),
                            )
                            .await?
                    } else {
                        library.apply(input, operation, context.scope()).await?
                    })
                }
                _ => Err("skills_method_unavailable".into()),
            }
        })
    }
}
impl NativeOwner for Library {
    fn execution_basis(&self) -> Option<Value> {
        let sources = self
            .sources
            .iter()
            .map(|source| source.root.execution_basis())
            .collect::<std::io::Result<Vec<_>>>()
            .ok()?;
        let projects = self
            .projects
            .iter()
            .map(|project| {
                project
                    .identity()
                    .map(|identity| (project.path(), identity))
            })
            .collect::<std::io::Result<Vec<_>>>()
            .ok()?;
        let managed = match &self.managed {
            Some(managed) => Some(managed.execution_basis()?),
            None => None,
        };
        // Source order and metadata come from configuration. Held directories,
        // the private boundary and persistent stores are additional captures.
        serde_json::to_value((
            sources,
            projects,
            &self.private,
            self.preferences.execution_basis()?,
            managed,
        ))
        .ok()
    }
    fn prepare_retirement(
        &self,
    ) -> Option<Box<dyn maka_host_runtime::application::NativeRetirement>> {
        Some(Box::new(()))
    }
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        // All reads retain their original call's resource group. No independent
        // background scan, process, watcher or mutable catalog is owned here.
        Box::pin(async { Ok(()) })
    }
}
#[cfg(test)]
mod tests;

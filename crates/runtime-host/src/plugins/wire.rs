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
use super::{Error, Mutation, Platform, Snapshot};
use maka_plugins::{
    composition::{Entry, Scope},
    fiber::Phase,
    package::Package,
};
use maka_protocol::{OperationError, OperationErrorCode as Code, plugin::*};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

impl Platform {
    pub async fn execute(&self, input: Input) -> Result<Value, OperationError> {
        match input {
            Input::Remote(_) | Input::Authorization(_) => Err(failure(
                Code::OperationUnavailable,
                "Remote requires an authenticated Client connection",
            )),
            Input::Client(query) => encode(self.client_query(query)?),
            Input::Query(query) => self.query(query),
            Input::Preview { source_path } => {
                let package = read_source(source_path.clone()).await?;
                // Source reads and the current installed target are independent;
                // the precondition pins this single resulting authority snapshot.
                let snapshot = self.snapshot();
                let preview = encode(PackagePreview {
                    source_path,
                    expected: PackagePrecondition {
                        base_generation: snapshot.ledger.generation,
                        content_digest: snapshot
                            .packages
                            .get(&package.manifest().id)
                            .map(|installed| installed.digest().into()),
                    },
                    package: package_projection(&snapshot, &package),
                })?;
                if serde_json::to_vec(&preview).map_err(internal)?.len() > 128 * 1024 {
                    return Err(failure(
                        Code::OperationUnavailable,
                        "Package preview exceeds the protocol budget",
                    ));
                }
                Ok(preview)
            }
            Input::Export {
                extension_id,
                target_path,
            } => {
                let package = self
                    .snapshot()
                    .packages
                    .get(&extension_id)
                    .cloned()
                    .ok_or_else(|| failure(Code::NotFound, "Package is not installed"))?;
                let path = target_path.clone();
                tokio::task::spawn_blocking(move || package.export_to(std::path::Path::new(&path)))
                    .await
                    .map_err(internal)?
                    .map_err(|e| failure(Code::PersistenceFailed, e.to_string()))?;
                encode(Exported { target_path })
            }
            input => {
                let mut installed = None;
                let mutation = match input {
                    Input::Install(PackageInstall {
                        source_path,
                        source_digest,
                        expected,
                    }) => {
                        let package = read_source(source_path).await?;
                        if source_digest
                            .as_deref()
                            .is_some_and(|digest| digest != package.digest())
                        {
                            return Err(failure(
                                Code::OperationConflict,
                                "Package source changed since preview",
                            ));
                        }
                        installed = Some(package.manifest().id.clone());
                        Mutation::Install { package, expected }
                    }
                    Input::Apply(Apply {
                        base_generation,
                        operations,
                    }) => Mutation::Apply {
                        base_generation,
                        operations,
                    },
                    Input::Uninstall(PackageTarget {
                        extension_id,
                        expected,
                    }) => Mutation::Uninstall {
                        id: extension_id,
                        expected,
                    },
                    Input::Reload(PackageTarget {
                        extension_id,
                        expected,
                    }) => Mutation::Reload {
                        id: extension_id,
                        expected,
                    },
                    Input::Reconcile => Mutation::Reconcile,
                    Input::Remote(_)
                    | Input::Authorization(_)
                    | Input::Client(_)
                    | Input::Query(_)
                    | Input::Preview { .. }
                    | Input::Export { .. } => unreachable!(),
                };
                let snapshot = self.mutate(mutation).await.map_err(mutation_error)?;
                let receipt = receipt(&snapshot);
                match installed {
                    Some(extension_id) => encode(Installed {
                        receipt,
                        extension_id,
                    }),
                    None => encode(receipt),
                }
            }
        }
    }

    pub fn query(&self, query: Query) -> Result<Value, OperationError> {
        let snapshot = self.snapshot();
        let failures = failures(&snapshot);
        if query.view == View::Status {
            return encode(QueryResult::Status(Status {
                phase: if snapshot.lifecycle == super::Lifecycle::Closed {
                    maka_protocol::plugin::Phase::Closed
                } else if snapshot.lifecycle == super::Lifecycle::Draining {
                    maka_protocol::plugin::Phase::Draining
                } else if snapshot.fence.is_some() {
                    maka_protocol::plugin::Phase::Fenced
                } else if snapshot.runtime.converged {
                    maka_protocol::plugin::Phase::Ready
                } else {
                    maka_protocol::plugin::Phase::Degraded
                },
                authority_epoch: snapshot.ledger.generation,
                convergence: convergence(&snapshot),
                installed_package_count: snapshot.packages.len(),
                layered_package_count: snapshot.ledger.package_layers.len(),
                desired_entry_count: snapshot
                    .desired
                    .roots
                    .values()
                    .map(|entries| count(entries))
                    .sum(),
                live_entry_count: snapshot
                    .runtime
                    .entries
                    .iter()
                    .filter(|entry| entry.activation.is_some())
                    .count(),
                failure_count: failures.len(),
                fence_diagnostic: snapshot.fence.clone(),
            }));
        }
        let items = match query.view {
            View::Packages => snapshot
                .packages
                .values()
                .map(|package| encode(package_projection(&snapshot, package)))
                .collect::<Result<Vec<_>, _>>()?,
            View::Entries => {
                let mut items = Vec::new();
                for (scope, entries) in &snapshot.desired.roots {
                    if query.root_id.as_ref().is_none_or(|filter| filter == scope) {
                        entries_view(&snapshot, scope, entries, None, false, &mut items)?;
                    }
                }
                items
            }
            View::Tools => {
                let scopes = query
                    .root_id
                    .clone()
                    .map(|scope| vec![scope])
                    .unwrap_or_else(|| snapshot.desired.roots.keys().cloned().collect());
                let mut items = Vec::new();
                for scope in scopes {
                    let tools = self
                        .catalog
                        .snapshot::<maka_tools::plugins::PluginTool>(&scope);
                    for (name, tool) in tools.entries {
                        let Ok(identity) = tool.owner.identity() else {
                            continue;
                        };
                        // Profile inheritance belongs to model capture, not a
                        // duplicate row in each Session's registration inventory.
                        if identity.scope != scope {
                            continue;
                        }
                        items.push(encode(ToolProjection {
                            identity: ContributionIdentity {
                                entry_id: identity.entry_id,
                                extension_id: identity.package_id,
                                scope_id: identity.scope,
                                generation: identity.generation,
                            },
                            tool_name: name,
                            active_calls: tool.owner.active_calls(),
                            retired: !tool.owner.is_effective(),
                        })?);
                    }
                }
                items
            }
            View::Failures => failures.into_iter().map(encode).collect::<Result<_, _>>()?,
            View::Executors => {
                let scopes = query
                    .root_id
                    .clone()
                    .map(|scope| vec![scope])
                    .unwrap_or_else(|| snapshot.desired.roots.keys().cloned().collect());
                let mut items = Vec::new();
                for scope in scopes {
                    for (_, executor) in self
                        .catalog
                        .snapshot::<maka_plugins::executor::Executor>(&scope)
                        .entries
                    {
                        let Ok(identity) = executor.owner.identity() else {
                            continue;
                        };
                        if identity.scope != scope {
                            continue;
                        }
                        items.push(encode(ExecutorProjection {
                            identity: ContributionIdentity {
                                entry_id: identity.entry_id,
                                extension_id: identity.package_id,
                                scope_id: identity.scope,
                                generation: identity.generation,
                            },
                            id: executor.value.id.as_str().into(),
                            display_name: executor.value.display_name.clone(),
                            capabilities: ExecutorCapabilities {
                                thinking: executor.value.capabilities.thinking,
                                tool_activity: executor.value.capabilities.tool_activity,
                                history_copy: executor.value.capabilities.history_copy,
                            },
                        })?);
                    }
                }
                items
            }
            View::Commands => Vec::new(),
            View::TerminalViews => {
                let scopes = query
                    .root_id
                    .clone()
                    .map(|scope| vec![scope])
                    .unwrap_or_else(|| snapshot.desired.roots.keys().cloned().collect());
                let mut items = Vec::new();
                for scope in scopes {
                    for (name, endpoint) in self
                        .catalog
                        .snapshot::<maka_plugins::remote::Endpoint>(&scope)
                        .entries
                    {
                        let Ok(identity) = endpoint.owner.identity() else {
                            continue;
                        };
                        if identity.scope != scope || !endpoint.is_effective() {
                            continue;
                        }
                        let Some(descriptor) = endpoint.value.terminal_view() else {
                            continue;
                        };
                        let Some(method) = name.strip_prefix(&format!("{}/", identity.package_id))
                        else {
                            continue;
                        };
                        items.push(encode(TerminalViewProjection {
                            package_id: identity.package_id.clone(),
                            scope_id: scope.clone(),
                            method: method.into(),
                            target: endpoint.value.target(&identity),
                            descriptor: descriptor.clone(),
                        })?);
                    }
                }
                items
            }
            View::Status => unreachable!(),
        };
        page(query, items)
    }
}

async fn read_source(source_path: String) -> Result<Package, OperationError> {
    tokio::task::spawn_blocking(move || Package::read_from(std::path::Path::new(&source_path)))
        .await
        .map_err(internal)?
        .map_err(|error| failure(Code::SourceUnreadable, error.to_string()))
}

fn package_projection(snapshot: &Snapshot, package: &Package) -> PackageProjection {
    let manifest = package.manifest();
    PackageProjection {
        base_generation: snapshot.ledger.generation,
        extension_id: manifest.id.clone(),
        content_digest: package.digest().into(),
        display_name: if manifest.display_name.is_empty() {
            manifest.id.clone()
        } else {
            manifest.display_name.clone()
        },
        description: (!manifest.description.is_empty()).then(|| manifest.description.clone()),
        dependencies: manifest
            .dependencies
            .iter()
            .map(|dependency| dependency.id.clone())
            .collect(),
        structural_dependencies: manifest
            .composition
            .as_ref()
            .map(|composition| composition.structural_dependencies.clone())
            .unwrap_or_default(),
        required_by: snapshot
            .packages
            .values()
            .filter(|candidate| {
                candidate
                    .manifest()
                    .dependencies
                    .iter()
                    .any(|dependency| dependency.id == manifest.id)
                    || candidate
                        .manifest()
                        .composition
                        .as_ref()
                        .is_some_and(|composition| {
                            composition.structural_dependencies.contains(&manifest.id)
                        })
            })
            .map(|candidate| candidate.manifest().id.clone())
            .collect(),
        has_runtime: manifest.runtime.is_some(),
        has_client: manifest.client.is_some(),
        has_composition: manifest.composition.is_some(),
    }
}

fn entries_view(
    snapshot: &Snapshot,
    scope: &Scope,
    entries: &[Entry],
    parent: Option<&str>,
    inherited_disabled: bool,
    output: &mut Vec<Value>,
) -> Result<(), OperationError> {
    for entry in entries {
        let live = snapshot
            .runtime
            .entries
            .iter()
            .find(|live| live.entry_id == entry.id);
        let disabled = inherited_disabled || entry.disabled;
        let status = if disabled {
            EntryPhase::Disabled
        } else {
            match live.map(|live| live.phase).unwrap_or(Phase::Pending) {
                Phase::Pending => EntryPhase::Pending,
                Phase::Loading => EntryPhase::Loading,
                Phase::Active => EntryPhase::Active,
                Phase::Failed => EntryPhase::Failed,
                Phase::Unloading => EntryPhase::Unloading,
                Phase::Disposed => EntryPhase::Disposed,
            }
        };
        output.push(encode(EntryProjection {
            base_generation: snapshot.ledger.generation,
            id: entry.id.clone(),
            root_id: scope.clone(),
            parent_id: parent.map(str::to_owned),
            package_id: entry.package_id.clone(),
            config: entry.config.clone(),
            local_disabled: entry.disabled,
            disabled,
            inject: entry.inject.clone(),
            isolate: entry.isolate.clone(),
            intercept: entry.intercept.clone(),
            required_services: match &entry.package_id {
                Some(id) => snapshot.required_services.get(id).cloned().flatten(),
                None => Some(Vec::new()),
            },
            status,
            generation: live.and_then(|live| live.generation),
            waiting_for: live.map_or_else(Vec::new, |live| live.waiting_for.clone()),
            effects: live.map_or_else(Vec::new, |live| live.effects.clone()),
            children: Vec::new(),
            diagnostic: live.and_then(|live| live.error.clone()),
        })?);
        entries_view(
            snapshot,
            scope,
            &entry.children,
            Some(&entry.id),
            disabled,
            output,
        )?;
    }
    Ok(())
}

fn count(entries: &[Entry]) -> usize {
    entries.iter().map(|entry| 1 + count(&entry.children)).sum()
}
fn convergence(snapshot: &Snapshot) -> Convergence {
    if snapshot.runtime.converged {
        Convergence::Converged
    } else {
        Convergence::Diverged
    }
}
fn failures(snapshot: &Snapshot) -> Vec<Failure> {
    snapshot
        .runtime
        .entries
        .iter()
        .filter_map(|entry| {
            entry.error.as_ref().map(|error| Failure {
                entry_id: Some(entry.entry_id.clone()),
                extension_id: None,
                diagnostic: error.chars().take(4096).collect(),
            })
        })
        .collect()
}
fn receipt(snapshot: &Snapshot) -> Receipt {
    Receipt {
        authority_epoch: snapshot.ledger.generation,
        durability: Durability::Committed,
        convergence: convergence(snapshot),
        cleanup: if snapshot.runtime.cleanup_complete {
            Cleanup::Complete
        } else {
            Cleanup::Pending
        },
        failures: failures(snapshot).into_iter().take(64).collect(),
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    view: View,
    root: Option<Scope>,
    digest: String,
    offset: usize,
}

fn page(query: Query, values: Vec<Value>) -> Result<Value, OperationError> {
    let digest = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&values).map_err(internal)?)
    );
    let offset = if let Some(cursor) = &query.cursor {
        let cursor: Cursor = serde_json::from_str(cursor)
            .map_err(|_| failure(Code::StaleCursor, "Invalid plugin cursor"))?;
        if cursor.view != query.view
            || cursor.root != query.root_id
            || cursor.digest != digest
            || cursor.offset > values.len()
        {
            return Err(failure(
                Code::StaleCursor,
                "Plugin view changed; restart pagination",
            ));
        }
        cursor.offset
    } else {
        0
    };
    let mut bytes = 4096;
    let mut items = Vec::new();
    for value in values.iter().skip(offset).take(query.limit.unwrap_or(32)) {
        let size = serde_json::to_vec(value).map_err(internal)?.len() + 1;
        if bytes + size > 128 * 1024 {
            if items.is_empty() {
                return Err(failure(
                    Code::OperationUnavailable,
                    "Plugin item exceeds the protocol page budget",
                ));
            }
            break;
        }
        bytes += size;
        items.push(value.clone());
    }
    let next = offset + items.len();
    let next_cursor = (next < values.len())
        .then(|| {
            serde_json::to_string(&Cursor {
                view: query.view,
                root: query.root_id,
                digest,
                offset: next,
            })
        })
        .transpose()
        .map_err(internal)?;
    Ok(serde_json::json!({ "view": query.view, "items": items, "nextCursor": next_cursor }))
}

fn encode(value: impl Serialize) -> Result<Value, OperationError> {
    serde_json::to_value(value).map_err(internal)
}
fn internal(error: impl ToString) -> OperationError {
    failure(Code::InternalFailure, error.to_string())
}
fn failure(code: Code, message: impl Into<String>) -> OperationError {
    OperationError {
        code,
        message: message.into(),
    }
}
fn mutation_error(error: Error) -> OperationError {
    use maka_event_log::StoreError;
    let code = match &error {
        Error::Closed => Code::HostDraining,
        Error::OutcomeUnknown => Code::CommitOutcomeUnknown,
        Error::Fenced(_) => Code::CommitOutcomeUnknown,
        Error::Invalid(_) => Code::InvalidRequest,
        Error::Persistence(StoreError::EventConflict | StoreError::RevisionConflict { .. }) => {
            Code::OperationConflict
        }
        Error::Persistence(StoreError::CommitUnknown(_) | StoreError::OperationUnknown) => {
            Code::CommitOutcomeUnknown
        }
        Error::Persistence(_) => Code::PersistenceFailed,
    };
    failure(code, error.to_string())
}

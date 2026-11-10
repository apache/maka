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
use maka_agent_authority::setup::{ActualSetupContext, Error, SetupAccess};
use maka_host_runtime::application::{Binding, Context};
use maka_plugin_core::operation::RecoveryRef;
use std::sync::OnceLock;
pub(crate) mod profile;
use maka_process::isolated::{FrozenHome, TaskOwner};
use profile::{PreparedProfile, ProfileBroker, SeededProfile};

pub(crate) fn host_homes() -> std::io::Result<Vec<std::path::PathBuf>> {
    let mut homes = vec![maka_sandbox::account_home()?.canonicalize()?];
    if let Some(home) = std::env::var_os("HOME").filter(|home| !home.is_empty()) {
        let home = std::path::PathBuf::from(home).canonicalize()?;
        if !homes.contains(&home) {
            homes.push(home);
        }
    }
    Ok(homes)
}

pub(crate) fn managed_profile_policy() -> std::io::Result<maka_sandbox::filesystem::Policy> {
    use maka_sandbox::filesystem::{Access, Policy, Rule};
    let mut rules = Vec::new();
    for home in host_homes()? {
        for path in [
            ".claude",
            ".codex",
            ".gemini",
            ".config",
            ".local",
            "Library/Keychains",
        ] {
            rules.push(Rule::subtree(home.join(path), Access::Deny));
        }
    }
    Ok(Policy {
        default: Access::Write,
        rules,
        deny_globs: vec![],
    })
}

pub(super) enum SetupPurpose {
    Check,
    Authenticate,
}

enum SetupHome {
    Unprepared,
    Preparing,
    Issued(SeededProfile),
    Finished,
}

struct SetupSource {
    owner: Arc<Owner>,
    top: Arc<Context>,
    binding: Binding,
    purpose: SetupPurpose,
    original: OnceLock<RecoveryRef>,
    broker: ProfileBroker,
    home: Mutex<SetupHome>,
    prepared: Mutex<Option<PreparedProfile>>,
}
impl Owner {
    pub(super) fn setup_source(
        self: &Arc<Self>,
        top: Arc<Context>,
        binding: Binding,
        purpose: SetupPurpose,
    ) -> Result<Arc<ActualSetupContext>, String> {
        let original = top.operation().ok_or("executor_setup_requires_mutation")?;
        let dispatch = top
            .operation_scope()
            .ok_or("executor_setup_requires_original_dispatch")?;
        if !matches!(
            top.scope().identity,
            maka_capabilities::call::Identity::Remote { .. }
        ) || top.work_custody().is_some()
            || dispatch.reference() != original
            || original.namespace != self.data_source.namespace
            || original.source.deployment != self.run_owner().deployment
            || original.method != "executorSetup"
        {
            return Err("executor_setup_requires_actual_top_level_source".into());
        }
        if self.stop.is_cancelled() || top.scope().cancellation.is_cancelled() {
            return Err("agent_closed".into());
        }
        let broker = ProfileBroker::new(self, &binding).map_err(|error| error.to_string())?;
        Ok(Arc::new(ActualSetupContext(Arc::new(SetupSource {
            owner: self.clone(),
            top,
            binding,
            purpose,
            original: OnceLock::new(),
            broker,
            home: Mutex::new(SetupHome::Unprepared),
            prepared: Mutex::new(None),
        }))))
    }
}
impl SetupAccess for SetupSource {
    fn validate<'a>(&'a self, context: &'a Context) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            let actual = context
                .native_context::<ActualSetupContext>()
                .ok_or_else(|| Error::Invalid("original setup source is unavailable".into()))?;
            if !std::ptr::addr_eq(Arc::as_ptr(&actual.0), self as *const Self)
                || context.work_custody().is_some()
                || !matches!(context.scope().identity, maka_capabilities::call::Identity::Remote { request_id } if request_id == self.top.operation().expect("captured original operation").operation)
                || (context.requester() != self.binding.consumer()
                    && context.requester() != self.binding.provider())
            {
                return Err(Error::Invalid(
                    "setup call does not hold its original source".into(),
                ));
            }
            if self.owner.stop.is_cancelled() {
                return Err(Error::Retired);
            }
            if !self
                .top
                .scope()
                .sandbox_floor()
                .contains(context.scope().sandbox_floor())
                .map_err(|error| Error::Invalid(error.to_string()))?
            {
                return Err(Error::Invalid(
                    "setup scope widened the original caller restrictions".into(),
                ));
            }
            if self.top.scope().cancellation.is_cancelled()
                || context.scope().cancellation.is_cancelled()
            {
                return Err(Error::Cancelled);
            }
            Ok(())
        })
    }
    fn bind_original<'a>(
        &'a self,
        context: &'a Context,
    ) -> BoxFuture<'a, Result<RecoveryRef, Error>> {
        Box::pin(async move {
            self.validate(context).await?;
            let reference = context
                .operation()
                .ok_or_else(|| Error::Invalid("setup mutation is required".into()))?;
            let scope = context
                .operation_scope()
                .ok_or_else(|| Error::Invalid("original setup dispatch is required".into()))?;
            if scope.reference() != reference
                || context.requester() != self.binding.consumer()
                || reference.source
                    != self
                        .top
                        .operation()
                        .expect("captured original operation")
                        .source
                || &reference.namespace != self.binding.provider().instance()
                || reference.export != self.binding.export()
                || reference.method != "setup"
                || reference.operation
                    != self
                        .top
                        .operation()
                        .expect("captured original operation")
                        .operation
            {
                return Err(Error::Invalid(
                    "setup dispatch changed its original selected provider".into(),
                ));
            }
            let original = self.original.get_or_init(|| reference.clone());
            if original != reference {
                return Err(Error::Invalid(
                    "setup source was already bound to a different original operation".into(),
                ));
            }
            Ok(original.clone())
        })
    }
    fn prepare_private_process<'a>(
        &'a self,
        context: &'a Context,
        selected: &'a maka_process::Command,
    ) -> BoxFuture<'a, Result<TaskOwner, Error>> {
        Box::pin(async move {
            self.validate(context).await?;
            if self.original.get().is_none() {
                return Err(Error::Invalid(
                    "original setup dispatch was not bound".into(),
                ));
            }
            {
                let mut home = self.home.lock().await;
                if !matches!(&*home, SetupHome::Unprepared) {
                    return Err(Error::Invalid(
                        "original setup private process preparation was already started".into(),
                    ));
                }
                *home = SetupHome::Preparing;
            }
            let root = self
                .owner
                .store
                .owned_root()
                .map_err(|error| Error::Invalid(error.to_string()))?
                .canonical_path()
                .to_path_buf();
            let source = tokio::task::spawn_blocking(tempfile::tempdir)
                .await
                .map_err(|error| Error::Provider(error.to_string()))?
                .map_err(|error| Error::Provider(error.to_string()))?;
            let root_policy = root.clone();
            let privacy = tokio::task::spawn_blocking(move || {
                use maka_sandbox::filesystem::{Access, Policy, Rule};
                let mut rules = vec![Rule::subtree(root_policy, Access::Deny)];
                rules.extend(
                    host_homes()
                        .map_err(|error| Error::Provider(error.to_string()))?
                        .into_iter()
                        .map(|home| Rule::subtree(home, Access::Deny)),
                );
                Ok::<_, Error>(Policy {
                    default: Access::Read,
                    rules,
                    deny_globs: vec![],
                })
            })
            .await
            .map_err(|error| Error::Provider(error.to_string()))??;
            let caller = self
                .top
                .scope()
                .sandbox_floor()
                .intersect(context.scope().sandbox_floor())
                .map_err(|error| Error::Invalid(error.to_string()))?;
            let mut task = TaskOwner::prepare(
                source.path(),
                &root,
                &self.owner.helper,
                &caller,
                &privacy,
                context.scope().cancellation.child_token(),
            )
            .await
            .map_err(|error| Error::Provider(error.to_string()))?;
            task.bind_command(selected, &caller)
                .await
                .map_err(|error| Error::Provider(error.to_string()))?;
            let (task, seeded) = self.broker.seed_setup_profile(task).await?;
            *self.home.lock().await = SetupHome::Issued(seeded);
            self.validate(context).await?;
            Ok(task)
        })
    }
    fn stage_home<'a>(
        &'a self,
        context: &'a Context,
        frozen: FrozenHome,
    ) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            self.validate(context).await?;
            if self.original.get().is_none() {
                return Err(Error::Invalid(
                    "original setup dispatch was not bound".into(),
                ));
            }
            let seeded = {
                let mut home = self.home.lock().await;
                let SetupHome::Issued(seeded) = &*home else {
                    return Err(Error::Invalid(
                        "original setup HOME was not issued or was already completed".into(),
                    ));
                };
                if !seeded.owns(&frozen) {
                    return Err(Error::Invalid(
                        "setup HOME does not belong to the original issued process".into(),
                    ));
                }
                let SetupHome::Issued(seeded) = std::mem::replace(&mut *home, SetupHome::Finished)
                else {
                    unreachable!()
                };
                seeded
            };
            if matches!(self.purpose, SetupPurpose::Check) {
                return Ok(());
            }
            let prepared = self
                .broker
                .stage_frozen_home(&self.top, &seeded, frozen)
                .await?;
            *self.prepared.lock().await = Some(prepared);
            Ok(())
        })
    }
    fn prepare_profile<'a>(
        &'a self,
        context: &'a Context,
    ) -> BoxFuture<'a, Result<Option<maka_host_runtime::storage::StateChange>, Error>> {
        Box::pin(async move {
            if context.operation() != self.top.operation()
                || !Arc::ptr_eq(&context.scope().resources, &self.top.scope().resources)
                || context
                    .operation_scope()
                    .is_none_or(|scope| Some(scope.reference()) != self.top.operation())
                || context.work_custody().is_some()
            {
                return Err(Error::Invalid(
                    "profile publication requires the original top-level setup dispatch".into(),
                ));
            }
            if self.owner.stop.is_cancelled() {
                return Err(Error::Retired);
            }
            let Some(prepared) = self.prepared.lock().await.take() else {
                return Ok(None);
            };
            self.broker.prepare_selector(context, prepared).map(Some)
        })
    }
}

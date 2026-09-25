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

use crate::execution::{Executions, Result, failure, internal};
use crate::session::{SessionConfiguration, SessionTarget};
use maka_config::plugin_authorization::Principal;
use maka_plugins::{
    composition::Scope,
    contributions::Contribution,
    fiber::CallGuard,
    session::{NativeInputPolicy, SessionBehavior},
    storage::Namespace,
};
use maka_protocol::{
    OperationErrorCode as Code, message::SubmitInput, session::NativeInputAvailability,
};

pub(super) enum NativeInput {
    Ordinary,
    Managed(Managed),
}

pub(super) struct Managed {
    manager: Namespace,
    digest: String,
    mode: maka_runtime::execution::BehaviorId,
    behavior: Contribution<SessionBehavior>,
}

impl NativeInput {
    pub(super) async fn capture(
        executions: &Executions,
        input: &SubmitInput,
        principal: &Principal,
    ) -> Result<Self> {
        let Some(manager) = executions
            .log
            .session_manager(&input.session_id)
            .await
            .map_err(internal)?
        else {
            return Ok(Self::Ordinary);
        };
        if input.turn_orchestration.is_some() {
            return Err(failure(
                Code::OperationUnavailable,
                "Managed native input cannot override its Session behavior",
            ));
        }
        let record = executions
            .log
            .get_session::<SessionConfiguration>(&input.session_id)
            .await
            .map_err(internal)?
            .ok_or_else(|| failure(Code::NotFound, "Session does not exist"))?;
        let behavior = selected(
            &executions.plugin_catalog,
            &input.session_id,
            &record.configuration,
            &manager,
        )?;
        crate::server::plugin_authorization::validate_native_input(
            &executions.configuration,
            principal,
        )
        .await?;
        Ok(Self::Managed(Managed {
            manager,
            digest: record.configuration_digest,
            mode: record
                .configuration
                .orchestration_mode
                .for_collaboration(record.configuration.collaboration_mode)
                .map_err(internal)?,
            behavior,
        }))
    }

    pub(super) async fn check_active(
        &self,
        executions: &Executions,
        invocation: &maka_runtime::event::Invocation,
    ) -> Result<()> {
        let Self::Managed(managed) = self else {
            return Ok(());
        };
        let configuration = executions
            .log
            .invocation_configuration(invocation)
            .await
            .map_err(internal)?
            .ok_or_else(unavailable)?;
        if configuration.model.is_none() || configuration.orchestration_mode != managed.mode {
            return Err(unavailable());
        }
        Ok(())
    }

    pub(super) fn check_environment(
        &self,
        environment: &crate::execution::prepare::Environment,
    ) -> Result<()> {
        if let Self::Managed(managed) = self
            && (environment.behavior_registration() != Some(managed.behavior.registration_id())
                || environment.session.orchestration_mode != managed.mode)
        {
            return Err(unavailable());
        }
        Ok(())
    }

    /// A guard pins exactly this request's registration through canonical commit.
    /// A replacement is never a fresh grant to a request already being prepared.
    pub(super) async fn admit(
        &self,
        executions: &Executions,
        session: &str,
        principal: &Principal,
    ) -> Result<Option<CallGuard>> {
        let Self::Managed(managed) = self else {
            return Ok(None);
        };
        let manager = executions
            .log
            .session_manager(session)
            .await
            .map_err(internal)?;
        let record = executions
            .log
            .get_session::<SessionConfiguration>(session)
            .await
            .map_err(internal)?
            .ok_or_else(|| failure(Code::NotFound, "Session does not exist"))?;
        if manager.as_ref() != Some(&managed.manager)
            || record.configuration_digest != managed.digest
            || !managed.behavior.is_effective()
        {
            return Err(unavailable());
        }
        crate::server::plugin_authorization::validate_native_input(
            &executions.configuration,
            principal,
        )
        .await?;
        // Resolve the effective contribution after the last asynchronous gate;
        // a newly published Session shadow must not hide behind a caller check.
        let current = selected(
            &executions.plugin_catalog,
            session,
            &record.configuration,
            &managed.manager,
        )?;
        if current.registration_id() != managed.behavior.registration_id()
            || current.owner.identity().map_err(internal)?
                != managed.behavior.owner.identity().map_err(internal)?
        {
            return Err(unavailable());
        }
        managed
            .behavior
            .admit()
            .map(Some)
            .map_err(|_| unavailable())
    }
}

impl Executions {
    pub(crate) async fn native_input_availability(
        &self,
        session: &str,
        configuration: &SessionConfiguration,
    ) -> Result<NativeInputAvailability> {
        let Some(manager) = self.log.session_manager(session).await.map_err(internal)? else {
            return Ok(NativeInputAvailability::Ordinary);
        };
        Ok(
            if selected(&self.plugin_catalog, session, configuration, &manager).is_ok() {
                NativeInputAvailability::ManagedNative
            } else {
                NativeInputAvailability::ManagedUnavailable
            },
        )
    }
}

fn selected(
    catalog: &maka_plugins::contributions::Catalog,
    session: &str,
    configuration: &SessionConfiguration,
    manager: &Namespace,
) -> Result<Contribution<SessionBehavior>> {
    if !matches!(configuration.target, SessionTarget::Model { .. }) {
        return Err(unavailable());
    }
    let name = configuration
        .orchestration_mode
        .for_collaboration(configuration.collaboration_mode)
        .map_err(internal)?;
    let contribution = catalog
        .snapshot::<SessionBehavior>(&Scope::Session(session.into()))
        .entries
        .remove(name.as_str())
        .ok_or_else(unavailable)?;
    let owner = contribution.owner.identity().map_err(|_| unavailable())?;
    if owner.package_id != manager.package()
        || &owner.scope != manager.scope()
        || contribution.value.native_input != NativeInputPolicy::NativeUserMessages
        || !contribution.is_effective()
    {
        return Err(unavailable());
    }
    Ok(contribution)
}

fn unavailable() -> maka_protocol::OperationError {
    failure(
        Code::OperationUnavailable,
        "Managed Session native input is unavailable or changed",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::future::BoxFuture;
    use maka_plugins::{
        contributions::{Catalog, Staged},
        fiber::Fiber,
        session::{Behavior, Preparation, Request},
    };
    use std::sync::Arc;

    struct Empty;
    impl Behavior for Empty {
        fn prepare(&self, _: Request) -> BoxFuture<'_, std::result::Result<Preparation, String>> {
            Box::pin(async { Ok(Preparation::default()) })
        }
    }
    #[tokio::test]
    async fn native_input_resolves_collaboration_before_exact_owner_and_shadow_checks() {
        let catalog = Catalog::default();
        let manager = Namespace::new("example", Scope::Profile).unwrap();
        let profile = Fiber::new("example", "profile", Scope::Profile).unwrap();
        profile.begin_loading().unwrap();
        profile.ready().unwrap();
        profile.publish().unwrap();
        let mut staged = Staged::default();
        staged
            .insert(
                "example.review",
                SessionBehavior::new(Arc::new(Empty))
                    .with_native_input(NativeInputPolicy::NativeUserMessages),
            )
            .unwrap();
        staged
            .insert("example.review:plan", SessionBehavior::new(Arc::new(Empty)))
            .unwrap();
        let profile_registration = catalog.register(&profile.context(), staged).unwrap();
        let mut configuration = crate::session::PreparedSession::new(
            serde_json::from_value(serde_json::json!({
                "sessionId":"session","workspace":{"kind":"host_path","path":"/workspace"},
                "modelTarget":{"kind":"default"},"orchestrationMode":"example.review"
            }))
            .unwrap(),
        )
        .unwrap()
        .bind(
            maka_protocol::session::WorkspaceProjection {
                target: maka_protocol::session::WorkspaceTarget::HostPath {
                    path: "/workspace".into(),
                },
                host_cwd: "/workspace".into(),
            },
            crate::session::SessionModel {
                connection_id: "connection".into(),
                connection_slug: "connection".into(),
                model: "model".into(),
            },
            maka_runtime::execution::SandboxMode::ReadOnly,
        );
        assert!(selected(&catalog, "session", &configuration, &manager).is_ok());
        configuration.collaboration_mode = maka_runtime::execution::CollaborationMode::Plan;
        assert!(selected(&catalog, "session", &configuration, &manager).is_err());
        configuration.collaboration_mode = maka_runtime::execution::CollaborationMode::Agent;
        for package in ["foreign", "example"] {
            let shadow = Fiber::new(package, "shadow", Scope::Session("session".into())).unwrap();
            shadow.begin_loading().unwrap();
            shadow.ready().unwrap();
            shadow.publish().unwrap();
            let mut staged = Staged::default();
            staged
                .insert(
                    "example.review",
                    SessionBehavior::new(Arc::new(Empty))
                        .with_native_input(NativeInputPolicy::NativeUserMessages),
                )
                .unwrap();
            let registration = catalog.register(&shadow.context(), staged).unwrap();
            assert!(
                selected(&catalog, "session", &configuration, &manager).is_err(),
                "Session shadow never falls back to the profile owner"
            );
            drop(registration);
            shadow
                .shutdown(tokio::time::Instant::now() + std::time::Duration::from_secs(1))
                .await
                .unwrap();
        }
        assert!(selected(&catalog, "session", &configuration, &manager).is_ok());
        drop(profile_registration);
        profile
            .shutdown(tokio::time::Instant::now() + std::time::Duration::from_secs(1))
            .await
            .unwrap();
    }
}

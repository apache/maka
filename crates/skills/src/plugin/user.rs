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
use super::{Error, Skills};
use crate::publication::{Publisher, UserFiles, UserStore};
use maka_plugins::{
    authorization::{self, Capability, Id, Target},
    filesystem::Files,
    storage::{Data, Mutation, Store},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const KEY: &str = "user-publications";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct State {
    namespace: uuid::Uuid,
    grant: Id,
}
pub(super) struct UserAccess {
    pub store: Arc<dyn Store>,
    pub authorizations: Arc<dyn authorization::Access>,
    pub files: Arc<dyn Files>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Status {
    pub(super) target: Target,
    pub(super) grant: Option<Id>,
    pub(super) recovery: Option<String>,
}
impl Skills {
    pub(super) fn user_target(&self) -> Result<Target, Error> {
        let input = self
            .inputs
            .open("user-skills")
            .map_err(|e| Error::Source(e.to_string()))?
            .ok_or_else(|| Error::Source("User Skills input is not configured".into()))?;
        let root = input
            .location()
            .to_str()
            .map(str::to_owned)
            .ok_or_else(|| Error::Source("User Skills path is not UTF-8".into()))?;
        Ok(Target::Directory { path: root })
    }
    pub(super) async fn user_status(&self) -> Result<Status, Error> {
        let record = self.user.store.read(KEY.into()).await.map_err(stored)?;
        let state = record
            .and_then(|record| record.data.value().cloned())
            .map(serde_json::from_value::<State>)
            .transpose()?;
        Ok(Status {
            target: self.user_target()?,
            grant: state.map(|state| state.grant),
            recovery: self.user_recovery.lock().unwrap().clone(),
        })
    }
    /// Called under the domain mutation lock. Persist the recovery reference
    /// before the first user-directory effect; the reference itself grants nothing.
    pub(super) async fn user_files(&self, grant: Id) -> Result<UserFiles, Error> {
        let authorized = self
            .user
            .authorizations
            .open(grant)
            .await
            .map_err(|e| Error::Source(e.to_string()))?;
        if authorized.grant.request.target != self.user_target()?
            || ![Capability::ReadFiles, Capability::WriteFiles]
                .iter()
                .all(|capability| authorized.grant.request.capabilities.contains(capability))
        {
            return Err(Error::Invalid(
                "Skills grant does not cover the user library".into(),
            ));
        }
        let record = self.user.store.read(KEY.into()).await.map_err(stored)?;
        let previous = record
            .as_ref()
            .and_then(|record| record.data.value())
            .map(|value| serde_json::from_value::<State>(value.clone()))
            .transpose()?;
        let namespace = previous
            .as_ref()
            .map_or_else(uuid::Uuid::new_v4, |state| state.namespace);
        if previous.as_ref().is_none_or(|state| state.grant != grant) {
            self.user
                .store
                .batch(vec![Mutation {
                    key: KEY.into(),
                    expected_revision: record.map(|record| record.revision),
                    data: Data::Present(serde_json::to_value(State { namespace, grant })?),
                }])
                .await
                .map_err(stored)?;
        }
        let user = UserFiles::new(self.user.files.clone(), authorized.call, namespace);
        let recovered = self.recover_files(&user).await;
        *self.user_recovery.lock().unwrap() = recovered.as_ref().err().map(ToString::to_string);
        if let Err(error) = recovered {
            user.finish()
                .await
                .map_err(|e| Error::Source(e.to_string()))?;
            return Err(error);
        }
        Ok(user)
    }
    pub(super) async fn private_publisher(&self) -> Result<Publisher, Error> {
        self.data
            .run(Publisher::open)
            .await
            .map_err(|e| Error::Source(e.to_string()))?
            .map_err(|e| Error::Source(e.to_string()))
    }
    pub(super) async fn recover_user(&self) -> Result<(), Error> {
        let record = self.user.store.read(KEY.into()).await.map_err(stored)?;
        let Some(value) = record.and_then(|record| record.data.value().cloned()) else {
            return Ok(());
        };
        let state: State = serde_json::from_value(value)?;
        let user = self.user_files(state.grant).await?;
        user.finish()
            .await
            .map_err(|e| Error::Source(e.to_string()))
    }
    async fn recover_files(&self, user: &UserFiles) -> Result<(), Error> {
        for store in [
            UserStore::MakaSkills,
            UserStore::AgentSkills,
            UserStore::ManagedSources,
        ] {
            if let Some(publisher) = user
                .open(store, self.private_publisher().await?, false)
                .await
                .map_err(|e| Error::Source(e.to_string()))?
            {
                publisher
                    .recover()
                    .await
                    .map_err(|e| Error::Source(e.to_string()))?;
            }
        }
        Ok(())
    }
    pub(super) async fn resume_user(&self, grant: Id) -> Result<(), Error> {
        let admitted = self.basis.owner.admit().map_err(|_| Error::Retired)?;
        let skills = self.clone();
        let receiver = self
            .basis
            .owner
            .spawn_resource("Skills publication recovery", move |_| async move {
                let _admitted = admitted;
                let _serial = skills.mutations.write().await;
                let _invalidation = skills.input_revision.invalidate().await;
                let _notice = skills.notify_on_exit();
                let recovered = async {
                    skills
                        .user_files(grant)
                        .await?
                        .finish()
                        .await
                        .map_err(|error| Error::Source(error.to_string()))
                }
                .await;
                *skills.user_recovery.lock().unwrap() =
                    recovered.as_ref().err().map(ToString::to_string);
                Ok(recovered)
            })
            .map_err(|_| Error::Retired)?;
        receiver
            .await
            .map_err(|error| Error::OutcomeUnknown(error.to_string()))?
            .map_err(Error::OutcomeUnknown)?
    }
}
fn stored(error: maka_plugins::storage::StoreError) -> Error {
    match error {
        maka_plugins::storage::StoreError::OutcomeUnknown(message) => {
            Error::OutcomeUnknown(message)
        }
        maka_plugins::storage::StoreError::Retired => Error::Retired,
        error => Error::Source(error.to_string()),
    }
}

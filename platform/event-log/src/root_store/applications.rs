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

//! Application definitions and caller journals live in control; checkpoints use data writers.
use super::*;
use crate::applications::{
    DeploymentChanges, LoadedDeployment, PreparedApplication, SourceSnapshot,
    checkpoints::Checkpoints,
    intents::{CallerIntent, RecordedIntent},
    launch::Launch,
};
use maka_packages::Package;
use maka_plugin_core::{
    composition::{Input, InstanceId},
    deployment::{DeploymentRef, RemoteObservation, management::ManagedDeployment},
    operation::RecoveryRef,
};
use serde_json::Value;
use uuid::Uuid;

impl RootStore {
    pub async fn commit_application(
        &self,
        deployment: Uuid,
        expected_revision: u64,
        input: Input,
        observations: Vec<RemoteObservation>,
        bytes: Vec<Package>,
    ) -> Result<DeploymentRef, StoreError> {
        self.require_open()?;
        self.control
            .commit_application(deployment, expected_revision, input, observations, bytes)
            .await
    }
    pub async fn commit_prepared_application(
        &self,
        deployment: Uuid,
        expected_revision: u64,
        prepared: PreparedApplication,
    ) -> Result<LoadedDeployment, StoreError> {
        self.require_open()?;
        self.control
            .commit_prepared_application(deployment, expected_revision, prepared)
            .await
    }
    pub async fn load_application(
        &self,
        deployment: Uuid,
    ) -> Result<Option<LoadedDeployment>, StoreError> {
        self.require_open()?;
        self.control.load_application(deployment).await
    }
    pub async fn load_application_at(
        &self,
        reference: &DeploymentRef,
    ) -> Result<Option<LoadedDeployment>, StoreError> {
        self.require_open()?;
        self.control.load_application_at(reference).await
    }
    pub async fn read_application_metadata(
        &self,
        deployment: Uuid,
    ) -> Result<Option<ManagedDeployment>, StoreError> {
        self.require_open()?;
        self.control.read_application_metadata(deployment).await
    }
    pub async fn read_application_metadata_at(
        &self,
        reference: &DeploymentRef,
    ) -> Result<Option<ManagedDeployment>, StoreError> {
        self.require_open()?;
        self.control.read_application_metadata_at(reference).await
    }
    pub async fn compare_and_set_application_launch_configuration(
        &self,
        source: maka_plugin_core::deployment::DeploymentRef,
        expected: Value,
        configuration: Value,
    ) -> Result<bool, StoreError> {
        self.require_open()?;
        self.control
            .compare_and_set_application_launch_configuration(source, expected, configuration)
            .await
    }
    pub async fn application_launch(&self) -> Result<Option<Launch>, StoreError> {
        self.require_open()?;
        self.control.application_launch().await
    }
    pub async fn select_committed_application_launch(
        &self,
        source: maka_plugin_core::deployment::DeploymentRef,
        configuration: Value,
    ) -> Result<(), StoreError> {
        self.require_open()?;
        self.control
            .select_committed_application_launch(source, configuration)
            .await
    }
    pub async fn begin_application_launch(&self, launch: Launch) -> Result<(), StoreError> {
        self.require_open()?;
        self.control.begin_application_launch(launch).await
    }
    pub async fn begin_application_restore(
        &self,
        deployment: Uuid,
        pending: Vec<u8>,
    ) -> Result<(), StoreError> {
        self.require_open()?;
        self.control
            .begin_application_restore(deployment, pending)
            .await
    }
    pub async fn complete_application_launch(&self, deployment: Uuid) -> Result<(), StoreError> {
        self.require_open()?;
        self.control.complete_application_launch(deployment).await
    }
    pub fn subscribe_application(
        self: &Arc<Self>,
        observed: DeploymentRef,
    ) -> Result<DeploymentChanges, StoreError> {
        self.require_open()?;
        self.control
            .subscribe_application(observed)
            .map(|changes| changes.with_shutdown(self.gates.cancellation()))
    }
    pub async fn application_head(
        &self,
        deployment: uuid::Uuid,
    ) -> Result<Option<DeploymentRef>, StoreError> {
        self.require_open()?;
        self.control.application_head(deployment).await
    }

    pub fn check_application(&self, loaded: &LoadedDeployment) -> Result<(), StoreError> {
        self.require_open()?;
        loaded.check_store(&self.control)
    }
    pub async fn ui_checkpoints(
        &self,
        source: &DeploymentRef,
        instance: &InstanceId,
    ) -> Result<Checkpoints, StoreError> {
        let loaded = self
            .load_application_at(source)
            .await?
            .ok_or(StoreError::SessionNotFound)?;
        self.ui_checkpoints_from(&loaded.snapshot(), instance)
    }
    pub fn ui_checkpoints_from(
        &self,
        source: &SourceSnapshot,
        instance: &InstanceId,
    ) -> Result<Checkpoints, StoreError> {
        self.require_open()?;
        self.partitions[partition_for(b"application", &source.reference().deployment.to_string())]
            .ui_checkpoints_from(source, instance)
            .map(|capability| capability.with_shutdown(self.gates.cancellation()))
    }
    fn caller_journal(&self) -> Result<&EventLog, StoreError> {
        self.require_open()?;
        Ok(&self.control)
    }
    pub async fn application_intent(
        &self,
        deployment: Uuid,
        consumer: InstanceId,
        operation: Uuid,
    ) -> Result<Option<CallerIntent>, StoreError> {
        self.caller_journal()?
            .application_intent(deployment, consumer, operation)
            .await
    }
    pub async fn record_application_intent(
        &self,
        caller: DeploymentRef,
        consumer: InstanceId,
        reference: RecoveryRef,
        recovery: serde_json::Value,
    ) -> Result<RecordedIntent, StoreError> {
        let loaded = self.load_application_at(&caller).await?.ok_or_else(|| {
            StoreError::InvalidTransition("original caller source missing".into())
        })?;
        self.record_application_intent_from(&loaded.snapshot(), consumer, reference, recovery)
            .await
    }
    pub async fn record_application_intent_from(
        &self,
        source: &SourceSnapshot,
        consumer: InstanceId,
        reference: RecoveryRef,
        recovery: serde_json::Value,
    ) -> Result<RecordedIntent, StoreError> {
        self.caller_journal()?
            .record_application_intent_from(source, consumer, reference, recovery)
            .await
    }
    pub async fn application_intents(
        &self,
        deployment: Uuid,
        consumer: InstanceId,
        after: u64,
        limit: usize,
    ) -> Result<Vec<CallerIntent>, StoreError> {
        self.caller_journal()?
            .application_intents(deployment, consumer, after, limit)
            .await
    }
    pub async fn application_deployment_intents(
        &self,
        deployment: Uuid,
        after: u64,
        limit: usize,
    ) -> Result<Vec<CallerIntent>, StoreError> {
        self.caller_journal()?
            .application_deployment_intents(deployment, after, limit)
            .await
    }
}

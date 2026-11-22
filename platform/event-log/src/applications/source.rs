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

//! Checked historical caller origin, held by its original executor.
use super::{StoreError, invalid};
use crate::{EventLog, root::RootOwner};
use maka_plugin_core::{composition::InstanceId, deployment::DeploymentRef, plan::Plan};
use std::{
    collections::BTreeSet,
    sync::{Arc, Weak},
};

/// Evidence from one fully validated storage snapshot. This is neither a service
/// grant nor a dispatch token. It cannot be constructed from a serialized locator
/// and does not keep its original Root lease alive after the executor closes.
#[derive(Clone)]
pub struct SourceSnapshot(Arc<Original>);
struct Original {
    root: Weak<RootOwner>,
    reference: DeploymentRef,
    executable: BTreeSet<InstanceId>,
}
impl SourceSnapshot {
    pub(super) fn new(root: Weak<RootOwner>, reference: DeploymentRef, plan: &Plan) -> Self {
        Self(Arc::new(Original {
            root,
            reference,
            executable: plan
                .instances()
                .iter()
                .filter(|(_, i)| !i.disabled && i.entry.is_some())
                .map(|(id, _)| id.clone())
                .collect(),
        }))
    }
    pub fn reference(&self) -> &DeploymentRef {
        &self.0.reference
    }
    pub(super) fn check(&self, store: &EventLog, consumer: &InstanceId) -> Result<(), StoreError> {
        self.check_root(store)?;
        if !self.0.executable.contains(consumer) {
            return Err(invalid(
                "caller must belong to an executable original source instance",
            ));
        }
        Ok(())
    }
    pub(super) fn check_root(&self, store: &EventLog) -> Result<(), StoreError> {
        store.validate_root()?;
        let root = self
            .0
            .root
            .upgrade()
            .ok_or_else(|| invalid("original source Root has closed"))?;
        if store
            .root_owner
            .as_ref()
            .is_none_or(|actual| !Arc::ptr_eq(actual, &root))
        {
            return Err(invalid("foreign original source Root"));
        }
        Ok(())
    }
}

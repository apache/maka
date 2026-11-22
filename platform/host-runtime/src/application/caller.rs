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

use maka_plugin_core::{composition::InstanceId, deployment::DeploymentRef};
use std::sync::Arc;
use uuid::Uuid;

/// Equality-only origin captured by the trusted Host policy. This is neither a
/// grant nor a bearer handle. Services still need independent method admission
/// and the original request lifetime before using an associated resource.
/// There is deliberately no serialized representation or guest constructor.
#[derive(Clone, Debug)]
pub struct Caller {
    incarnation: Arc<()>,
    source: DeploymentRef,
    consumer: InstanceId,
    mount: Uuid,
}
impl Caller {
    /// A trusted policy derives these facts from its private channel evidence.
    /// Reuse the same incarnation only within that original approval lifetime.
    /// A fresh marker makes identical external observations a different caller.
    pub fn new(
        incarnation: Arc<()>,
        source: DeploymentRef,
        consumer: InstanceId,
        mount: Uuid,
    ) -> Self {
        Self {
            incarnation,
            source,
            consumer,
            mount,
        }
    }
}
impl PartialEq for Caller {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.incarnation, &other.incarnation)
            && self.source == other.source
            && self.consumer == other.consumer
            && self.mount == other.mount
    }
}
impl Eq for Caller {}

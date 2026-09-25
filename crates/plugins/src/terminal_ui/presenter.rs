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

//! Host-owned execution for one terminal document. A factory belongs to a
//! registration; its pages belong to documents, never the business activation.

use super::transcript::Resource;
use crate::remote::{Caller, Error, Target};
use futures_util::future::BoxFuture;
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub trait Factory: Send + Sync {
    /// Exact source registrations captured when this app was published.
    fn observations(&self) -> &[Observation] {
        &[]
    }
    /// Reserve ownership before asynchronous module initialization starts.
    fn open(&self, cancellation: CancellationToken) -> Result<Arc<dyn Page>, Error>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Observation {
    pub method: String,
    pub target: Target,
    pub role: ObservationRole,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ObservationRole {
    ChangesStream,
    TranscriptRead(Resource),
    TranscriptStream(Resource),
}

pub trait Page: Send + Sync {
    fn call(&self, input: Value, caller: Caller) -> BoxFuture<'static, Result<Value, Error>>;
    /// Revoke this page synchronously. Cleanup confirmation is separate.
    fn cancel(&self);
    /// Page execution may retire even after returning a valid backend receipt.
    fn retired(&self) -> BoxFuture<'_, ()> {
        Box::pin(std::future::pending())
    }
    fn close(&self) -> BoxFuture<'_, Result<(), Error>>;
}

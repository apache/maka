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

use std::sync::Arc;
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

/// Serializes domain invalidation with the Host's final durable admission.
/// A writer holds the returned guard through its domain transaction.
#[derive(Clone, Default)]
pub struct Revision(Arc<RwLock<u64>>);

pub struct Invalidation {
    _guard: OwnedRwLockWriteGuard<u64>,
}

#[derive(Clone)]
pub struct Basis {
    revision: Revision,
    expected: u64,
}

impl Revision {
    /// Captured versions are observations, never authorization.
    pub fn at(&self, expected: u64) -> Basis {
        Basis {
            revision: self.clone(),
            expected,
        }
    }
    pub async fn capture(&self) -> Basis {
        Basis {
            revision: self.clone(),
            expected: *self.0.read().await,
        }
    }
    pub async fn invalidate(&self) -> Invalidation {
        let mut write = self.0.clone().write_owned().await;
        *write = write.checked_add(1).expect("input revision exhausted");
        Invalidation { _guard: write }
    }
}
impl Basis {
    pub fn version(&self) -> u64 {
        self.expected
    }
    /// Never wait for a domain writer while holding Host admission.
    pub fn admit(&self) -> Option<OwnedRwLockReadGuard<u64>> {
        let guard = self.revision.0.clone().try_read_owned().ok()?;
        (*guard == self.expected).then_some(guard)
    }
}

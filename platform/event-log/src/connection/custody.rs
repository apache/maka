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

//! Accepted SQL custody belongs to the original actors, beyond callback unwind.
use std::sync::{Arc, Mutex};

pub(crate) type Custody = Arc<dyn Send + Sync>;

/// Exactly one in-flight slot per physical actor. A failed close leaves its
/// slot with the original owner; there is no completed-work history to grow.
#[derive(Default)]
pub(super) struct Retained([Mutex<Vec<Custody>>; 3]);

impl Retained {
    pub(super) fn hold(&self, slot: usize, custody: Custody) {
        self.0[slot]
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(custody);
    }
    pub(super) fn clear(&self, slot: usize) {
        let retained = std::mem::take(
            &mut *self.0[slot]
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
        drop(retained);
    }
}

pub(super) fn combine(current: &Option<Custody>, next: Custody) -> Custody {
    match current {
        Some(current) => Arc::new((current.clone(), next)),
        None => next,
    }
}

#[cfg(test)]
mod tests;

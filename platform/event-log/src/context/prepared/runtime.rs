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

//! Execution state belongs to the projection owner, without retaining its own lease.
use super::{assembly, discovery, lifetime::Key};
use std::collections::HashMap;

#[derive(Default)]
pub(crate) struct InFlight {
    pub(super) generations: HashMap<Key, Generation>,
}
pub(super) enum Generation {
    Logical(discovery::Logical),
    Wire(discovery::Wire),
    Rendering,
    Assembling(assembly::State),
}
impl InFlight {
    pub(super) fn key(kind: assembly::Kind, id: &str) -> Key {
        Key {
            kind: kind.name(),
            id: id.to_owned(),
        }
    }
    pub(super) fn insert(&mut self, kind: assembly::Kind, id: &str, state: Generation) {
        self.generations.insert(Self::key(kind, id), state);
    }
    pub(super) fn remove(&mut self, kind: &'static str, id: &str) {
        self.generations.remove(&Key {
            kind,
            id: id.to_owned(),
        });
    }
    pub(super) fn assembling(&self, kind: assembly::Kind, id: &str) -> bool {
        matches!(
            self.generations.get(&Self::key(kind, id)),
            Some(Generation::Assembling(_))
        )
    }
}

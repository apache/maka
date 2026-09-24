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

use maka_plugins::terminal_ui::Context;
use maka_protocol::plugin::TerminalViewProjection;
use serde::{Deserialize, Serialize};

/// What names an open view across registrations, reconnects and restarts:
/// the package and method that serve it, the session it belongs to, and
/// for a view filling a slot, where that slot is. A registration target is
/// a binding of the moment, never an identity.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Key {
    pub package: String,
    pub method: String,
    #[serde(default)]
    pub session: Option<String>,
    /// The instance whose view declares the slot, and the slot's path in it.
    #[serde(default)]
    pub within: Option<Box<(Key, String)>>,
}

/// Slots may nest this deep and no deeper, so a view can never fill itself.
pub(super) const NESTING: usize = 2;

impl Key {
    /// The key of an entry opened on its own, in `session` when it needs one.
    pub fn of(entry: &TerminalViewProjection, session: Option<&str>) -> Option<Self> {
        let session = match entry.descriptor.context {
            Context::Application => None,
            Context::Session => Some(session?.to_owned()),
        };
        Some(Self {
            package: entry.package_id.clone(),
            method: entry.method.clone(),
            session,
            within: None,
        })
    }
    pub fn serves(&self, entry: &TerminalViewProjection) -> bool {
        self.package == entry.package_id && self.method == entry.method
    }
    /// How many slots deep this instance sits.
    pub(super) fn depth(&self) -> usize {
        self.within
            .as_ref()
            .map_or(0, |within| within.0.depth() + 1)
    }
    /// Whether this key or one of the instances around it is served by `entry`.
    pub(super) fn contains(&self, entry: &TerminalViewProjection) -> bool {
        self.serves(entry)
            || self
                .within
                .as_ref()
                .is_some_and(|within| within.0.contains(entry))
    }
    /// A stable node key: the kernel joins keys with `/`.
    pub(crate) fn node(&self) -> String {
        format!("{}:{}", self.package, self.method).replace('/', ":")
    }
    pub(super) fn valid(&self) -> bool {
        let text = |value: &str, max: usize| {
            !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
        };
        text(&self.package, 256)
            && text(&self.method, 256)
            && self
                .session
                .as_deref()
                .is_none_or(|session| text(session, 256))
            && self.depth() <= NESTING
            && self
                .within
                .as_ref()
                .is_none_or(|within| within.0.valid() && text(&within.1, 4096))
    }
}

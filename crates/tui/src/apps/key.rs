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

use maka_plugins::terminal_ui::{Context, Placement, view::Request};
use maka_protocol::plugin::TerminalViewProjection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;

/// An immutable location across registrations: contribution, mount, route and
/// the original slot context. Runtime targets never form part of this identity.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ViewAddress {
    pub package: String,
    pub method: String,
    pub session: Option<String>,
    pub placement: Placement,
    pub within: Option<Box<(ViewAddress, String)>>,
    pub origin: Value,
    pub route: Value,
}

pub(super) const NESTING: usize = 2;

impl ViewAddress {
    pub fn of(entry: &TerminalViewProjection, session: Option<&str>) -> Option<Self> {
        let session = match entry.descriptor.context {
            Context::Application => None,
            Context::Session => Some(session?.to_owned()),
        };
        if matches!(entry.descriptor.placement, Placement::Slot { .. }) {
            return None;
        }
        Some(Self {
            package: entry.package_id.clone(),
            method: entry.method.clone(),
            session,
            placement: entry.descriptor.placement.clone(),
            ..Self::default()
        })
    }
    pub fn serves(&self, entry: &TerminalViewProjection) -> bool {
        self.package == entry.package_id
            && self.method == entry.method
            && self.placement == entry.descriptor.placement
    }
    pub(crate) fn same_mount(&self, other: &Self) -> bool {
        self.package == other.package
            && self.method == other.method
            && self.session == other.session
            && self.placement == other.placement
            && self.within == other.within
            && self.origin == other.origin
    }
    pub(crate) fn at(&self, route: Value) -> Self {
        Self {
            route,
            ..self.clone()
        }
    }
    pub(crate) fn depth(&self) -> usize {
        self.within
            .as_ref()
            .map_or(0, |within| within.0.depth() + 1)
    }
    pub(super) fn contains(&self, entry: &TerminalViewProjection) -> bool {
        (self.package == entry.package_id && self.method == entry.method)
            || self
                .within
                .as_ref()
                .is_some_and(|within| within.0.contains(entry))
    }
    pub(crate) fn descends_from(&self, parent: &Self) -> bool {
        self.within
            .as_ref()
            .is_some_and(|within| &within.0 == parent || within.0.descends_from(parent))
    }
    fn repeats_parent(&self, parent: &Self) -> bool {
        (self.package == parent.package && self.method == parent.method)
            || parent
                .within
                .as_ref()
                .is_some_and(|within| self.repeats_parent(&within.0))
    }
    pub(crate) fn references_session(&self, session: &str) -> bool {
        self.session.as_deref() == Some(session)
            || self
                .within
                .as_ref()
                .is_some_and(|within| within.0.references_session(session))
    }
    pub(crate) fn node(&self) -> String {
        format!("{}:{}", self.package, self.method).replace('/', ":")
    }
    pub(crate) fn valid(&self) -> bool {
        let text = |value: &str, max: usize| {
            !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
        };
        let route = |value: &Value| {
            Request::Read {
                route: value.clone(),
                locale: "en".into(),
            }
            .validate()
            .is_ok()
        };
        text(&self.package, 256)
            && text(&self.method, 256)
            && self
                .session
                .as_deref()
                .is_none_or(|session| text(session, 256))
            && route(&self.route)
            && route(&self.origin)
            && self.depth() <= NESTING
            && match (&self.placement, &self.within) {
                (Placement::Slot { name }, Some(within)) => {
                    text(name, 128)
                        && text(&within.1, 4096)
                        && within.0.valid()
                        && self
                            .session
                            .as_ref()
                            .is_none_or(|session| within.0.session.as_ref() == Some(session))
                        && !self.repeats_parent(&within.0)
                }
                (Placement::Slot { .. }, None) | (_, Some(_)) => false,
                (Placement::Panel | Placement::Status, None) => {
                    self.session.is_some() && self.origin.is_null()
                }
                (Placement::Settings, None) => self.session.is_none() && self.origin.is_null(),
                (Placement::Page, None) => self.origin.is_null(),
            }
    }
}

impl PartialOrd for ViewAddress {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for ViewAddress {
    fn cmp(&self, other: &Self) -> Ordering {
        (&self.package, &self.method, &self.session, &self.within)
            .cmp(&(&other.package, &other.method, &other.session, &other.within))
            .then_with(|| {
                serde_json::to_string(&self.placement)
                    .unwrap()
                    .cmp(&serde_json::to_string(&other.placement).unwrap())
            })
            .then_with(|| compare(&self.origin, &other.origin))
            .then_with(|| compare(&self.route, &other.route))
    }
}

// JSON objects compare by their keys, independent of their wire insertion order.
fn compare(left: &Value, right: &Value) -> Ordering {
    fn kind(value: &Value) -> u8 {
        match value {
            Value::Null => 0,
            Value::Bool(_) => 1,
            Value::Number(_) => 2,
            Value::String(_) => 3,
            Value::Array(_) => 4,
            Value::Object(_) => 5,
        }
    }
    if left == right {
        return Ordering::Equal;
    }
    match (left, right) {
        (Value::Bool(a), Value::Bool(b)) => a.cmp(b),
        (Value::String(a), Value::String(b)) => a.cmp(b),
        (Value::Number(a), Value::Number(b)) => {
            let kind = |n: &serde_json::Number| {
                if n.is_f64() {
                    2
                } else if n.is_u64() {
                    1
                } else {
                    0
                }
            };
            kind(a).cmp(&kind(b)).then_with(|| {
                if a.is_f64() {
                    a.as_f64()
                        .unwrap()
                        .partial_cmp(&b.as_f64().unwrap())
                        .unwrap()
                } else if a.is_u64() {
                    a.as_u64().unwrap().cmp(&b.as_u64().unwrap())
                } else {
                    a.as_i64().unwrap().cmp(&b.as_i64().unwrap())
                }
            })
        }
        (Value::Array(a), Value::Array(b)) => a
            .iter()
            .zip(b)
            .map(|(a, b)| compare(a, b))
            .find(|order| !order.is_eq())
            .unwrap_or_else(|| a.len().cmp(&b.len())),
        (Value::Object(a), Value::Object(b)) => {
            let a: std::collections::BTreeMap<_, _> = a.iter().collect();
            let b: std::collections::BTreeMap<_, _> = b.iter().collect();
            a.iter()
                .zip(&b)
                .map(|((ka, va), (kb, vb))| ka.cmp(kb).then_with(|| compare(va, vb)))
                .find(|order| !order.is_eq())
                .unwrap_or_else(|| a.len().cmp(&b.len()))
        }
        _ => kind(left).cmp(&kind(right)),
    }
}

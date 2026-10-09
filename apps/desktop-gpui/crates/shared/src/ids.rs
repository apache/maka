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

//! Stable `ElementId`s for repeated elements.

use gpui_kit::{ElementId, SharedString};

/// The `ElementId` of the element that shows one domain object, for example
/// `domain_element_id("session-row", session_id)`.
///
/// It depends only on the kind and the object's own id, never on its position
/// in a list, so the element keeps its identity (focus, hover, element state)
/// when rows are inserted, removed, or reordered. `kind` namespaces ids so two
/// kinds of rows for the same object cannot collide.
pub fn domain_element_id(kind: &'static str, id: &str) -> ElementId {
    ElementId::Name(SharedString::from(format!("{kind}:{id}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_depends_on_kind_and_id_only() {
        assert_eq!(domain_element_id("session-row", "s1"), domain_element_id("session-row", "s1"));
        assert_ne!(domain_element_id("session-row", "s1"), domain_element_id("session-row", "s2"));
        assert_ne!(domain_element_id("session-row", "s1"), domain_element_id("tool-card", "s1"));
    }
}

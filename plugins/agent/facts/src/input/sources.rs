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

use super::{Selections, validate_selections};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Captured discovery identity, never authority to execute or read a resource.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectionSource {
    pub provider: String,
    pub package_id: String,
    pub entry_id: String,
    pub activation: String,
    pub registration: uuid::Uuid,
    pub session_id: String,
}

/// A list keeps duplicate provider declarations visible to validation.
pub type SelectionSources = Vec<SelectionSource>;

pub fn validate_selection_sources(
    selections: &Selections,
    sources: &[SelectionSource],
) -> Result<(), &'static str> {
    validate_selections(selections)?;
    let mut seen = HashSet::new();
    for source in sources {
        if !seen.insert(&source.provider)
            || !selections.contains_key(&source.provider)
            || source.registration.is_nil()
            || [
                &source.provider,
                &source.package_id,
                &source.entry_id,
                &source.activation,
                &source.session_id,
            ]
            .into_iter()
            .any(|value| value.is_empty() || value.chars().any(char::is_control))
        {
            return Err("invalid input selection source");
        }
    }
    Ok(())
}

pub fn validate_selection_session(
    sources: &[SelectionSource],
    session: &str,
) -> Result<(), &'static str> {
    if sources.iter().any(|source| source.session_id != session) {
        return Err("input selection belongs to another Session");
    }
    Ok(())
}

/// This classifies shape only. Host must verify every source's actual paired
/// registration and domain selectors before granting queue admission.
pub fn has_unbound_selections(selections: &Selections, sources: &[SelectionSource]) -> bool {
    selections
        .keys()
        .any(|provider| !sources.iter().any(|source| &source.provider == provider))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sources_retain_exact_identity_and_reject_ambiguous_bindings() {
        let selections = Selections::from([("example".into(), vec!["record:7".into()])]);
        let source = SelectionSource {
            provider: "example".into(),
            package_id: "example.context".into(),
            entry_id: "context".into(),
            activation: "original".into(),
            registration: uuid::Uuid::new_v4(),
            session_id: "original-session".into(),
        };
        validate_selection_sources(&selections, std::slice::from_ref(&source)).unwrap();
        assert!(!has_unbound_selections(
            &selections,
            std::slice::from_ref(&source)
        ));
        assert!(has_unbound_selections(&selections, &[]));
        assert!(
            validate_selection_sources(&selections, &[source.clone(), source.clone()]).is_err()
        );
        assert!(
            validate_selection_sources(&Selections::new(), std::slice::from_ref(&source)).is_err()
        );
        assert!(
            validate_selection_session(std::slice::from_ref(&source), "child-session").is_err()
        );
        validate_selection_session(std::slice::from_ref(&source), "original-session").unwrap();
        let json = serde_json::to_vec(&source).unwrap();
        assert_eq!(
            serde_json::from_slice::<SelectionSource>(&json).unwrap(),
            source
        );
    }
}

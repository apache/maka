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

use std::collections::{BTreeMap, HashSet};

/// Explicit input-provider selections, not tool permissions or prepared receipts.
/// The provider interprets its own selectors; Host validates their identity.
pub type Selections = BTreeMap<String, Vec<String>>;

pub fn validate_selections(selections: &Selections) -> Result<(), &'static str> {
    for (provider, values) in selections {
        if provider.is_empty() || provider.chars().any(char::is_control) || values.is_empty() {
            return Err("invalid input-provider selection");
        }
        let mut seen = HashSet::new();
        if values.iter().any(|value| !seen.insert(value)) {
            return Err("duplicate input-provider selector");
        }
        if values
            .iter()
            .any(|value| value.is_empty() || value.chars().any(char::is_control))
        {
            return Err("invalid input-provider selector");
        }
    }
    Ok(())
}

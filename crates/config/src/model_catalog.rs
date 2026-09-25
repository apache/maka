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

use crate::Result;
mod entry;
mod limits;
pub(crate) use limits::validate_overrides;
use maka_runtime::configuration::{ConnectionCatalogEntry, ModelCatalogEntry, ModelInfo};
use std::collections::HashSet;

/// Project persisted provider facts and explicit user declarations without resolving plugins.
pub fn resolve(
    row: &ConnectionCatalogEntry,
    default: Option<&str>,
) -> Result<Vec<ModelCatalogEntry>> {
    let default = default.map(str::trim).filter(|id| !id.is_empty());
    let mut models = row.models.clone();
    let mut seen = HashSet::new();
    models.retain(|model| {
        let id = model.id.trim();
        !id.is_empty() && seen.insert(id.to_owned())
    });
    if let Some(id) = default
        && seen.insert(id.to_owned())
    {
        models.insert(0, ModelInfo::new(id));
    }
    for id in row
        .enabled_model_ids
        .iter()
        .chain(row.model_overrides.iter().flat_map(|values| values.keys()))
    {
        let id = id.trim();
        if !id.is_empty() && seen.insert(id.to_owned()) {
            models.push(ModelInfo::new(id));
        }
    }
    Ok(models
        .iter()
        .map(|model| entry::resolve(row, model, default))
        .collect())
}

pub(crate) fn wire_limit(text: &str, max: usize) -> String {
    let mut units = 0;
    text.chars()
        .take_while(|character| {
            units += character.len_utf16();
            units <= max
        })
        .collect()
}

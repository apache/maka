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

use crate::contract::{CatalogModel, CatalogModelsPage, CatalogModelsRead};
use maka_agent_facts::configuration::CatalogModelReference;
use maka_providers::catalog::Snapshot;

pub(crate) fn page(snapshot: &Snapshot, request: CatalogModelsRead) -> CatalogModelsPage {
    let query = request.query.to_lowercase();
    let terms: Vec<_> = query.split_whitespace().collect();
    let mut matches = snapshot
        .models(request.after.as_ref())
        .filter(|(provider, model)| {
            let text = format!(
                "{provider}\n{}\n{}",
                model.id,
                model.display_name.as_deref().unwrap_or("")
            )
            .to_lowercase();
            terms.iter().all(|term| text.contains(term))
        });
    let models: Vec<_> = matches
        .by_ref()
        .take(16)
        .map(|(provider, model)| CatalogModel {
            reference: CatalogModelReference {
                provider: provider.into(),
                model_id: model.id.clone(),
            },
            label: model
                .display_name
                .clone()
                .unwrap_or_else(|| model.id.clone()),
            context_window: model.context_window,
        })
        .collect();
    let after = matches
        .next()
        .and_then(|_| models.last().map(|model| model.reference.clone()));
    CatalogModelsPage { models, after }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn search_pages_have_no_skips_or_duplicates_and_match_all_terms() {
        let snapshot = Snapshot::bundled().unwrap();
        let mut after = None;
        let mut found = BTreeSet::new();
        loop {
            let page = page(
                &snapshot,
                CatalogModelsRead {
                    query: String::new(),
                    after,
                },
            );
            for model in page.models {
                assert!(found.insert(model.reference));
            }
            after = page.after;
            if after.is_none() {
                break;
            }
        }
        let expected: BTreeSet<_> = snapshot
            .models(None)
            .map(|(provider, model)| CatalogModelReference {
                provider: provider.into(),
                model_id: model.id.clone(),
            })
            .collect();
        assert_eq!(found, expected);
        let reference = expected.iter().next().unwrap();
        let page = page(
            &snapshot,
            CatalogModelsRead {
                query: format!(
                    "{}  {}",
                    reference.provider.to_uppercase(),
                    reference.model_id.to_uppercase()
                ),
                after: None,
            },
        );
        assert!(
            page.models
                .iter()
                .any(|model| model.reference == *reference)
        );
        assert!(page.models.iter().all(|model| {
            let text = format!(
                "{} {} {}",
                model.reference.provider, model.reference.model_id, model.label
            )
            .to_lowercase();
            text.contains(&reference.provider.to_lowercase())
                && text.contains(&reference.model_id.to_lowercase())
        }));
    }
}

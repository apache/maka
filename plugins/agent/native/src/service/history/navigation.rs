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

use super::*;
use maka_agent_state::{recall::Field, session_history::navigation::SourceFind};

pub(crate) async fn search(
    owner: &Owner,
    scope: &Scope,
    input: ui::HistorySearch,
) -> Result<ui::HistorySearchPage, String> {
    let history = open(owner, scope, &input.session_id).await?;
    let cut = cut(&history, Some(input.through)).await?;
    let tree = maka_agent_state::session_history::source_tree::SourceTree::live(&history, &cut)
        .await
        .map_err(|error| error.to_string())?;
    let mut request = SourceFind {
        after: input.after,
        query: input.query,
        case_sensitive: input.case_sensitive,
        whole_word: input.whole_word,
        include_internal: input.include_internal,
    };
    let mut cache = source::Cache::default();
    let page = loop {
        let mut page = tree
            .find_page(request.clone(), scope.cancellation.clone())
            .await
            .map_err(|error| error.to_string())?;
        let mut matches = Vec::new();
        for mut found in page.matches {
            if let Some((position, order)) = source::search_anchor(
                &tree,
                &found.position,
                found.order,
                &mut cache,
                &scope.cancellation,
            )
            .await?
            {
                found.position = position;
                found.order = order;
                matches.push(found);
            }
        }
        page.matches = matches;
        if !page.matches.is_empty() || page.next_after.is_none() {
            break page;
        }
        request.after = page.next_after;
    };
    authorize(owner, scope, &input.session_id).await?;
    Ok(ui::HistorySearchPage::Ready {
        through: cut.through_sequence,
        matches: page
            .matches
            .into_iter()
            .map(|found| ui::HistoryMatch {
                position: found.position,
                order: found.order,
                field: match found.field {
                    Field::Body => wire::SourceField::Body,
                    Field::Thinking => wire::SourceField::Thinking,
                    Field::ToolName => wire::SourceField::ToolName,
                    Field::FailureMessage => wire::SourceField::FailureMessage,
                    Field::ErrorClass => wire::SourceField::ErrorClass,
                    Field::Arguments => wire::SourceField::Arguments,
                    Field::Result => wire::SourceField::Result,
                    Field::Receipt => wire::SourceField::Receipt,
                },
                preview: found.preview,
            })
            .collect(),
        next_after: page.next_after,
    })
}
pub(crate) async fn landmarks(
    owner: &Owner,
    scope: &Scope,
    input: ui::HistoryLandmarksRead,
) -> Result<ui::HistoryLandmarks, String> {
    let history = open(owner, scope, &input.session_id).await?;
    let cut = cut(&history, Some(input.through)).await?;
    let tree = maka_agent_state::session_history::source_tree::SourceTree::live(&history, &cut)
        .await
        .map_err(|error| error.to_string())?;
    let landmarks = tree
        .landmarks(64, scope.cancellation.clone())
        .await
        .map_err(|error| error.to_string())?;
    authorize(owner, scope, &input.session_id).await?;
    Ok(ui::HistoryLandmarks {
        through: cut.through_sequence,
        landmarks: landmarks
            .into_iter()
            .map(|landmark| ui::HistoryLandmark {
                turn_id: landmark.turn_id,
                imported_turn: landmark.imported_turn,
                position: landmark.position,
                order: landmark.order,
                last_position: landmark.last_position,
                last_order: landmark.last_order,
                label: landmark.label,
                origin: landmark.origin,
            })
            .collect(),
    })
}

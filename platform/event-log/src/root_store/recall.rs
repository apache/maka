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

use super::{RootStore, SessionStore};
use crate::{
    StoreError,
    recall::{Ranked, SearchBatch, SearchContext, SearchQuery, normalize_query},
};
use futures_util::future::try_join_all;
use tokio_util::sync::CancellationToken;

impl RootStore {
    pub async fn search_history(
        &self,
        prefix: &str,
        mut input: SearchQuery,
        cancellation: CancellationToken,
    ) -> Result<SearchBatch, StoreError> {
        self.require_open()?;
        if prefix.is_empty()
            || input
                .session_id
                .as_ref()
                .is_some_and(|session| !session.starts_with(prefix))
        {
            return Err(StoreError::SessionNotFound);
        }
        normalize_query(&mut input)?;
        let stop = cancellation.child_token();
        let _cancel_on_drop = stop.clone().drop_guard();
        let results = try_join_all(self.partitions.iter().enumerate().map(|(partition, log)| {
            log.search_history_partition(partition, prefix.to_owned(), input.clone(), stop.clone())
        }))
        .await?;
        let batch = tokio::task::spawn_blocking(move || {
            let mut ranked = Ranked::new(input.limit);
            let mut gaps = Vec::new();
            for result in results {
                gaps.extend(result.gaps);
                for hit in result.hits {
                    if stop.is_cancelled() {
                        return Err(cancelled());
                    }
                    ranked.push(hit);
                }
            }
            if stop.is_cancelled() {
                return Err(cancelled());
            }
            Ok(SearchBatch {
                hits: ranked.finish(&stop)?,
                gaps,
            })
        })
        .await
        .map_err(|error| {
            StoreError::InvalidTransition(format!("history result merge failed: {error}"))
        })??;
        self.require_open()?;
        Ok(batch)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn history_context(
        &self,
        prefix: &str,
        session: &str,
        anchor_message_id: &str,
        before: usize,
        after: usize,
        through: Option<u64>,
        exclude: Option<(String, String)>,
        execution: Option<&SessionStore>,
        cancellation: CancellationToken,
    ) -> Result<SearchContext, StoreError> {
        self.require_open()?;
        if prefix.is_empty() || !session.starts_with(prefix) || anchor_message_id.is_empty() {
            return Err(StoreError::SessionNotFound);
        }
        let stop = cancellation.child_token();
        let _cancel_on_drop = stop.clone().drop_guard();
        let selected = async {
            if let Some(execution) = execution {
                let (source, _, _) = self
                    .pin_session_pair(session, execution.id(), Some(execution))
                    .await?;
                Ok::<_, StoreError>(source)
            } else {
                self.session(session).await?.scoped().await
            }
        };
        let log = tokio::select! {
            biased;
            _ = stop.cancelled() => return Err(cancelled()),
            selected = selected => selected?,
        };
        let partition = self.route_partition(session).await?;
        log.history_context_partition(
            partition,
            prefix.to_owned(),
            session.to_owned(),
            anchor_message_id.to_owned(),
            before,
            after,
            through,
            exclude,
            stop,
        )
        .await
    }
}

fn cancelled() -> StoreError {
    StoreError::InvalidTransition("history search cancelled".into())
}

#[cfg(test)]
mod tests;

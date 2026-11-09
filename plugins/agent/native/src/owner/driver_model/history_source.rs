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

//! Exclusive reads from the live fixed cut or an actual bound snapshot.
use maka_agent_engine::{
    RunError,
    preparation::{self, MediaSource, NotificationSource},
};
use maka_agent_facts::durable::{ContentRef, RecordedFact, RequestSpec, RunId, StepId};
use maka_agent_state::{
    Store,
    artifacts::{ArtifactReadScope, ArtifactStore},
    fold::RunView,
    session_history::{HistoryCut, HistoryItem, RunSource, SessionHistory, snapshot::Snapshot},
};
use serde::de::DeserializeOwned;
use std::io::BufReader;

#[derive(Clone)]
pub(super) enum HistorySource<'a> {
    Live {
        state: &'a Store,
        history: SessionHistory,
        cut: HistoryCut,
        artifacts: ArtifactStore,
    },
    Snapshot(Snapshot, Vec<RunId>),
}
impl<'a> HistorySource<'a> {
    pub(super) fn live(state: &'a Store, cut: &HistoryCut) -> Self {
        Self::Live {
            state,
            history: state.session_history(cut.owner.clone(), cut.session.clone()),
            cut: cut.clone(),
            artifacts: state.artifacts(),
        }
    }
    pub(super) async fn page(
        &self,
        after: u64,
        limit: u32,
    ) -> Result<(Vec<HistoryItem>, Option<u64>), RunError> {
        match self {
            Self::Live { history, cut, .. } => {
                let page = history.page(cut, after, limit).await?;
                Ok((page.items, page.next))
            }
            Self::Snapshot(snapshot, _) => {
                let page = snapshot.page(after, limit).await?;
                Ok((page.items, page.next))
            }
        }
    }
    pub(super) async fn run_source(&self, run: RunId) -> Result<RunSource, RunError> {
        Ok(match self {
            Self::Live { history, .. } => history.run_source(run).await?,
            Self::Snapshot(snapshot, _) => snapshot.run_source(run).await?,
        })
    }
    pub(super) async fn view(&self, run: RunId) -> Result<RunView, RunError> {
        match self {
            Self::Live { history, cut, .. } => Ok(history.view_at(cut, run).await?),
            Self::Snapshot(snapshot, _) => {
                let source = snapshot.run_source(run).await?;
                let mut view = RunView::admitted(run, source.spec)?;
                let mut after = 0;
                loop {
                    let page = snapshot.history(run, after, 256).await?;
                    if page.is_empty() {
                        break;
                    }
                    for fact in page {
                        view.apply(&fact)?;
                        after = fact.revision;
                    }
                }
                Ok(view)
            }
        }
    }
    pub(super) async fn history(
        &self,
        run: RunId,
        after: u64,
        limit: u32,
    ) -> Result<Vec<RecordedFact>, RunError> {
        Ok(match self {
            Self::Live { state, .. } => state.history(run, after, limit).await?,
            Self::Snapshot(snapshot, _) => snapshot.history(run, after, limit).await?,
        })
    }
    pub(super) async fn request(&self, run: RunId, step: StepId) -> Result<RequestSpec, RunError> {
        Ok(match self {
            Self::Live { history, cut, .. } => history.request(cut, run, step).await?,
            Self::Snapshot(snapshot, _) => snapshot.request(run, step).await?,
        })
    }
    pub(super) async fn tool_call(
        &self,
        run: RunId,
        key: &maka_agent_facts::durable::ToolKey,
    ) -> Result<maka_agent_facts::model::ModelToolCall, RunError> {
        Ok(match self {
            Self::Live { history, cut, .. } => history.tool_call(cut, run, key).await?,
            Self::Snapshot(snapshot, _) => snapshot.tool_call(run, key).await?,
        })
    }
    pub(super) async fn decode<T: DeserializeOwned + Send + 'static>(
        &self,
        run: RunId,
        reference: &ContentRef,
    ) -> Result<T, RunError> {
        let consume = |reader: &mut dyn std::io::Read| {
            Ok(serde_json::from_reader::<_, T>(BufReader::new(reader)))
        };
        let decoded = match self {
            Self::Live { history, cut, .. } => {
                history.with_content(cut, run, reference, consume).await?
            }
            Self::Snapshot(snapshot, _) => snapshot.with_content(run, reference, consume).await?,
        };
        decoded.map_err(RunError::Checkpoint)
    }
    pub(super) fn content_source(&self) -> preparation::ContentSource<'_> {
        match self {
            Self::Live { history, cut, .. } => preparation::ContentSource::Live { history, cut },
            Self::Snapshot(snapshot, _) => preparation::ContentSource::Snapshot(snapshot),
        }
    }
    pub(super) fn tool_result_reader(
        &self,
        run: RunId,
        stop: &tokio_util::sync::CancellationToken,
    ) -> maka_agent_state::session_history::tool_result_source::ToolResultReader {
        use maka_agent_state::session_history::tool_result_source::ToolResultReader;
        match self {
            Self::Live { history, cut, .. } => ToolResultReader::live(history, cut, run, stop),
            Self::Snapshot(snapshot, _) => ToolResultReader::snapshot(snapshot, run, stop),
        }
    }
    pub(super) fn media_source(&self, scope: ArtifactReadScope) -> MediaSource<'_> {
        match self {
            Self::Live { artifacts, .. } => MediaSource::Live { artifacts, scope },
            Self::Snapshot(snapshot, _) => MediaSource::Snapshot { snapshot, scope },
        }
    }
    pub(super) fn notification_source(&self) -> NotificationSource<'_> {
        match self {
            Self::Live { state, .. } => NotificationSource::Live(state),
            Self::Snapshot(snapshot, _) => NotificationSource::Snapshot(snapshot),
        }
    }
    pub(super) fn as_snapshot(&self) -> Option<&Snapshot> {
        match self {
            Self::Live { .. } => None,
            Self::Snapshot(snapshot, _) => Some(snapshot),
        }
    }
    pub(super) async fn nested(&self, run: RunId) -> Result<Self, RunError> {
        let mut path = self.source_path().to_vec();
        path.push(run);
        let snapshot = match self {
            Self::Live { history, cut, .. } => history.snapshot(cut, run).await?,
            Self::Snapshot(snapshot, _) => snapshot.nested(run).await?,
        };
        Ok(Self::Snapshot(snapshot, path))
    }
    pub(super) fn source_path(&self) -> &[RunId] {
        match self {
            Self::Live { .. } => &[],
            Self::Snapshot(_, path) => path,
        }
    }
}

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

//! Resolve request document citations from independent compiler facts.
use crate::ModelError;
use maka_agent_facts::model::prompt_source::{NativeCitationDocuments, WireSource};
use maka_provider_protocol::output::{Event, Source};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(super) struct Documents(Arc<dyn NativeCitationDocuments>);
impl Documents {
    pub(super) fn new(source: &dyn WireSource) -> Option<Self> {
        source.citation_documents().map(Self)
    }
    pub(super) fn len(&self) -> usize {
        self.0.len()
    }
    pub(super) async fn resolve(
        &self,
        events: &mut [Event],
        cancellation: &CancellationToken,
    ) -> Result<(), ModelError> {
        for event in events {
            let Event::Source(source) = event else {
                continue;
            };
            let Source::DeferredDocument {
                id,
                document_index,
                title,
                extensions,
            } = source
            else {
                continue;
            };
            if cancellation.is_cancelled() {
                return Err(ModelError::Cancelled);
            }
            let document = self.0.document(*document_index).ok_or_else(|| {
                ModelError::Adapter(
                    "source citation document index is outside its frozen request".into(),
                )
            })?;
            *source = Source::Document {
                id: std::mem::take(id),
                media_type: document.media_type().into(),
                title: title.take().unwrap_or_else(|| "Untitled Document".into()),
                filename: None,
                extensions: extensions.take(),
            };
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;

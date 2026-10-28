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

//! Resolve only request documents actually emitted as model sources.
use crate::ModelError;
use maka_agent_facts::model::prompt_source::source::{
    self, SourceBudget, SourceBudgetFactory, TextSource,
};
use maka_provider_protocol::output::{Event, Source};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(super) struct Documents {
    documents: Arc<dyn maka_agent_facts::model::prompt_source::WireSource>,
    budgets: Arc<dyn SourceBudgetFactory>,
}
impl Documents {
    pub(super) fn new(
        documents: Arc<dyn maka_agent_facts::model::prompt_source::WireSource>,
    ) -> Result<Option<Self>, ModelError> {
        if documents.document_count() == 0 {
            return Ok(None);
        }
        let budgets = documents.budget_factory().ok_or_else(|| {
            ModelError::Adapter("source citation documents have no preparation resources".into())
        })?;
        Ok(Some(Self { documents, budgets }))
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
            let budget = tokio::select! {biased;_ = cancellation.cancelled()=>return Err(ModelError::Cancelled),result=self.budgets.acquire()=>result.map_err(|error|ModelError::Adapter(error.to_string()))?};
            if cancellation.is_cancelled() {
                return Err(ModelError::Cancelled);
            }
            let document = self
                .documents
                .document(*document_index, budget.clone())
                .await?
                .ok_or_else(|| {
                    ModelError::Adapter(
                        "source citation document index is outside its frozen request".into(),
                    )
                })?;
            let media_type = owned_text(
                document.media_type.text.clone(),
                budget.clone(),
                cancellation,
            )
            .await?;
            let title = match title.take() {
                Some(title) => title,
                None => {
                    owned_text(document.title.text.clone(), budget.clone(), cancellation).await?
                }
            };
            let filename = match &document.filename {
                Some(filename) => {
                    Some(owned_text(filename.text.clone(), budget, cancellation).await?)
                }
                None => None,
            };
            *source = Source::Document {
                id: std::mem::take(id),
                media_type,
                title,
                filename,
                extensions: extensions.take(),
            };
        }
        Ok(())
    }
}
async fn owned_text(
    text: TextSource,
    budget: Arc<dyn SourceBudget>,
    cancellation: &CancellationToken,
) -> Result<String, ModelError> {
    if cancellation.is_cancelled() {
        return Err(ModelError::Cancelled);
    }
    let mut cursor = source::text::cursor(text, budget.clone());
    let mut buffer = budget
        .allocate(4096)
        .await
        .map_err(|error| ModelError::Adapter(error.to_string()))?;
    let mut output = String::new();
    let mut pending = [0; 4];
    let mut pending_len = 0;
    loop {
        if cancellation.is_cancelled() {
            return Err(ModelError::Cancelled);
        }
        let read = cursor
            .read_chunk(buffer)
            .await
            .map_err(|error| ModelError::Adapter(error.to_string()))?;
        append_utf8(
            &mut output,
            &read.buffer.as_ref()[..read.bytes_read],
            &mut pending,
            &mut pending_len,
        )?;
        buffer = read.buffer;
        if read.eof {
            if pending_len != 0 {
                return Err(ModelError::Adapter("truncated citation UTF-8 text".into()));
            }
            break;
        }
        if read.bytes_read == 0 {
            return Err(ModelError::Adapter(
                "citation text source made no progress".into(),
            ));
        }
        tokio::task::yield_now().await;
    }
    Ok(output)
}
fn append_utf8(
    output: &mut String,
    mut bytes: &[u8],
    pending: &mut [u8; 4],
    pending_len: &mut usize,
) -> Result<(), ModelError> {
    while !bytes.is_empty() {
        if *pending_len > 0 {
            pending[*pending_len] = bytes[0];
            *pending_len += 1;
            bytes = &bytes[1..];
            match std::str::from_utf8(&pending[..*pending_len]) {
                Ok(text) => {
                    output.push_str(text);
                    *pending_len = 0;
                }
                Err(error) if error.error_len().is_none() => {}
                Err(error) => return Err(ModelError::Adapter(error.to_string())),
            }
            continue;
        }
        match std::str::from_utf8(bytes) {
            Ok(text) => {
                output.push_str(text);
                break;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                output.push_str(
                    std::str::from_utf8(&bytes[..valid]).expect("validated UTF-8 prefix"),
                );
                if error.error_len().is_some() {
                    return Err(ModelError::Adapter(error.to_string()));
                }
                let tail = &bytes[valid..];
                pending[..tail.len()].copy_from_slice(tail);
                *pending_len = tail.len();
                break;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;

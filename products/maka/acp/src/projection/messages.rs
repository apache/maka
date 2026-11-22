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

pub(crate) struct ModelMetadataUpdate {
    key: (MessageIdentity, MessageKind),
    meta: Meta,
    pub update: Update,
}

impl Projection {
    pub fn pending_model_positions(
        &self,
        steps: Option<&HashSet<(StepId, ModelAttemptId)>>,
    ) -> Vec<(
        maka_agent_ports::session::history::RowPosition,
        HistoryField,
    )> {
        let rows: Vec<_> = if let Some(steps) = steps {
            steps
                .iter()
                .filter_map(|step| self.pending_models.get(step))
                .collect()
        } else {
            self.pending_models.values().collect()
        };
        rows.into_iter()
            .flat_map(|rows| rows.iter())
            .map(|(position, kind)| {
                (
                    position.clone(),
                    if *kind == MessageKind::Thinking {
                        HistoryField::Thinking
                    } else {
                        HistoryField::Body
                    },
                )
            })
            .collect()
    }

    pub fn acknowledge_models(&mut self, steps: Option<&HashSet<(StepId, ModelAttemptId)>>) {
        if let Some(steps) = steps {
            for step in steps {
                self.pending_models.remove(step);
            }
        } else {
            self.pending_models.clear();
        }
    }

    pub fn prepare_model_metadata(
        &self,
        chunk: &HistoryChunk,
    ) -> Result<Option<ModelMetadataUpdate>, crate::Error> {
        let kind = if chunk.field == HistoryField::Thinking {
            MessageKind::Thinking
        } else {
            MessageKind::Text
        };
        let identity = MessageIdentity::history(chunk);
        let key = (identity.clone(), kind);
        let message = self
            .streams
            .get(&key)
            .ok_or("Model metadata has no canonical message")?;
        let model = chunk.model.as_ref().map(serde_json::to_value).transpose()?;
        if message.meta["maka"].get("model") == model.as_ref() {
            return Ok(None);
        }
        let mut meta = message.meta.clone();
        let metadata = meta
            .get_mut("maka")
            .and_then(Value::as_object_mut)
            .expect("message metadata");
        if let Some(model) = model {
            metadata.insert("model".into(), model);
        } else {
            metadata.remove("model");
        }
        let update = Update::Message {
            id: identity.presentation_id(kind)?,
            kind,
            text: Text::Metadata,
            meta: meta.clone(),
        };
        Ok(Some(ModelMetadataUpdate { key, meta, update }))
    }

    pub fn commit_model_metadata(&mut self, update: ModelMetadataUpdate) {
        self.streams
            .get_mut(&update.key)
            .expect("retained canonical message")
            .meta = update.meta;
    }

    pub(super) fn replace_text(
        &mut self,
        identity: MessageIdentity,
        kind: MessageKind,
        next: &str,
        meta: Meta,
    ) -> Result<Vec<Update>, crate::Error> {
        let key = (identity.clone(), kind);
        let previous = self.streams.get(&key);
        if previous.is_some_and(|p| p.text == next && p.meta == meta)
            || (previous.is_none()
                && next.is_empty()
                && kind != MessageKind::User
                && !matches!(&identity, MessageIdentity::Row(_)))
        {
            return Ok(vec![]);
        }
        let message_id = identity.presentation_id(kind)?;
        let update = Update::Message {
            id: message_id,
            kind,
            text: Text::Snapshot(next.into()),
            meta: meta.clone(),
        };
        let canonical = previous.is_some_and(|message| message.canonical);
        self.streams.insert(
            key,
            Message {
                text: next.to_owned(),
                meta,
                canonical,
            },
        );
        Ok(vec![update])
    }
}

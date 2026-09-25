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

use crate::artifact::{Artifact, content_digest};
use crate::event::{CommitError, Fact, Invocation, RuntimeEvent, ToolOutcome};
use crate::tool_output::{RawToolResultRef, ToolOutput, ToolSuccess, encode_raw_tool_result};
use std::{sync::Arc, time::SystemTime};

/// One checked transaction submission: successful facts cannot omit their bytes.
#[derive(Clone, Debug)]
pub struct EventWrite {
    composition: Option<Arc<crate::composition::FrozenComposition>>,
    quote: Option<crate::pricing::Quote>,
    event: RuntimeEvent,
    raw_payload: Option<Arc<[u8]>>,
    projection_artifacts: Vec<ProjectionArtifactWrite>,
}

#[derive(Clone, Debug)]
pub struct ProjectionArtifactWrite {
    artifact: Artifact,
    bytes: Arc<[u8]>,
}

impl ProjectionArtifactWrite {
    pub(crate) fn new(artifact: Artifact, bytes: Vec<u8>) -> Self {
        Self {
            artifact,
            bytes: bytes.into(),
        }
    }
    pub fn artifact(&self) -> &Artifact {
        &self.artifact
    }
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn evidence(&self) -> crate::artifact::ArtifactEvidence {
        crate::artifact::ArtifactEvidence {
            id: self.artifact.id.clone(),
            bytes: self.bytes.len() as u64,
            digest: content_digest(&self.bytes),
        }
    }
}

impl EventWrite {
    pub fn plain(event: RuntimeEvent) -> Result<Self, CommitError> {
        match &event.fact {
            Fact::ToolNotified {
                operation_id,
                text,
                model_text,
            } if operation_id.is_empty()
                || operation_id.len() > 4096
                || text.trim().is_empty()
                || text.len() > 128 * 1024
                || model_text.trim().is_empty()
                || model_text.len() > 128 * 1024 =>
            {
                return Err(CommitError::Rejected(
                    "invalid Code Mode notification".into(),
                ));
            }
            Fact::MessageImported { .. } => {
                return Err(CommitError::Rejected(
                    "imported history requires Session import admission".into(),
                ));
            }
            Fact::ExecutorStarted { binding, settings } => binding
                .validate()
                .and_then(|()| settings.validate())
                .map_err(|reason| CommitError::Rejected(reason.into()))?,
            Fact::ExecutorObserved { output } => output
                .validate()
                .map_err(|reason| CommitError::Rejected(reason.into()))?,
            Fact::ExecutorCompleted { text } if text.len() > 1024 * 1024 => {
                return Err(CommitError::Rejected(
                    "executor result exceeds 1 MiB".into(),
                ));
            }
            _ => {}
        }
        if let Fact::InvocationOpened { input, .. } = &event.fact {
            input
                .validate_inheritance(&event.invocation)
                .map_err(|reason| CommitError::Rejected(reason.into()))?;
        }
        if let Fact::InvocationOpened {
            input:
                crate::input::InvocationInput::Continuation {
                    request_fingerprint,
                    ..
                },
            ..
        } = &event.fact
            && !crate::archive::valid_projection_digest(request_fingerprint)
        {
            return Err(CommitError::Rejected(
                "invalid continuation request fingerprint".into(),
            ));
        }
        if let Fact::InvocationOpened {
            input:
                crate::input::InvocationInput::Message {
                    content,
                    source_messages,
                    ..
                },
            ..
        } = &event.fact
        {
            crate::message::validate_sources(content, source_messages)
                .map_err(|message| CommitError::Rejected(message.into()))?;
            if !source_messages.is_empty()
                && serde_json::to_vec(&event)
                    .map_err(|error| CommitError::Rejected(error.to_string()))?
                    .len()
                    > 1024 * 1024
            {
                return Err(CommitError::Rejected(
                    "root message opening exceeds durable capacity".into(),
                ));
            }
        }
        if let Fact::MessageSteered { message } = &event.fact {
            message
                .validate()
                .map_err(|message| CommitError::Rejected(message.into()))?;
        }
        if let Fact::InvocationOpened {
            configuration: Some(configuration),
            ..
        } = &event.fact
            && let Some(prompt) = &configuration.system_prompt
        {
            prompt
                .validate()
                .map_err(|message| CommitError::Rejected(message.into()))?;
        }
        if let Fact::ToolResultArchived { placeholder } = &event.fact {
            placeholder
                .validate()
                .map_err(|message| CommitError::Rejected(message.into()))?;
        }
        if let Fact::ModelRequested {
            effective_source_digest: Some(digest),
            ..
        } = &event.fact
            && !crate::archive::valid_projection_digest(digest)
        {
            return Err(CommitError::Rejected(
                "invalid effective source digest".into(),
            ));
        }
        if let Fact::ModelRequested {
            context: Some(context),
            ..
        } = &event.fact
        {
            context
                .validate()
                .map_err(|message| CommitError::Rejected(message.into()))?;
        }
        if let Fact::ContextCheckpointRecorded { checkpoint } = &event.fact {
            checkpoint
                .validate()
                .map_err(|message| CommitError::Rejected(message.into()))?;
        }
        if matches!(
            event.fact,
            Fact::ToolSettled {
                outcome: ToolOutcome::Succeeded { .. },
                ..
            }
        ) {
            return Err(CommitError::Rejected(
                "successful tool fact requires its raw payload".into(),
            ));
        }
        Ok(Self {
            composition: None,
            quote: None,
            event,
            raw_payload: None,
            projection_artifacts: Vec::new(),
        })
    }

    /// Identity and capture time are supplied once and preserved across exact retries.
    pub fn tool_success(
        id: String,
        recorded_at: SystemTime,
        invocation: Invocation,
        operation_id: String,
        success: ToolSuccess,
    ) -> Result<(Self, ToolOutput), CommitError> {
        let success = success
            .normalize(&id, recorded_at, &invocation)
            .map_err(|message| CommitError::Rejected(message.into()))?;
        let output = success.output;
        let bytes = encode_raw_tool_result(&output)
            .map_err(|message| CommitError::Rejected(message.into()))?;
        let raw = RawToolResultRef {
            bytes: bytes.len() as u64,
            digest: content_digest(&bytes),
        };
        Ok((
            Self {
                composition: None,
                quote: None,
                event: RuntimeEvent {
                    id,
                    recorded_at,
                    invocation,
                    fact: Fact::ToolSettled {
                        operation_id,
                        outcome: ToolOutcome::Succeeded {
                            raw,
                            model_projection: success.projection,
                            artifacts: success
                                .artifacts
                                .iter()
                                .map(ProjectionArtifactWrite::evidence)
                                .collect(),
                        },
                    },
                },
                raw_payload: Some(bytes.into()),
                projection_artifacts: success.artifacts,
            },
            output,
        ))
    }

    pub fn event(&self) -> &RuntimeEvent {
        &self.event
    }
    pub fn with_composition(
        mut self,
        composition: Arc<crate::composition::FrozenComposition>,
    ) -> Result<Self, CommitError> {
        if !matches!(self.event.fact, Fact::ModelRequested { .. }) {
            return Err(CommitError::Rejected(
                "request composition requires a model request".into(),
            ));
        }
        self.composition = Some(composition);
        Ok(self)
    }
    pub fn composition(&self) -> Option<&crate::composition::FrozenComposition> {
        self.composition.as_deref()
    }
    pub fn with_quote(mut self, quote: crate::pricing::Quote) -> Result<Self, CommitError> {
        let Fact::ModelRequested { model_id, .. } = &self.event.fact else {
            return Err(CommitError::Rejected(
                "model quote requires a model request".into(),
            ));
        };
        quote
            .validate(model_id)
            .map_err(|error| CommitError::Rejected(error.into()))?;
        self.quote = Some(quote);
        Ok(self)
    }
    pub fn quote(&self) -> Option<&crate::pricing::Quote> {
        self.quote.as_ref()
    }
    pub fn raw_payload(&self) -> Option<&[u8]> {
        self.raw_payload.as_deref()
    }
    pub fn projection_artifacts(&self) -> &[ProjectionArtifactWrite] {
        &self.projection_artifacts
    }
}

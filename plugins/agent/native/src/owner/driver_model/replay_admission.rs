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

use maka_agent_engine::{PreparedModel, RunError, preparation};
use maka_agent_facts::{
    context::{CodexRequestProvenance, ModelOperation, codex_replay_allowed},
    model::{ModelPart, PlaintextReasoningReplay, TextKind, prompt_source::source::*},
};
use maka_model::{ProviderKind, prompt::AssistantPart};
use std::sync::Arc;

#[derive(Clone, Copy)]
pub(in crate::owner) struct ReplayTarget<'a> {
    pub model: &'a str,
    pub codex: Option<&'a CodexRequestProvenance>,
    provider: &'a ProviderKind,
    operation: ModelOperation,
}

#[derive(Clone, Copy)]
enum Reasoning {
    Original,
    Plaintext,
    Omit,
}

impl<'a> ReplayTarget<'a> {
    pub fn new(model: &'a PreparedModel, operation: ModelOperation) -> Self {
        Self {
            model: &model.provider.model,
            codex: model
                .context
                .as_ref()
                .and_then(|context| context.codex.as_ref()),
            provider: &model.provider.kind,
            operation,
        }
    }

    pub fn encrypted_allowed(self, model: &str, source: Option<&CodexRequestProvenance>) -> bool {
        let (Some(target), Some(source)) = (self.codex, source) else {
            return false;
        };
        codex_replay_allowed(
            self.model == model,
            source
                .compatibility
                .as_ref()
                .zip(target.compatibility.as_ref())
                .map(|(old, new)| old.comp_hash == new.comp_hash),
            self.operation,
        )
    }

    fn reasoning(self, model: &str, source: Option<&CodexRequestProvenance>) -> Reasoning {
        if (self.codex.is_none() && source.is_none()) || self.encrypted_allowed(model, source) {
            return Reasoning::Original;
        }
        self.incompatible()
    }

    fn incompatible(self) -> Reasoning {
        match self.provider {
            ProviderKind::OpenaiChatCompletions | ProviderKind::OpenaiCompatible { .. } => {
                Reasoning::Plaintext
            }
            ProviderKind::OpenResponses(contract)
                if contract.reasoning_replay == PlaintextReasoningReplay::PlaintextContent =>
            {
                Reasoning::Plaintext
            }
            _ => Reasoning::Omit,
        }
    }

    pub fn part(
        self,
        part: &ModelPart,
        model: &str,
        source: Option<&CodexRequestProvenance>,
    ) -> Result<Option<AssistantPart>, RunError> {
        let mut projected = preparation::assistant_part(part)?;
        if let ModelPart::Text {
            text_kind: TextKind::Thinking,
            ..
        } = part
        {
            match self.reasoning(model, source) {
                Reasoning::Original => {}
                Reasoning::Omit => return Ok(None),
                Reasoning::Plaintext => {
                    if let Some(AssistantPart::Reasoning {
                        provider_options, ..
                    }) = &mut projected
                    {
                        *provider_options = None;
                    }
                }
            }
        }
        Ok(projected)
    }

    /// New requests use each opaque leaf's producer, never the enclosing request's certificate.
    pub async fn recipe(self, recipe: MessageRecipe) -> Result<Option<MessageRecipe>, RunError> {
        let MessageRecipe::Assistant {
            content,
            provider_options,
        } = recipe
        else {
            return Ok(Some(recipe));
        };
        let admission = RecipeAdmission {
            target: ReplayOrigin::observed(self.model, self.codex),
            operation: self.operation,
            incompatible: self.incompatible(),
        };
        let mut len = 0usize;
        let mut cursor = content.open(0);
        while let Some(part) = cursor.next().await? {
            if admitted_recipe(part, admission)?.is_some() {
                len = len
                    .checked_add(1)
                    .ok_or_else(|| RunError::InvalidInput("assistant directory overflow".into()))?;
            }
        }
        Ok((len > 0).then(|| MessageRecipe::Assistant {
            content: Arc::new(AdmittedParts {
                content,
                admission,
                len,
            }),
            provider_options,
        }))
    }
}

#[derive(Clone, Copy)]
struct RecipeAdmission {
    target: ReplayOrigin,
    operation: ModelOperation,
    incompatible: Reasoning,
}
impl RecipeAdmission {
    fn decide(self, origin: ReplayOrigin) -> (Reasoning, bool) {
        use CodexReplayOrigin::{Absent, Hashed};
        let encrypted = match (origin, self.target) {
            (
                ReplayOrigin::Observed {
                    model: old,
                    codex: source,
                },
                ReplayOrigin::Observed {
                    model: new,
                    codex: target,
                },
            ) if source != Absent && target != Absent => codex_replay_allowed(
                old == new,
                match (source, target) {
                    (Hashed(old), Hashed(new)) => Some(old == new),
                    _ => None,
                },
                self.operation,
            ),
            _ => false,
        };
        let non_codex = matches!(
            origin,
            ReplayOrigin::Unattested | ReplayOrigin::Observed { codex: Absent, .. }
        ) && matches!(self.target, ReplayOrigin::Observed { codex: Absent, .. });
        (
            if encrypted || non_codex {
                Reasoning::Original
            } else {
                self.incompatible
            },
            encrypted,
        )
    }
}
fn admitted_recipe(
    part: AssistantRecipe,
    admission: RecipeAdmission,
) -> std::io::Result<Option<AssistantRecipe>> {
    Ok(match part {
        AssistantRecipe::CodexCompaction { item } => {
            if !admission.decide(item.replay_origin()).1 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "native Codex checkpoint requires compatible ChatGPT state or re-compaction",
                ));
            }
            Some(AssistantRecipe::CodexCompaction { item })
        }
        AssistantRecipe::Reasoning {
            text,
            provider_options,
        } => {
            let origin = provider_options
                .as_ref()
                .map(JsonSource::replay_origin)
                .unwrap_or(ReplayOrigin::Unattested);
            match admission.decide(origin).0 {
                Reasoning::Original => Some(AssistantRecipe::Reasoning {
                    text,
                    provider_options,
                }),
                Reasoning::Plaintext => Some(AssistantRecipe::Reasoning {
                    text,
                    provider_options: None,
                }),
                Reasoning::Omit => None,
            }
        }
        part => Some(part),
    })
}

struct AdmittedParts {
    content: Arc<dyn RecipeSource<AssistantRecipe>>,
    admission: RecipeAdmission,
    len: usize,
}
struct AdmittedCursor {
    source: Box<dyn RecipeCursor<AssistantRecipe>>,
    admission: RecipeAdmission,
    skip: usize,
}
impl RecipeSource<AssistantRecipe> for AdmittedParts {
    fn len(&self) -> usize {
        self.len
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<AssistantRecipe>> {
        Box::new(AdmittedCursor {
            source: self.content.open(0),
            admission: self.admission,
            skip: start,
        })
    }
}
impl RecipeCursor<AssistantRecipe> for AdmittedCursor {
    fn next(&mut self) -> NextRecipe<'_, AssistantRecipe> {
        Box::pin(async move {
            while let Some(part) = self.source.next().await? {
                if let Some(part) = admitted_recipe(part, self.admission)? {
                    if self.skip > 0 {
                        self.skip -= 1;
                    } else {
                        return Ok(Some(part));
                    }
                }
            }
            Ok(None)
        })
    }
}

/// Only canonical producing requests/checkpoints may introduce an observed origin.
pub(in crate::owner) async fn append_observed(
    messages: &mut preparation::PromptBuilder,
    message: maka_model::prompt::Message,
    origin: ReplayOrigin,
) -> Result<(), RunError> {
    let prompt = maka_model::prompt::Prompt::from_messages(vec![message]);
    let source = prompt
        .recipes()
        .ok_or_else(|| RunError::Internal("generated recipe absent".into()))?;
    let mut cursor = source.open(0);
    while let Some(recipe) = cursor.next().await? {
        let recipe = match recipe {
            MessageRecipe::Assistant {
                content,
                provider_options,
            } => MessageRecipe::Assistant {
                content: Arc::new(OriginParts { content, origin }),
                provider_options,
            },
            recipe => recipe,
        };
        messages.append_recipe(&recipe).await?;
    }
    Ok(())
}
struct OriginParts {
    content: Arc<dyn RecipeSource<AssistantRecipe>>,
    origin: ReplayOrigin,
}
struct OriginCursor {
    source: Box<dyn RecipeCursor<AssistantRecipe>>,
    origin: ReplayOrigin,
}
impl RecipeSource<AssistantRecipe> for OriginParts {
    fn len(&self) -> usize {
        self.content.len()
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<AssistantRecipe>> {
        Box::new(OriginCursor {
            source: self.content.open(start),
            origin: self.origin,
        })
    }
}
impl RecipeCursor<AssistantRecipe> for OriginCursor {
    fn next(&mut self) -> NextRecipe<'_, AssistantRecipe> {
        Box::pin(async move {
            Ok(self.source.next().await?.map(|part| match part {
                AssistantRecipe::Reasoning {
                    text,
                    provider_options,
                } => AssistantRecipe::Reasoning {
                    text,
                    provider_options: provider_options
                        .map(|value| value.with_replay_origin(self.origin)),
                },
                AssistantRecipe::CodexCompaction { item } => AssistantRecipe::CodexCompaction {
                    item: item.with_replay_origin(self.origin),
                },
                part => part,
            }))
        })
    }
}

pub(in crate::owner) fn current_context(
    provenance: &mut serde_json::Value,
    model: &PreparedModel,
    operation: ModelOperation,
) -> Result<Option<maka_agent_facts::context::ModelRequestContext>, RunError> {
    let mut context = model.context.clone();
    if let Some(value) = context.as_mut() {
        value.operation = operation;
    }
    provenance
        .as_object_mut()
        .ok_or_else(|| RunError::InvalidInput("frozen model provenance is not an object".into()))?
        .insert(
            "modelContext".into(),
            serde_json::to_value(&context).map_err(RunError::Json)?,
        );
    Ok(context)
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::context::CodexCompatibility;
    use serde_json::json;

    fn provenance(account: &str, hash: Option<&str>) -> CodexRequestProvenance {
        CodexRequestProvenance {
            connection_id: format!("connection-{account}"),
            account_id: Some(account.into()),
            compatibility: hash.map(|hash| CodexCompatibility {
                comp_hash: hash.into(),
                fetched_at: 1,
            }),
        }
    }

    #[test]
    fn reasoning_uses_recorded_model_and_hash_not_account_connection_or_catalog_age() {
        let options = json!({"openai":{"itemId":"reason-original","reasoningEncryptedContent":"opaque-original"}});
        let part = ModelPart::Text {
            text_kind: TextKind::Thinking,
            text: "visible summary".into(),
            provider_options: Some(Arc::new(options.clone())),
        };
        let provider = ProviderKind::OpenaiResponses;
        for (source_model, source_hash, source_codex, model, hash, target_codex, expected) in [
            (
                "model-a",
                Some("3000"),
                true,
                "model-b",
                Some("3000"),
                true,
                true,
            ),
            (
                "model-a",
                Some("3000"),
                true,
                "model-b",
                Some("4000"),
                true,
                false,
            ),
            ("model-a", None, true, "model-b", Some("3000"), true, false),
            ("model-a", Some("3000"), true, "model-b", None, true, false),
            ("model-a", None, true, "model-a", None, true, true),
            (
                "model-a",
                Some("3000"),
                true,
                "model-a",
                Some("4000"),
                true,
                false,
            ),
            (
                "model-a",
                Some("3000"),
                false,
                "model-a",
                Some("3000"),
                true,
                false,
            ),
            (
                "model-a",
                Some("3000"),
                true,
                "model-a",
                Some("3000"),
                false,
                false,
            ),
        ] {
            let source = provenance("original-account", source_hash);
            let target = provenance("other-account", hash);
            let target = ReplayTarget {
                model,
                codex: target_codex.then_some(&target),
                provider: &provider,
                operation: ModelOperation::Inference,
            };
            let projected = target
                .part(&part, source_model, source_codex.then_some(&source))
                .unwrap();
            assert_eq!(
                projected.is_some(),
                expected,
                "{source_model}/{source_hash:?} -> {model}/{hash:?}"
            );
            if let Some(AssistantPart::Reasoning {
                text,
                provider_options,
            }) = projected
            {
                assert_eq!(text, "visible summary");
                assert_eq!(
                    provider_options,
                    Some(options.clone()),
                    "opaque payload must be replayed unchanged"
                );
            }
        }
        let source = provenance("original-account", Some("3000"));
        let provider = ProviderKind::OpenaiCompatible {
            name: "ollama".into(),
        };
        let target = ReplayTarget {
            model: "other",
            codex: None,
            provider: &provider,
            operation: ModelOperation::Inference,
        };
        assert_eq!(
            target.part(&part, "model-a", Some(&source)).unwrap(),
            Some(AssistantPart::Reasoning {
                text: "visible summary".into(),
                provider_options: None
            })
        );
    }

    #[tokio::test]
    async fn native_items_share_reasoning_admission_and_same_model_can_recompact_old_hash() {
        let provider = ProviderKind::OpenaiResponses;
        let source = provenance("original-account", Some("3000"));
        let equal = provenance("other-account", Some("3000"));
        let changed = provenance("other-account", Some("4000"));
        let item = json!({"type":"compaction","id":"original","encrypted_content":"opaque-original","extension":{"keep":true}});
        let recipe = || MessageRecipe::Assistant {
            content: Arc::new(generated::GeneratedRecipes::new(vec![
                AssistantRecipe::CodexCompaction {
                    item: generated::json(&item)
                        .with_replay_origin(ReplayOrigin::observed("model-a", Some(&source))),
                },
            ])),
            provider_options: None,
        };
        for (model, codex, operation, expected) in [
            ("model-b", Some(&equal), ModelOperation::Inference, true),
            ("model-b", Some(&changed), ModelOperation::Inference, false),
            ("model-a", Some(&changed), ModelOperation::Inference, false),
            (
                "model-a",
                Some(&changed),
                ModelOperation::CodexCompaction,
                true,
            ),
            (
                "model-b",
                Some(&changed),
                ModelOperation::CodexCompaction,
                false,
            ),
            ("model-a", None, ModelOperation::CodexCompaction, false),
        ] {
            let target = ReplayTarget {
                model,
                codex,
                provider: &provider,
                operation,
            };
            assert_eq!(target.recipe(recipe()).await.is_ok(), expected);
        }
    }
}

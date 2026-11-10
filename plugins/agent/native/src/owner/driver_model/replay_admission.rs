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
pub(super) struct ReplayTarget<'a> {
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

    /// Newly prepared requests re-admit adjudicated bases; exact attempt recovery
    /// continues to restore its original bytes without this projection.
    pub async fn recipe(
        self,
        recipe: MessageRecipe,
        model: &str,
        source: Option<&CodexRequestProvenance>,
    ) -> Result<Option<MessageRecipe>, RunError> {
        let MessageRecipe::Assistant {
            content,
            provider_options,
        } = recipe
        else {
            return Ok(Some(recipe));
        };
        let mode = self.reasoning(model, source);
        let encrypted = self.encrypted_allowed(model, source);
        if matches!(mode, Reasoning::Original) && encrypted {
            return Ok(Some(MessageRecipe::Assistant {
                content,
                provider_options,
            }));
        }
        let mut len = 0usize;
        let mut cursor = content.open(0);
        while let Some(part) = cursor.next().await? {
            if admitted_recipe(part, mode, encrypted)?.is_some() {
                len = len
                    .checked_add(1)
                    .ok_or_else(|| RunError::InvalidInput("assistant directory overflow".into()))?;
            }
        }
        Ok((len > 0).then(|| MessageRecipe::Assistant {
            content: Arc::new(AdmittedParts {
                content,
                mode,
                encrypted,
                len,
            }),
            provider_options,
        }))
    }
}
fn admitted_recipe(
    part: AssistantRecipe,
    mode: Reasoning,
    encrypted: bool,
) -> std::io::Result<Option<AssistantRecipe>> {
    Ok(match part {
        AssistantRecipe::CodexCompaction { .. } if !encrypted => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "native Codex checkpoint requires compatible ChatGPT state or re-compaction",
            ));
        }
        AssistantRecipe::Reasoning {
            text,
            provider_options,
        } => match mode {
            Reasoning::Original => Some(AssistantRecipe::Reasoning {
                text,
                provider_options,
            }),
            Reasoning::Plaintext => Some(AssistantRecipe::Reasoning {
                text,
                provider_options: None,
            }),
            Reasoning::Omit => None,
        },
        part => Some(part),
    })
}

// Frozen directories can be arbitrarily long; count and stream without collecting them.
struct AdmittedParts {
    content: Arc<dyn RecipeSource<AssistantRecipe>>,
    mode: Reasoning,
    encrypted: bool,
    len: usize,
}
struct AdmittedCursor {
    source: Box<dyn RecipeCursor<AssistantRecipe>>,
    mode: Reasoning,
    encrypted: bool,
    skip: usize,
}
impl RecipeSource<AssistantRecipe> for AdmittedParts {
    fn len(&self) -> usize {
        self.len
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<AssistantRecipe>> {
        Box::new(AdmittedCursor {
            source: self.content.open(0),
            mode: self.mode,
            encrypted: self.encrypted,
            skip: start,
        })
    }
}
impl RecipeCursor<AssistantRecipe> for AdmittedCursor {
    fn next(&mut self) -> NextRecipe<'_, AssistantRecipe> {
        Box::pin(async move {
            while let Some(part) = self.source.next().await? {
                if let Some(part) = admitted_recipe(part, self.mode, self.encrypted)? {
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
                    item: generated::json(&item),
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
            assert_eq!(
                target
                    .recipe(recipe(), "model-a", Some(&source))
                    .await
                    .is_ok(),
                expected
            );
        }
    }
}

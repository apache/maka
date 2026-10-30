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

use crate::{artifact::content_digest, tools::ToolDefinition};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::sync::Arc;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    ModelAdapter,
    ModelProvider,
    Input,
    Tool,
    PromptSection,
    PromptVariable,
    PromptContext,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceRevision {
    pub kind: SourceKind,
    pub name: String,
    pub package_id: String,
    pub entry_id: String,
    pub activation: String,
    pub revision: String,
}

/// The immutable capability surface of one logical model step. Conversation
/// history retains its own canonical prefix evidence in ModelRequested.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestComposition {
    pub system_prompt: Option<String>,
    pub dynamic_context: Vec<String>,
    pub tool_catalog_digest: String,
    pub tools: Vec<Arc<ToolDefinition>>,
    pub provider_options: Option<Value>,
    pub max_output_tokens: Option<u64>,
    pub sources: Vec<SourceRevision>,
}
impl RequestComposition {
    pub fn freeze(self) -> Result<FrozenComposition, &'static str> {
        if !crate::archive::valid_projection_digest(&self.tool_catalog_digest) {
            return Err("invalid tool catalog digest");
        }
        let mut names = BTreeSet::new();
        for tool in &self.tools {
            if tool.name.is_empty() || !names.insert(&tool.name) {
                return Err("invalid request composition tools");
            }
        }
        for source in &self.sources {
            for value in [
                &source.name,
                &source.package_id,
                &source.entry_id,
                &source.activation,
                &source.revision,
            ] {
                if value.is_empty() || value.chars().any(char::is_control) {
                    return Err("invalid request composition source");
                }
            }
        }
        let bytes =
            serde_json::to_vec(&self).map_err(|_| "invalid request composition encoding")?;
        Ok(FrozenComposition {
            digest: content_digest(&bytes),
            bytes: bytes.into_boxed_slice(),
        })
    }
}

#[derive(Clone, Debug)]
pub struct FrozenComposition {
    digest: String,
    bytes: Box<[u8]>,
}
impl FrozenComposition {
    pub fn digest(&self) -> &str {
        &self.digest
    }
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

/// Request evidence is inline until a successful canonical commit permits a reference.
#[derive(Clone, Debug)]
pub enum CompositionEvidence {
    Inline(std::sync::Arc<FrozenComposition>),
    Committed { event_id: String, digest: String },
}

impl From<std::sync::Arc<FrozenComposition>> for CompositionEvidence {
    fn from(composition: std::sync::Arc<FrozenComposition>) -> Self {
        Self::Inline(composition)
    }
}

impl CompositionEvidence {
    pub fn digest(&self) -> &str {
        match self {
            Self::Inline(composition) => composition.digest(),
            Self::Committed { digest, .. } => digest,
        }
    }

    /// Retire inline bytes only after the caller received a successful commit receipt.
    pub fn committed(&mut self, event_id: String) {
        if let Self::Inline(composition) = self {
            *self = Self::Committed {
                digest: composition.digest().to_owned(),
                event_id,
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn canonical_tools_restore_independent_shared_attempt_material() {
        let canonical = br#"{"systemPrompt":null,"dynamicContext":[],"toolCatalogDigest":"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","tools":[{"name":"fixture","description":"historical description","inputSchema":{"type":"integer"}}],"providerOptions":null,"maxOutputTokens":null,"sources":[]}"#;
        let composition: RequestComposition = serde_json::from_slice(canonical).unwrap();
        let restored_again: RequestComposition = serde_json::from_slice(canonical).unwrap();
        assert!(!Arc::ptr_eq(
            &composition.tools[0],
            &restored_again.tools[0]
        ));
        let summary_tools = composition.tools.clone();
        let attempt_tools = summary_tools.clone();
        assert!(Arc::ptr_eq(&composition.tools[0], &summary_tools[0]));
        assert!(Arc::ptr_eq(&summary_tools[0], &attempt_tools[0]));
        let mut current = composition.tools[0].as_ref().clone();
        current.description = "current description".into();
        current.input_schema = serde_json::json!({"type":"boolean"});
        assert_eq!(attempt_tools[0].name, current.name);
        assert_eq!(attempt_tools[0].description, "historical description");
        assert_eq!(
            attempt_tools[0].input_schema,
            serde_json::json!({"type":"integer"})
        );
        let frozen = composition.freeze().unwrap();
        assert_eq!(frozen.bytes(), canonical);
        assert_eq!(frozen.digest(), content_digest(canonical));
    }

    #[test]
    fn committed_evidence_releases_inline_body_and_keeps_original_locator() {
        let frozen = Arc::new(
            RequestComposition {
                system_prompt: Some("frozen system".into()),
                dynamic_context: vec!["frozen context".into()],
                tool_catalog_digest: content_digest(b"[]"),
                tools: vec![],
                provider_options: Some(serde_json::json!({"temperature": 0.25})),
                max_output_tokens: Some(4096),
                sources: vec![],
            }
            .freeze()
            .unwrap(),
        );
        let digest = frozen.digest().to_owned();
        let body = Arc::downgrade(&frozen);
        let mut evidence = CompositionEvidence::from(frozen);
        let submission = evidence.clone();
        assert!(Arc::ptr_eq(
            &body.upgrade().unwrap(),
            match &submission {
                CompositionEvidence::Inline(frozen) => frozen,
                CompositionEvidence::Committed { .. } =>
                    panic!("unconfirmed evidence must retain bytes"),
            }
        ));
        drop(submission);
        evidence.committed("original-request".into());
        assert!(
            body.upgrade().is_none(),
            "confirmed evidence must release the body"
        );
        evidence.committed("retry-request".into());
        let CompositionEvidence::Committed {
            event_id,
            digest: actual,
        } = evidence
        else {
            panic!("confirmed evidence must use its canonical reference");
        };
        assert_eq!(event_id, "original-request");
        assert_eq!(actual, digest);
    }
}

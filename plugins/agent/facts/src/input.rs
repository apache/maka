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

use crate::attachment::AttachmentRef;
use serde::{Deserialize, Serialize};
mod references;
mod selections;
mod sources;
pub use references::{
    CaptureTime, DirectoryReference, InlineReference, InlineReferenceKind, QuoteRef,
    SessionQuoteSource,
};
pub use selections::{Selections, validate_selections};
pub use sources::{
    SelectionSource, SelectionSources, has_unbound_selections, validate_selection_session,
    validate_selection_sources,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RunInput {
    HistorySource {
        source: crate::durable::ContentRef,
    },
    Continuation {
        claim: Box<crate::continuation::ContinuationClaim>,
        request_fingerprint: String,
    },
    ContextCompact {
        request_fingerprint: String,
    },
    Message {
        content: MessageInput,
        request_fingerprint: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        source_messages: Vec<crate::message::RootSourceMessage>,
    },
    Code {
        source: String,
    },
}

impl RunInput {
    pub fn request_fingerprint(&self) -> Option<&str> {
        match self {
            Self::Message {
                request_fingerprint,
                ..
            } => request_fingerprint.as_deref(),
            Self::Continuation {
                request_fingerprint,
                ..
            }
            | Self::ContextCompact {
                request_fingerprint,
            } => Some(request_fingerprint),
            Self::Code { .. } | Self::HistorySource { .. } => None,
        }
    }

    pub fn inherited_claim(&self) -> Option<&crate::continuation::ContinuationClaim> {
        match self {
            Self::Continuation { claim, .. } => Some(claim),
            _ => None,
        }
    }

    pub fn validate_inheritance(
        &self,
        target: &crate::durable::ExecutionIdentity,
    ) -> Result<(), &'static str> {
        match self {
            Self::Continuation { claim, .. } => claim.validate(target),
            Self::HistorySource { source } => source.validate(),
            _ => Ok(()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageInput {
    /// Host-stamped provenance of immutable plugin-prepared input.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub preparation: Vec<InputReceipt>,
    pub text: String,
    pub display_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<AttachmentRef>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quotes: Option<Vec<QuoteRef>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory_references: Option<Vec<DirectoryReference>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inline_references: Option<Vec<InlineReference>>,
}

impl MessageInput {
    /// Opaque Rust-host admission identity; never derived from a UI projection.
    pub fn content_digest(&self) -> Result<String, serde_json::Error> {
        use sha2::{Digest, Sha256};
        Ok(format!(
            "sha256:{}",
            hex::encode(Sha256::digest(serde_json::to_vec(self)?))
        ))
    }
    /// All retained text, including reference metadata; used before projection clones.
    pub fn text_bytes(&self) -> usize {
        let bytes = std::iter::once(self.text.as_str())
            .chain(self.display_text.as_deref())
            .chain(self.quotes.iter().flatten().flat_map(|quote| {
                std::iter::once(quote.text.as_str())
                    .chain(quote.label.as_deref())
                    .chain(quote.source_turn_id.as_deref())
                    .chain(quote.source.iter().flat_map(|source| {
                        [source.session_id.as_str(), source.session_name.as_str()]
                    }))
            }))
            .chain(
                self.directory_references
                    .iter()
                    .flatten()
                    .flat_map(|reference| [reference.host_id.as_str(), reference.path.as_str()]),
            )
            .chain(
                self.inline_references
                    .iter()
                    .flatten()
                    .flat_map(|reference| [reference.value.as_str(), reference.label.as_str()]),
            )
            .fold(0usize, |bytes, text| bytes.saturating_add(text.len()));
        self.attachments
            .iter()
            .flatten()
            .fold(bytes, |bytes, attachment| {
                bytes.saturating_add(attachment.text_bytes())
            })
    }
}

/// Immutable client identity and prepared content delivered by a root or steering fact.
/// Its submitted digest identifies client content before Host preparation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeliveredMessage {
    pub message_id: String,
    pub content: MessageInput,
    pub submitted_content_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<crate::message::MessageOrigin>,
}

impl DeliveredMessage {
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_receipts(&self.content.preparation)?;
        crate::interaction::entity_id(&self.message_id)?;
        if let Some(origin) = &self.origin {
            origin.validate()?;
        }
        if !crate::archive::valid_projection_digest(&self.submitted_content_digest) {
            return Err("invalid submitted message digest");
        }
        Ok(())
    }
}

impl From<String> for MessageInput {
    fn from(text: String) -> Self {
        Self {
            preparation: Vec::new(),
            text,
            display_text: None,
            attachments: None,
            quotes: None,
            directory_references: None,
            inline_references: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputReceipt {
    pub source: crate::composition::SourceRevision,
    pub receipt: serde_json::Value,
}

pub fn validate_receipts(receipts: &[InputReceipt]) -> Result<(), &'static str> {
    for receipt in receipts {
        let source = &receipt.source;
        if source.kind != crate::composition::SourceKind::Input
            || [
                &source.name,
                &source.package_id,
                &source.entry_id,
                &source.activation,
                &source.revision,
            ]
            .into_iter()
            .any(|value| value.is_empty() || value.chars().any(char::is_control))
        {
            return Err("invalid input preparation source");
        }
    }
    Ok(())
}

impl From<&str> for MessageInput {
    fn from(text: &str) -> Self {
        text.to_owned().into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::composition::{SourceKind, SourceRevision};

    #[test]
    fn input_receipts_accept_complete_payloads_and_validate_source_kind() {
        let mut receipts: Vec<_> = (0..4096)
            .map(|index| InputReceipt {
                source: SourceRevision {
                    kind: SourceKind::Input,
                    name: format!("provider-{}", index % 64),
                    package_id: "example".into(),
                    entry_id: "entry".into(),
                    activation: "activation".into(),
                    revision: format!("revision-{index}"),
                },
                receipt: serde_json::json!({"message": index / 64}),
            })
            .collect();
        validate_receipts(&receipts).unwrap();
        receipts[0].source.kind = SourceKind::Tool;
        assert_eq!(
            validate_receipts(&receipts),
            Err("invalid input preparation source")
        );
        receipts[0].source.kind = SourceKind::Input;
        receipts[0].receipt = serde_json::json!("x".repeat(1024 * 1024));
        validate_receipts(&receipts).unwrap();
    }
}

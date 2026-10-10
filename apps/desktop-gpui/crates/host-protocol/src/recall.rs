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

//! `recall.query`: searching what was said across Sessions.
//!
//! Sources: `RecallQueryInput`, `RecallQueryResult`, `decodeRecallQueryInput`
//! and `decodeRecallQueryResult` in
//! `packages/runtime-host/src/protocol/recall.ts`; the search itself and the
//! checks the protocol decoder leaves to it are `runRecall` and
//! `normalizeRecallRequest` in `packages/core/src/recall.ts`; the projection
//! is `projectRecallResult` in
//! `packages/runtime-host/src/server/recall-coordinator.ts`.
//!
//! Terms match as literal, case-insensitive (NFC-folded) substrings,
//! OR-combined and ranked by BM25, with tool results at half weight and at
//! most one passage per Turn. Archived Sessions are searched too. A query the
//! search refuses is an `ok: false` result ([`RecallQueryResult::Failed`]);
//! an operation error (`host_not_ready`, `host_draining`,
//! `operation_unavailable`, `invalid_request`, `internal_failure`) means the
//! request never reached it. The protocol has no cancel.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::serde_util::is_false;
use crate::{AttachmentKind, Operation};

/// `RECALL_MAX_TERMS`.
pub const RECALL_MAX_TERMS: usize = 8;
/// `RECALL_MAX_LIMIT`: passages per answer.
pub const RECALL_MAX_LIMIT: u8 = 25;
/// `RECALL_DEFAULT_LIMIT`: passages when `limit` is absent.
pub const RECALL_DEFAULT_LIMIT: u8 = 8;
/// `RECALL_QUERY_TERM_MAX_CHARS` (`SEARCH_QUERY_MAX_CHARS`): Unicode scalar
/// values in one trimmed term.
pub const RECALL_QUERY_TERM_MAX_CHARS: usize = 500;
/// `RECALL_QUERY_QUESTION_MAX_BYTES`: UTF-8 bytes of `question` on the wire.
pub const RECALL_QUERY_QUESTION_MAX_BYTES: usize = 2 * 1024;
/// `RECALL_ID_MAX_CHARS`: the search reads `question` (and `sessionId`)
/// with `optionalString`, so a trimmed question longer than this many
/// UTF-16 units is refused as `invalid_query` although the wire allows
/// [`RECALL_QUERY_QUESTION_MAX_BYTES`].
pub const RECALL_QUESTION_MAX_UTF16: usize = 256;
/// `RECALL_PASSAGE_NEIGHBOURS`: messages kept on each side of the anchor,
/// within its Turn.
pub const RECALL_PASSAGE_NEIGHBOURS: usize = 4;
/// `RECALL_MESSAGE_MAX_BYTES`: text of one passage message.
pub const RECALL_MESSAGE_MAX_BYTES: usize = 4 * 1024;
/// `RECALL_PASSAGE_MAX_BYTES`.
pub const RECALL_PASSAGE_MAX_BYTES: usize = 12 * 1024;
/// `RECALL_TOTAL_PAYLOAD_CAP_BYTES`: passage text across one answer.
pub const RECALL_TOTAL_PAYLOAD_CAP_BYTES: usize = 96 * 1024;

/// The highest integer a JavaScript number holds exactly
/// (`Number.MAX_SAFE_INTEGER`), the bound of `requireCount`.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// `RecallQueryInput` (`decodeRecallQueryInput`, then
/// `normalizeRecallRequest`). Build it with [`RecallQueryInput::new`], which
/// applies both checks; credential-shaped terms are refused only by the
/// Host (`redactSecrets`), as `invalid_query`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct RecallQueryInput {
    /// 1 to [`RECALL_MAX_TERMS`] literal terms.
    pub terms: Vec<String>,
    /// Why the search is made; recorded, not matched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    /// 1 to [`RECALL_MAX_LIMIT`]; [`RECALL_DEFAULT_LIMIT`] when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u8>,
    /// Search only this Session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Unix milliseconds bounds on message time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<u64>,
}

impl RecallQueryInput {
    /// A search for `terms` across every Session.
    pub fn new<I, S>(terms: I) -> Result<Self, RecallQueryError>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let input = Self {
            terms: terms.into_iter().map(Into::into).collect(),
            question: None,
            limit: None,
            session_id: None,
            since: None,
            until: None,
        };
        input.validate()?;
        Ok(input)
    }

    /// The same search, returning at most `limit` passages.
    pub fn with_limit(mut self, limit: u8) -> Result<Self, RecallQueryError> {
        self.limit = Some(limit);
        self.validate()?;
        Ok(self)
    }

    /// The same search within one Session.
    pub fn in_session(mut self, session_id: impl Into<String>) -> Result<Self, RecallQueryError> {
        self.session_id = Some(session_id.into());
        self.validate()?;
        Ok(self)
    }

    /// The same search over messages from `since` to `until` (Unix
    /// milliseconds; either may be open).
    pub fn between(
        mut self,
        since: Option<u64>,
        until: Option<u64>,
    ) -> Result<Self, RecallQueryError> {
        self.since = since;
        self.until = until;
        self.validate()?;
        Ok(self)
    }

    /// The same search, saying why it is made.
    pub fn with_question(mut self, question: impl Into<String>) -> Result<Self, RecallQueryError> {
        self.question = Some(question.into());
        self.validate()?;
        Ok(self)
    }

    /// Checks the input as the Host's decoder and the search do.
    pub fn validate(&self) -> Result<(), RecallQueryError> {
        if self.terms.is_empty() {
            return Err(RecallQueryError::NoTerms);
        }
        if self.terms.len() > RECALL_MAX_TERMS {
            return Err(RecallQueryError::TooManyTerms);
        }
        for term in &self.terms {
            let trimmed = term.trim();
            if trimmed.is_empty() {
                return Err(RecallQueryError::BlankTerm);
            }
            if trimmed.chars().count() > RECALL_QUERY_TERM_MAX_CHARS {
                return Err(RecallQueryError::TermTooLong);
            }
        }
        if self.limit.is_some_and(|limit| !(1..=RECALL_MAX_LIMIT).contains(&limit)) {
            return Err(RecallQueryError::Limit);
        }
        if let Some(question) = &self.question {
            let trimmed = question.trim();
            if trimmed.is_empty()
                || trimmed.encode_utf16().count() > RECALL_QUESTION_MAX_UTF16
                || question.len() > RECALL_QUERY_QUESTION_MAX_BYTES
            {
                return Err(RecallQueryError::Question);
            }
        }
        if let Some(session_id) = &self.session_id {
            let valid = (1..=128).contains(&session_id.len())
                && session_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
            if !valid {
                return Err(RecallQueryError::SessionId);
            }
        }
        let bounds = [self.since, self.until];
        if bounds.iter().flatten().any(|bound| *bound > MAX_SAFE_INTEGER)
            || matches!(bounds, [Some(since), Some(until)] if since > until)
        {
            return Err(RecallQueryError::TimeRange);
        }
        Ok(())
    }
}

/// The terms Desktop's search box sends for a typed phrase
/// (`recallTermsFor` in `packages/ui/src/search-modal.tsx`): its distinct
/// whitespace-separated words, the first [`RECALL_MAX_TERMS`] of them.
/// Empty for a blank phrase.
pub fn recall_terms_for(phrase: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    for word in phrase.split_whitespace() {
        if !terms.iter().any(|term| term == word) {
            terms.push(word.to_owned());
        }
    }
    terms.truncate(RECALL_MAX_TERMS);
    terms
}

/// A recall input the Host would refuse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum RecallQueryError {
    #[error("recall needs at least one term")]
    NoTerms,
    #[error("recall accepts at most 8 terms")]
    TooManyTerms,
    #[error("recall terms must not be blank")]
    BlankTerm,
    #[error("recall terms must be 500 characters or fewer")]
    TermTooLong,
    #[error("the recall limit must be between 1 and 25")]
    Limit,
    #[error("the recall question must not be blank or longer than 256 characters")]
    Question,
    #[error("the recall Session id is invalid")]
    SessionId,
    #[error("recall `since` must not be after `until`")]
    TimeRange,
}

wire_enum! {
    /// `RecallFailureReason` (`packages/core/src/recall.ts`).
    pub enum RecallFailureReason {
        /// The terms, limit, Session, time bounds or question were refused;
        /// `message` says which.
        InvalidQuery = "invalid_query",
        /// Workspace privacy forbids reading history.
        IncognitoActive = "incognito_active",
        NotFound = "not_found",
        Aborted = "aborted",
    }
}

/// `RecallQueryFact`: a distilled statement from memory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct RecallFact {
    pub content: String,
    pub kind: String,
    pub observed_at: u64,
}

wire_enum! {
    /// `RecallQueryPassageMessage.role` (`RECALL_ROLES`).
    pub enum RecallRole {
        User = "user",
        Assistant = "assistant",
        Tool = "tool",
    }
}

wire_enum! {
    /// `RecallQueryPassageMessage.matchKind`: what kind of transcript row the
    /// message is (`threadSearchMatchKind` in
    /// `packages/core/src/transcript-search.ts`).
    pub enum RecallMatchKind {
        UserMessage = "user_message",
        AssistantMessage = "assistant_message",
        /// A Tool call's arguments.
        ToolIntent = "tool_intent",
        ToolResult = "tool_result",
    }
}

/// `RecallQueryMaterial` (`decodeMaterial`): a file a message carried.
/// Either `resource` (an address `Read` answers here) or the pair
/// `source_session_id` and `material_id`, never both.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct RecallMaterial {
    pub name: String,
    pub kind: AttachmentKind,
    pub mime_type: String,
    pub bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material_id: Option<String>,
}

/// `RecallQueryPassageMessage` (`decodePassageMessage`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct RecallPassageMessage {
    pub message_id: String,
    pub role: RecallRole,
    pub match_kind: RecallMatchKind,
    /// At most [`RECALL_MESSAGE_MAX_BYTES`]; empty when the message carried
    /// only files.
    pub text: String,
    /// Unix milliseconds.
    pub timestamp: u64,
    /// The message the terms matched.
    pub is_anchor: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub materials: Option<Vec<RecallMaterial>>,
}

/// `RecallQueryPassage` (`decodePassage`): a matching message with its
/// neighbours in the same Turn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct RecallPassage {
    pub session_id: String,
    /// Empty for an unnamed Session.
    pub session_title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub anchor_message_id: String,
    /// The anchor's 0-based index in its Session transcript: the coordinate
    /// to scroll to.
    pub sequence: u64,
    pub messages: Vec<RecallPassageMessage>,
    /// The query terms found in the passage.
    pub matched_terms: Vec<String>,
    /// BM25; higher is better.
    pub score: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_at: Option<u64>,
    /// The Turn has messages before or after the ones kept.
    pub has_more_before: bool,
    pub has_more_after: bool,
    /// Text was cut to the passage caps.
    #[serde(default, skip_serializing_if = "is_false")]
    pub truncated: bool,
}

impl RecallPassage {
    /// The message the terms matched.
    pub fn anchor(&self) -> Option<&RecallPassageMessage> {
        self.messages.iter().find(|message| message.is_anchor)
    }
}

/// `RecallQueryResult` (`decodeRecallQueryResult`): the passages found, or
/// why the search refused.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "RawResult", into = "RawResult")]
#[non_exhaustive]
pub enum RecallQueryResult {
    Found {
        /// At most 10 distilled facts.
        facts: Vec<RecallFact>,
        /// Best first, at most the query's limit.
        passages: Vec<RecallPassage>,
        /// What the search covered and did not find, written for the model.
        gaps: String,
        /// The candidate index was bypassed for a full scan.
        searched_every_session: bool,
    },
    Failed {
        reason: RecallFailureReason,
        message: String,
    },
}

/// The result as the wire has it: `ok` says which fields it carries.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
struct RawResult {
    ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    facts: Option<Vec<RecallFact>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    passages: Option<Vec<RecallPassage>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    gaps: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    searched_every_session: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<RecallFailureReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

impl TryFrom<RawResult> for RecallQueryResult {
    type Error = String;

    fn try_from(raw: RawResult) -> Result<Self, Self::Error> {
        match raw {
            RawResult {
                ok: true,
                facts: Some(facts),
                passages: Some(passages),
                gaps: Some(gaps),
                searched_every_session: Some(searched_every_session),
                reason: None,
                message: None,
            } => Ok(Self::Found { facts, passages, gaps, searched_every_session }),
            RawResult {
                ok: false,
                facts: None,
                passages: None,
                gaps: None,
                searched_every_session: None,
                reason: Some(reason),
                message: Some(message),
            } => Ok(Self::Failed { reason, message }),
            _ => Err("a recall result is its passages or its failure, never both".to_owned()),
        }
    }
}

impl From<RecallQueryResult> for RawResult {
    fn from(result: RecallQueryResult) -> Self {
        match result {
            RecallQueryResult::Found { facts, passages, gaps, searched_every_session } => Self {
                ok: true,
                facts: Some(facts),
                passages: Some(passages),
                gaps: Some(gaps),
                searched_every_session: Some(searched_every_session),
                reason: None,
                message: None,
            },
            RecallQueryResult::Failed { reason, message } => Self {
                ok: false,
                facts: None,
                passages: None,
                gaps: None,
                searched_every_session: None,
                reason: Some(reason),
                message: Some(message),
            },
        }
    }
}

/// `recall.query` (mode `query`, `RECALL_OPERATION_SPECS`).
#[derive(Debug)]
pub enum RecallQuery {}

impl Operation for RecallQuery {
    const NAME: &'static str = "recall.query";
    type Input = RecallQueryInput;
    type Output = RecallQueryResult;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn inputs_are_checked_as_the_host_checks_them() {
        let input = RecallQueryInput::new(recall_terms_for("  backoff  retry backoff "))
            .and_then(|input| input.with_limit(10))
            .and_then(|input| input.in_session("s-1"))
            .and_then(|input| input.between(Some(5), Some(9)))
            .expect("valid");
        assert_eq!(
            serde_json::to_value(&input).expect("encode"),
            json!({"terms": ["backoff", "retry"], "limit": 10, "sessionId": "s-1",
                   "since": 5, "until": 9})
        );
        let empty: [&str; 0] = [];
        assert_eq!(RecallQueryInput::new(empty), Err(RecallQueryError::NoTerms));
        assert_eq!(RecallQueryInput::new(["a"; 9]), Err(RecallQueryError::TooManyTerms));
        assert_eq!(RecallQueryInput::new(["  "]), Err(RecallQueryError::BlankTerm));
        let five_hundred = "字".repeat(RECALL_QUERY_TERM_MAX_CHARS);
        assert!(RecallQueryInput::new([five_hundred.clone()]).is_ok());
        assert_eq!(
            RecallQueryInput::new([format!("{five_hundred}x")]),
            Err(RecallQueryError::TermTooLong)
        );
        let input = RecallQueryInput::new(["a"]).expect("valid");
        assert_eq!(input.clone().with_limit(0), Err(RecallQueryError::Limit));
        assert_eq!(input.clone().with_limit(26), Err(RecallQueryError::Limit));
        assert_eq!(input.clone().in_session("a/b"), Err(RecallQueryError::SessionId));
        assert_eq!(input.clone().between(Some(9), Some(5)), Err(RecallQueryError::TimeRange));
        assert!(input.clone().with_question("q".repeat(RECALL_QUESTION_MAX_UTF16)).is_ok());
        assert_eq!(
            input.with_question("q".repeat(RECALL_QUESTION_MAX_UTF16 + 1)),
            Err(RecallQueryError::Question)
        );
        assert_eq!(recall_terms_for(" \t "), Vec::<String>::new());
        assert_eq!(recall_terms_for("a b c d e f g h i j").len(), RECALL_MAX_TERMS);
    }

    #[test]
    fn a_result_is_its_passages_or_its_failure() {
        let found = json!({
            "ok": true, "facts": [], "gaps": "", "searchedEverySession": false,
            "passages": [{
                "sessionId": "s", "sessionTitle": "", "anchorMessageId": "m2", "sequence": 3,
                "matchedTerms": ["gate"], "score": 1.5, "hasMoreBefore": false,
                "hasMoreAfter": true, "truncated": true,
                "messages": [
                    {"messageId": "m1", "role": "user", "matchKind": "user_message",
                     "text": "", "timestamp": 1, "isAnchor": false,
                     "materials": [{"name": "a.png", "kind": "image", "mimeType": "image/png",
                                    "bytes": 4, "sourceSessionId": "s", "materialId": "x"}]},
                    {"messageId": "m2", "role": "assistant", "matchKind": "assistant_message",
                     "text": "the gate", "timestamp": 2, "isAnchor": true}
                ]
            }]
        });
        let decoded: RecallQueryResult = serde_json::from_value(found.clone()).expect("decode");
        assert_eq!(serde_json::to_value(&decoded).expect("encode"), found);
        let RecallQueryResult::Found { passages, .. } = decoded else { panic!("found") };
        assert_eq!(passages[0].anchor().map(|m| m.text.as_str()), Some("the gate"));
        assert!(passages[0].truncated);

        let failed = json!({"ok": false, "reason": "rate_limited", "message": "m"});
        let decoded: RecallQueryResult = serde_json::from_value(failed.clone()).expect("decode");
        assert!(matches!(
            decoded,
            RecallQueryResult::Failed { reason: RecallFailureReason::Other(_), .. }
        ));
        assert_eq!(serde_json::to_value(&decoded).expect("encode"), failed);
        for broken in [
            json!({"ok": true, "facts": []}),
            json!({"ok": false, "message": "no reason"}),
            json!({"ok": false, "reason": "aborted", "message": "m", "gaps": ""}),
        ] {
            assert!(serde_json::from_value::<RecallQueryResult>(broken).is_err());
        }
    }
}

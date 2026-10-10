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

//! Classification of every frame a Host can send.
//!
//! Source: `decodeHostFrame` in `packages/runtime-host/src/protocol/index.ts`
//! and the routing in `RuntimeHostConnectionImpl#readResponses`
//! (`client/connection.ts`). Frames with a `kind` are handshake results or
//! pushes; frames without one are operation responses. Unlike the TS decoder,
//! a frame whose `kind` is unknown is kept as [`PushFrame::Unknown`] instead of
//! failing the connection.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::{HandshakeResult, ResponseFrame, SessionFrame};

/// One decoded Host frame.
#[derive(Debug, Clone, PartialEq)]
pub enum HostFrame {
    /// `accepted`, `incompatible`, or `draining`. Valid only as the first frame.
    Handshake(HandshakeResult),
    /// The answer to one request.
    Response(ResponseFrame),
    /// Anything the Host sends without being asked.
    Push(PushFrame),
}

/// A frame the Host sends on its own initiative.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum PushFrame {
    /// `subscription.*`, routed by `subscriptionId`.
    Subscription(SubscriptionFrame),
    /// A catalog or configuration revision changed.
    Change(ChangeNotice),
    /// `client.capability.*` (`CLIENT_CAPABILITY_HOST_FRAME_KINDS` in
    /// `protocol/client-capability.ts`). Only clients that registered a
    /// capability receive these.
    ClientCapability(Value),
    /// A frame this client does not model yet, kept verbatim.
    Unknown(Value),
}

/// A `subscription.*` frame (`SubscriptionFrame` in
/// `protocol/session-continuity.ts`), as routed by the connection. Only the
/// routing fields are decoded here, so a frame this client cannot model never
/// tears the connection down; [`SubscriptionFrame::decode`] gives the typed
/// [`SessionFrame`].
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct SubscriptionFrame {
    /// For example `subscription.session_delta`.
    pub kind: String,
    pub subscription_id: String,
    /// The whole frame, including `kind` and `subscriptionId`.
    pub raw: Value,
}

impl SubscriptionFrame {
    /// Decodes the frame (`decodeSubscriptionFrame`). An unknown `kind`
    /// yields [`SessionFrame::Unknown`]; a known kind with a malformed body
    /// is an error, which a subscriber treats like a sequence gap.
    pub fn decode(&self) -> Result<SessionFrame, serde_json::Error> {
        serde_json::from_value(self.raw.clone())
    }

    /// Decodes the frame as the one frame type its `kind` names, for
    /// example [`crate::SessionRuntimeResourcePtyDataFrame`], without
    /// copying it first: terminal output frames carry up to 48 KiB.
    pub fn decode_as<'a, T: Deserialize<'a>>(&'a self) -> Result<T, serde_json::Error> {
        T::deserialize(&self.raw)
    }
}

wire_enum! {
    /// `ScheduledTaskChangedReason` (`protocol/scheduled-task-change.ts`).
    pub enum ScheduledTaskChangedReason {
        Created = "created",
        Updated = "updated",
        Deleted = "deleted",
        Fired = "fired",
        Failed = "failed",
        Blocked = "blocked",
    }
}

wire_enum! {
    /// `SessionAttention.kind` (`decodeSessionAttention` in
    /// `protocol/session-catalog-change.ts`).
    pub enum SessionAttentionKind {
        /// The root Turn completed.
        Completed = "completed",
        /// The root Turn failed; `body` carries the Host's redacted reason.
        Errored = "errored",
        /// The Session waits on the user.
        Waiting = "waiting",
    }
}

/// `SessionAttention`: why a `session.catalog.changed` asks for attention,
/// the event a desktop notification is raised for. Since epoch 191.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionAttention {
    pub kind: SessionAttentionKind,
    /// The event that caused it, for example the Turn's terminal event;
    /// one attention per `event_id`.
    pub event_id: String,
    /// At most 2048 UTF-8 bytes (`SESSION_ATTENTION_BODY_MAX_BYTES`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

/// A revision change notice. Sources: `protocol/configuration-change.ts`,
/// `connection-catalog-change.ts`, `project-catalog-change.ts`,
/// `session-catalog-change.ts`, `scheduled-task-change.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum ChangeNotice {
    #[serde(rename = "configuration.changed")]
    ConfigurationChanged { revision: u64 },
    #[serde(rename = "connection.catalog.changed")]
    ConnectionCatalogChanged { revision: u64 },
    #[serde(rename = "project.catalog.changed")]
    ProjectCatalogChanged { revision: u64 },
    #[serde(rename = "session.catalog.changed", rename_all = "camelCase")]
    SessionCatalogChanged {
        revision: u64,
        session_id: String,
        /// Present when the change is a Turn ending or the Session waiting.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attention: Option<SessionAttention>,
    },
    #[serde(rename = "scheduled-task.changed", rename_all = "camelCase")]
    ScheduledTaskChanged { revision: u64, reason: ScheduledTaskChangedReason, task_id: String },
}

impl ChangeNotice {
    const KINDS: [&'static str; 5] = [
        "configuration.changed",
        "connection.catalog.changed",
        "project.catalog.changed",
        "session.catalog.changed",
        "scheduled-task.changed",
    ];
}

/// A frame that cannot be classified.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum FrameDecodeError {
    /// `requireRecord`: every Host frame is a JSON object.
    #[error("Runtime Host frame is not a JSON object")]
    NotAnObject,
    /// The frame names a shape this client models, but does not match it.
    #[error("malformed Runtime Host {shape} frame")]
    Malformed {
        shape: &'static str,
        #[source]
        source: serde_json::Error,
    },
}

impl HostFrame {
    /// Classifies one parsed frame. Never fails for an unknown `kind`.
    pub fn decode(value: Value) -> Result<Self, FrameDecodeError> {
        let Some(object) = value.as_object() else {
            return Err(FrameDecodeError::NotAnObject);
        };
        let Some(kind) = object.get("kind").and_then(Value::as_str) else {
            if object.contains_key("requestId") {
                return decode_as(value, "response").map(Self::Response);
            }
            return Ok(Self::Push(PushFrame::Unknown(value)));
        };
        match kind {
            "accepted" | "incompatible" | "draining" => {
                decode_as(value, "handshake").map(Self::Handshake)
            }
            kind if kind.starts_with("subscription.") => {
                let kind = kind.to_owned();
                let subscription_id =
                    object.get("subscriptionId").and_then(Value::as_str).map(str::to_owned);
                match subscription_id {
                    Some(subscription_id) => {
                        Ok(Self::Push(PushFrame::Subscription(SubscriptionFrame {
                            kind,
                            subscription_id,
                            raw: value,
                        })))
                    }
                    None => Err(FrameDecodeError::Malformed {
                        shape: "subscription",
                        source: serde::de::Error::missing_field("subscriptionId"),
                    }),
                }
            }
            kind if kind.starts_with("client.capability.") => {
                Ok(Self::Push(PushFrame::ClientCapability(value)))
            }
            kind if ChangeNotice::KINDS.contains(&kind) => decode_as(value, "change notice")
                .map(|notice| Self::Push(PushFrame::Change(notice))),
            _ => Ok(Self::Push(PushFrame::Unknown(value))),
        }
    }
}

fn decode_as<T: for<'de> Deserialize<'de>>(
    value: Value,
    shape: &'static str,
) -> Result<T, FrameDecodeError> {
    serde_json::from_value(value).map_err(|source| FrameDecodeError::Malformed { shape, source })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Outcome;
    use serde_json::json;

    #[test]
    fn handshake_frames_classify() {
        let frame =
            HostFrame::decode(json!({"kind": "draining", "hostEpoch": "e"})).expect("frame");
        assert!(matches!(frame, HostFrame::Handshake(HandshakeResult::Draining(_))));
    }

    #[test]
    fn responses_are_frames_without_kind() {
        let frame = HostFrame::decode(json!({
            "requestId": "r1", "operation": "host.status", "ok": true, "result": {}
        }))
        .expect("frame");
        let HostFrame::Response(response) = frame else {
            panic!("expected response");
        };
        assert_eq!(response.outcome, Outcome::Ok(json!({})));
    }

    #[test]
    fn subscription_frames_keep_their_payload() {
        let value = json!({
            "kind": "subscription.session_delta",
            "subscriptionId": "sub-1",
            "seq": 4,
            "delta": {"text": "hi"}
        });
        let frame = HostFrame::decode(value.clone()).expect("frame");
        let HostFrame::Push(PushFrame::Subscription(subscription)) = frame else {
            panic!("expected subscription");
        };
        assert_eq!(subscription.kind, "subscription.session_delta");
        assert_eq!(subscription.subscription_id, "sub-1");
        assert_eq!(subscription.raw, value);
    }

    #[test]
    fn subscription_frame_without_id_is_malformed() {
        let result = HostFrame::decode(json!({"kind": "subscription.closed"}));
        assert!(matches!(result, Err(FrameDecodeError::Malformed { shape: "subscription", .. })));
    }

    #[test]
    fn change_notices_decode() {
        let frame = HostFrame::decode(json!({
            "kind": "session.catalog.changed", "revision": 7, "sessionId": "s1"
        }))
        .expect("frame");
        assert_eq!(
            frame,
            HostFrame::Push(PushFrame::Change(ChangeNotice::SessionCatalogChanged {
                revision: 7,
                session_id: "s1".into(),
                attention: None,
            }))
        );
        let frame = HostFrame::decode(json!({
            "kind": "session.catalog.changed", "revision": 8, "sessionId": "s1",
            "attention": {"kind": "errored", "eventId": "ev1", "body": "auth failed"}
        }))
        .expect("frame");
        let HostFrame::Push(PushFrame::Change(ChangeNotice::SessionCatalogChanged {
            attention: Some(attention),
            ..
        })) = frame
        else {
            panic!("expected an attention");
        };
        assert_eq!(
            (attention.kind, attention.event_id.as_str(), attention.body.as_deref()),
            (SessionAttentionKind::Errored, "ev1", Some("auth failed"))
        );
        let frame = HostFrame::decode(json!({
            "kind": "scheduled-task.changed", "revision": 1, "reason": "fired", "taskId": "t1"
        }))
        .expect("frame");
        assert!(matches!(
            frame,
            HostFrame::Push(PushFrame::Change(ChangeNotice::ScheduledTaskChanged {
                reason: ScheduledTaskChangedReason::Fired,
                ..
            }))
        ));
    }

    #[test]
    fn catalog_and_configuration_notices_decode() {
        for (kind, expected) in [
            ("project.catalog.changed", ChangeNotice::ProjectCatalogChanged { revision: 3 }),
            ("connection.catalog.changed", ChangeNotice::ConnectionCatalogChanged { revision: 3 }),
            ("configuration.changed", ChangeNotice::ConfigurationChanged { revision: 3 }),
        ] {
            let frame = HostFrame::decode(json!({"kind": kind, "revision": 3})).expect("frame");
            assert_eq!(frame, HostFrame::Push(PushFrame::Change(expected)));
        }
    }

    #[test]
    fn subscription_frames_decode_to_typed_frames() {
        let value = json!({
            "kind": "subscription.transcript_advanced", "hostEpoch": "e",
            "subscriptionId": "sub-1", "sequence": 2, "sessionId": "s", "throughSequence": 31
        });
        let HostFrame::Push(PushFrame::Subscription(frame)) =
            HostFrame::decode(value).expect("frame")
        else {
            panic!("expected subscription");
        };
        let decoded = frame.decode().expect("typed");
        assert_eq!(decoded.sequence(), Some(2));
        assert!(
            matches!(decoded, SessionFrame::TranscriptAdvanced(ref advanced) if advanced.through_sequence == 31)
        );
        // The routing layer tolerates what the typed layer rejects.
        let partial =
            json!({"kind": "subscription.session_delta", "subscriptionId": "sub", "seq": 1});
        let HostFrame::Push(PushFrame::Subscription(frame)) =
            HostFrame::decode(partial).expect("frame")
        else {
            panic!("expected subscription");
        };
        assert!(frame.decode().is_err());
    }

    #[test]
    fn client_capability_frames_are_kept_raw() {
        let value = json!({"kind": "client.capability.call", "callId": "c1"});
        assert_eq!(
            HostFrame::decode(value.clone()).expect("frame"),
            HostFrame::Push(PushFrame::ClientCapability(value))
        );
    }

    #[test]
    fn unknown_frames_never_fail() {
        for value in [
            json!({"kind": "brand.new.frame", "x": 1}),
            json!({"kind": 42}),
            json!({"something": "else"}),
        ] {
            assert_eq!(
                HostFrame::decode(value.clone()).expect("frame"),
                HostFrame::Push(PushFrame::Unknown(value))
            );
        }
    }

    #[test]
    fn non_objects_are_rejected() {
        assert!(matches!(HostFrame::decode(json!([1, 2])), Err(FrameDecodeError::NotAnObject)));
    }

    #[test]
    fn malformed_known_shapes_are_errors() {
        assert!(matches!(
            HostFrame::decode(json!({"requestId": "r1", "operation": "x", "ok": true})),
            Err(FrameDecodeError::Malformed { shape: "response", .. })
        ));
        assert!(matches!(
            HostFrame::decode(json!({"kind": "accepted", "hostEpoch": "e"})),
            Err(FrameDecodeError::Malformed { shape: "handshake", .. })
        ));
    }
}

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

//! What stops every connection attempt until a person changes something
//! outside the app, in a form a window can explain on a screen of its own
//! rather than as one sentence of error text.
//!
//! A [`HostBlocker`] comes with [`crate::ConnectionEvent::Suspended`]: the
//! supervisor derives it from the attempt that failed permanently
//! ([`AttemptError::blocker`]). Other permanent failures (a copied State
//! Root, a Node that is too old, a refused credential) carry none; their
//! reason text says what to do.

use host_protocol::{RUNTIME_HOST_COMPATIBILITY_EPOCH, ReplacementDisposition};

use crate::{AttemptError, ConnectError, LaunchError, MissingCheckout};

/// Why no connection attempt can succeed until a person acts.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum HostBlocker {
    /// The Host speaks another compatibility epoch than this client.
    Epoch(EpochMismatch),
    /// No Host answered, and the Maka checkout to start one from is missing
    /// or was not built.
    Checkout(MissingCheckout),
}

/// A Host of one compatibility epoch and a client of another. The Host
/// refuses every request from a client whose epoch differs
/// (`HostKernel#handshake` in `packages/runtime-host/src/server/host-kernel.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct EpochMismatch {
    /// This client's, [`RUNTIME_HOST_COMPATIBILITY_EPOCH`].
    pub client: u32,
    /// The Host's, from its `incompatible` answer or its registration.
    pub host: u32,
    /// From an `incompatible` answer: whether the running Host exits by
    /// itself once it is idle (`wait_for_idle_exit`, an ephemeral Host with
    /// nothing in flight), after which a new one can start, or stays until
    /// someone stops it (`blocked_by_residency`: a service, or work in
    /// progress). `None` when the Host's registration said it.
    pub replacement: Option<ReplacementDisposition>,
}

impl EpochMismatch {
    /// A client at [`RUNTIME_HOST_COMPATIBILITY_EPOCH`] and a Host at `host`.
    pub fn new(host: u32, replacement: Option<ReplacementDisposition>) -> Self {
        Self { client: RUNTIME_HOST_COMPATIBILITY_EPOCH, host, replacement }
    }

    /// Whether the Host is the newer side (epochs only grow).
    pub fn host_is_newer(&self) -> bool {
        self.host > self.client
    }
}

impl ConnectError {
    /// The epochs, when this error is a Host of another compatibility epoch
    /// refusing this client. An `incompatible` answer at this client's own
    /// epoch (another composition or protocol) is not one.
    pub fn epoch_mismatch(&self) -> Option<EpochMismatch> {
        let (client, host, replacement) = match self {
            Self::Incompatible(incompatible) => (
                RUNTIME_HOST_COMPATIBILITY_EPOCH,
                incompatible.compatibility_epoch,
                Some(incompatible.replacement.clone()),
            ),
            Self::CompatibilityEpochMismatch { expected, actual } => (*expected, *actual, None),
            Self::RegisteredEpochMismatch { expected, registered, .. } => {
                (*expected, *registered, None)
            }
            _ => return None,
        };
        (client != host).then_some(EpochMismatch { client, host, replacement })
    }
}

impl AttemptError {
    /// What the window should explain instead of this error's text, when
    /// it is something only a person can fix outside the app.
    ///
    /// A remote Host's refusal is not one yet: what the screen tells the
    /// user to update is the local checkout, and a remote Host runs from
    /// another machine's. Its reason text stays in the strip.
    pub fn blocker(&self) -> Option<HostBlocker> {
        let connect = match self {
            Self::Connect(error) => error,
            Self::Launch(error) => match error.as_ref() {
                LaunchError::Connect(error) => error,
                LaunchError::Installation(error) => {
                    return error.checkout().cloned().map(HostBlocker::Checkout);
                }
                _ => return None,
            },
            _ => return None,
        };
        connect.epoch_mismatch().map(HostBlocker::Epoch)
    }
}

#[cfg(test)]
mod tests {
    use host_protocol::HandshakeResult;
    use serde_json::json;

    use super::*;
    use crate::MakaInstallation;

    /// An `incompatible` answer from the TypeScript Host's shape
    /// (`HostKernel#handshake`), at `epoch`.
    fn incompatible(epoch: u32, replacement: &str) -> ConnectError {
        let result: HandshakeResult = serde_json::from_value(json!({
            "kind": "incompatible", "hostEpoch": "h1", "protocolMin": 0, "protocolMax": 0,
            "compatibilityEpoch": epoch, "compositionId": "maka.interactive",
            "compositionRevision": "3", "state": "ready", "replacement": replacement
        }))
        .expect("incompatible");
        let HandshakeResult::Incompatible(incompatible) = result else {
            unreachable!("decoded as incompatible");
        };
        ConnectError::Incompatible(Box::new(incompatible))
    }

    #[test]
    fn an_incompatible_answer_of_another_epoch_names_both_epochs() {
        let older = AttemptError::Connect(incompatible(196, "wait_for_idle_exit"));
        let Some(HostBlocker::Epoch(mismatch)) = older.blocker() else {
            panic!("expected an epoch mismatch");
        };
        assert_eq!((mismatch.client, mismatch.host), (RUNTIME_HOST_COMPATIBILITY_EPOCH, 196));
        assert!(!mismatch.host_is_newer());
        assert_eq!(mismatch.replacement, Some(ReplacementDisposition::WaitForIdleExit));

        let newer = AttemptError::from(LaunchError::Connect(incompatible(
            RUNTIME_HOST_COMPATIBILITY_EPOCH + 1,
            "blocked_by_residency",
        )));
        let Some(HostBlocker::Epoch(mismatch)) = newer.blocker() else {
            panic!("expected an epoch mismatch");
        };
        assert!(mismatch.host_is_newer());
        assert_eq!(mismatch.replacement, Some(ReplacementDisposition::BlockedByResidency));
    }

    #[test]
    fn an_incompatible_answer_at_this_epoch_is_not_an_epoch_mismatch() {
        let error = AttemptError::Connect(incompatible(
            RUNTIME_HOST_COMPATIBILITY_EPOCH,
            "blocked_by_residency",
        ));
        assert_eq!(error.blocker(), None);
    }

    #[test]
    fn an_accepted_epoch_or_a_registered_one_counts_too() {
        let accepted = AttemptError::Connect(ConnectError::CompatibilityEpochMismatch {
            expected: RUNTIME_HOST_COMPATIBILITY_EPOCH,
            actual: 150,
        });
        assert_eq!(accepted.blocker(), Some(HostBlocker::Epoch(EpochMismatch::new(150, None))));
        let registered = AttemptError::Connect(ConnectError::RegisteredEpochMismatch {
            expected: RUNTIME_HOST_COMPATIBILITY_EPOCH,
            registered: 150,
            source: Box::new(ConnectError::UnexpectedFrame),
        });
        assert_eq!(registered.blocker(), Some(HostBlocker::Epoch(EpochMismatch::new(150, None))));
        let other = AttemptError::Connect(ConnectError::ProtocolOutOfRange(3));
        assert_eq!(other.blocker(), None);
    }

    #[test]
    fn a_checkout_without_a_build_is_named() {
        let home = std::path::PathBuf::from("/nonexistent/home");
        let installation =
            futures_lite::future::block_on(MakaInstallation::discover_in(None, Some(home.clone())))
                .expect_err("no checkout");
        let error = AttemptError::from(LaunchError::Installation(installation));
        let Some(HostBlocker::Checkout(checkout)) = error.blocker() else {
            panic!("expected a missing checkout");
        };
        assert_eq!(checkout.path, home.join("code/maka-pin"));
        assert!(!checkout.from_environment);
        assert!(!checkout.exists);
    }
}

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

//! Compatibility constants shared by every Runtime Host peer.
//!
//! Source: `packages/runtime-host/src/protocol/index.ts` (constants near the
//! top of the file, `RUNTIME_HOST_MAX_MESSAGE_BYTES`, `negotiateProtocol`) and
//! `packages/runtime-host/src/composition-identity.ts`.

/// `RUNTIME_HOST_PROTOCOL_VERSION` (index.ts:104). Both the TS client and the
/// Host advertise the single range `{ min: 0, max: 0 }`
/// (`server/host-kernel.ts` `HOST_PROTOCOL`, `cli/src/runtime-host-cli-context.ts`).
pub const PROTOCOL_VERSION: u32 = 0;

/// The protocol range this client offers in its `hello`.
pub const SUPPORTED_PROTOCOLS: ProtocolRange =
    ProtocolRange::new(PROTOCOL_VERSION, PROTOCOL_VERSION);

/// `RUNTIME_HOST_COMPATIBILITY_EPOCH` (index.ts:107). A Host rejects any
/// client whose epoch differs, before admitting domain commands. Bump this
/// together with every protocol change mirrored from the TypeScript side;
/// `scripts/check-protocol-drift.sh` checks it against `MAKA_PIN` and the
/// pinned Maka checkout.
pub const RUNTIME_HOST_COMPATIBILITY_EPOCH: u32 = 197;

/// `MAKA_PIN` at the repository root, as this build read it.
const MAKA_PIN_FILE: &str = include_str!("../../../MAKA_PIN");

/// The apache/maka commit `MAKA_PIN` names: a Host built from that commit
/// speaks [`RUNTIME_HOST_COMPATIBILITY_EPOCH`]. The window names it when a
/// Host of another epoch refuses this client. Read from `MAKA_PIN` when this
/// crate compiles; a pin without a `commit=` line fails the build.
pub const MAKA_PIN_COMMIT: &str = pin_value(MAKA_PIN_FILE, b"commit=");

/// The value of the `key` line (`commit=`, `epoch=`) of a `MAKA_PIN` file,
/// trimmed. Evaluated at compile time, so a missing line is a build error.
const fn pin_value(file: &'static str, key: &[u8]) -> &'static str {
    let bytes = file.as_bytes();
    let mut start = 0;
    while start < bytes.len() {
        let mut end = start;
        while end < bytes.len() && bytes[end] != b'\n' {
            end += 1;
        }
        let mut matches = end - start >= key.len();
        let mut index = 0;
        while matches && index < key.len() {
            matches = bytes[start + index] == key[index];
            index += 1;
        }
        if matches {
            let (_, rest) = bytes.split_at(start + key.len());
            let (value, _) = rest.split_at(end - start - key.len());
            match std::str::from_utf8(value) {
                Ok(value) => return value.trim_ascii(),
                Err(_) => panic!("MAKA_PIN is not UTF-8"),
            }
        }
        start = end + 1;
    }
    panic!("MAKA_PIN lacks a line for the key")
}

/// `RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION` (index.ts:103).
pub const REGISTRATION_SCHEMA_VERSION: u32 = 1;

/// `RUNTIME_HOST_MAX_MESSAGE_BYTES` (index.ts:491): the byte limit of one
/// encoded JSON message, excluding the `\n` delimiter.
pub const MAX_MESSAGE_BYTES: usize = 768 * 1024;

/// `RUNTIME_HOST_MAX_IN_FLIGHT_DOMAIN_REQUESTS` (index.ts:492). The Host tears
/// the connection down when a client exceeds it; `host.status` may use one
/// reserved slot (`server/connection-session.ts`).
pub const MAX_IN_FLIGHT_DOMAIN_REQUESTS: usize = 64;

/// `INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID` (composition-identity.ts).
pub const COMPOSITION_ID: &str = "maka.interactive";

/// `decodeCompositionId` (index.ts): an absent `compositionId` means the
/// interactive composition.
pub(crate) fn default_composition_id() -> String {
    COMPOSITION_ID.to_owned()
}

/// `decodeCompositionRevision` (index.ts): an absent `compositionRevision`
/// is `"legacy"`.
pub(crate) fn legacy_composition_revision() -> String {
    "legacy".to_owned()
}

/// An inclusive protocol version range (`ProtocolRange` in index.ts).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub struct ProtocolRange {
    pub min: u32,
    pub max: u32,
}

impl ProtocolRange {
    /// A range from `min` to `max`, inclusive. An inverted range is allowed
    /// here and rejected by [`ProtocolRange::negotiate`], as in the TS source.
    pub const fn new(min: u32, max: u32) -> Self {
        Self { min, max }
    }

    /// Mirrors `negotiateProtocol`: the highest version both ranges contain.
    ///
    /// Returns `None` when either range is invalid (`max < min`) or the
    /// ranges do not overlap.
    pub fn negotiate(self, other: ProtocolRange) -> Option<u32> {
        if self.max < self.min || other.max < other.min {
            return None;
        }
        let selected = self.max.min(other.max);
        (selected >= self.min.max(other.min)).then_some(selected)
    }

    /// Whether `version` lies inside this range.
    pub fn contains(self, version: u32) -> bool {
        self.min <= version && version <= self.max
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiate_selects_highest_common_version() {
        let client = ProtocolRange { min: 0, max: 3 };
        let host = ProtocolRange { min: 2, max: 5 };
        assert_eq!(client.negotiate(host), Some(3));
        assert_eq!(host.negotiate(client), Some(3));
    }

    #[test]
    fn negotiate_rejects_disjoint_and_invalid_ranges() {
        let low = ProtocolRange { min: 0, max: 1 };
        let high = ProtocolRange { min: 2, max: 3 };
        assert_eq!(low.negotiate(high), None);
        let inverted = ProtocolRange { min: 3, max: 1 };
        assert_eq!(inverted.negotiate(high), None);
    }

    #[test]
    fn supported_range_matches_host_range() {
        assert_eq!(SUPPORTED_PROTOCOLS.negotiate(SUPPORTED_PROTOCOLS), Some(0));
    }

    /// The pin the build embeds is the one the epoch constant mirrors
    /// (`scripts/check-protocol-drift.sh` checks the checkout as well).
    #[test]
    fn the_embedded_pin_names_a_commit_of_this_epoch() {
        assert_eq!(MAKA_PIN_COMMIT.len(), 40, "{MAKA_PIN_COMMIT:?}");
        assert!(MAKA_PIN_COMMIT.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(
            pin_value(MAKA_PIN_FILE, b"epoch=").parse::<u32>(),
            Ok(RUNTIME_HOST_COMPATIBILITY_EPOCH)
        );
    }
}

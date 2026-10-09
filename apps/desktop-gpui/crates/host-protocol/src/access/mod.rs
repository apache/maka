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

//! Reaching a Runtime Host that is not on this machine: access credentials
//! and the pairing operations, the transports a remote Host profile names,
//! Desktop's owner connection code, the activation frame an operator
//! prints when SSH starts a managed Host, and what a remote owner may do.
//!
//! Sources in `packages/runtime-host/src/`: `protocol/access-authority.ts`,
//! `RuntimeHostRemoteTransport` and `decodeRuntimeHostRemoteTransport` in
//! `client/host-profile.ts`, `normalizeRemoteRuntimeHostUrl` in
//! `client/connection.ts`, `protocol/websocket-path.ts`,
//! `operator/operator-command.ts`, `operator/activation-frame.ts`, and
//! `client/owner-connection-code.ts`; the grants are in
//! `protocol/operations.ts`.
//!
//! The TypeScript decoders here reject unknown fields (`requireExactRecord`,
//! zod `.strict()`). These types tolerate them, like every production type in
//! this crate, so a connection code or activation frame from a newer Maka
//! still decodes; an ignored field never widens what the client does.

mod activation;
mod connection_code;
mod credential;
mod grants;
mod transport;

pub use activation::{
    ACTIVATION_FRAME_MAX_BYTES, ACTIVATION_FRAME_PREFIX, ActivationEndpoint, ActivationFailure,
    ActivationFrame, ActivationResult, decode_activation_frame,
};
pub use connection_code::{
    InvalidConnectionCode, OWNER_CONNECTION_CODE_PREFIX, OwnerConnectionCode,
    decode_owner_connection_code,
};
pub use credential::{
    ACCESS_CREDENTIAL_MAX_BYTES, AccessCredential, AccessCredentialFinalize,
    AccessCredentialFinalizeInput, AccessCredentialFinalizeResult, AccessCredentialIssueResult,
    AccessCredentialPrepare, AccessCredentialPrepareInput, AccessPrincipalKind,
    ClientCapabilityOwnerIdentity, InvalidAccessCredential,
};
pub use grants::{REMOTE_OWNER_OPERATION_GRANTS, operation_allows_remote_owner};
pub use transport::{
    DEFAULT_WEBSOCKET_PATH, DirectPeerTransport, OperatorCommand, OperatorPlatform,
    PLAINTEXT_ACKNOWLEDGEMENT, RemoteHostUrl, RemoteTransport, RemoteTransportKind, SshEndpoint,
    SshTransport, TransportError, WEBSOCKET_PATH_MAX_BYTES, is_canonical_websocket_path,
    normalize_ssh_destination,
};

/// JavaScript's `\s` in a Unicode-mode regular expression: WhiteSpace and
/// LineTerminator (ECMA-262 §22.2.2.9). Rust's `char::is_whitespace` differs
/// in U+0085 and U+FEFF, so the TypeScript checks are mirrored with this.
pub(crate) fn is_js_whitespace(character: char) -> bool {
    // U+0009..U+000D are tab, line feed, vertical tab, form feed, and
    // carriage return.
    matches!(character, '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}')
        || matches!(character, '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}')
        || character == '\u{feff}'
}

/// `/[\u0000-\u001f\u007f]/u`: a C0 control character or DEL.
pub(crate) fn is_control(character: char) -> bool {
    matches!(character, '\u{0}'..='\u{1f}' | '\u{7f}')
}

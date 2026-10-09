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

//! The transports a remote Runtime Host profile can name.
//!
//! Source: `RuntimeHostRemoteTransport` and `decodeRuntimeHostRemoteTransport`
//! in `packages/runtime-host/src/client/host-profile.ts`;
//! `normalizeRemoteRuntimeHostUrl` in `client/connection.ts`;
//! `isCanonicalRuntimeHostWebSocketPath` in `protocol/websocket-path.ts`;
//! `normalizeRuntimeHostSshDestination` in `client/ssh-tunnel.ts`;
//! `decodeRuntimeHostOperatorCommand` and `runtimeHostOperatorInvocation` in
//! `operator/operator-command.ts`.

use std::fmt;
use std::net::{Ipv4Addr, Ipv6Addr};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use url::{Host, Url};

use super::{is_control, is_js_whitespace};

/// `RUNTIME_HOST_PLAINTEXT_ACKNOWLEDGEMENT`: the value a plaintext transport
/// must carry to show that someone chose to send the bearer credential
/// unencrypted.
pub const PLAINTEXT_ACKNOWLEDGEMENT: &str = "plaintext-bearer-v1";

/// `RUNTIME_HOST_WEBSOCKET_PATH_MAX_BYTES`.
pub const WEBSOCKET_PATH_MAX_BYTES: usize = 1_000;

/// The upgrade path a Host listens on unless configured otherwise
/// (`DEFAULT_WEBSOCKET_PATH` in `server/websocket-listener.ts`).
pub const DEFAULT_WEBSOCKET_PATH: &str = "/runtime-host";

/// `destination.length > 512` in `normalizeRuntimeHostSshDestination`, in
/// UTF-16 units.
const SSH_DESTINATION_MAX_UNITS: usize = 512;

/// `PATH_MAX_BYTES` in `operator-command.ts`.
const OPERATOR_PATH_MAX_BYTES: usize = 4 * 1024;

/// `PEER_ID_MAX_BYTES` in `peer-reachability/model.ts`.
const PEER_ID_MAX_BYTES: usize = 256;

/// Why a transport, URL, or path is not one a remote profile may name. The
/// messages are the TypeScript decoders'.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum TransportError {
    #[error("Runtime Host URL is invalid")]
    InvalidUrl,
    #[error("Remote Runtime Host URL must use ws or wss")]
    UnsupportedScheme,
    #[error("Remote Runtime Host URL must not contain credentials, a query, or a fragment")]
    UrlExtras,
    #[error("Plain remote Runtime Host WebSocket URLs must use loopback")]
    PlaintextNotLoopback,
    #[error("Runtime Host TLS URL must use wss")]
    TlsRequiresWss,
    #[error("Runtime Host plaintext URL must use ws")]
    PlaintextRequiresWs,
    #[error("Runtime Host plaintext transport requires explicit acknowledgement")]
    PlaintextNotAcknowledged,
    #[error("Runtime Host SSH destination is invalid")]
    InvalidSshDestination,
    #[error("{0} must be an integer between 1 and 65535")]
    InvalidPort(&'static str),
    #[error("Runtime Host SSH WebSocket path must be a canonical absolute URL path")]
    InvalidWebSocketPath,
    /// A connect-only SSH transport needs `remotePort` and `websocketPath`;
    /// an activated one needs `activation` and neither of those.
    #[error(
        "Runtime Host SSH transport must name either a forwarded port and path or an activation"
    )]
    SshEndpointShape,
    #[error("Runtime Host SSH activation kind is invalid")]
    InvalidActivationKind,
    #[error("Runtime Host {0} must be an absolute {1} path")]
    InvalidOperatorPath(&'static str, &'static str),
    #[error("Runtime Host direct peer transport is invalid")]
    InvalidDirectPeer,
    #[error("Runtime Host direct peer transport requires at least one route")]
    DirectPeerWithoutRoutes,
}

/// A remote Host's WebSocket URL, normalized the way Node's `URL` prints it
/// (lowercase host, default port dropped, IDNA, percent-encoded path).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RemoteHostUrl(Url);

impl RemoteHostUrl {
    /// `normalizeRemoteRuntimeHostUrl`: a `ws:` or `wss:` URL with no user
    /// name, password, query, or fragment. A `ws:` URL must name
    /// `127.0.0.1` or `[::1]` unless `allow_insecure_remote`.
    ///
    /// A bare `?` or `#` is refused too; Node's `URL` reports those as an
    /// empty search and hash, which the TypeScript check lets through.
    pub fn parse(value: &str, allow_insecure_remote: bool) -> Result<Self, TransportError> {
        let url = Url::parse(value).map_err(|_| TransportError::InvalidUrl)?;
        if !matches!(url.scheme(), "ws" | "wss") {
            return Err(TransportError::UnsupportedScheme);
        }
        if !url.username().is_empty()
            || url.password().is_some_and(|password| !password.is_empty())
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(TransportError::UrlExtras);
        }
        let url = Self(url);
        if !url.is_tls() && !allow_insecure_remote && !url.is_loopback() {
            return Err(TransportError::PlaintextNotLoopback);
        }
        Ok(url)
    }

    /// The URL as Node's `url.toString()` prints it.
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }

    /// The parsed URL.
    pub fn as_url(&self) -> &Url {
        &self.0
    }

    /// Whether the scheme is `wss`.
    pub fn is_tls(&self) -> bool {
        self.0.scheme() == "wss"
    }

    /// Whether the host is exactly `127.0.0.1` or `::1`, the addresses the
    /// TypeScript check accepts for a plain `ws:` URL.
    pub fn is_loopback(&self) -> bool {
        match self.0.host() {
            Some(Host::Ipv4(address)) => address == Ipv4Addr::LOCALHOST,
            Some(Host::Ipv6(address)) => address == Ipv6Addr::LOCALHOST,
            _ => false,
        }
    }
}

impl fmt::Display for RemoteHostUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// `isCanonicalRuntimeHostWebSocketPath`: an absolute path that Node's `URL`
/// would print unchanged, at most [`WEBSOCKET_PATH_MAX_BYTES`].
///
/// The TypeScript check parses the path against a `ws:` base and compares.
/// Here that is spelled out: printable ASCII only, none of the characters the
/// WHATWG path percent-encode set escapes (`space " # < > ? ^ \` { }`) or a
/// backslash (a separator in special URLs), no leading `//` (an authority),
/// and no `.`/`..` segment in any spelling (`%2e`), which parsing removes.
pub fn is_canonical_websocket_path(path: &str) -> bool {
    path.len() <= WEBSOCKET_PATH_MAX_BYTES
        && path.starts_with('/')
        && !path.starts_with("//")
        && path
            .bytes()
            .all(|byte| (0x21..=0x7e).contains(&byte) && !b"\"#<>?\\^`{}".contains(&byte))
        && !path.split('/').any(is_dot_segment)
}

fn is_dot_segment(segment: &str) -> bool {
    let lower = segment.to_ascii_lowercase();
    matches!(lower.as_str(), "." | "%2e" | ".." | ".%2e" | "%2e." | "%2e%2e")
}

/// `normalizeRuntimeHostSshDestination`: trimmed, 1–512 UTF-16 units, not
/// starting with `-` (which `ssh` would read as an option), and without
/// whitespace or control characters.
pub fn normalize_ssh_destination(value: &str) -> Result<String, TransportError> {
    let destination = value.trim_matches(is_js_whitespace);
    let valid = !destination.is_empty()
        && destination.encode_utf16().count() <= SSH_DESTINATION_MAX_UNITS
        && !destination.starts_with('-')
        && !destination.chars().any(|c| is_js_whitespace(c) || is_control(c));
    if valid { Ok(destination.to_owned()) } else { Err(TransportError::InvalidSshDestination) }
}

/// Which kind of transport a profile or connection code names, for
/// reporting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum RemoteTransportKind {
    /// WebSocket over TLS.
    Tls,
    /// WebSocket without TLS, acknowledged.
    Plaintext,
    /// WebSocket through an SSH `-L` forward to a port that already listens.
    Ssh,
    /// WebSocket through an SSH forward to a Host an operator activates.
    SshOperator,
    /// libp2p Direct peer. Recognised; this client cannot use it yet.
    DirectPeer,
}

/// `RuntimeHostRemoteTransport`: how to reach a remote Host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "WireTransport", into = "WireTransport")]
#[non_exhaustive]
pub enum RemoteTransport {
    /// `kind: "tls"`: a `wss:` URL.
    Tls(RemoteHostUrl),
    /// `kind: "plaintext"`: a `ws:` URL on any host, carrying
    /// `acknowledgement: "plaintext-bearer-v1"`.
    Plaintext(RemoteHostUrl),
    /// `kind: "ssh"`.
    Ssh(SshTransport),
    /// `kind: "libp2p-direct"`.
    DirectPeer(DirectPeerTransport),
}

impl RemoteTransport {
    /// A TLS transport for a `wss:` URL.
    pub fn tls(url: &str) -> Result<Self, TransportError> {
        let url = RemoteHostUrl::parse(url, false)?;
        if url.is_tls() { Ok(Self::Tls(url)) } else { Err(TransportError::TlsRequiresWss) }
    }

    /// A plaintext transport for a `ws:` URL. Calling this is the
    /// acknowledgement: the bearer credential crosses the network in the
    /// clear.
    pub fn plaintext(url: &str) -> Result<Self, TransportError> {
        let url = RemoteHostUrl::parse(url, true)?;
        if url.is_tls() {
            Err(TransportError::PlaintextRequiresWs)
        } else {
            Ok(Self::Plaintext(url))
        }
    }

    /// Which kind of transport this is.
    pub fn kind(&self) -> RemoteTransportKind {
        match self {
            Self::Tls(_) => RemoteTransportKind::Tls,
            Self::Plaintext(_) => RemoteTransportKind::Plaintext,
            Self::Ssh(ssh) => match ssh.endpoint() {
                SshEndpoint::Forward { .. } => RemoteTransportKind::Ssh,
                SshEndpoint::Operator(_) => RemoteTransportKind::SshOperator,
            },
            Self::DirectPeer(_) => RemoteTransportKind::DirectPeer,
        }
    }
}

/// The `ssh` variants of `RuntimeHostRemoteTransport`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshTransport {
    destination: String,
    ssh_port: Option<u16>,
    endpoint: SshEndpoint,
}

/// Where the Host listens on the far side of an SSH connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SshEndpoint {
    /// Connect-only: the Host already listens on `127.0.0.1:<remote_port>`
    /// there, at `websocket_path`.
    #[non_exhaustive]
    Forward { remote_port: u16, websocket_path: String },
    /// `activation: { kind: "ssh_operator", operator }`: run the operator
    /// over SSH first; it starts the Host and prints where it listens.
    Operator(OperatorCommand),
}

impl SshTransport {
    /// A connect-only SSH transport.
    pub fn forward(
        destination: &str,
        ssh_port: Option<u16>,
        remote_port: u16,
        websocket_path: &str,
    ) -> Result<Self, TransportError> {
        let endpoint = SshEndpoint::Forward {
            remote_port: require_port(remote_port.into(), "Runtime Host SSH remote port")?,
            websocket_path: require_websocket_path(websocket_path)?,
        };
        Self::new(destination, ssh_port, endpoint)
    }

    /// An SSH transport whose Host `operator` activates.
    pub fn activated(
        destination: &str,
        ssh_port: Option<u16>,
        operator: OperatorCommand,
    ) -> Result<Self, TransportError> {
        Self::new(destination, ssh_port, SshEndpoint::Operator(operator))
    }

    fn new(
        destination: &str,
        ssh_port: Option<u16>,
        endpoint: SshEndpoint,
    ) -> Result<Self, TransportError> {
        let ssh_port =
            ssh_port.map(|port| require_port(port.into(), "Runtime Host SSH port")).transpose()?;
        Ok(Self { destination: normalize_ssh_destination(destination)?, ssh_port, endpoint })
    }

    /// The `ssh` destination, `[user@]host` or a `Host` alias.
    pub fn destination(&self) -> &str {
        &self.destination
    }

    /// `-p`, when the profile sets one.
    pub fn ssh_port(&self) -> Option<u16> {
        self.ssh_port
    }

    pub fn endpoint(&self) -> &SshEndpoint {
        &self.endpoint
    }
}

/// `RuntimeHostOperatorCommand`: how to run a managed deployment's operator.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "WireOperator", into = "WireOperator")]
pub enum OperatorCommand {
    /// `kind: "node"`: `<node_path> <module_path> …`.
    #[non_exhaustive]
    Node { platform: OperatorPlatform, node_path: String, module_path: String },
    /// `kind: "legacy_posix_executable"`, for deployments made before the
    /// Node operator shipped.
    #[non_exhaustive]
    LegacyPosixExecutable { executable_path: String },
}

/// `RuntimeHostOperatorPlatform`: the path and shell conventions of the
/// machine the operator runs on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OperatorPlatform {
    Posix,
    Win32,
}

impl OperatorPlatform {
    fn name(self) -> &'static str {
        match self {
            Self::Posix => "posix",
            Self::Win32 => "win32",
        }
    }
}

impl OperatorCommand {
    /// `createRuntimeHostOperatorCommand`: both paths absolute for
    /// `platform`.
    pub fn node(
        platform: OperatorPlatform,
        node_path: &str,
        module_path: &str,
    ) -> Result<Self, TransportError> {
        Ok(Self::Node {
            platform,
            node_path: require_absolute_path(node_path, platform, "operator Node path")?,
            module_path: require_absolute_path(module_path, platform, "operator module path")?,
        })
    }

    /// `createRuntimeHostLegacyPosixOperatorCommand`.
    pub fn legacy_posix(executable_path: &str) -> Result<Self, TransportError> {
        Ok(Self::LegacyPosixExecutable {
            executable_path: require_absolute_path(
                executable_path,
                OperatorPlatform::Posix,
                "legacy operator executable",
            )?,
        })
    }

    /// The platform the operator runs on; a legacy executable is POSIX.
    pub fn platform(&self) -> OperatorPlatform {
        match self {
            Self::Node { platform, .. } => *platform,
            Self::LegacyPosixExecutable { .. } => OperatorPlatform::Posix,
        }
    }

    /// `runtimeHostOperatorInvocation`: the executable and its arguments
    /// for running the operator with `args`.
    pub fn invocation(&self, args: &[&str]) -> (String, Vec<String>) {
        let args = args.iter().map(|arg| (*arg).to_owned());
        match self {
            Self::Node { node_path, module_path, .. } => {
                (node_path.clone(), std::iter::once(module_path.clone()).chain(args).collect())
            }
            Self::LegacyPosixExecutable { executable_path } => {
                (executable_path.clone(), args.collect())
            }
        }
    }
}

/// The `libp2p-direct` transport: a signed peer reachability lease
/// (`SignedPeerReachabilityLeaseV1`). This client cannot dial a Direct peer
/// yet, so the lease is kept verbatim and checked only for the fields it
/// reports: the lease's `peerId` and that it names at least one route. Its
/// signature is not verified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectPeerTransport {
    reachability: Value,
    peer_id: String,
}

impl DirectPeerTransport {
    fn decode(reachability: Value) -> Result<Self, TransportError> {
        let lease = reachability.get("lease").ok_or(TransportError::InvalidDirectPeer)?;
        let peer_id = lease
            .get("peerId")
            .and_then(Value::as_str)
            .filter(|id| {
                !id.is_empty()
                    && id.len() <= PEER_ID_MAX_BYTES
                    && !id.chars().any(|c| is_js_whitespace(c) || is_control(c))
            })
            .ok_or(TransportError::InvalidDirectPeer)?
            .to_owned();
        let routes = |field: &str| -> Result<usize, TransportError> {
            let routes = lease
                .get(field)
                .and_then(Value::as_array)
                .ok_or(TransportError::InvalidDirectPeer)?;
            if routes.iter().all(Value::is_string) {
                Ok(routes.len())
            } else {
                Err(TransportError::InvalidDirectPeer)
            }
        };
        if routes("directRoutes")? + routes("coordinationRoutes")? == 0 {
            return Err(TransportError::DirectPeerWithoutRoutes);
        }
        Ok(Self { reachability, peer_id })
    }

    /// The Host's libp2p peer id.
    pub fn peer_id(&self) -> &str {
        &self.peer_id
    }

    /// The signed lease, as decoded.
    pub fn reachability(&self) -> &Value {
        &self.reachability
    }
}

fn require_port(value: u64, label: &'static str) -> Result<u16, TransportError> {
    u16::try_from(value).ok().filter(|port| *port != 0).ok_or(TransportError::InvalidPort(label))
}

fn require_websocket_path(path: &str) -> Result<String, TransportError> {
    if is_canonical_websocket_path(path) {
        Ok(path.to_owned())
    } else {
        Err(TransportError::InvalidWebSocketPath)
    }
}

/// `requireAbsolutePath` in `operator-command.ts`, with Node's
/// `path.posix.isAbsolute` / `path.win32.isAbsolute`.
fn require_absolute_path(
    value: &str,
    platform: OperatorPlatform,
    label: &'static str,
) -> Result<String, TransportError> {
    let absolute = match platform {
        OperatorPlatform::Posix => value.starts_with('/'),
        OperatorPlatform::Win32 => {
            let bytes = value.as_bytes();
            let separator = |byte: u8| byte == b'/' || byte == b'\\';
            bytes.first().copied().is_some_and(separator)
                || (bytes.len() > 2
                    && bytes[0].is_ascii_alphabetic()
                    && bytes[1] == b':'
                    && separator(bytes[2]))
        }
    };
    if absolute && value.len() <= OPERATOR_PATH_MAX_BYTES && !value.chars().any(is_control) {
        Ok(value.to_owned())
    } else {
        Err(TransportError::InvalidOperatorPath(label, platform.name()))
    }
}

/// The literal wire layout of [`RemoteTransport`].
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind")]
enum WireTransport {
    #[serde(rename = "tls")]
    Tls { url: String },
    #[serde(rename = "plaintext")]
    Plaintext {
        url: String,
        #[serde(default)]
        acknowledgement: Option<String>,
    },
    #[serde(rename = "ssh", rename_all = "camelCase")]
    Ssh {
        destination: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ssh_port: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        remote_port: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        websocket_path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        activation: Option<WireActivation>,
    },
    #[serde(rename = "libp2p-direct")]
    DirectPeer { reachability: Value },
}

#[derive(Serialize, Deserialize)]
struct WireActivation {
    kind: String,
    operator: OperatorCommand,
}

/// `kind` of [`WireActivation`].
const SSH_OPERATOR_ACTIVATION: &str = "ssh_operator";

impl TryFrom<WireTransport> for RemoteTransport {
    type Error = TransportError;

    fn try_from(wire: WireTransport) -> Result<Self, TransportError> {
        match wire {
            WireTransport::Tls { url } => {
                // The scheme check comes first, as in the TypeScript decoder,
                // so a `ws:` URL reads as the wrong scheme rather than as a
                // plaintext URL off loopback.
                match Url::parse(&url) {
                    Ok(parsed) if parsed.scheme() == "wss" => Self::tls(&url),
                    Ok(_) => Err(TransportError::TlsRequiresWss),
                    Err(_) => Err(TransportError::InvalidUrl),
                }
            }
            WireTransport::Plaintext { url, acknowledgement } => {
                if acknowledgement.as_deref() != Some(PLAINTEXT_ACKNOWLEDGEMENT) {
                    return Err(TransportError::PlaintextNotAcknowledged);
                }
                match Url::parse(&url) {
                    Ok(parsed) if parsed.scheme() == "ws" => Self::plaintext(&url),
                    Ok(_) => Err(TransportError::PlaintextRequiresWs),
                    Err(_) => Err(TransportError::InvalidUrl),
                }
            }
            WireTransport::Ssh {
                destination,
                ssh_port,
                remote_port,
                websocket_path,
                activation,
            } => {
                let ssh_port =
                    ssh_port.map(|port| require_port(port, "Runtime Host SSH port")).transpose()?;
                let transport = match (activation, remote_port, websocket_path) {
                    (Some(activation), None, None) => {
                        if activation.kind != SSH_OPERATOR_ACTIVATION {
                            return Err(TransportError::InvalidActivationKind);
                        }
                        SshTransport::activated(&destination, ssh_port, activation.operator)?
                    }
                    (None, Some(remote_port), Some(websocket_path)) => {
                        let remote_port =
                            require_port(remote_port, "Runtime Host SSH remote port")?;
                        SshTransport::forward(&destination, ssh_port, remote_port, &websocket_path)?
                    }
                    _ => return Err(TransportError::SshEndpointShape),
                };
                Ok(Self::Ssh(transport))
            }
            WireTransport::DirectPeer { reachability } => {
                Ok(Self::DirectPeer(DirectPeerTransport::decode(reachability)?))
            }
        }
    }
}

impl From<RemoteTransport> for WireTransport {
    fn from(transport: RemoteTransport) -> Self {
        match transport {
            RemoteTransport::Tls(url) => Self::Tls { url: url.as_str().to_owned() },
            RemoteTransport::Plaintext(url) => Self::Plaintext {
                url: url.as_str().to_owned(),
                acknowledgement: Some(PLAINTEXT_ACKNOWLEDGEMENT.to_owned()),
            },
            RemoteTransport::Ssh(SshTransport { destination, ssh_port, endpoint }) => {
                let ssh_port = ssh_port.map(u64::from);
                match endpoint {
                    SshEndpoint::Forward { remote_port, websocket_path } => Self::Ssh {
                        destination,
                        ssh_port,
                        remote_port: Some(remote_port.into()),
                        websocket_path: Some(websocket_path),
                        activation: None,
                    },
                    SshEndpoint::Operator(operator) => Self::Ssh {
                        destination,
                        ssh_port,
                        remote_port: None,
                        websocket_path: None,
                        activation: Some(WireActivation {
                            kind: SSH_OPERATOR_ACTIVATION.to_owned(),
                            operator,
                        }),
                    },
                }
            }
            RemoteTransport::DirectPeer(peer) => {
                Self::DirectPeer { reachability: peer.reachability }
            }
        }
    }
}

/// The literal wire layout of [`OperatorCommand`].
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind")]
enum WireOperator {
    #[serde(rename = "node", rename_all = "camelCase")]
    Node { platform: OperatorPlatform, node_path: String, module_path: String },
    #[serde(rename = "legacy_posix_executable", rename_all = "camelCase")]
    LegacyPosixExecutable { executable_path: String },
}

impl TryFrom<WireOperator> for OperatorCommand {
    type Error = TransportError;

    fn try_from(wire: WireOperator) -> Result<Self, TransportError> {
        match wire {
            WireOperator::Node { platform, node_path, module_path } => {
                Self::node(platform, &node_path, &module_path)
            }
            WireOperator::LegacyPosixExecutable { executable_path } => {
                Self::legacy_posix(&executable_path)
            }
        }
    }
}

impl From<OperatorCommand> for WireOperator {
    fn from(command: OperatorCommand) -> Self {
        match command {
            OperatorCommand::Node { platform, node_path, module_path } => {
                Self::Node { platform, node_path, module_path }
            }
            OperatorCommand::LegacyPosixExecutable { executable_path } => {
                Self::LegacyPosixExecutable { executable_path }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Results of `isCanonicalRuntimeHostWebSocketPath` at the pin, recorded
    /// with Node 24.18.
    #[test]
    fn canonical_paths_match_the_typescript_check() {
        let cases: &[(&str, bool)] = &[
            ("/runtime-host", true),
            ("/", true),
            ("//x", false),
            ("/a/./b", false),
            ("/a/../b", false),
            ("/a/.", false),
            ("/a/..", false),
            ("/a/%2e/b", false),
            ("/a/%2E%2e/b", false),
            ("/a/.x", true),
            ("/a/..x", true),
            ("/a b", false),
            ("/a?b", false),
            ("/a#b", false),
            ("/a\\b", false),
            ("/a^b", false),
            ("/a`b", false),
            ("/a{b}", false),
            ("/a|b", true),
            ("/a\"b", false),
            ("/a<b>", false),
            ("/a'b", true),
            ("/a%zz", true),
            ("/a%20b", true),
            ("/\u{e9}", false),
            ("/a\u{7f}", false),
            ("/a\tb", false),
            ("", false),
            ("runtime-host", false),
            ("/a;b=c", true),
            ("/a:b@c", true),
            ("/~user", true),
            ("/a[b]", true),
            ("/%", true),
            ("/a/b/", true),
            ("/a//b", true),
            ("/a!$&()*+,=", true),
        ];
        for (path, canonical) in cases {
            assert_eq!(is_canonical_websocket_path(path), *canonical, "{path:?}");
        }
        let longest = format!("/{}", "a".repeat(WEBSOCKET_PATH_MAX_BYTES - 1));
        assert!(is_canonical_websocket_path(&longest));
        assert!(!is_canonical_websocket_path(&format!("{longest}a")));
    }

    /// `normalizeRemoteRuntimeHostUrl(url)` and
    /// `normalizeRemoteRuntimeHostUrl(url, { allowInsecureRemote: true })` at
    /// the pin, recorded with Node 24.18. `None` is a refusal.
    #[test]
    fn remote_urls_normalize_like_node() {
        let cases: &[(&str, Option<&str>, Option<&str>)] = &[
            (
                "ws://127.0.0.1:8080/runtime-host",
                Some("ws://127.0.0.1:8080/runtime-host"),
                Some("ws://127.0.0.1:8080/runtime-host"),
            ),
            (
                "wss://Example.COM/runtime-host",
                Some("wss://example.com/runtime-host"),
                Some("wss://example.com/runtime-host"),
            ),
            ("wss://example.com:443/x", Some("wss://example.com/x"), Some("wss://example.com/x")),
            ("ws://[::1]:9/x", Some("ws://[::1]:9/x"), Some("ws://[::1]:9/x")),
            ("ws://localhost:9/x", None, Some("ws://localhost:9/x")),
            ("ws://10.0.0.1/x", None, Some("ws://10.0.0.1/x")),
            ("http://example.com/", None, None),
            ("wss://u:p@example.com/", None, None),
            ("wss://example.com/?a", None, None),
            ("wss://example.com/#a", None, None),
            ("wss://example.com", Some("wss://example.com/"), Some("wss://example.com/")),
            (
                "wss://example.com/a b",
                Some("wss://example.com/a%20b"),
                Some("wss://example.com/a%20b"),
            ),
            ("wss://example.com/a/../b", Some("wss://example.com/b"), Some("wss://example.com/b")),
            (
                "wss://\u{391}\u{392}\u{393}.com/",
                Some("wss://xn--mxacd.com/"),
                Some("wss://xn--mxacd.com/"),
            ),
            ("ws://127.0.0.1:80/x", Some("ws://127.0.0.1/x"), Some("ws://127.0.0.1/x")),
            ("wss://example.com:65536/", None, None),
            ("ws://0x7f.1/x", Some("ws://127.0.0.1/x"), Some("ws://127.0.0.1/x")),
            ("ws://127.1/x", Some("ws://127.0.0.1/x"), Some("ws://127.0.0.1/x")),
            ("wss://exa mple.com/", None, None),
            (
                "wss://[::ffff:127.0.0.1]/x",
                Some("wss://[::ffff:7f00:1]/x"),
                Some("wss://[::ffff:7f00:1]/x"),
            ),
            ("ws://[0:0:0:0:0:0:0:1]/x", Some("ws://[::1]/x"), Some("ws://[::1]/x")),
            (
                "WSS://EXAMPLE.com/Path",
                Some("wss://example.com/Path"),
                Some("wss://example.com/Path"),
            ),
            ("wss://example.com./x", Some("wss://example.com./x"), Some("wss://example.com./x")),
            ("wss://@example.com/", Some("wss://example.com/"), Some("wss://example.com/")),
            ("wss://example.com/%7e", Some("wss://example.com/%7e"), Some("wss://example.com/%7e")),
        ];
        for (input, strict, insecure) in cases {
            let parse = |allow| RemoteHostUrl::parse(input, allow).ok();
            assert_eq!(parse(false).as_ref().map(RemoteHostUrl::as_str), *strict, "{input}");
            assert_eq!(parse(true).as_ref().map(RemoteHostUrl::as_str), *insecure, "{input}");
        }
        // Node reports a bare `?` and `#` as empty; this client refuses them.
        assert_eq!(
            RemoteHostUrl::parse("wss://example.com/?", false),
            Err(TransportError::UrlExtras)
        );
        assert_eq!(
            RemoteHostUrl::parse("wss://example.com/#", false),
            Err(TransportError::UrlExtras)
        );
    }

    /// `decodeRuntimeHostRemoteTransport` at the pin, recorded with Node 24.18.
    #[test]
    fn transports_decode_like_the_typescript_decoder() {
        let decode = |value: Value| serde_json::from_value::<RemoteTransport>(value);
        let tls = decode(json!({"kind": "tls", "url": "wss://Host.example.com:443/runtime-host"}))
            .expect("tls");
        assert_eq!(
            serde_json::to_value(&tls).expect("encode"),
            json!({"kind": "tls", "url": "wss://host.example.com/runtime-host"})
        );
        assert_eq!(tls.kind(), RemoteTransportKind::Tls);

        let plaintext = json!({
            "kind": "plaintext",
            "url": "ws://10.0.0.2:7000/runtime-host",
            "acknowledgement": "plaintext-bearer-v1"
        });
        let decoded = decode(plaintext.clone()).expect("plaintext");
        assert_eq!(serde_json::to_value(&decoded).expect("encode"), plaintext);
        let unacknowledged = decode(json!({"kind": "plaintext", "url": "ws://10.0.0.2:7000/x"}));
        assert!(unacknowledged.expect_err("refused").to_string().contains("acknowledgement"));

        let ssh = decode(json!({
            "kind": "ssh",
            "destination": " me@box ",
            "sshPort": 2222,
            "remotePort": 7000,
            "websocketPath": "/runtime-host"
        }))
        .expect("ssh");
        assert_eq!(
            serde_json::to_value(&ssh).expect("encode"),
            json!({
                "kind": "ssh",
                "destination": "me@box",
                "sshPort": 2222,
                "remotePort": 7000,
                "websocketPath": "/runtime-host"
            })
        );
        assert_eq!(ssh.kind(), RemoteTransportKind::Ssh);

        let activated = json!({
            "kind": "ssh",
            "destination": "me@box",
            "activation": {
                "kind": "ssh_operator",
                "operator": {"kind": "node", "platform": "posix", "nodePath": "/n", "modulePath": "/m.mjs"}
            }
        });
        let decoded = decode(activated.clone()).expect("activated ssh");
        assert_eq!(serde_json::to_value(&decoded).expect("encode"), activated);
        assert_eq!(decoded.kind(), RemoteTransportKind::SshOperator);

        for (value, message) in [
            (
                json!({"kind": "ssh", "destination": "-oProxyCommand=x", "remotePort": 7000, "websocketPath": "/runtime-host"}),
                "Runtime Host SSH destination is invalid",
            ),
            (
                json!({"kind": "ssh", "destination": "me@box", "remotePort": 7000, "websocketPath": "/a/../b"}),
                "Runtime Host SSH WebSocket path must be a canonical absolute URL path",
            ),
            (
                json!({"kind": "tls", "url": "ws://127.0.0.1/x"}),
                "Runtime Host TLS URL must use wss",
            ),
            (
                json!({"kind": "ssh", "destination": "me@box", "remotePort": 0, "websocketPath": "/x"}),
                "Runtime Host SSH remote port must be an integer between 1 and 65535",
            ),
            (
                json!({"kind": "ssh", "destination": "me@box", "remotePort": 7000}),
                "Runtime Host SSH transport must name either a forwarded port and path or an activation",
            ),
            (
                json!({"kind": "ssh", "destination": "me@box", "activation": {"kind": "other", "operator": {"kind": "legacy_posix_executable", "executablePath": "/x"}}}),
                "Runtime Host SSH activation kind is invalid",
            ),
            (
                json!({"kind": "ssh", "destination": "me@box", "activation": {"kind": "ssh_operator", "operator": {"kind": "node", "platform": "win32", "nodePath": "/n", "modulePath": "m.mjs"}}}),
                "Runtime Host operator module path must be an absolute win32 path",
            ),
        ] {
            let error = decode(value.clone()).expect_err("refused");
            assert!(error.to_string().contains(message), "{value}: {error}");
        }
        assert!(decode(json!({"kind": "carrier-pigeon"})).is_err());
    }

    #[test]
    fn a_direct_peer_transport_keeps_its_lease_and_reports_the_peer() {
        let reachability = json!({
            "lease": {
                "version": 1,
                "peerId": "12D3KooWGzBbDJhbY2Y4nB1hCKdk9oS8Z2xCmT4pj3uqvG1X3oYu",
                "revision": 2,
                "issuedAt": 1_790_000_000_000_u64,
                "expiresAt": 1_790_000_600_000_u64,
                "directRoutes": ["/ip4/192.168.1.20/udp/4001/quic-v1"],
                "coordinationRoutes": []
            },
            "publicKey": "CAESIC0",
            "signature": "c2lnbmF0dXJl"
        });
        let value = json!({"kind": "libp2p-direct", "reachability": reachability});
        let transport: RemoteTransport = serde_json::from_value(value.clone()).expect("decode");
        assert_eq!(transport.kind(), RemoteTransportKind::DirectPeer);
        let RemoteTransport::DirectPeer(peer) = &transport else {
            panic!("expected a direct peer");
        };
        assert_eq!(peer.peer_id(), "12D3KooWGzBbDJhbY2Y4nB1hCKdk9oS8Z2xCmT4pj3uqvG1X3oYu");
        assert_eq!(serde_json::to_value(&transport).expect("encode"), value);

        let mut routeless = value;
        routeless["reachability"]["lease"]["directRoutes"] = json!([]);
        let error = serde_json::from_value::<RemoteTransport>(routeless).expect_err("refused");
        assert!(error.to_string().contains("at least one route"), "{error}");
    }

    #[test]
    fn operator_paths_follow_the_platform_rules() {
        // `path.win32.isAbsolute` at Node 24.18.
        for (path, absolute) in [
            ("C:\\Users\\me\\operator.mjs", true),
            ("C:/Users/me/operator.mjs", true),
            ("\\\\server\\share\\operator.mjs", true),
            ("\\operator.mjs", true),
            ("C:", false),
            ("C:operator.mjs", false),
            ("operator.mjs", false),
        ] {
            let command = OperatorCommand::node(OperatorPlatform::Win32, "C:\\node.exe", path);
            assert_eq!(command.is_ok(), absolute, "{path}");
        }
        assert!(OperatorCommand::node(OperatorPlatform::Posix, "/n", "C:\\m.mjs").is_err());
        assert!(OperatorCommand::legacy_posix("/usr/bin/op\u{1}").is_err());
        assert!(OperatorCommand::legacy_posix(&format!("/{}", "a".repeat(4096))).is_err());

        let node = OperatorCommand::node(OperatorPlatform::Posix, "/n", "/m.mjs").expect("valid");
        assert_eq!(
            node.invocation(&["activate", "--framed"]),
            ("/n".to_owned(), vec!["/m.mjs".to_owned(), "activate".into(), "--framed".into()])
        );
        let legacy = OperatorCommand::legacy_posix("/op").expect("valid");
        assert_eq!(legacy.invocation(&["activate"]), ("/op".to_owned(), vec!["activate".into()]));
    }

    #[test]
    fn ssh_destinations_are_trimmed_and_checked() {
        assert_eq!(normalize_ssh_destination("\u{a0} me@box\n").as_deref(), Ok("me@box"));
        for invalid in ["", "  ", "-p22", "me box", "me@box\u{1}", &"a".repeat(513)] {
            assert_eq!(
                normalize_ssh_destination(invalid),
                Err(TransportError::InvalidSshDestination),
                "{invalid:?}"
            );
        }
        assert!(normalize_ssh_destination(&"a".repeat(512)).is_ok());
    }
}

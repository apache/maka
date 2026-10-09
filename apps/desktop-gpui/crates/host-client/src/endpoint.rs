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

//! What kind of local IPC endpoint a registration names.
//!
//! `registration.json` carries the Host's local IPC endpoint as a string
//! (`endpoint`, `readHostRegistration` in
//! `packages/runtime-host/src/control/registration.ts`). The Host chooses it
//! in `prepareRuntimeHostEndpoint`
//! (`packages/runtime-host/src/control/endpoint.ts`):
//!
//! - on macOS and Linux, a Unix domain socket in a private directory, for
//!   example `/var/folders/…/T/m-501-…/h.sock`;
//! - on Windows, a named pipe on the local machine:
//!   `\\.\pipe\maka-runtime-host-<first 16 characters of rootId>-<hostEpoch>`.
//!
//! [`LocalEndpoint::parse`] tells the two apart and refuses anything else,
//! in particular a pipe on another machine (`\\server\pipe\…`), which
//! Windows would open over the network.

use std::path::PathBuf;

use thiserror::Error;

/// The prefixes of a pipe in the local machine's pipe namespace. The Host
/// writes the first; Node's `net` accepts both.
const LOCAL_PIPE_PREFIXES: [&str; 2] = [r"\\.\pipe\", r"\\?\pipe\"];

/// "The entire pipe name string can be up to 256 characters long"
/// (`CreateNamedPipeW`, Win32 documentation), in UTF-16 units.
const MAX_PIPE_PATH_UNITS: usize = 256;

/// A Runtime Host's local IPC endpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum LocalEndpoint {
    /// A Unix domain socket at this absolute path (macOS, Linux).
    UnixSocket(PathBuf),
    /// A named pipe on this machine (Windows), as the whole path the
    /// registration gave, for example `\\.\pipe\maka-runtime-host-…`.
    NamedPipe(String),
}

/// Why an endpoint string is not one this client opens.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum EndpointError {
    /// A named pipe on another machine. The Host only listens locally, and
    /// opening a remote pipe would send this account's credentials to that
    /// machine.
    #[error("the Runtime Host endpoint {0:?} is a named pipe on another machine")]
    NotLocal(String),
    /// A local pipe path whose name is empty, contains a backslash or NUL,
    /// or makes the path longer than 256 characters.
    #[error("the Runtime Host endpoint {0:?} is not a valid named pipe path")]
    InvalidPipeName(String),
    /// Neither an absolute Unix socket path nor a named pipe path.
    #[error("the Runtime Host endpoint {0:?} is neither a Unix socket path nor a named pipe")]
    Unrecognized(String),
    /// A valid endpoint of a kind this platform cannot open, such as a Unix
    /// socket path on Windows.
    #[error("the Runtime Host endpoint {0:?} cannot be opened on this platform")]
    Unsupported(String),
}

impl LocalEndpoint {
    /// Classifies the `endpoint` of a registration.
    ///
    /// A named pipe path must start with `\\.\pipe\` or `\\?\pipe\` (the
    /// word `pipe` in any case, as Windows compares object names without
    /// case), and the name after it must be non-empty, without a backslash
    /// or NUL, and short enough that the whole path fits in 256 UTF-16
    /// units. A Unix socket path must be absolute.
    pub fn parse(endpoint: &str) -> Result<Self, EndpointError> {
        if let Some(name) = local_pipe_name(endpoint) {
            let valid = !name.is_empty()
                && !name.contains(['\\', '\0'])
                && endpoint.encode_utf16().count() <= MAX_PIPE_PATH_UNITS;
            return if valid {
                Ok(Self::NamedPipe(endpoint.to_owned()))
            } else {
                Err(EndpointError::InvalidPipeName(endpoint.to_owned()))
            };
        }
        if is_remote_pipe(endpoint) {
            return Err(EndpointError::NotLocal(endpoint.to_owned()));
        }
        if endpoint.starts_with('/') && !endpoint.contains('\0') {
            return Ok(Self::UnixSocket(PathBuf::from(endpoint)));
        }
        Err(EndpointError::Unrecognized(endpoint.to_owned()))
    }
}

/// The pipe name after a local pipe prefix, compared without case.
fn local_pipe_name(endpoint: &str) -> Option<&str> {
    LOCAL_PIPE_PREFIXES.iter().find_map(|prefix| strip_prefix_ignore_case(endpoint, prefix))
}

/// Whether `endpoint` is `\\<server>\pipe\…` for a server other than this
/// machine.
fn is_remote_pipe(endpoint: &str) -> bool {
    let Some((server, rest)) = endpoint.strip_prefix(r"\\").and_then(|rest| rest.split_once('\\'))
    else {
        return false;
    };
    !matches!(server, "." | "?") && strip_prefix_ignore_case(rest, r"pipe\").is_some()
}

fn strip_prefix_ignore_case<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix).then(|| &text[prefix.len()..])
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT_ID: &str = "67d440f2c07d4cf4e9f56a52aa2bf8e435c71602ddda6244987e201de0c4fb8d";
    const HOST_EPOCH: &str = "9c0a3a5e-1f5d-4b8e-9d3c-0e6f7a1bb912";

    /// The path `prepareRuntimeHostEndpoint` builds on Windows.
    fn host_pipe_path() -> String {
        format!(r"\\.\pipe\maka-runtime-host-{}-{HOST_EPOCH}", &ROOT_ID[..16])
    }

    #[test]
    fn the_hosts_windows_endpoint_is_a_local_named_pipe() {
        let path = host_pipe_path();
        assert_eq!(LocalEndpoint::parse(&path), Ok(LocalEndpoint::NamedPipe(path.clone())));
    }

    #[test]
    fn the_verbatim_prefix_and_any_case_of_pipe_are_local_too() {
        for path in [r"\\?\pipe\maka", r"\\.\PIPE\maka", r"\\?\Pipe\maka"] {
            assert_eq!(
                LocalEndpoint::parse(path),
                Ok(LocalEndpoint::NamedPipe(path.to_owned())),
                "{path}"
            );
        }
    }

    #[test]
    fn the_hosts_unix_endpoint_is_a_socket_path() {
        let path = "/var/folders/xy/T/m-501-Z9RA8sB9TPTp-1a2b-AbC123/h.sock";
        assert_eq!(LocalEndpoint::parse(path), Ok(LocalEndpoint::UnixSocket(PathBuf::from(path))));
    }

    #[test]
    fn a_pipe_on_another_machine_is_refused() {
        for path in [r"\\server\pipe\maka-runtime-host-x", r"\\192.168.1.2\PIPE\x"] {
            assert_eq!(
                LocalEndpoint::parse(path),
                Err(EndpointError::NotLocal(path.to_owned())),
                "{path}"
            );
        }
    }

    #[test]
    fn invalid_pipe_names_are_refused() {
        let too_long = format!(r"\\.\pipe\{}", "a".repeat(MAX_PIPE_PATH_UNITS));
        let longest = format!(r"\\.\pipe\{}", "a".repeat(MAX_PIPE_PATH_UNITS - 9));
        for path in [r"\\.\pipe\", r"\\.\pipe\a\b", "\\\\.\\pipe\\a\0b", too_long.as_str()] {
            assert_eq!(
                LocalEndpoint::parse(path),
                Err(EndpointError::InvalidPipeName(path.to_owned())),
                "{path:.40}"
            );
        }
        assert_eq!(longest.encode_utf16().count(), MAX_PIPE_PATH_UNITS);
        assert_eq!(LocalEndpoint::parse(&longest), Ok(LocalEndpoint::NamedPipe(longest.clone())));
    }

    #[test]
    fn anything_else_is_unrecognized() {
        for path in [
            "",
            "h.sock",
            "./h.sock",
            r"C:\maka\h.sock",
            "pipe\\x",
            "/tmp/a\0b",
            r"\\.\C:\maka",
            r"\\server\share\h.sock",
        ] {
            assert_eq!(
                LocalEndpoint::parse(path),
                Err(EndpointError::Unrecognized(path.to_owned())),
                "{path:?}"
            );
        }
    }

    #[test]
    fn a_multibyte_character_across_the_prefix_does_not_panic() {
        // The prefix length falls inside the two bytes of the last character.
        let path = "\\\\.\\pipe\u{e9}x";
        assert_eq!(LocalEndpoint::parse(path), Err(EndpointError::Unrecognized(path.to_owned())));
    }
}

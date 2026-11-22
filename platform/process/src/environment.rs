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

use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
};

/// These variables can load code or write loader diagnostics before the
/// isolation wrapper has installed its policy. Set them in the target command
/// (for example through `env`) only after the wrapper has entered the sandbox.
pub(super) fn controls_loader(name: &OsStr) -> bool {
    let bytes = name.as_encoded_bytes();
    bytes.starts_with(b"LD_")
        || bytes.starts_with(b"DYLD_")
        || matches!(
            bytes,
            b"GCONV_PATH" | b"LOCPATH" | b"NLSPATH" | b"MALLOC_TRACE" | b"GLIBC_TUNABLES"
        )
}

/// Inherit developer tooling configuration without implicitly handing model
/// commands the Host's credentials or launch-control context. Explicit env()
/// overrides remain possible after the caller authorizes that disclosure.
pub(super) fn inherit(
    vars: impl IntoIterator<Item = (OsString, OsString)>,
) -> BTreeMap<OsString, OsString> {
    vars.into_iter()
        .filter(|(name, _)| {
            if controls_loader(name) {
                return false;
            }
            let Some(name) = name.to_str() else {
                return false;
            };
            let upper = name.to_ascii_uppercase();
            !["KEY", "SECRET", "TOKEN", "PASSWORD", "CREDENTIAL"]
                .iter()
                .any(|part| upper.contains(part))
                && !upper.starts_with("MAKA_RUNTIME_HOST_")
                && !matches!(
                    upper.as_str(),
                    "MAKA_CODEX_AUTH_FILE"
                        | "OPENAI_IDENTITY_TOKEN_FILE"
                        | "OPENAI_WORKLOAD_IDENTITY_CONTEXT"
                        | "OPENAI_FEDERATION_RULE_ID"
                        | "SSH_AUTH_SOCK"
                        | "SSH_AGENT_PID"
                )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inherited_environment_preserves_toolchains_but_not_implicit_credentials() {
        let vars = [
            ("PATH", "/usr/bin"),
            ("SDKROOT", "/sdk"),
            ("CARGO_HOME", "/cargo"),
            ("SystemRoot", r"C:\Windows"),
            ("HttpS_Proxy", "http://proxy:8080"),
            ("OPENROUTER_API_KEY", "key"),
            ("api_ToKeN", "token"),
            ("MAKA_RUNTIME_HOST_LAUNCH_OWNER_LEASE_FD", "7"),
            ("SSH_AUTH_SOCK", "/agent.sock"),
            ("Database_Password", "password"),
            ("OPENAI_WORKLOAD_IDENTITY_CONTEXT", "context"),
            ("LD_PRELOAD", "/workspace/library.so"),
            ("LD_DEBUG_OUTPUT", "/outside/loader-log"),
            ("DYLD_INSERT_LIBRARIES", "/workspace/library.dylib"),
            ("GCONV_PATH", "/workspace/converters"),
        ];
        let filtered = inherit(vars.map(|(k, v)| (k.into(), v.into())));
        assert_eq!(filtered.len(), 5);
        for (name, value) in &vars[..5] {
            assert_eq!(
                filtered.get(&OsString::from(name)),
                Some(&OsString::from(value))
            );
        }
    }
}

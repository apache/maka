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

//! Installation-selected desktop and browser connections for Computer Use.
//! Runtime calls and Session ownership belong to the ordinary workspace service.

use serde::{Deserialize, Serialize};

/// Selects the Host's local desktop or its Windows host when running in WSL.
/// Executables and transport addresses are exclusively Host configuration.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum Desktop {
    #[default]
    Auto,
    Local,
    Windows,
}

/// An explicitly configured browser provider. The REPL cannot supply endpoints,
/// restart a browser, switch profiles or enable remote debugging by itself.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BrowserConnection {
    pub id: String,
    pub endpoint: String,
}

#[cfg(test)]
mod browser_subject_tests {
    use maka_plugin_core::computer::BrowserLeaseSubject;
    use serde_json::json;

    #[test]
    fn browser_subject_wire_preserves_the_closed_domain() {
        for (subject, wire) in [
            (
                BrowserLeaseSubject::PhysicalClaim {
                    claim_id: "claim-a".into(),
                },
                json!({"kind":"physical_claim","claimId":"claim-a"}),
            ),
            (
                BrowserLeaseSubject::FixedSession {
                    scope_id: "scope-a".into(),
                },
                json!({"kind":"fixed_session","scopeId":"scope-a"}),
            ),
        ] {
            assert_eq!(serde_json::to_value(&subject).unwrap(), wire);
            assert_eq!(
                serde_json::from_value::<BrowserLeaseSubject>(wire).unwrap(),
                subject
            );
        }
    }

    #[test]
    fn browser_subject_rejects_missing_mixed_and_untyped_tokens() {
        for wire in [
            json!({"kind":"physical_claim","scopeId":"scope-a"}),
            json!({"kind":"fixed_session","claimId":"claim-a"}),
            json!({"kind":"fixed_session","scopeId":"scope-a","claimId":"claim-a"}),
            json!({"claimId":"claim-a"}),
            json!("scope-a"),
        ] {
            assert!(
                serde_json::from_value::<BrowserLeaseSubject>(wire.clone()).is_err(),
                "wire={wire}"
            );
        }
    }
}

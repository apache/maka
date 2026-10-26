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

use serde::Serialize;
use serde_json::ser::Formatter;
use std::io;

/// Serialize validated typed interaction records with compact ECMAScript numbers.
/// Record equality is semantic; object key order is not a canonical byte contract.
pub fn stringify(value: &impl Serialize) -> Result<String, serde_json::Error> {
    struct JsFormatter;
    impl Formatter for JsFormatter {
        fn write_f64<W: ?Sized + io::Write>(
            &mut self,
            writer: &mut W,
            value: f64,
        ) -> io::Result<()> {
            writer.write_all(ryu_js::Buffer::new().format(value).as_bytes())
        }
        fn write_u64<W: ?Sized + io::Write>(
            &mut self,
            writer: &mut W,
            value: u64,
        ) -> io::Result<()> {
            self.write_f64(writer, value as f64)
        }
        fn write_i64<W: ?Sized + io::Write>(
            &mut self,
            writer: &mut W,
            value: i64,
        ) -> io::Result<()> {
            self.write_f64(writer, value as f64)
        }
    }
    let mut bytes = Vec::new();
    // Value's arbitrary-precision numbers bypass the typed formatter callbacks.
    value.serialize(&mut serde_json::Serializer::with_formatter(
        &mut bytes,
        JsFormatter,
    ))?;
    Ok(String::from_utf8(bytes).expect("JSON serialization emits UTF-8"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        capability::{FormField, FormFieldSpec, FormRequester, FormResult, FormValue},
        interaction::{
            GrantCapability, GrantScope, GrantTarget, InteractionAnswer, InteractionOutcome,
            InteractionRecord, InteractionRequest, MAX_SAFE_INTEGER, SessionGrant,
        },
        workspace::{BindingStamp, PermissionBasis},
    };
    use serde::Deserialize;
    use serde_json::value::RawValue;
    use std::collections::BTreeMap;

    #[test]
    fn typed_forms_preserve_values_and_ecmascript_number_spellings() {
        let numbers = [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (1.5, "1.5"),
            (1e-7, "1e-7"),
            (1e-6, "0.000001"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
        ];
        let fields = numbers
            .iter()
            .enumerate()
            .map(|(index, (number, _))| FormField {
                name: format!("n{index}"),
                label: format!("Number {index}"),
                required: true,
                description: None,
                spec: FormFieldSpec::Number {
                    default: Some(*number),
                    minimum: None,
                    maximum: None,
                },
            })
            .collect();
        let result = FormResult::Accept {
            values: numbers
                .iter()
                .enumerate()
                .map(|(index, (number, _))| (format!("n{index}"), FormValue::Number(*number)))
                .collect(),
        };
        assert_eq!(
            serde_json::from_str::<FormResult>(&stringify(&result).unwrap()).unwrap(),
            result
        );
        let answer = InteractionAnswer::Form { result };
        let outcome = answer.clone().into_outcome(MAX_SAFE_INTEGER);
        let wire = stringify(&outcome).unwrap();
        #[derive(Deserialize)]
        struct Encoded {
            values: BTreeMap<String, Box<RawValue>>,
        }
        let encoded: Encoded = serde_json::from_str(&wire).unwrap();
        assert_eq!(encoded.values.len(), numbers.len());
        for (index, (_, expected)) in numbers.iter().enumerate() {
            assert_eq!(encoded.values[&format!("n{index}")].get(), *expected);
        }
        let decoded: InteractionOutcome = serde_json::from_str(&wire).unwrap();
        assert_eq!(decoded, outcome);
        assert!(answer.matches_outcome(&decoded));
        let record = InteractionRecord {
            session_id: "session".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            request_id: "form".into(),
            created_at: MAX_SAFE_INTEGER,
            request: InteractionRequest::Form {
                tool_use_id: "tool".into(),
                message: "Complete form response: 中文\n\"quoted\"".into(),
                requester: FormRequester {
                    name: "Tool".into(),
                    source: None,
                },
                fields,
            },
            outcome: Some(outcome),
        };
        record.validate().unwrap();
        assert_eq!(
            serde_json::from_str::<InteractionRecord>(&stringify(&record).unwrap()).unwrap(),
            record
        );
    }

    #[test]
    fn typed_grants_preserve_nested_authority_and_safe_integer_boundaries() {
        let grant = SessionGrant {
            session_id: "session".into(),
            target: GrantTarget {
                provider_id: "provider".into(),
                contract_id: "contract".into(),
                server_id: "server".into(),
                tool_name: "tool".into(),
                capability: GrantCapability::Browser,
                scope: GrantScope::BrowserOrigin {
                    origin: "https://example.com".into(),
                },
            },
            granted_at: MAX_SAFE_INTEGER,
            basis: Some(PermissionBasis {
                boundary_revision: MAX_SAFE_INTEGER,
                binding: BindingStamp {
                    id: uuid::Uuid::from_u128(1),
                    permission_epoch: MAX_SAFE_INTEGER,
                },
            }),
        };
        grant.validate().unwrap();
        assert_eq!(
            serde_json::from_str::<SessionGrant>(&stringify(&grant).unwrap()).unwrap(),
            grant
        );
    }
}

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

use maka_agent_api::contract::{ImportsRead, ProjectChange, WorkRead};
use maka_plugin_core::contract::Interface;
use serde_json::json;

#[test]
fn complete_agent_selectors_validate_and_deserialize_without_losing_original_values() {
    let Interface::Service { methods } = maka_agent_api::contract().interface else {
        panic!("Agent exposes a service contract");
    };
    let work = json!({
        "sessionId": "session".repeat(24),
        "target": {"kind":"run", "runId":"00000000-0000-0000-0000-000000000001"},
        "cursor":{"runId":"00000000-0000-0000-0000-000000000001", "offset":0}
    });
    let imported = json!({
        "kind":"preview", "source":{"id":"00000000-0000-0000-0000-000000000001","revision":1},
        "entry":{"sessionId":"original".repeat(129),"path":format!("{}.jsonl", "catalogue/".repeat(456))},
        "digest":null, "after":0
    });
    let renamed = json!({
        "kind":"rename", "project":{"id":"00000000-0000-0000-0000-000000000001","revision":"a".repeat(64)},
        "name":format!("Research 项目{}", "完整".repeat(9000))
    });
    let failures: Vec<_> = [
        ("work", &work),
        ("imports", &imported),
        ("project", &renamed),
    ]
    .into_iter()
    .flat_map(|(name, input)| {
        let validator = jsonschema::validator_for(&methods[name].input).unwrap();
        validator
            .iter_errors(input)
            .map(|error| {
                format!(
                    "{name}: {} at {}",
                    error.instance_path(),
                    error.schema_path()
                )
            })
            .collect::<Vec<_>>()
    })
    .collect();
    assert!(failures.is_empty(), "{}", failures.join("; "));
    let work: WorkRead = serde_json::from_value(work).unwrap();
    assert_eq!(work.session_id, "session".repeat(24));
    assert_eq!(
        work.cursor.unwrap().run_id.to_string(),
        "00000000-0000-0000-0000-000000000001"
    );
    assert_eq!(
        serde_json::to_value(work.target).unwrap(),
        json!({"kind":"run", "runId":"00000000-0000-0000-0000-000000000001"})
    );
    let imported: ImportsRead = serde_json::from_value(imported).unwrap();
    let ImportsRead::Preview { entry, .. } = imported else {
        panic!("original preview selector retained")
    };
    assert_eq!(entry.session_id, "original".repeat(129));
    assert_eq!(entry.path, format!("{}.jsonl", "catalogue/".repeat(456)));
    let renamed: ProjectChange = serde_json::from_value(renamed).unwrap();
    let ProjectChange::Rename { name, .. } = renamed else {
        panic!("original rename retained")
    };
    assert_eq!(name, format!("Research 项目{}", "完整".repeat(9000)));
}

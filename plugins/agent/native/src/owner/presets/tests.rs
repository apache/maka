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

use super::*;

#[test]
fn preset_storage_isolates_agent_scopes_and_checks_versions_at_commit() {
    let connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch(include_str!(
            "../../../../state/migrations/0038_subagent_presets.sql"
        ))
        .unwrap();
    let original = Preset {
        id: PresetId(Uuid::new_v4()),
        revision: PresetRevision(1),
        name: "Reviewer".into(),
        description: "Reviews changes".into(),
        instruction: String::new(),
        model: ModelSelection {
            connection_id: "connection".into(),
            model_id: "model".into(),
        },
        thinking_level: None,
        enabled: true,
    };
    for scope in ["host-a/agent-a", "host-a/agent-b", "host-b/agent-a"] {
        assert!(matches!(
            Write {
                scope: scope.into(),
                change: Change::Create(original.clone())
            }
            .execute(&connection)
            .unwrap()
            .value,
            PresetResult::Saved { .. }
        ));
    }
    let fence = CreationFence {
        scope: "host-a/agent-a".into(),
        id: original.id.clone(),
        revision: original.revision,
    };
    assert!(fence.check(&connection).unwrap().is_none());
    let mut updated = original.clone();
    updated.revision = PresetRevision(2);
    updated.name = "Renamed".into();
    assert!(matches!(
        Write {
            scope: "host-a/agent-a".into(),
            change: Change::Update(updated.clone(), original.revision)
        }
        .execute(&connection)
        .unwrap()
        .value,
        PresetResult::Saved { .. }
    ));
    assert!(matches!(
        Write {
            scope: "host-a/agent-a".into(),
            change: Change::Update(updated, original.revision)
        }
        .execute(&connection)
        .unwrap()
        .value,
        PresetResult::Conflict {
            actual: PresetRevision(2)
        }
    ));
    assert!(matches!(
        fence.check(&connection).unwrap(),
        Some(Rejection::PresetConflict)
    ));
    assert_eq!(
        read(&connection, "host-b/agent-a", &original.id).unwrap(),
        Some(original.clone())
    );
    assert_eq!(
        read(&connection, "host-a/agent-b", &original.id).unwrap(),
        Some(original)
    );
}

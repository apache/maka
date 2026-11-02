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

use maka_agent_facts::workspace::{BindingStamp, PermissionBasis};
use maka_event_log::EventLog;
use serde_json::json;

pub async fn create(log: &EventLog, session: &str, cwd: &str) -> PermissionBasis {
    let binding = log
        .attach_workspace("shell-fixture", &json!({"path":cwd}))
        .await
        .unwrap();
    log.create_session(
        session,
        &format!("create-{session}"),
        &json!({"workspace":binding,"boundary_revision":0}),
        1,
    )
    .await
    .unwrap();
    PermissionBasis {
        boundary_revision: 0,
        binding: BindingStamp {
            id: binding.id,
            permission_epoch: binding.permission_epoch_at_attach,
        },
    }
}

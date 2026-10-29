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

fn instances_schema(request: &support::ModelRequest) -> &Value {
    assert_eq!(
        request.tool_schema_error, None,
        "{:?}",
        request.tool_schema_error
    );
    &request.body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["function"]["name"] == "PluginInstances")
        .expect("the actual installation must expose PluginInstances")["function"]["parameters"]
}

fn last_tool_result(request: &support::ModelRequest) -> &str {
    request.body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["role"] == "tool")
        .expect("the actual Host tool result must reach the provider")["content"]
        .as_str()
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn default_management_tool_schemas_complete_through_strict_compatible_http() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let mut fixture = Fixture::management_tools().await;
        let client = fixture.client().await;
        let start = json!({"kind":"start"});
        let expected_start = client
            .query("management", "instances", start.clone())
            .await
            .unwrap();
        assert!(
            expected_start["instances"]
                .as_array()
                .unwrap()
                .iter()
                .any(|instance| instance["path"] == json!(["management"]))
        );
        assert!(
            !expected_start["next"].is_null(),
            "the real deployment must span pages"
        );
        let continuation = json!({
            "kind":"continue",
            "source":expected_start["source"],
            "after":expected_start["next"],
        });
        let expected_continuation = client
            .query("management", "instances", continuation.clone())
            .await
            .unwrap();
        assert!(
            expected_continuation["instances"]
                .as_array()
                .unwrap()
                .iter()
                .any(|instance| instance["path"] == json!(["workbench-ui"]))
        );

        let sent = support::mutate(
            &client,
            "send",
            json!({
                "sessionId":fixture.session,
                "message":"Inspect this deployment and continue its original instance listing.",
                "model":fixture.selection,
            }),
        )
        .await;
        assert_eq!(sent["kind"], "started");
        let request = fixture.next_request().await;
        evidence(
            "management-provider-request",
            &serde_json::to_string_pretty(&request.body).unwrap(),
        );
        let validator = maka_plugin_core::validator(instances_schema(&request)).unwrap();
        let start = json!({"request":start});
        assert!(validator.is_valid(&start));
        request.tool("PluginInstances", start).await;

        let request = fixture.next_request().await;
        instances_schema(&request);
        let result: Value = serde_json::from_str(last_tool_result(&request)).unwrap();
        assert_eq!(result, expected_start);
        let continuation = json!({"request":continuation});
        assert!(validator.is_valid(&continuation));
        request.tool("PluginInstances", continuation).await;

        let request = fixture.next_request().await;
        instances_schema(&request);
        let result: Value = serde_json::from_str(last_tool_result(&request)).unwrap();
        assert_eq!(result, expected_continuation);
        let invalid = json!({"request":{"kind":"continue","source":false,"after":null}});
        assert!(!validator.is_valid(&invalid));
        request.tool("PluginInstances", invalid).await;

        let request = fixture.next_request().await;
        instances_schema(&request);
        assert_eq!(
            last_tool_result(&request),
            "invalid tool input: arguments do not match the declared schema",
        );
        request.finish().await;
        fixture.idle(&client, &fixture.session).await;
        client.close().await.unwrap();
        fixture.finish().await;
    })
    .await
    .expect("the actual management catalog must complete through strict HTTP");
}

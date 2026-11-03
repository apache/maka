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
use maka_agent_facts::configuration::policy::{ShellPolicy, ShellPreference};

#[tokio::test]
async fn git_bash_command_keeps_model_visible_choice_after_host_preference_changes() {
    let bash = std::env::var_os("MAKA_TEST_GIT_BASH")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::PathBuf::from(std::env::var_os("ProgramFiles").unwrap())
                .join(r"Git\bin\bash.exe")
        });
    assert!(bash.is_file(), "Git Bash is required: {}", bash.display());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let f = Fixture::with_services(
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        None,
        None,
        Some(service_tools::Setup::processes()),
    )
    .await;
    let session = f.create("Captured shell selection").await;
    files::change(&f, &session, "danger_full_access", false, true).await;
    let policy = f.config.runtime_policy().await.unwrap();
    f.config
        .set_shell(
            policy.revision,
            ShellPolicy {
                preference: ShellPreference::GitBash,
                executable: bash.to_string_lossy().into(),
                titles: true,
            },
        )
        .await
        .unwrap();
    f.send(&session).await.unwrap();
    let (mut socket, _) = listener.accept().await.unwrap();
    let sent = request(&mut socket).await;
    let execute = sent["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["function"]["name"] == "Execute")
        .unwrap();
    assert!(
        execute["function"]["parameters"]["properties"]["command"]["description"]
            .as_str()
            .unwrap()
            .contains("write Bash syntax")
    );
    assert!(
        execute["function"]["parameters"]["properties"]
            .get("shell")
            .is_none()
    );
    let policy = f.config.runtime_policy().await.unwrap();
    f.config
        .set_shell(
            policy.revision,
            ShellPolicy {
                preference: ShellPreference::Auto,
                executable: String::new(),
                titles: true,
            },
        )
        .await
        .unwrap();
    service_tools::named_tool_response(
        &mut socket,
        "Execute",
        json!({"command":"[[ -n \"$BASH_VERSION\" ]] && printf captured-git-bash", "login":false}),
    )
    .await;
    let (mut socket, _) = listener.accept().await.unwrap();
    let sent = request(&mut socket).await;
    let tool = sent["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["role"] == "tool")
        .unwrap();
    let result: Value = serde_json::from_str(tool["content"].as_str().unwrap()).unwrap();
    assert_eq!(
        result["value"]["output"]["stdout"], "captured-git-bash",
        "{result}"
    );
    response(&mut socket).await;
    f.drained().await;
    f.app.shutdown().await.unwrap();
    f.config.shutdown().await.unwrap();
}

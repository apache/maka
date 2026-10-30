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

fn system_texts(request: &Value) -> impl Iterator<Item = &str> {
    request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "system")
        .map(|message| message["content"].as_str().unwrap())
}

fn context_payload<'a>(texts: impl IntoIterator<Item = &'a str>) -> Value {
    let mut contexts = Vec::new();
    for text in texts {
        for (offset, _) in text
            .char_indices()
            .filter(|(_, character)| *character == '{')
        {
            if let Some(Ok(value)) = serde_json::Deserializer::from_str(&text[offset..])
                .into_iter::<Value>()
                .next()
                && value.get("cwd").is_some()
                && value.get("sessionId").is_some()
            {
                contexts.push(value);
            }
        }
    }
    assert_eq!(
        contexts.len(),
        1,
        "one unambiguous session context payload: {contexts:?}"
    );
    contexts.pop().unwrap()
}

pub(super) fn assert_current_context(request: &Value, session: &Value) {
    let context = context_payload(system_texts(request));
    assert_eq!(context["cwd"], session["workspace"]["path"]);
    assert_eq!(context["sessionId"], session["id"]);
}

pub(super) async fn composition(
    fixture: &Fixture,
    session: &str,
) -> maka_agent_facts::composition::RequestComposition {
    let prefix = fixture
        .session(session)
        .await
        .scoped_prefix(
            maka_agent_facts::event::LogScope::Session { id: session.into() },
            128,
            1024 * 1024,
        )
        .await
        .unwrap();
    let requested = prefix
        .events
        .iter()
        .rev()
        .find(|row| {
            matches!(
                row.event.fact,
                maka_agent_facts::event::Fact::ModelRequested { .. }
            )
        })
        .expect("actual model dispatch must retain ModelRequested");
    fixture
        .session(session)
        .await
        .request_composition(session, &requested.event.id)
        .await
        .unwrap()
        .unwrap()
}

pub(super) fn assert_frozen_context(
    request: &Value,
    frozen: &maka_agent_facts::composition::RequestComposition,
) {
    assert_eq!(
        context_payload(system_texts(request)),
        context_payload(frozen.dynamic_context.iter().map(String::as_str)),
        "durable dynamic context must match the actual outgoing context payload",
    );
}

#[tokio::test]
async fn no_agents_file_still_exposes_each_selected_workspace_and_current_session() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::new(&format!("http://{}/v1", listener.local_addr().unwrap()), None).await;
        #[cfg(not(windows))]
        let child_name = "资料\"selected";
        #[cfg(windows)]
        let child_name = "资料 selected";
        let child_path = fixture.workspace.join(child_name);
        std::fs::create_dir(&child_path).unwrap();
        let roots = fixture.query("directories", json!({"kind":"roots"})).await.unwrap();
        let children = fixture.query("directories", json!({"kind":"children", "selection":roots["roots"][0]["selection"], "after":null})).await.unwrap();
        let child = children["children"].as_array().unwrap().iter().find(|entry| entry["path"] == child_path.to_str().unwrap()).unwrap();
        let mut captured = Vec::new();
        for (title, selection) in [
            ("Quoted Unicode workspace", child["selection"].clone()),
            ("Independent workspace", roots["roots"][1]["selection"].clone()),
        ] {
            let created = fixture.mutation(2, "create", json!({"title":title,"labels":[],"workspace":{"kind":"directory","selection":selection}}), Uuid::new_v4()).await.unwrap();
            let session = created["session"].clone();
            let id = session["id"].as_str().unwrap();
            fixture.send(id).await.unwrap();
            let (mut socket, _) = listener.accept().await.unwrap();
            let outgoing = request(&mut socket).await;
            response(&mut socket).await;
            fixture.drained().await;
            let frozen = composition(&fixture, id).await;
            captured.push((session, outgoing, frozen));
        }
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();

        assert!(!child_path.join("AGENTS.md").exists());
        assert_eq!(captured[0].0["workspace"]["path"], child_path.to_str().unwrap());
        assert_ne!(captured[0].0["id"], captured[1].0["id"]);
        assert_ne!(captured[0].0["workspace"]["path"], captured[1].0["workspace"]["path"]);
        for (session, outgoing, frozen) in captured {
            assert_current_context(&outgoing, &session);
            assert_frozen_context(&outgoing, &frozen);
        }
    }).await.unwrap();
}

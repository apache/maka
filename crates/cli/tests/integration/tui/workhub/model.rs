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
use std::sync::{Arc, Mutex};
use tokio::io::AsyncWriteExt;

pub(super) struct Provider {
    pub url: String,
    pub executed: Arc<Mutex<Vec<String>>>,
    pub delegated: Arc<Mutex<Vec<String>>>,
    pub task: tokio::task::JoinHandle<()>,
}
impl Provider {
    pub async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let executed = Arc::new(Mutex::new(Vec::<String>::new()));
        let delegated = Arc::new(Mutex::new(Vec::<String>::new()));
        let runs = executed.clone();
        let routes = delegated.clone();
        let task = tokio::spawn(async move {
            // Anonymous connection verification and final model discovery.
            for _ in 0..2 {
                let (mut stream, headers) = support::model_list_request(&listener).await;
                assert!(!headers.to_ascii_lowercase().contains("authorization:"));
                let body = models().to_string();
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
            loop {
                let (mut stream, body, _) = model_http_request(&listener).await;
                let chunk = response(&body, &runs, &routes);
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {chunk}\n\ndata: [DONE]\n\n").as_bytes()).await.unwrap();
            }
        });
        Self {
            url,
            executed,
            delegated,
            task,
        }
    }
}

pub(super) fn models() -> Value {
    json!({"data":[{"id":"fixture-model","context_window":128000},{"id":"worker-model","context_window":128000}]})
}

pub(super) fn response(
    body: &Value,
    runs: &Mutex<Vec<String>>,
    routes: &Mutex<Vec<String>>,
) -> Value {
    let coordinator = body["tools"].as_array().is_some_and(|tools| {
        tools
            .iter()
            .any(|tool| tool["function"]["name"] == "workhub_tasks")
    });
    // Host context (for example the skills catalog) may follow the
    // actual input as another user-role message. Match the latest
    // exact fixture input, rather than assuming the final user-role
    // message is the user's request or searching system/tool text.
    let task = body["messages"]
    .as_array()
    .unwrap()
    .iter()
    .rev()
    .filter(|message| message["role"] == "user")
    .find_map(|message| {
        let text = message["content"].as_str()?;
        ["alpha", "beta"].into_iter().find(|task| {
            if coordinator {
                text == format!("Delegate {task}")
            } else {
                text == format!("Original user request:\nDelegate {task}\n\nDelegation instructions:\nRun {task} once")
            }
        })
    });
    let choice = if coordinator {
        let fresh = task.filter(|task| {
            !routes
                .lock()
                .unwrap()
                .iter()
                .any(|sent| sent.as_str() == *task)
        });
        if let Some(task) = fresh {
            routes.lock().unwrap().push(task.into());
            let input = json!({"operation":"route","target":{"kind":"create","title":format!("Task {task}")},"text":format!("Run {task} once")});
            json!({"index":0,"delta":{"tool_calls":[{"index":0,"id":format!("delegate-{task}"),"type":"function","function":{"name":"workhub_tasks","arguments":input.to_string()}}]},"finish_reason":"tool_calls"})
        } else {
            json!({"index":0,"delta":{"content":"Coordinator checked the task"},"finish_reason":"stop"})
        }
    } else {
        let task = task.unwrap_or_else(|| panic!("unexpected worker request: {body}"));
        runs.lock().unwrap().push(task.into());
        let expected = if task == "alpha" {
            "worker-model"
        } else {
            "fixture-model"
        };
        assert_eq!(body["model"], expected);
        json!({"index":0,"delta":{"content":format!("Result {task} complete")},"finish_reason":"stop"})
    };
    json!({"id":"workhub-fixture","object":"chat.completion.chunk","model":body["model"],"choices":[choice],"usage":{"prompt_tokens":20,"completion_tokens":8,"total_tokens":28}})
}

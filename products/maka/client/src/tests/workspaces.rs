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

#[tokio::test]
async fn recent_workspaces_survive_reopen_without_evicting_older_selections() {
    let fixture = Fixture::new().await;
    let first = fixture.client().await;
    let second = fixture.client().await;
    for number in 0..10 {
        let client = if number % 2 == 0 { &first } else { &second };
        client
            .set_recent_workspace(
                format!("/project/{number}"),
                Some(json!({"directory":number})),
            )
            .await
            .unwrap();
    }
    first.close().await.unwrap();
    second.close().await.unwrap();
    let client = fixture.client().await;
    let recent = client.recent_workspaces().await.unwrap();
    assert_eq!(
        recent
            .iter()
            .map(|item| item.path.as_str())
            .collect::<Vec<_>>(),
        (0..10)
            .rev()
            .map(|number| format!("/project/{number}"))
            .collect::<Vec<_>>()
    );
    let recent = client
        .set_recent_workspace(
            "/project/3".into(),
            Some(json!({"directory":"new identity"})),
        )
        .await
        .unwrap();
    assert_eq!(recent.len(), 10);
    assert_eq!(recent[0].path, "/project/3");
    assert_eq!(recent[0].workspace, json!({"directory":"new identity"}));
    assert_eq!(
        recent
            .iter()
            .filter(|item| item.path == "/project/3")
            .count(),
        1
    );
    client.close().await.unwrap();
    let client = fixture.client().await;
    client
        .set_recent_workspace("/project/3".into(), None)
        .await
        .unwrap();
    client.close().await.unwrap();
    let client = fixture.client().await;
    let recent = client.recent_workspaces().await.unwrap();
    assert_eq!(recent.len(), 9);
    assert_eq!(recent[0].path, "/project/9");
    assert!(!recent.iter().any(|item| item.path == "/project/3"));
    client.close().await.unwrap();
    fixture.finish().await;
}

#[tokio::test]
async fn recent_workspaces_are_scoped_to_the_admitted_host() {
    let first = Fixture::new().await;
    let second = Fixture::new().await;
    let client = first.client().await;
    client
        .set_recent_workspace("/first".into(), Some(json!({"directory":1})))
        .await
        .unwrap();
    let host = HostClient::connect(&second.address, Some(second.host.epoch()))
        .await
        .unwrap();
    let journal = Journal::open(&first.directory.path().join("client.db"))
        .await
        .unwrap();
    let other = Client::new(host, journal, "receipts".into()).unwrap();
    assert!(other.recent_workspaces().await.unwrap().is_empty());
    other
        .set_recent_workspace("/second".into(), Some(json!({"directory":2})))
        .await
        .unwrap();
    assert_eq!(client.recent_workspaces().await.unwrap()[0].path, "/first");
    client.close().await.unwrap();
    other.close().await.unwrap();
    first.finish().await;
    second.finish().await;
}

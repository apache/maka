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
use serde_json::{Value, json};
use sqlx::Connection;

type Metadata = (
    Option<f64>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

async fn metadata(db: &mut sqlx::SqliteConnection, id: &str) -> Metadata {
    sqlx::query_as("SELECT accounting_at,accounting_usage,invocation_model,accounting_tool,event_session FROM event_log WHERE event_id=?")
        .bind(id).fetch_one(db).await.unwrap()
}

fn decoded(value: &Option<String>) -> Option<Value> {
    value
        .as_deref()
        .map(|value| serde_json::from_str(value).unwrap())
}

#[tokio::test]
async fn publication_derives_metadata_once_and_collection_preserves_it() {
    let mut db = sqlx::SqliteConnection::connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(crate::schema::fixture(|kind, _| {
        kind != "trigger"
    })))
    .execute(&mut db)
    .await
    .unwrap();
    let invocation = json!({"session_id":"session","invocation_id":"invocation"});
    let model = json!({"connection_id":"connection","model":"model"});
    let usage = json!({"input_tokens":3,"output_tokens":5});
    let call = json!({"tool_call_id":"call","origin":{"kind":"provider","step_id":"step"}});
    // Each expected value is a publication fact, independent of SQL extraction.
    let cases = [
        (
            "invocation_opened",
            json!({"configuration":{"model":model}}),
            None,
            Some(model.clone()),
            None,
        ),
        ("model_requested", json!({}), Some(1123.456789), None, None),
        (
            "model_completed",
            json!({"output":{"usage":usage}}),
            Some(1123.456789),
            None,
            None,
        ),
        (
            "model_interrupted",
            json!({}),
            Some(1123.456789),
            None,
            None,
        ),
        ("invocation_ended", json!({}), Some(1123.456789), None, None),
        (
            "model_observed",
            json!({"event":{"kind":"finished","data":{"usage":usage}}}),
            None,
            None,
            None,
        ),
        (
            "model_observed",
            json!({"event":{"kind":"part_delta","data":{"text":"delta"}}}),
            None,
            None,
            None,
        ),
        (
            "tool_dispatched",
            json!({"call":call,"name":"exec"}),
            Some(1123.456789),
            None,
            Some(json!({"invocation":invocation,"call":call,"name":"exec","rejection":null})),
        ),
        (
            "tool_rejected",
            json!({"call":call,"name":"exec","reason":{"kind":"invalid_input"}}),
            Some(1123.456789),
            None,
            Some(
                json!({"invocation":invocation,"call":call,"name":"exec","rejection":"invalid_input"}),
            ),
        ),
        (
            "tool_settled",
            json!({"outcome":{"kind":"succeeded"}}),
            Some(1123.456789),
            None,
            Some(json!({"outcome":"succeeded"})),
        ),
    ];
    for (index, (kind, fact, at, expected_model, tool)) in cases.into_iter().enumerate() {
        let id = format!("runtime-{index}");
        let body = json!({"invocation":invocation,"recorded_at":{"secs_since_epoch":1,"nanos_since_epoch":123456789},"fact":fact}).to_string();
        insert(Record {
            sequence: Some(index as i64 + 1),
            event_id: &id,
            invocation_id: Some("invocation"),
            kind,
            operation_id: None,
            json: &body,
        })
        .execute(&mut db)
        .await
        .unwrap();
        let expected_usage = match index {
            2 | 5 => Some(usage.clone()),
            _ => None,
        };
        let before = metadata(&mut db, &id).await;
        match (before.0, at) {
            (Some(actual), Some(expected)) => assert!((actual - expected).abs() < 0.000001),
            (None, None) => {}
            other => panic!("{id}: unexpected publication time {other:?}"),
        }
        assert_eq!(decoded(&before.1), expected_usage, "{id}: usage");
        assert_eq!(decoded(&before.2), expected_model, "{id}: model binding");
        assert_eq!(decoded(&before.3), tool, "{id}: tool identity");
        assert_eq!(before.4.as_deref(), Some("session"), "{id}: owner");
        sqlx::query("UPDATE event_log SET event_json=NULL,retained_json='{}',body_digest='collected' WHERE event_id=?")
            .bind(&id).execute(&mut db).await.unwrap();
        assert_eq!(
            metadata(&mut db, &id).await,
            before,
            "{id}: collection retains publication metadata"
        );
    }
    for (id, kind, body, expected_at, expected_usage) in [
        (
            "aux-start",
            "auxiliary_model_started",
            json!({"started_at":{"secs_since_epoch":2,"nanos_since_epoch":500000000}}),
            Some(2500.0),
            None,
        ),
        (
            "aux-usage",
            "auxiliary_model_usage",
            json!({"usage":usage}),
            None,
            Some(usage.clone()),
        ),
        (
            "aux-end",
            "auxiliary_model_settled",
            json!({"completed_at":{"secs_since_epoch":3,"nanos_since_epoch":250000000}}),
            Some(3250.0),
            None,
        ),
    ] {
        insert(Record {
            sequence: None,
            event_id: id,
            invocation_id: None,
            kind,
            operation_id: None,
            json: &body.to_string(),
        })
        .execute(&mut db)
        .await
        .unwrap();
        let actual = metadata(&mut db, id).await;
        assert_eq!(actual.0, expected_at, "{id}");
        assert_eq!(decoded(&actual.1), expected_usage, "{id}");
        assert_eq!((actual.2, actual.3, actual.4), (None, None, None), "{id}");
    }
    let retained_owners: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM event_log WHERE event_session='session' AND event_json IS NULL",
    )
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(
        retained_owners, 10,
        "collected publications remain addressable by their original owner"
    );
}

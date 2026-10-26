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
use crate::EventLog;
use maka_agent_facts::event::{
    EventWrite, Fact, Invocation, InvocationInput, InvocationOutcome, RuntimeEvent,
};
use sqlx::Connection;

#[tokio::test]
async fn durable_boundaries_match_prefixes_across_reopen_and_reject_unselected_cuts() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let scope = Selection::session("session").scope;
    let mut expected = vec![
        log.scoped_prefix(scope.clone(), 100, 1024 * 1024)
            .await
            .unwrap(),
    ];
    let mut foreign = 0;
    for (session, id, text) in [
        ("session", "large", "漢\0\r\n".repeat(20_000)),
        ("foreign", "excluded", "excluded".into()),
        ("session", "small", "last".into()),
    ] {
        let invocation = Invocation {
            session_id: session.into(),
            turn_id: id.into(),
            run_id: id.into(),
            invocation_id: id.into(),
        };
        let opening = RuntimeEvent::new(
            invocation.clone(),
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    source_messages: Vec::new(),
                    content: text.into(),
                    request_fingerprint: None,
                },
            },
        );
        let sequence = log
            .append(&EventWrite::plain(opening).unwrap())
            .await
            .unwrap();
        if session == "session" {
            expected.push(
                log.scoped_prefix(scope.clone(), 100, 1024 * 1024)
                    .await
                    .unwrap(),
            );
        } else {
            foreign = sequence;
        }
        log.append(
            &EventWrite::plain(RuntimeEvent::new(
                invocation,
                Fact::InvocationEnded {
                    outcome: InvocationOutcome::Completed,
                },
            ))
            .unwrap(),
        )
        .await
        .unwrap();
    }
    expected.push(log.scoped_prefix(scope, 100, 1024 * 1024).await.unwrap());
    let reopened_high = expected.last().unwrap().high_water;
    let reopened_digest = expected.last().unwrap().digest.clone();
    log.connection
        .run(move |connection| {
            Box::pin(async move {
                let mut tx = connection.begin().await?;
                let selection = Selection::session("session");
                let throughs: Vec<_> = expected.iter().map(|prefix| prefix.high_water).collect();
                let actual = digests(&mut tx, &selection, &throughs).await?;
                assert_eq!(
                    actual,
                    expected
                        .iter()
                        .map(|prefix| prefix.digest.clone())
                        .collect::<Vec<_>>()
                );
                let last = *throughs.last().unwrap();
                assert_eq!(
                    digests(&mut tx, &selection, &[last]).await?,
                    [actual.last().unwrap().clone()]
                );
                assert!(
                    matches!(
                        digests(&mut tx, &selection, &[foreign, last]).await,
                        Err(StoreError::InvalidTransition(_))
                    ),
                    "a valid last cut must not hide an unselected intermediate cut"
                );
                assert!(digests(&mut tx, &selection, &[last + 1]).await.is_err());
                tx.rollback().await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    log.connection
        .run(move |connection| {
            Box::pin(async move {
                let source =
                    selected(connection, &Selection::session("session"), reopened_high).await?;
                assert_eq!(source.digest, reopened_digest);
                Ok(())
            })
        })
        .await
        .unwrap();
    log.close().await.unwrap();
}

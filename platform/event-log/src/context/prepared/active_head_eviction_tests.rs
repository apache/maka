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
async fn retained_generation_extends_incrementally_after_head_eviction() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("prepared.sqlite"))
        .await
        .unwrap();
    seed(&log, 1, 1, false).await;
    seed(&log, 3, 3, false).await;
    let values = BTreeMap::from([
        ("1".into(), vec![Message::user("first")]),
        ("3".into(), vec![Message::user("second")]),
        ("4".into(), vec![Message::user("tool result")]),
    ]);
    let build = log
        .prepare_model_view(selection(3), "active", None)
        .await
        .unwrap();
    assert_eq!(render(&log, &build, &values).await, 2);
    let retained = log.finish_prepared(&build).await.unwrap();
    let (wire, encoded) = encode(&log, &retained, WireFormat::Responses, &values).await;
    assert_eq!(encoded, 2);
    let old_bytes = bytes(&log, &wire).await;
    assert_log_refs(&log).await;
    log.prepared_store()
        .unwrap()
        .run(|connection, _in_flight| {
            Box::pin(async move {
                sqlx::query("DELETE FROM context_prepared_heads WHERE session_id='prepared-test'")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    assert_log_refs(&log).await;
    seed(&log, 4, 4, false).await;
    let next = log
        .prepare_model_view(selection(4), "active", Some(&retained))
        .await
        .unwrap();
    assert_eq!(next.previous_revision, 3);
    assert_eq!(render(&log, &next, &values).await, 1);
    let next = log.finish_prepared(&next).await.unwrap();
    let build = log
        .prepare_wire_view(&next, WireFormat::Responses, "fixture-v1", Some(&wire))
        .await
        .unwrap();
    let dirty = log
        .prepared_wire_dirty_groups(&build, None, 8)
        .await
        .unwrap();
    assert_eq!(
        dirty
            .iter()
            .map(|group| group.id.as_str())
            .collect::<Vec<_>>(),
        ["4"]
    );
    for group in dirty {
        log.put_prepared_wire_group(
            &build,
            &group,
            encoded_wire(&values[&group.id], WireFormat::Responses, "ordinary"),
        )
        .await
        .unwrap();
    }
    let next_wire = log.finish_prepared_wire(&build).await.unwrap();
    assert_eq!(bytes(&log, &wire).await, old_bytes);
    assert_eq!(
        log.prepared_wire_prefix_identity(&next_wire, 2)
            .await
            .unwrap(),
        log.prepared_wire_prefix_identity(&wire, 2).await.unwrap()
    );
    let cold = log
        .prepare_model_view(selection(4), "independent-cold-policy", Some(&retained))
        .await
        .unwrap();
    assert_eq!(cold.previous_revision, 0, "incompatible policy rebuilds");
    assert_eq!(render(&log, &cold, &values).await, 3);
    let cold = log.finish_prepared(&cold).await.unwrap();
    let (cold_wire, encoded) = encode(&log, &cold, WireFormat::Responses, &values).await;
    assert_eq!(encoded, 3);
    assert_eq!(bytes(&log, &next_wire).await, bytes(&log, &cold_wire).await);
    assert_log_refs(&log).await;
    log.close().await.unwrap();
}

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
use sqlx::Connection;

#[tokio::test]
async fn payload_migration_preserves_existing_references_and_accepts_large_values() {
    let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    crate::sqlite_functions::register(&mut db).await.unwrap();
    MIGRATIONS.run_to(3, &mut db).await.unwrap();
    sqlx::raw_sql(
        "INSERT INTO event_log(event_id,invocation_id,kind,event_json) VALUES
        ('tool-result','invocation','probe','{}'),('model-request','invocation','probe','{}');
        INSERT INTO tool_result_payloads VALUES('tool-result',X'010203');
        INSERT INTO request_compositions VALUES('surface',X'040506');
        INSERT INTO model_request_compositions VALUES('model-request','surface');",
    )
    .execute(&mut db)
    .await
    .unwrap();
    MIGRATIONS.run(&mut db).await.unwrap();
    let preserved: (Vec<u8>,Vec<u8>) = sqlx::query_as("SELECT t.payload,c.surface
        FROM tool_result_payloads t,request_compositions c JOIN model_request_compositions m USING(digest)
        WHERE t.event_id='tool-result' AND m.event_id='model-request'").fetch_one(&mut db).await.unwrap();
    assert_eq!(preserved, (vec![1, 2, 3], vec![4, 5, 6]));
    sqlx::raw_sql(
        "UPDATE tool_result_payloads SET payload=zeroblob(67108865);
        UPDATE request_compositions SET surface=zeroblob(4194305);",
    )
    .execute(&mut db)
    .await
    .unwrap();
    let sizes: (i64,i64) = sqlx::query_as("SELECT length(t.payload),length(c.surface)
        FROM tool_result_payloads t,request_compositions c JOIN model_request_compositions m USING(digest)
        WHERE t.event_id='tool-result' AND m.event_id='model-request'").fetch_one(&mut db).await.unwrap();
    assert_eq!(sizes, (67_108_865, 4_194_305));
    let foreign_keys: i64 = sqlx::query_scalar("SELECT count(*) FROM pragma_foreign_key_check")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(foreign_keys, 0);
    db.close().await.unwrap();
}

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
use crate::{
    OpenPurpose, ROOT_MIGRATIONS,
    root::{ROOT_DATABASE, RootNamespaces, RootOwner},
};
use std::sync::Arc;

fn package(id: &str, body: &str) -> Package {
    let manifest = format!(
        r#"{{"schemaVersion":1,"id":"{id}","application":{{"host":{{"implementation":{{"kind":"javascript","module":"host.mjs","realm":"shared"}},"configuration":{{"type":"object"}},"imports":{{}},"exports":{{}}}}}}}}"#
    );
    Package::new(BTreeMap::from([
        ("maka.extension.json".into(), manifest.into_bytes()),
        ("host.mjs".into(), body.as_bytes().to_vec()),
    ]))
    .unwrap()
}

async fn count(log: &EventLog, sql: &'static str) -> i64 {
    log.connection
        .read(move |connection| Ok(connection.query_row(sql, [], |row| row.get(0))?))
        .await
        .unwrap()
}

#[tokio::test]
async fn launch_releases_superseded_sources_unless_an_operation_may_recover_them() {
    let directory = tempfile::tempdir().unwrap();
    let base = directory.path();
    let namespaces = RootNamespaces {
        ownership: base.join("owners"),
        control: base.join("control"),
    };
    let owner = Arc::new(RootOwner::create(&base.join("root"), &namespaces).unwrap());
    let log = EventLog::open_owned(
        &owner.canonical_path().join(ROOT_DATABASE),
        Some(owner.clone()),
        OpenPurpose::Execution,
        ROOT_MIGRATIONS,
    )
    .await
    .unwrap();
    let input = || Input {
        base: None,
        instances: BTreeMap::new(),
        ui: None,
    };
    let deployment = Uuid::new_v4();
    let shared = package("example.shared", "export const shared = 1;");
    let mut sources = Vec::new();
    for (expected, body) in [
        "export const v = 1;",
        "export const v = 2;",
        "export const v = 3;",
    ]
    .into_iter()
    .enumerate()
    {
        sources.push(
            log.commit_application(
                deployment,
                expected as u64,
                input(),
                vec![],
                vec![package("example.app", body), shared.clone()],
            )
            .await
            .unwrap(),
        );
    }
    // An intent recorded at revision 1 whose operation never settled.
    let first = sources[0].revision as i64;
    log.connection
        .run(move |connection| {
            connection.execute(
                "INSERT INTO application_intents(deployment,consumer,operation,source_revision,reference_json)
                 VALUES (?,'[]',?,?,'{}')",
                params![deployment.to_string(), Uuid::new_v4().to_string(), first],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let packages = "SELECT count(*) FROM application_packages";
    let files = "SELECT count(*) FROM contents";
    assert_eq!(count(&log, packages).await, 4);
    let contents_before = count(&log, files).await;

    for _ in 0..2 {
        log.release_superseded_application_sources(&sources[2])
            .await
            .unwrap();
    }

    assert!(
        log.load_application_at(&sources[0])
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        log.load_application_at(&sources[1])
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        log.load_application_at(&sources[2])
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(count(&log, packages).await, 3);
    // Revision 2's own host.mjs is gone; its manifest is shared with the others.
    assert_eq!(count(&log, files).await, contents_before - 1);
    assert_eq!(
        count(&log, "SELECT count(*) FROM pragma_foreign_key_check").await,
        0
    );
}

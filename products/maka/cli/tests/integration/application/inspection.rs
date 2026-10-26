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

//! Real command opening regressions: historical schema and original file custody.
use maka_agent_facts::event::{Fact, Invocation, InvocationInput, InvocationOutcome, RuntimeEvent};
use maka_event_log::root::{FileLease, ROOT_DATABASE, RootNamespaces, RootOwner};
use maka_host_runtime::application::host::Configuration;
use maka_packages::Package;
use maka_plugin_core::composition::Input;
use rusqlite::config::DbConfig;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::{Command, Output},
};
use uuid::Uuid;

static MIGRATIONS: sqlx::migrate::Migrator =
    sqlx::migrate!("../../../platform/event-log/migrations");

#[derive(Debug, PartialEq)]
enum Member {
    Directory,
    File(Vec<u8>),
}
type Members = BTreeMap<PathBuf, Member>;

fn members(root: &Path) -> Members {
    fn walk(root: &Path, directory: &Path, output: &mut Members) {
        for entry in std::fs::read_dir(directory).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            let relative = path.strip_prefix(root).unwrap().to_owned();
            let kind = entry.file_type().unwrap();
            if kind.is_dir() {
                output.insert(relative, Member::Directory);
                walk(root, &path, output);
            } else {
                assert!(kind.is_file(), "unexpected original member {path:?}");
                output.insert(relative, Member::File(std::fs::read(path).unwrap()));
            }
        }
    }
    let mut result = BTreeMap::new();
    walk(root, root, &mut result);
    result
}

struct Case {
    directory: Option<tempfile::TempDir>,
    root: PathBuf,
    evidence: PathBuf,
    commands: usize,
}
impl Case {
    fn new() -> Self {
        let directory = tempfile::Builder::new()
            .prefix("maka-k110-original-")
            .tempdir()
            .unwrap();
        let root = directory.path().join("root");
        let evidence = tempfile::Builder::new()
            .prefix("maka-k110-evidence-")
            .tempdir()
            .unwrap()
            .keep();
        println!(
            "K110 original Root: {}; evidence: {}",
            root.display(),
            evidence.display()
        );
        Self {
            directory: Some(directory),
            root,
            evidence,
            commands: 0,
        }
    }
    fn retain_members(&self, name: &str, members: &Members) {
        let destination = self.evidence.join(name);
        std::fs::create_dir_all(&destination).unwrap();
        let mut manifest = Vec::new();
        for (path, member) in members {
            match member {
                Member::Directory => manifest.push(json!({"path":path,"kind":"directory"})),
                Member::File(bytes) => {
                    let copy = destination.join("bytes").join(path);
                    std::fs::create_dir_all(copy.parent().unwrap()).unwrap();
                    std::fs::write(copy, bytes).unwrap();
                    manifest.push(json!({"path":path,"kind":"file","bytes":bytes.len(),
                        "sha256":hex::encode(Sha256::digest(bytes))}));
                }
            }
        }
        std::fs::write(
            destination.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
    }
    fn unchanged(&self, name: &str, before: &Members) {
        let after = members(&self.root);
        self.retain_members(name, &after);
        assert_eq!(
            before.keys().collect::<Vec<_>>(),
            after.keys().collect::<Vec<_>>(),
            "{name}: original Root member set changed; evidence {}",
            self.evidence.display()
        );
        for (path, original) in before {
            assert!(
                after.get(path) == Some(original),
                "{name}: original Root member changed {path:?}; evidence {}",
                self.evidence.display()
            );
        }
    }
    fn command(&mut self, name: &str, arguments: &[&str], bundle: &Path) -> Output {
        self.commands += 1;
        let output = Command::new(env!("CARGO_BIN_EXE_maka"))
            .args(arguments)
            .output()
            .unwrap();
        let prefix = self.evidence.join(format!("{:02}-{name}", self.commands));
        std::fs::write(prefix.with_extension("stdout"), &output.stdout).unwrap();
        std::fs::write(prefix.with_extension("stderr"), &output.stderr).unwrap();
        std::fs::write(prefix.with_extension("status"), output.status.to_string()).unwrap();
        std::fs::write(
            prefix.with_extension("command.json"),
            serde_json::to_vec_pretty(&json!({"binary":env!("CARGO_BIN_EXE_maka"),
                "arguments":arguments,"bundle":bundle}))
            .unwrap(),
        )
        .unwrap();
        // Retain the physical result before a status/JSON assertion can unwind.
        self.retain_members(
            &format!("{:02}-{name}-root", self.commands),
            &members(&self.root),
        );
        output
    }
    fn success(&mut self, name: &str, arguments: &[&str], bundle: &Path) -> Value {
        let output = self.command(name, arguments, bundle);
        assert!(
            output.status.success(),
            "{name}: {}; evidence {}",
            String::from_utf8_lossy(&output.stderr),
            self.evidence.display()
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
}
impl Drop for Case {
    fn drop(&mut self) {
        if std::thread::panicking()
            && let Some(directory) = self.directory.take()
        {
            eprintln!(
                "K110 retained original case {}; evidence {}",
                directory.keep().display(),
                self.evidence.display()
            );
        }
    }
}

struct Fixture {
    case: Case,
    bundle: PathBuf,
    deployment: Uuid,
    domain: String,
    input: Input,
    previous: Package,
    current: Package,
    history: Vec<String>,
    revision: u64,
}
impl Fixture {
    fn source(&self, input: &Input, revision: u64) -> Value {
        json!({"reference":{"stateDomain":self.domain,"deployment":self.deployment,
            "revision":revision},"input":input,"remoteExports":[]})
    }
    fn outcome(&self, applied: bool) -> Value {
        let old = self.previous.application_ref();
        let new = self.current.application_ref();
        json!({"scope":"selected_packages","customized":true,"changed":true,
            "applied":applied,"conflicts":[],"changes":[format!(
                "/instances/files/package: {}@{} -> {}@{}",old.id,old.revision,new.id,new.revision)]})
    }
    fn preview(&mut self) -> Value {
        let root = self.case.root.to_str().unwrap().to_owned();
        self.case.success(
            "preview",
            &["application", "update-defaults", "--root", &root],
            &self.bundle,
        )
    }
    fn read(&mut self) -> Value {
        let root = self.case.root.to_str().unwrap().to_owned();
        self.case.success(
            "read",
            &[
                "application",
                "read",
                "--root",
                &root,
                "--deployment",
                &self.deployment.to_string(),
            ],
            &self.bundle,
        )
    }
    fn reacquire(&self) {
        let owner = RootOwner::open(
            &self.case.root,
            &RootNamespaces::for_current_account().unwrap(),
        )
        .unwrap();
        assert_eq!(owner.root_id(), self.domain);
        let lease =
            FileLease::acquire(&self.case.root.join(format!("{ROOT_DATABASE}.writer.lock")))
                .unwrap();
        lease.validate().unwrap();
        drop((lease, owner));
    }
}

async fn insert_revision(
    connection: &mut SqliteConnection,
    deployment: Uuid,
    revision: u64,
    input: &Input,
    packages: &[&Package],
) {
    maka_event_log::applications::validate_application(
        input,
        &[],
        &packages
            .iter()
            .map(|package| (**package).clone())
            .collect::<Vec<_>>(),
    )
    .unwrap();
    sqlx::query("INSERT INTO application_sources(deployment,revision,input_json,remote_exports_json) VALUES(?,?,?,'[]')")
        .bind(deployment.to_string()).bind(revision as i64).bind(serde_json::to_string(input).unwrap())
        .execute(&mut *connection).await.unwrap();
    for package in packages {
        let reference = package.application_ref();
        sqlx::query("INSERT INTO application_source_packages(deployment,source_revision,id,revision) VALUES(?,?,?,?)")
            .bind(deployment.to_string()).bind(revision as i64).bind(reference.id).bind(reference.revision)
            .execute(&mut *connection).await.unwrap();
    }
}

async fn seed(wal: bool) -> Fixture {
    let case = Case::new();
    let namespaces = RootNamespaces::for_current_account().unwrap();
    let owner = RootOwner::create(&case.root, &namespaces).unwrap();
    let domain = owner.root_id().to_owned();
    let lease =
        FileLease::acquire(&case.root.join(format!("{ROOT_DATABASE}.writer.lock"))).unwrap();
    let bundle = PathBuf::from(env!("OUT_DIR")).join("product");
    // Same built package discovery and same-ID old fork as the ordinary standalone
    // command fixture. No injected synchronizer map or synthetic product bundle.
    let current = Package::read_from(&bundle.join("packages/workspace-files")).unwrap();
    let mut files = current.files().clone();
    files.insert(
        "previous-release.txt".into(),
        b"K110 previous selected package\n".to_vec(),
    );
    let previous = Package::new(files).unwrap();
    assert_ne!(previous.application_ref(), current.application_ref());
    let manifest: Value = serde_json::from_slice(&current.files()["maka.extension.json"]).unwrap();
    let contract = &manifest["application"]["entries"]["host"]["exports"]["files"]["contract"];
    let consumer = Package::new(BTreeMap::from([
        ("maka.extension.json".into(), serde_json::to_vec(&json!({"schemaVersion":1,
            "id":"example.k110-consumer","application":{"entries":{"host":{
                "implementation":{"kind":"javascript","module":"host.mjs","realm":"shared"},
                "configuration":{"type":"object","properties":{"label":{"type":"string"}},
                    "required":["label"],"additionalProperties":false},
                "imports":{"files":{"contract":contract,"cardinality":{"kind":"one"}}},"exports":{}}}}})).unwrap()),
        ("host.mjs".into(), b"export function activate() { return {}; }".to_vec()),
    ])).unwrap();
    let deployment = Uuid::new_v4();
    let files_key = Uuid::new_v4();
    let consumer_key = Uuid::new_v4();
    let mut input: Input = serde_json::from_value(json!({"environment":{"location":"host"},"instances":{
        "files":{"key":files_key,"package":{"source":"pinned","package":previous.application_ref()},"usePackage":"entry"},
        "custom":{"key":consumer_key,"package":{"source":"pinned","package":consumer.application_ref()},
            "usePackage":"entry","configuration":{"values":{"label":"main-only-value"}},
            "bindings":{"files":[{"kind":"instance","path":["files"],"export":"files"}]}}
    }})).unwrap();
    let selection = json!({"kind":"public_host","endpoints":{"files":{
        "consumer":[consumer_key],"import":"files","grant":{"methods":["readText"],"recovery":false}}},
        "native":[{"origin":[consumer_key],"consumer":[consumer_key],"provider":[files_key],
            "export":"files","methods":["readText"],"recovery":false}]});
    serde_json::from_value::<Configuration>(selection.clone())
        .unwrap()
        .validate()
        .unwrap();
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(case.root.join(ROOT_DATABASE))
            .create_if_missing(true),
    )
    .await
    .unwrap();
    sqlx::raw_sql("PRAGMA application_id=1296124754;")
        .execute(&mut connection)
        .await
        .unwrap();
    MIGRATIONS
        .run_direct(Some(32), &mut connection, false)
        .await
        .unwrap();
    let mut tx = connection.begin().await.unwrap();
    for package in [&previous, &consumer] {
        let reference = package.application_ref();
        sqlx::query("INSERT INTO application_packages(id,revision) VALUES(?,?)")
            .bind(&reference.id)
            .bind(&reference.revision)
            .execute(&mut *tx)
            .await
            .unwrap();
        for (path, bytes) in package.files() {
            sqlx::query(
                "INSERT INTO application_package_files(id,revision,path,payload) VALUES(?,?,?,?)",
            )
            .bind(&reference.id)
            .bind(&reference.revision)
            .bind(path)
            .bind(bytes)
            .execute(&mut *tx)
            .await
            .unwrap();
        }
    }
    insert_revision(&mut tx, deployment, 1, &input, &[&previous, &consumer]).await;
    sqlx::query("INSERT INTO application_deployments(id,revision) VALUES(?,1)")
        .bind(deployment.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO application_launch(singleton,deployment,configuration,pending,product) VALUES(1,?,?,NULL,NULL)")
        .bind(deployment.to_string()).bind(serde_json::to_string(&selection).unwrap())
        .execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO session_control(id,fingerprint,revision,created_at,updated_at,archived,configuration) VALUES('k110-session','k110-original',1,1,1,0,?)")
        .bind(r#"{"title":"Preserve original user history"}"#).execute(&mut *tx).await.unwrap();
    let invocation = Invocation {
        session_id: "k110-session".into(),
        turn_id: "k110-turn".into(),
        run_id: "k110-run".into(),
        invocation_id: "k110-invocation".into(),
    };
    for (kind, fact) in [
        (
            "invocation_opened",
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    source_messages: vec![],
                    content: "K110 original user message".into(),
                    request_fingerprint: None,
                },
            },
        ),
        (
            "invocation_ended",
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Completed,
            },
        ),
    ] {
        let event = RuntimeEvent::new(invocation.clone(), fact);
        sqlx::query(
            "INSERT INTO event_log(event_id,invocation_id,kind,event_json) VALUES(?,?,?,?)",
        )
        .bind(&event.id)
        .bind(&invocation.invocation_id)
        .bind(kind)
        .bind(serde_json::to_string(&event).unwrap())
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
    sqlx::raw_sql("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .execute(&mut connection)
        .await
        .unwrap();
    let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    assert_eq!(journal_mode, "wal");
    let revision = if wal {
        let checkpoint: (i64, i64, i64) = sqlx::query_as("PRAGMA wal_checkpoint(TRUNCATE)")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(checkpoint.0, 0);
        {
            let mut locked = connection.lock_handle().await.unwrap();
            // SAFETY: the borrowed wrapper is callback-local under SQLx's exclusive
            // handle guard; it neither owns nor closes this connection.
            let borrowed =
                unsafe { rusqlite::Connection::from_handle(locked.as_raw_handle().as_ptr()) }
                    .unwrap();
            assert!(
                borrowed
                    .set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)
                    .unwrap()
            );
            assert!(
                borrowed
                    .db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE)
                    .unwrap()
            );
        }
        input
            .instances
            .get_mut("custom")
            .unwrap()
            .configuration
            .values
            .insert("label".into(), json!("latest-committed-wal-value"));
        let mut tx = connection.begin().await.unwrap();
        insert_revision(&mut tx, deployment, 2, &input, &[&previous, &consumer]).await;
        sqlx::query("UPDATE application_deployments SET revision=2 WHERE id=?")
            .bind(deployment.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        2
    } else {
        1
    };
    let ledger: Vec<(i64, Vec<u8>)> =
        sqlx::query_as("SELECT version,checksum FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&mut connection)
            .await
            .unwrap();
    assert_eq!(
        ledger.iter().map(|row| row.0).collect::<Vec<_>>(),
        (1..=32).collect::<Vec<_>>()
    );
    std::fs::write(
        case.evidence.join("seed-ledger.json"),
        serde_json::to_vec_pretty(&ledger).unwrap(),
    )
    .unwrap();
    let history: Vec<String> =
        sqlx::query_scalar("SELECT event_json FROM event_log ORDER BY sequence")
            .fetch_all(&mut connection)
            .await
            .unwrap();
    std::fs::write(
        case.evidence.join("seed-history.json"),
        serde_json::to_vec_pretty(&history).unwrap(),
    )
    .unwrap();
    connection.close().await.unwrap();
    owner.validate_current().unwrap();
    lease.validate().unwrap();
    drop((lease, owner));
    std::fs::create_dir(case.root.join("retained")).unwrap();
    std::fs::write(
        case.root.join("retained/user-data.bin"),
        b"K110 exact user data\0\xff\n",
    )
    .unwrap();
    std::fs::write(
        case.evidence.join("package-inputs.json"),
        serde_json::to_vec_pretty(
            &json!({"bundle":bundle,"package_path":bundle.join("packages/workspace-files"),
            "previous":previous.application_ref(),"current":current.application_ref(),
            "consumer":consumer.application_ref(),"seed_revision":revision,"state_domain":domain,
            "deployment":deployment}),
        )
        .unwrap(),
    )
    .unwrap();
    let fixture = Fixture {
        case,
        bundle,
        deployment,
        domain,
        input,
        previous,
        current,
        history,
        revision,
    };
    std::fs::write(
        fixture.case.evidence.join("expected-source.json"),
        serde_json::to_vec_pretty(&fixture.source(&fixture.input, revision)).unwrap(),
    )
    .unwrap();
    fixture
}

#[tokio::test]
#[ignore = "requires the built bundled product"]
async fn historical_application_preview_and_read_preserve_original_root_before_apply() {
    let mut f = seed(false).await;
    assert!(!f.case.root.join(format!("{ROOT_DATABASE}-wal")).exists());
    assert!(!f.case.root.join(format!("{ROOT_DATABASE}-shm")).exists());
    let before = members(&f.case.root);
    f.case.retain_members("before", &before);
    let expected_preview = f.outcome(false);
    assert_eq!(f.preview(), expected_preview);
    f.case.unchanged("after-preview", &before);
    let expected_source = f.source(&f.input, f.revision);
    assert_eq!(f.read(), expected_source);
    f.case.unchanged("after-read", &before);
    f.reacquire();
    f.case.unchanged("after-reacquire", &before);

    // Only this explicit positive-control phase may migrate and write.
    let root = f.case.root.to_str().unwrap().to_owned();
    let applied = f.case.success(
        "apply",
        &["application", "update-defaults", "--root", &root, "--apply"],
        &f.bundle,
    );
    assert_eq!(applied, f.outcome(true));
    let mut target = f.input.clone();
    target.instances.get_mut("files").unwrap().package = f.current.application_ref().into();
    let expected = f.source(&target, 2);
    assert_eq!(f.read(), expected);
    f.reacquire();
    let owner = RootOwner::open(
        &f.case.root,
        &RootNamespaces::for_current_account().unwrap(),
    )
    .unwrap();
    let lease =
        FileLease::acquire(&f.case.root.join(format!("{ROOT_DATABASE}.writer.lock"))).unwrap();
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(f.case.root.join(ROOT_DATABASE))
            .read_only(true),
    )
    .await
    .unwrap();
    let versions: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&mut connection)
            .await
            .unwrap();
    assert_eq!(versions, (1..=36).collect::<Vec<_>>());
    let history: Vec<String> =
        sqlx::query_scalar("SELECT event_json FROM event_log ORDER BY sequence")
            .fetch_all(&mut connection)
            .await
            .unwrap();
    assert_eq!(history, f.history);
    let session: String =
        sqlx::query_scalar("SELECT configuration FROM session_control WHERE id='k110-session'")
            .fetch_one(&mut connection)
            .await
            .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&session).unwrap(),
        json!({"title":"Preserve original user history"})
    );
    connection.close().await.unwrap();
    owner.validate_current().unwrap();
    lease.validate().unwrap();
    drop((lease, owner));
    assert_eq!(
        std::fs::read(f.case.root.join("retained/user-data.bin")).unwrap(),
        b"K110 exact user data\0\xff\n"
    );
}

#[tokio::test]
#[ignore = "requires the built bundled product"]
async fn historical_application_inspection_reads_committed_wal_without_changing_members() {
    let mut f = seed(true).await;
    assert!(
        std::fs::metadata(f.case.root.join(format!("{ROOT_DATABASE}-wal")))
            .unwrap()
            .len()
            > 32
    );
    let before = members(&f.case.root);
    f.case.retain_members("before", &before);
    // Offline evidence is a database file only, never another owned Root. Its
    // main-only value must differ from the committed value the real CLI reads.
    let main = f.case.evidence.join("main-only.sqlite");
    std::fs::write(
        &main,
        std::fs::read(f.case.root.join(ROOT_DATABASE)).unwrap(),
    )
    .unwrap();
    let mut evidence = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(main)
            .read_only(true)
            .immutable(true),
    )
    .await
    .unwrap();
    let head: i64 = sqlx::query_scalar("SELECT revision FROM application_deployments WHERE id=?")
        .bind(f.deployment.to_string())
        .fetch_one(&mut evidence)
        .await
        .unwrap();
    assert_eq!(head, 1);
    let source: String = sqlx::query_scalar(
        "SELECT input_json FROM application_sources WHERE deployment=? AND revision=1",
    )
    .bind(f.deployment.to_string())
    .fetch_one(&mut evidence)
    .await
    .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&source).unwrap()["instances"]["custom"]["configuration"]["values"]
            ["label"],
        "main-only-value"
    );
    evidence.close().await.unwrap();
    let expected_source = f.source(&f.input, 2);
    assert_eq!(f.read(), expected_source);
    f.case.unchanged("after-read", &before);
    let expected_preview = f.outcome(false);
    assert_eq!(f.preview(), expected_preview);
    f.case.unchanged("after-preview", &before);
    f.reacquire();
    f.case.unchanged("after-reacquire", &before);
}

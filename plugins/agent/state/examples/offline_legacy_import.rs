// Licensed to the Apache Software Foundation (ASF) under one or more
// contributor license agreements. See the NOTICE file distributed with
// this work for additional information regarding copyright ownership.
// The ASF licenses this file to you under the Apache License, Version 2.0
// (the "License"); you may not use this file except in compliance with
// the License. You may obtain a copy of the License at
// https://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
use maka_agent_facts::{
    durable::*,
    history_snapshot::{Entry, ImportedMessage, ImportedPart},
};
use maka_agent_state::{
    ContentBlob, DriverDomain, Store, session_history::snapshot::ImportedCaptureRequest,
};
use maka_event_log::{
    RootStore,
    root::{RootNamespaces, RootOwner},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::{
    error::Error,
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::Path,
    sync::Arc,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn validate_tape(path: &Path, session: &str) -> Result<()> {
    let mut file = File::open(path)?;
    let mut magic = vec![0; maka_agent_state::session_history::snapshot::IMPORT_TAPE_MAGIC.len()];
    file.read_exact(&mut magic)?;
    if magic != maka_agent_state::session_history::snapshot::IMPORT_TAPE_MAGIC {
        return Err("unsupported tape".into());
    }
    let mut offsets = BTreeMap::new();
    fn value<T: serde::de::DeserializeOwned>(
        file: &mut File,
        offsets: &BTreeMap<String, (u64, u64)>,
        reference: &ContentRef,
    ) -> Result<T> {
        let end = file.stream_position()?;
        let (offset, bytes) = offsets
            .get(&reference.digest)
            .ok_or("content frame missing")?;
        if *bytes != reference.bytes {
            return Err("content length differs".into());
        }
        file.seek(SeekFrom::Start(*offset))?;
        let result = serde_json::from_reader(BufReader::new(file.by_ref().take(*bytes)))?;
        file.seek(SeekFrom::Start(end))?;
        Ok(result)
    }
    loop {
        let mut tag = [0];
        if file.read(&mut tag)? == 0 {
            break;
        }
        let mut size = [0; 8];
        match tag[0] {
            0 => {
                let mut digest = [0; 32];
                file.read_exact(&mut digest)?;
                file.read_exact(&mut size)?;
                let bytes = u64::from_be_bytes(size);
                let offset = file.stream_position()?;
                offsets.insert(format!("sha256:{}", hex::encode(digest)), (offset, bytes));
                let end = offset.checked_add(bytes).ok_or("tape offset overflow")?;
                if end > file.metadata()?.len() {
                    return Err("content frame truncated".into());
                }
                file.seek(SeekFrom::Start(end))?;
            }
            1 => {
                file.read_exact(&mut size)?;
                let entry: Entry = serde_json::from_reader(BufReader::new(
                    file.by_ref().take(u64::from_be_bytes(size)),
                ))?;
                if let Entry::Imported { message, .. } = entry {
                    let message: ImportedMessage = value(&mut file, &offsets, &message)?;
                    for reference in message.parts {
                        let part: ImportedPart = value(&mut file, &offsets, &reference)?;
                        if let ImportedPart::ToolReturn { result, .. } = part {
                            result.validate()?;
                            result.body.projection.validate(session)?;
                        }
                    }
                }
            }
            _ => return Err("unknown tape frame".into()),
        }
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() == 3 && args[1] == "validate" {
        for line in BufReader::new(File::open(&args[2])?).lines() {
            let v: Value = serde_json::from_str(&line?)?;
            validate_tape(
                Path::new(v["tape"].as_str().ok_or("missing tape")?),
                v["session"].as_str().ok_or("missing session")?,
            )?;
        }
        println!("All prepared messages decode with the current production types.");
        return Ok(());
    }
    if args.len() < 3
        || !matches!(args[1].as_str(), "init" | "import" | "with-root")
        || (args[1] == "import" && args.len() != 4)
        || (args[1] == "with-root" && args.len() < 4)
    {
        return Err("usage: offline_legacy_import init ROOT | import ROOT PLAN.jsonl | with-root ROOT COMMAND [ARG...]".into());
    }
    let root = Path::new(&args[2]);
    let ns = RootNamespaces::for_current_account()?;
    if args[1] == "init" {
        RootOwner::create(root, &ns)?;
        return Ok(());
    }
    let owner = Arc::new(RootOwner::open(root, &ns)?);
    if args[1] == "with-root" {
        let command = args[3..].to_vec();
        let status = tokio::task::spawn_blocking(move || {
            std::process::Command::new(&command[0])
                .args(&command[1..])
                .status()
        })
        .await??;
        drop(owner);
        if !status.success() {
            return Err(format!("offline operation failed: {status}").into());
        }
        return Ok(());
    }
    let catalog: Vec<_> = maka_event_log::ROOT_MIGRATIONS
        .iter()
        .chain(maka_agent_state::MIGRATIONS)
        .copied()
        .collect();
    let log = Arc::new(RootStore::open(owner, &catalog).await?);
    let data = log.data_writer()?;
    let store = Store::new(data.clone(), DriverDomain::new(data.clone())?)?;
    for line in BufReader::new(File::open(&args[3])?).lines() {
        let v: Value = serde_json::from_str(&line?)?;
        let session = v["session"].as_str().ok_or("missing session")?.to_owned();
        let scope: RunOwner = serde_json::from_value(v["owner"].clone())?;
        let history = store.session_history(scope.clone(), session.clone());
        let request: ImportedCaptureRequest = serde_json::from_value(v["capture"].clone())?;
        let id = request.id;
        let source = history
            .capture_imported(
                request,
                File::open(v["tape"].as_str().ok_or("missing tape")?)?,
                CancellationToken::new(),
            )
            .await?;
        let mut after = None;
        let mut count = 0u64;
        let mut parts = 0u64;
        let mut media = BTreeSet::new();
        loop {
            let page = source.imported(after, 256).await?;
            for (ordinal, message) in page.items {
                for id in &message.media {
                    if media.insert(id.clone()) {
                        let expected = source
                            .artifact(scope.clone(), session.clone(), None, id.clone())
                            .await?
                            .ok_or("missing imported media")?;
                        let digest = source
                            .with_artifact(
                                scope.clone(),
                                session.clone(),
                                None,
                                id.clone(),
                                |_, r| {
                                    let mut hash = Sha256::new();
                                    let mut block = [0; 65536];
                                    loop {
                                        let n = r.read(&mut block)?;
                                        if n == 0 {
                                            break;
                                        }
                                        hash.update(&block[..n]);
                                    }
                                    Ok(format!("sha256:{}", hex::encode(hash.finalize())))
                                },
                            )
                            .await?
                            .ok_or("media is not readable")?;
                        if digest != expected.payload.digest {
                            return Err("media bytes differ from original".into());
                        }
                    }
                }
                for r in message.parts {
                    let part: ImportedPart = source
                        .with_imported_content(ordinal, &r, |r| {
                            Ok(serde_json::from_reader(BufReader::new(r)))
                        })
                        .await??;
                    if let ImportedPart::ToolReturn { result, .. } = &part {
                        result.validate()?;
                        result.body.projection.validate(&session)?;
                    }
                    parts += 1;
                }
                count += 1;
            }
            match page.next {
                Some(next) => after = Some(next),
                None => break,
            }
        }
        if count != v["totals"]["messages"].as_u64().ok_or("missing count")? {
            return Err("message count differs from immutable tape".into());
        }
        let mut model_after = None;
        let mut model_count = 0u64;
        loop {
            let page = source.model_messages(model_after, 256).await?;
            model_count += page.items.len() as u64;
            match page.next {
                Some(next) => model_after = Some(next),
                None => break,
            }
        }
        if model_count != v["modelMessages"].as_u64().ok_or("missing model count")? {
            return Err("model projection does not start at original summary boundary".into());
        }
        let system = ContentBlob::json(&Option::<String>::None)?;
        let tools = ContentBlob::json(
            &json!({"definitions":[],"direct_only":[],"services":[],"internal_bindings":{}}),
        )?;
        let input = ContentBlob::json(&maka_agent_facts::input::RunInput::HistorySource {
            source: source.reference().clone(),
        })?;
        let spec: RunSpec = serde_json::from_value(json!({
            "schemaVersion":SCHEMA_VERSION,"sessionId":session,"owner":scope,
            "turnId":format!("history:{id}"),"origin":{"kind":"imported","source":source.reference()},
            "trigger":{"kind":"history_source"},"workspace":v["workspace"],
            "permissionBasis":v["permissionBasis"],
            "permissionCeiling":{"sandbox":{"kind":"disabled"},"approval":{"kind":"never"}},
            "backend":{"kind":"historical"},"collaboration":"agent","language":"en",
            "toolDiscovery":false,"allowedTools":null,"mcpRevision":null,"compactionPrompt":null,
            "systemPrompt":system.reference(),"toolSelection":tools.reference(),"input":input.reference(),
            "budget":{"tokens":null,"retries":0,"deadline":null},"budgetBasis":null
        }))?;
        let operation: Uuid = id.into();
        let change = source.adopt(
            &history,
            operation,
            spec,
            UnixMillis(v["at"].as_i64().ok_or("missing timestamp")?),
            vec![system, tools, input],
        )?;
        let installed = data.write(change).await?;
        let cut = history.capture().await?;
        if history.latest(&cut).await?.map(|s| s.run) != Some(installed.run) {
            return Err("installed historical source is not readable".into());
        }
        store
            .catalog(
                scope.clone(),
                session
                    .rsplit_once('_')
                    .ok_or("invalid session")?
                    .0
                    .to_owned()
                    + "_",
            )?
            .rebuild(session.clone())
            .await?;
        println!(
            "{}",
            json!({"session":session,"run":installed.run,"messages":count,"parts":parts,"modelMessages":model_count,"media":media.len()})
        );
    }
    log.shutdown().await?;
    Ok(())
}

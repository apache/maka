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

//! Manual baseline: ordinary Host admissions plus bounded checkpoint delivery.
use super::*;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;

fn rss() -> u64 {
    let output = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .unwrap();
    assert!(output.status.success());
    std::str::from_utf8(&output.stdout)
        .unwrap()
        .trim()
        .parse::<u64>()
        .unwrap()
        * 1024
}
struct Memory {
    baseline: u64,
    stop: Arc<AtomicBool>,
    peak: Arc<AtomicU64>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Memory {
    fn start() -> Self {
        let baseline = rss();
        let stop = Arc::new(AtomicBool::new(false));
        let peak = Arc::new(AtomicU64::new(baseline));
        let (s, p) = (stop.clone(), peak.clone());
        let worker = std::thread::spawn(move || {
            while !s.load(Ordering::Relaxed) {
                p.fetch_max(rss(), Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        Self {
            baseline,
            stop,
            peak,
            worker: Some(worker),
        }
    }
    fn finish(mut self) -> Value {
        self.peak.fetch_max(rss(), Ordering::Relaxed);
        self.stop.store(true, Ordering::Relaxed);
        self.worker.take().unwrap().join().unwrap();
        json!({"baselineRss":self.baseline,"sampledPeakRss":self.peak.load(Ordering::Relaxed)})
    }
}
impl Drop for Memory {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}
fn disk(root: &std::path::Path) -> Value {
    fn size(path: &std::path::Path) -> u64 {
        if !path.exists() {
            return 0;
        }
        if path.is_file() {
            return path.metadata().unwrap().len();
        }
        std::fs::read_dir(path)
            .unwrap()
            .map(|e| size(&e.unwrap().path()))
            .sum()
    }
    let directory = root.to_owned();
    let wal = std::fs::read_dir(&directory)
        .unwrap()
        .filter_map(|e| {
            let e = e.unwrap();
            e.file_name()
                .to_string_lossy()
                .ends_with("-wal")
                .then(|| e.metadata().unwrap().len())
        })
        .sum::<u64>();
    json!({"rootBytes":size(root),"checkpointBytes":size(&root.join("history-checkpoints")),"runtimeWalBytes":wal})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "manual history checkpoint performance baseline; select MAKA_CHECKPOINT_BENCH_CASE"]
async fn history_checkpoint_baseline() {
    let case = std::env::var("MAKA_CHECKPOINT_BENCH_CASE").expect("small, artifact or long");
    let (turns, artifact_bytes) = match case.as_str() {
        "small" => (1, 0),
        "artifact" => (1, 32 * 1024 * 1024),
        "long" => (64, 0),
        _ => panic!("unknown case"),
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let f = Fixture::new(
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        None,
    )
    .await;
    let session = f.create("Benchmark history").await;
    if artifact_bytes > 0 {
        let bytes = vec![23; artifact_bytes];
        assert_eq!(
            attachments::upload(
                &f,
                &session,
                "large-tool-payload.bin",
                &bytes,
                Uuid::new_v4()
            )
            .await
            .unwrap()["kind"],
            "uploaded"
        );
    }
    for _ in 0..turns {
        turn(&f, &listener, &session, "completed history benchmark turn").await;
    }
    // Keep the probe in the source's physical partition so this does not hide
    // read-transaction contention behind independent partition scheduling.
    let mut probe = f.create("Ordinary message probe").await;
    while f.session_database(&probe) != f.session_database(&session) {
        probe = f.create("Same-partition message probe").await;
    }
    let time = Instant::now();
    f.send(&probe).await.unwrap();
    let baseline_message_ms = time.elapsed().as_secs_f64() * 1000.;
    let (mut socket, _) = listener.accept().await.unwrap();
    request(&mut socket).await;
    response(&mut socket).await;
    f.drained().await;
    let original = input(&f, &session, Value::Null).await;
    let before = disk(&f.root);
    let memory = Memory::start();
    let publishing = async {
        let time = Instant::now();
        let (_, receipt) = publish(&f, original, Uuid::new_v4()).await;
        (published(receipt), time.elapsed().as_secs_f64() * 1000.)
    };
    let probe_call = async {
        let time = Instant::now();
        f.send(&probe).await.unwrap();
        time.elapsed().as_secs_f64() * 1000.
    };
    let ((publication, publish_ms), concurrent_message_ms) = tokio::join!(publishing, probe_call);
    let publication_memory = memory.finish();
    let after_publish = disk(&f.root);
    let (mut socket, _) = listener.accept().await.unwrap();
    request(&mut socket).await;
    response(&mut socket).await;
    f.drained().await;
    let observed = scope(&f.issuer, true);
    let memory = Memory::start();
    let time = Instant::now();
    let mut stream = f
        .app
        .client()
        .subscribe(
            f.binding(2).await,
            "readHistoryCheckpoint".into(),
            json!({"sessionId":session,"revision":publication["state"]["head"]["revision"]}),
            observed.clone(),
            Attachments::new().into(),
        )
        .await
        .unwrap();
    let mut total = 0u64;
    let mut max_chunk = 0;
    let mut hash = Sha256::new();
    let mut ended = false;
    let mut first_ms = None;
    while let Some(frame) = stream.recv().await {
        first_ms.get_or_insert(time.elapsed().as_secs_f64() * 1000.);
        match frame["kind"].as_str().unwrap() {
            "checkpoint" => {}
            "chunk" => {
                assert_eq!(frame["offset"], total);
                let chunk = STANDARD.decode(frame["data"].as_str().unwrap()).unwrap();
                max_chunk = max_chunk.max(chunk.len());
                total += chunk.len() as u64;
                hash.update(chunk);
            }
            "end" => {
                assert_eq!(frame["bytes"], total);
                assert_eq!(frame["digest"], hex::encode(hash.clone().finalize()));
                ended = true;
            }
            _ => unreachable!(),
        }
    }
    let completion = stream.completion().await;
    completion.cleanup.unwrap();
    completion.result.unwrap();
    observed.resources.finish().await.unwrap();
    assert!(ended);
    let read_ms = time.elapsed().as_secs_f64() * 1000.;
    let read_memory = memory.finish();
    println!(
        "CHECKPOINT_BASELINE {}",
        json!({"case":case,"turns":turns,"artifactBytes":artifact_bytes,"bundleBytes":total,"publishMs":publish_ms,"readMs":read_ms,"firstFrameMs":first_ms,"maxChunkBytes":max_chunk,"publicationMemory":publication_memory,"readMemory":read_memory,"baselineMessageAdmissionMs":baseline_message_ms,"concurrentMessageAdmissionMs":concurrent_message_ms,"before":before,"afterPublish":after_publish,"afterRead":disk(&f.root)})
    );
    close(&f).await;
}

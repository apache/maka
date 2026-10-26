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

//! One public metadata reader and refresh lifetime for a product State Root.
use futures_util::{StreamExt, stream::FuturesUnordered};
use maka_agent_ports::model::Transport;
use maka_capabilities::http;
use maka_config::{
    ConfigurationStore,
    public_catalog::{PublicCatalogBody, PublicCatalogRecord, PublicCatalogSource},
};
pub use maka_providers::catalog::{Catalog, Snapshot};
use std::{
    collections::BTreeMap,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

const SOURCES: [(PublicCatalogSource, &str); 2] = [
    (
        PublicCatalogSource::ModelsDev,
        "https://models.dev/api.json",
    ),
    (
        PublicCatalogSource::OpenRouter,
        "https://openrouter.ai/api/v1/models",
    ),
];

#[derive(Clone, Debug)]
enum RefreshError {
    Failed(String),
    CleanupUnconfirmed(String),
}
impl RefreshError {
    fn message(&self) -> &str {
        match self {
            Self::Failed(message) | Self::CleanupUnconfirmed(message) => message,
        }
    }
}
impl From<String> for RefreshError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}
impl From<&str> for RefreshError {
    fn from(message: &str) -> Self {
        Self::Failed(message.into())
    }
}
fn retain_cleanup(result: &Result<(), RefreshError>, failure: &mut Option<String>) {
    if let Err(RefreshError::CleanupUnconfirmed(message)) = result {
        *failure = Some(message.clone());
    }
}

struct Owner {
    configuration: ConfigurationStore,
    catalog: Arc<Catalog>,
    transport: Option<Arc<dyn Transport>>,
}

/// Registry readers do not own network tasks. The product joins this owner
/// before releasing its Host and State Root.
pub struct RuntimeCatalog {
    owner: Arc<Owner>,
    cancellation: CancellationToken,
    task: Option<JoinHandle<Result<(), String>>>,
    requests: Option<mpsc::UnboundedReceiver<oneshot::Sender<Result<(), String>>>>,
}
impl RuntimeCatalog {
    pub async fn open(configuration: ConfigurationStore) -> Result<Self, String> {
        Self::load(configuration, None).await
    }

    /// Explicit transport injection keeps embedded service tests off the public network.
    pub async fn with_transport(
        configuration: ConfigurationStore,
        transport: Arc<dyn Transport>,
    ) -> Result<Self, String> {
        Self::load(configuration, Some(transport)).await
    }

    async fn load(
        configuration: ConfigurationStore,
        transport: Option<Arc<dyn Transport>>,
    ) -> Result<Self, String> {
        let loaded = async {
            let sources = configuration
                .public_catalog()
                .await
                .map_err(|_| "public catalog cache unavailable")?
                .sources;
            snapshot(&valid_sources(sources))
        }
        .await;
        let snapshot = match loaded {
            Ok(snapshot) => snapshot,
            Err(error) => {
                configuration
                    .shutdown()
                    .await
                    .map_err(|_| "public catalog cache cleanup failed")?;
                return Err(error);
            }
        };
        let catalog = Arc::new(Catalog::new(snapshot));
        let requests = catalog.attach_refresh();
        Ok(Self {
            owner: Arc::new(Owner {
                configuration,
                catalog,
                transport,
            }),
            cancellation: CancellationToken::new(),
            task: None,
            requests: Some(requests),
        })
    }

    pub fn catalog(&self) -> Arc<Catalog> {
        self.owner.catalog.clone()
    }

    /// Start only after Host admission. Its existing drain signal also cancels
    /// public I/O; generic Host transport has no model-catalog responsibilities.
    pub fn start(&mut self, draining: impl Future<Output = ()> + Send + 'static) {
        let requests = self
            .requests
            .take()
            .expect("public catalog runtime already started");
        let owner = self.owner.clone();
        let cancellation = self.cancellation.clone();
        self.task = Some(tokio::spawn(drive(owner, requests, cancellation, draining)));
    }

    /// A real explicit refresh on this same owner; there is no second plugin,
    /// timer, per-connection task, or mutable catalog authority.
    pub async fn refresh(&self) -> Result<(), String> {
        self.owner
            .catalog
            .request_refresh()?
            .await
            .map_err(|_| "public catalog refresh receipt unavailable".to_owned())?
    }

    pub async fn shutdown(&mut self) -> Result<(), String> {
        self.cancellation.cancel();
        self.requests.take();
        let joined = match self.task.take() {
            Some(task) => task
                .await
                .map_err(|_| "public catalog task failed".to_owned())
                .and_then(|result| result),
            None => Ok(()),
        };
        let closed = self
            .owner
            .configuration
            .shutdown()
            .await
            .map_err(|_| "public catalog cache cleanup failed".to_owned());
        joined.and(closed)
    }
}
impl Drop for RuntimeCatalog {
    fn drop(&mut self) {
        self.cancellation.cancel();
        // Normal and fallible product paths explicitly join. Panic unwinding
        // must not detach a task retaining the original Root.
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}
async fn drive(
    owner: Arc<Owner>,
    mut requests: mpsc::UnboundedReceiver<oneshot::Sender<Result<(), String>>>,
    cancellation: CancellationToken,
    draining: impl Future<Output = ()> + Send,
) -> Result<(), String> {
    tokio::pin!(draining);
    let mut cleanup_failure = None;
    let mut waiting: Vec<oneshot::Sender<Result<(), String>>> = Vec::new();
    loop {
        let refresh = owner.refresh(&cancellation);
        tokio::pin!(refresh);
        let result = loop {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => {
                    retain_cleanup(&refresh.await, &mut cleanup_failure);
                    for reply in waiting { let _ = reply.send(Err("public catalog refresh cancelled".into())); }
                    return cleanup_failure.map_or(Ok(()), Err);
                }
                _ = &mut draining => {
                    cancellation.cancel();
                    retain_cleanup(&refresh.await, &mut cleanup_failure);
                    for reply in waiting { let _ = reply.send(Err("public catalog refresh cancelled".into())); }
                    return cleanup_failure.map_or(Ok(()), Err);
                }
                result = &mut refresh => break result,
                request = requests.recv() => match request {
                    Some(request) => waiting.push(request),
                    None => { cancellation.cancel(); retain_cleanup(&refresh.await, &mut cleanup_failure); return cleanup_failure.map_or(Ok(()), Err); }
                },
            }
        };
        retain_cleanup(&result, &mut cleanup_failure);
        if let Err(error) = &result {
            eprintln!("Public model catalog: {}", error.message());
        }
        let result = result.map_err(|error| error.message().to_owned());
        // Complete requests already queued at this refresh's completion with
        // its same receipt; later arrivals request the next refresh.
        for _ in 0..requests.len() {
            if let Ok(request) = requests.try_recv() {
                waiting.push(request);
            }
        }
        for reply in waiting.drain(..) {
            let _ = reply.send(result.clone());
        }
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return cleanup_failure.map_or(Ok(()), Err),
            _ = &mut draining => { cancellation.cancel(); return cleanup_failure.map_or(Ok(()), Err); }
            request = requests.recv() => match request {
                Some(request) => waiting.push(request),
                None => return cleanup_failure.map_or(Ok(()), Err),
            },
        }
    }
}

impl Owner {
    async fn refresh(&self, cancellation: &CancellationToken) -> Result<(), RefreshError> {
        if cancellation.is_cancelled() {
            return Err("public catalog refresh cancelled".into());
        }
        let mut sources = valid_sources(
            self.configuration
                .public_catalog()
                .await
                .map_err(|_| "public catalog cache unavailable")?
                .sources,
        );
        let network = self
            .configuration
            .network_configuration()
            .await
            .map_err(|_| "public catalog network configuration unavailable")?;
        let policy =
            maka_network::Policy::from_host_settings(&network.proxy, network.password.as_deref())
                .map_err(|_| "public catalog network policy unavailable")?;
        let transport = match &self.transport {
            Some(transport) => transport.clone(),
            None => maka_model::provider_transport(&policy)
                .map_err(|_| "public catalog transport unavailable")?,
        };
        // A slow source cannot prevent a completed independent source from publishing.
        let mut requests = FuturesUnordered::new();
        for (source, url) in SOURCES {
            let transport = transport.clone();
            let previous = sources.get(&source).cloned();
            requests
                .push(async move { (source, fetch(transport, url, previous, cancellation).await) });
        }
        let mut failures = Vec::new();
        let mut cleanup_unconfirmed = false;
        while let Some((source, result)) = requests.next().await {
            let result = async {
                let record = result?;
                let mut candidate = sources.clone();
                candidate.insert(source, record.clone());
                let next = snapshot(&candidate)?;
                let mut publication = tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return Err("public catalog refresh cancelled".into()),
                    guard = self.catalog.snapshot.write() => guard,
                };
                if cancellation.is_cancelled() { return Err("public catalog refresh cancelled".into()); }
                // Once a write is admitted, keep this guard until both durable
                // commit and publication finish, including during shutdown.
                match self.configuration.put_public_catalog(source, record).await {
                    Ok(_) => { *publication = Ok(Arc::new(next)); sources = candidate; Ok(()) }
                    Err(_) => {
                        // A failed acknowledgement cannot tell us whether SQL
                        // committed. Reconcile against durable facts while no
                        // consumer can pair an old snapshot with a new revision.
                        let durable = self.configuration.public_catalog().await
                            .map_err(|_| "public catalog state unavailable after uncertain write".to_owned())
                            .and_then(|durable| {
                                let next = snapshot(&durable.sources)?;
                                let applied = match (durable.sources.get(&source), candidate.get(&source)) {
                                    (Some(durable), Some(candidate)) => durable.same_content(candidate),
                                    (None, None) => Ok(true),
                                    _ => Ok(false),
                                }.map_err(|_| "public catalog comparison failed after uncertain write".to_owned())?;
                                Ok((durable.sources, next, applied))
                            });
                        match durable {
                            Ok((durable, next, applied)) => {
                                *publication = Ok(Arc::new(next));
                                sources = durable;
                                if applied { Ok(()) } else { Err("public catalog update was not committed".into()) }
                            }
                            Err(error) => {
                                *publication = Err(error.clone());
                                cancellation.cancel();
                                Err(RefreshError::Failed(error))
                            }
                        }
                    }
                }
            }.await;
            if let Err(error) = result {
                cleanup_unconfirmed |= matches!(error, RefreshError::CleanupUnconfirmed(_));
                failures.push(format!("{source:?}: {}", error.message()));
            }
        }
        if failures.is_empty() {
            Ok(())
        } else if cleanup_unconfirmed {
            Err(RefreshError::CleanupUnconfirmed(failures.join("; ")))
        } else {
            Err(RefreshError::Failed(failures.join("; ")))
        }
    }
}
fn valid_sources(
    mut sources: BTreeMap<PublicCatalogSource, PublicCatalogRecord>,
) -> BTreeMap<PublicCatalogSource, PublicCatalogRecord> {
    sources.retain(|source, record| {
        let valid = match source {
            PublicCatalogSource::ModelsDev => Snapshot::from_sources(Some(&record.body), None),
            PublicCatalogSource::OpenRouter => Snapshot::from_sources(None, Some(&record.body)),
        }
        .is_ok();
        if !valid {
            eprintln!("Public model catalog: invalid cached {source:?} data ignored");
        }
        valid
    });
    sources
}
fn snapshot(
    sources: &BTreeMap<PublicCatalogSource, PublicCatalogRecord>,
) -> Result<Snapshot, String> {
    Snapshot::from_sources(
        sources
            .get(&PublicCatalogSource::ModelsDev)
            .map(|record| &record.body),
        sources
            .get(&PublicCatalogSource::OpenRouter)
            .map(|record| &record.body),
    )
}
async fn fetch(
    transport: Arc<dyn Transport>,
    url: &'static str,
    previous: Option<PublicCatalogRecord>,
    cancellation: &CancellationToken,
) -> Result<PublicCatalogRecord, RefreshError> {
    let mut headers = vec![("accept".into(), "application/json".into())];
    if let Some(previous) = &previous {
        if let Some(etag) = &previous.etag {
            headers.push(("if-none-match".into(), etag.clone()));
        }
        if let Some(modified) = &previous.last_modified {
            headers.push(("if-modified-since".into(), modified.clone()));
        }
    }
    let response = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err("public catalog refresh cancelled".into()),
        result = transport.request(http::Request { url: url.into(), method: http::Method::Get, headers, body: Default::default() }, cancellation.clone()) => result.map_err(|_| "public catalog HTTP request failed")?,
    };
    let result = async {
        let header = |name: &str| response.head.headers.iter().find_map(|(key, value)| {
            key.eq_ignore_ascii_case(name).then(|| String::from_utf8(value.clone()).ok()).flatten()
        });
        let mut record = match response.head.status {
            304 => previous.ok_or("public catalog returned 304 without cached data")?,
            200 => {
                let mut bytes = Vec::new();
                loop {
                    let next = tokio::select! {
                        biased;
                        _ = cancellation.cancelled() => return Err(RefreshError::Failed("public catalog refresh cancelled".to_owned())),
                        next = response.body.next() => next.map_err(|_| "public catalog HTTP body failed")?,
                    };
                    let Some(chunk) = next else { break; };
                    bytes.extend_from_slice(&chunk);
                }
                PublicCatalogRecord { body: PublicCatalogBody::from_json(String::from_utf8(bytes).map_err(|_| "public catalog response is not valid JSON")?).map_err(|_| "public catalog response is not valid JSON")?, etag: None, last_modified: None, checked_at: 0 }
            }
            _ => return Err("public catalog HTTP request was not successful".into()),
        };
        if response.head.status == 200 || header("etag").is_some() { record.etag = header("etag"); }
        if response.head.status == 200 || header("last-modified").is_some() { record.last_modified = header("last-modified"); }
        record.checked_at = i64::try_from(SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "public catalog clock unavailable")?.as_millis()).map_err(|_| "public catalog clock cannot be represented")?;
        Ok(record)
    }.await;
    response.body.cancel();
    response.body.close().await.map_err(|_| {
        RefreshError::CleanupUnconfirmed("public catalog HTTP cleanup unconfirmed".into())
    })?;
    result
}

#[cfg(test)]
mod tests;

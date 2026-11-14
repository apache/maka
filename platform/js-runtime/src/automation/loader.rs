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

use super::js_error;
use deno_cache_dir::file_fetcher::{
    CacheSetting, File, HttpClient, LoadedFrom, NullBlobStore, SendError, SendResponse,
};
use deno_core::{
    FastString, ModuleLoadOptions, ModuleLoadReferrer, ModuleLoadResponse, ModuleLoader,
    ModuleSource, ModuleSourceCode, ModuleSpecifier, ModuleType, ResolutionKind, v8,
};
use deno_error::JsErrorBox;
use deno_graph::{GraphKind, ModuleGraph};
use deno_media_type::MediaType;
use deno_npm_cache::{
    DownloadError, NpmCacheHttpClient, NpmCacheHttpClientBytesResponse, NpmCacheHttpClientResponse,
    NpmCacheSetting,
};
use deno_npm_installer::{
    LogReporter, NpmInstallerFactory, NpmInstallerFactoryOptions, graph::NpmCachingStrategy,
    lifecycle_scripts::NullLifecycleScriptsExecutor,
};
use deno_permissions::{OpenAccessKind, PermissionsContainer};
use deno_resolver::{
    factory::{ConfigDiscoveryOption, ResolverFactory, WorkspaceFactory, WorkspaceFactoryOptions},
    file_fetcher::{
        DenoGraphLoader, DenoGraphLoaderOptions, PermissionedFileFetcher,
        PermissionedFileFetcherOptions,
    },
    graph::{DefaultDenoResolverRc, NpmTypesResolutionMode, ResolveWithGraphOptions},
    loader::{LoadedModuleOrAsset, LoadedModuleSource, MemoryFiles, RequestedModuleType},
    npm::{DenoInNpmPackageChecker, NpmResolver},
};
use node_resolver::{
    InNpmPackageChecker, NodeResolutionKind, ResolutionMode, errors::PackageJsonLoadError,
};
use reqwest::{StatusCode, header};
use std::{
    borrow::Cow,
    cell::RefCell,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    rc::Rc,
    sync::Arc,
};
use sys_traits::impls::RealSys;

type NodeServices =
    deno_node::NodeExtInitServices<DenoInNpmPackageChecker, NpmResolver<RealSys>, RealSys>;

#[derive(Clone)]
pub(super) struct Loader {
    factory: Arc<ResolverFactory<RealSys>>,
    resolver: DefaultDenoResolverRc<RealSys>,
    npm: Rc<NpmInstallerFactory<NpmTransport, LogReporter, RealSys>>,
    fetcher: Arc<PermissionedFileFetcher<NullBlobStore, RealSys, Transport>>,
    prepare_lock: Rc<tokio::sync::Mutex<()>>,
    prepared: Rc<RefCell<Rc<ModuleGraph>>>,
}

impl Loader {
    pub(super) async fn new(
        cwd: PathBuf,
        main: ModuleSpecifier,
        source: String,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let workspace = Arc::new(WorkspaceFactory::new(
            RealSys,
            cwd,
            WorkspaceFactoryOptions {
                config_discovery: ConfigDiscoveryOption::Disabled,
                node_modules_dir: Some(deno_config::deno_json::NodeModulesDirMode::None),
                no_lock: true,
                ..Default::default()
            },
        ));
        let factory = Arc::new(ResolverFactory::new(workspace.clone(), Default::default()));
        let transport = Transport(
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
        );
        let npm = Rc::new(NpmInstallerFactory::new(
            factory.clone(),
            Arc::new(NpmTransport(reqwest::Client::builder().build()?)),
            Arc::new(NullLifecycleScriptsExecutor),
            LogReporter,
            None,
            NpmInstallerFactoryOptions {
                cache_setting: NpmCacheSetting::Use,
                caching_strategy: NpmCachingStrategy::Eager,
                clean_on_install: false,
                dedup_lockfile_peer_variants: false,
                lifecycle_scripts_config: Default::default(),
                production: true,
                skip_types: true,
                resolve_npm_resolution_snapshot: Box::new(|| Ok(None)),
            },
        ));
        let fetcher = Arc::new(PermissionedFileFetcher::new(
            NullBlobStore,
            workspace.global_http_cache()?.clone(),
            transport,
            Arc::new(MemoryFiles::default()),
            RealSys,
            PermissionedFileFetcherOptions {
                allow_remote: true,
                cache_setting: CacheSetting::Use,
            },
        ));
        fetcher.insert_memory_files(File {
            url: main,
            mtime: None,
            maybe_headers: None,
            source: source.into_bytes().into(),
            loaded_from: LoadedFrom::Local,
        });
        Ok(Self {
            resolver: factory.deno_resolver().await?.clone(),
            factory,
            npm,
            fetcher,
            prepare_lock: Rc::new(tokio::sync::Mutex::new(())),
            prepared: Rc::new(RefCell::new(Rc::new(ModuleGraph::new(GraphKind::CodeOnly)))),
        })
    }

    pub(super) fn node_services(&self) -> Result<NodeServices, Box<dyn std::error::Error>> {
        Ok(deno_node::NodeExtInitServices {
            node_require_loader: Rc::new(RequireLoader(self.factory.cjs_tracker()?.clone())),
            node_resolver: self.factory.node_resolver()?.clone(),
            pkg_json_resolver: self.factory.pkg_json_resolver().clone(),
            sys: RealSys,
        })
    }

    async fn prepare(
        &self,
        specifier: ModuleSpecifier,
        is_dynamic: bool,
    ) -> Result<(), JsErrorBox> {
        if self
            .factory
            .in_npm_package_checker()
            .map_err(js_error)?
            .in_npm_package(&specifier)
        {
            return Ok(());
        }
        let _prepare = self.prepare_lock.lock().await;
        if self.prepared.borrow().contains(&specifier) {
            return Ok(());
        }
        let factory = &self.factory;
        let workspace = factory.workspace_factory();
        let loader = DenoGraphLoader::new(
            self.fetcher.clone(),
            workspace.global_http_cache().map_err(js_error)?.clone(),
            factory.in_npm_package_checker().map_err(js_error)?.clone(),
            RealSys,
            DenoGraphLoaderOptions {
                file_header_overrides: Default::default(),
                include_npm_sources: false,
                permissions: None,
                file_permission_api_name: None,
                reporter: None,
            },
        );
        let config = factory.compiler_options_resolver().map_err(js_error)?;
        let jsx = deno_resolver::deno_json::JsxImportSourceConfigResolver::from_compiler_options_resolver(config)
            .map_err(js_error)?;
        let adapter = self.resolver.as_graph_resolver(
            factory.cjs_tracker().map_err(js_error)?,
            &jsx,
            None,
            NpmTypesResolutionMode::Strict,
        );
        self.npm
            .initialize_npm_resolution_if_managed()
            .await
            .map_err(js_error)?;
        let npm = self.npm.npm_deno_graph_resolver().await.map_err(js_error)?;
        let mut graph = self.prepared.borrow().as_ref().clone();
        graph
            .build(
                vec![specifier],
                vec![],
                &loader,
                deno_graph::BuildOptions {
                    is_dynamic,
                    skip_dynamic_deps: true,
                    resolver: Some(&adapter),
                    npm_resolver: Some(npm.as_ref()),
                    jsr_version_resolver: Cow::Borrowed(
                        factory.jsr_version_resolver().map_err(js_error)?,
                    ),
                    ..Default::default()
                },
            )
            .await;
        graph.valid().map_err(js_error)?;
        self.prepared.replace(Rc::new(graph));
        Ok(())
    }
}

impl ModuleLoader for Loader {
    fn resolve(
        &self,
        specifier: &str,
        referrer: &str,
        kind: ResolutionKind,
    ) -> Result<ModuleSpecifier, JsErrorBox> {
        if matches!(kind, ResolutionKind::MainModule) {
            return deno_core::resolve_import(specifier, referrer).map_err(JsErrorBox::from_err);
        }
        let referrer = ModuleSpecifier::parse(referrer).map_err(JsErrorBox::from_err)?;
        self.resolver
            .resolve_with_graph(
                &self.prepared.borrow(),
                specifier,
                &referrer,
                deno_graph::Position::zeroed(),
                ResolveWithGraphOptions {
                    mode: ResolutionMode::Import,
                    kind: NodeResolutionKind::Execution,
                    maintain_npm_specifiers: matches!(kind, ResolutionKind::DynamicImport),
                },
            )
            .map_err(js_error)
    }

    fn prepare_load(
        &self,
        specifier: &ModuleSpecifier,
        _: Option<String>,
        _: Option<String>,
        options: ModuleLoadOptions,
    ) -> Pin<Box<dyn Future<Output = Result<(), JsErrorBox>>>> {
        let loader = self.clone();
        let specifier = specifier.clone();
        Box::pin(async move { loader.prepare(specifier, options.is_dynamic_import).await })
    }

    fn load(
        &self,
        specifier: &ModuleSpecifier,
        referrer: Option<&ModuleLoadReferrer>,
        options: ModuleLoadOptions,
    ) -> ModuleLoadResponse {
        let loader = self.clone();
        let specifier = specifier.clone();
        let referrer = referrer.map(|referrer| referrer.specifier.clone());
        ModuleLoadResponse::Async(Box::pin(async move {
            let graph = loader.prepared.borrow().clone();
            let resolved = if specifier.scheme() == "npm" {
                loader.resolve_prepared_npm(&specifier, referrer.as_ref())?
            } else {
                specifier.clone()
            };
            let requested = match &options.requested_module_type {
                deno_core::RequestedModuleType::None => RequestedModuleType::None,
                deno_core::RequestedModuleType::Json => RequestedModuleType::Json,
                deno_core::RequestedModuleType::Text => RequestedModuleType::Text,
                deno_core::RequestedModuleType::Bytes => RequestedModuleType::Bytes,
                deno_core::RequestedModuleType::Other(kind) => RequestedModuleType::Other(kind),
            };
            let loaded = loader
                .factory
                .module_loader()
                .map_err(js_error)?
                .load(&graph, &resolved, referrer.as_ref(), &requested, None)
                .await
                .map_err(js_error)?;
            let LoadedModuleOrAsset::Module(module) = loaded else {
                return Err(JsErrorBox::generic(format!(
                    "Unsupported module asset: {resolved}"
                )));
            };
            let kind = match requested {
                RequestedModuleType::Text => ModuleType::Text,
                RequestedModuleType::Bytes => ModuleType::Bytes,
                _ => match module.media_type {
                    MediaType::Json => ModuleType::Json,
                    MediaType::Wasm => ModuleType::Wasm,
                    _ => ModuleType::JavaScript,
                },
            };
            let source = match module.source {
                LoadedModuleSource::ArcStr(text) => ModuleSourceCode::String(text.into()),
                LoadedModuleSource::String(Cow::Borrowed(text)) => {
                    ModuleSourceCode::String(FastString::from_static(text))
                }
                LoadedModuleSource::String(Cow::Owned(text)) => {
                    ModuleSourceCode::String(text.into())
                }
                LoadedModuleSource::ArcBytes(bytes) => ModuleSourceCode::Bytes(bytes.into()),
                LoadedModuleSource::Bytes(Cow::Borrowed(bytes)) => {
                    ModuleSourceCode::Bytes(bytes.into())
                }
                LoadedModuleSource::Bytes(Cow::Owned(bytes)) => {
                    ModuleSourceCode::Bytes(bytes.into_boxed_slice().into())
                }
            };
            Ok(ModuleSource::new_with_redirect(
                kind,
                source,
                &specifier,
                &module.specifier,
                None,
            ))
        }))
    }

    fn get_host_defined_options<'s, 'i>(
        &self,
        scope: &mut v8::PinScope<'s, 'i>,
        name: &str,
    ) -> Option<v8::Local<'s, v8::Data>> {
        let url = ModuleSpecifier::parse(name).ok()?;
        self.factory
            .in_npm_package_checker()
            .ok()?
            .in_npm_package(&url)
            .then(|| deno_node::create_host_defined_options(scope))
    }
}

impl Loader {
    fn resolve_prepared_npm(
        &self,
        specifier: &ModuleSpecifier,
        referrer: Option<&ModuleSpecifier>,
    ) -> Result<ModuleSpecifier, JsErrorBox> {
        let reference = deno_semver::npm::NpmPackageReqReference::from_specifier(specifier)
            .map_err(js_error)?;
        self.resolver
            .resolve_managed_npm_req_ref(
                &reference,
                referrer,
                ResolutionMode::Import,
                NodeResolutionKind::Execution,
            )
            .map_err(js_error)
    }
}

struct RequireLoader(deno_resolver::cjs::CjsTrackerRc<DenoInNpmPackageChecker, RealSys>);

impl deno_node::NodeRequireLoader for RequireLoader {
    fn ensure_read_permission<'a>(
        &self,
        permissions: &mut PermissionsContainer,
        path: Cow<'a, Path>,
    ) -> Result<Cow<'a, Path>, JsErrorBox> {
        permissions
            .check_open(path, OpenAccessKind::Read, Some("require"))
            .map(|path| path.into_path())
            .map_err(JsErrorBox::from_err)
    }

    fn load_text_file_lossy(&self, path: &Path) -> Result<FastString, JsErrorBox> {
        let bytes = std::fs::read(path).map_err(JsErrorBox::from_err)?;
        Ok(String::from_utf8_lossy(&bytes).into_owned().into())
    }

    fn is_maybe_cjs(&self, specifier: &ModuleSpecifier) -> Result<bool, PackageJsonLoadError> {
        self.0
            .is_maybe_cjs(specifier, MediaType::from_specifier(specifier))
    }

    fn is_maybe_cjs_from_require(
        &self,
        specifier: &ModuleSpecifier,
    ) -> Result<bool, PackageJsonLoadError> {
        self.0
            .is_maybe_cjs_from_require(specifier, MediaType::from_specifier(specifier))
    }
}

#[derive(Debug)]
struct Transport(reqwest::Client);

#[async_trait::async_trait(?Send)]
impl HttpClient for Transport {
    async fn send_no_follow(
        &self,
        url: &ModuleSpecifier,
        headers: header::HeaderMap,
    ) -> Result<SendResponse, SendError> {
        let response = self
            .0
            .get(url.clone())
            .headers(headers)
            .send()
            .await
            .map_err(|error| SendError::Failed(Box::new(error)))?;
        let headers = response.headers().clone();
        match response.status() {
            StatusCode::NOT_MODIFIED => Ok(SendResponse::NotModified),
            StatusCode::NOT_FOUND => Err(SendError::NotFound),
            status if status.is_redirection() => Ok(SendResponse::Redirect(headers)),
            status if status.is_success() => {
                let bytes = response
                    .bytes()
                    .await
                    .map_err(|error| SendError::Failed(Box::new(error)))?;
                Ok(SendResponse::Success(headers, bytes.to_vec()))
            }
            status => Err(SendError::StatusCode(status)),
        }
    }
}

#[derive(Debug)]
struct NpmTransport(reqwest::Client);

#[async_trait::async_trait(?Send)]
impl NpmCacheHttpClient for NpmTransport {
    async fn download_with_retries_on_any_tokio_runtime(
        &self,
        url: ModuleSpecifier,
        auth: Option<String>,
        etag: Option<String>,
        _: Option<&deno_npmrc::RegistryConfig>,
    ) -> Result<NpmCacheHttpClientResponse, DownloadError> {
        let mut request = self.0.get(url).header(
            header::ACCEPT,
            "application/vnd.npm.install-v1+json, application/json;q=0.8, */*;q=0.5",
        );
        if let Some(auth) = auth {
            request = request.header(header::AUTHORIZATION, auth);
        }
        if let Some(etag) = etag {
            request = request.header(header::IF_NONE_MATCH, etag);
        }
        let response = request.send().await.map_err(download_error)?;
        match response.status() {
            StatusCode::NOT_FOUND => Ok(NpmCacheHttpClientResponse::NotFound),
            StatusCode::NOT_MODIFIED => Ok(NpmCacheHttpClientResponse::NotModified),
            status if status.is_success() => {
                let etag = response
                    .headers()
                    .get(header::ETAG)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned);
                let bytes = response.bytes().await.map_err(download_error)?.to_vec();
                Ok(NpmCacheHttpClientResponse::Bytes(
                    NpmCacheHttpClientBytesResponse { bytes, etag },
                ))
            }
            status => Err(DownloadError {
                status_code: Some(status.as_u16()),
                error: js_error(format_args!("{}: {status}", response.url())),
            }),
        }
    }
}

fn download_error(error: reqwest::Error) -> DownloadError {
    DownloadError {
        status_code: error.status().map(|status| status.as_u16()),
        error: js_error(error),
    }
}

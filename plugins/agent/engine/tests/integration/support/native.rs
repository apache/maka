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

use maka_agent_api::{
    Configuration, EXPORT, IMPLEMENTATION, ModelSelection,
    contract::{BackendPreference, SendResult},
};
use maka_agent_facts::{
    configuration::{
        CatalogMutationResult, ConnectionCatalogEntryUpdate, ConnectionCredentialTarget,
        ConnectionVersionBasis, ModelOverride, Patch, UpdateCatalogConnectionInput,
    },
    durable::RunId,
};
use maka_agent_state::{DriverDomain, Store, fold::RunView};
use maka_capabilities::call::{Attachments, Identity, Issuer, Scope};
use maka_config::ConfigurationStore;
use maka_event_log::{
    StoreError,
    root::{RootNamespaces, RootOwner},
    root_store::RootStore,
};
use maka_host_runtime::application::{
    Application, Binding, Caller, Handler, Invocation, NativeActivation, NativeOwner,
    NativeRegistry, Policy, RecoveryInvocation,
    transport::{NativeGrant, PeerPolicy},
};
use maka_packages::{MANIFEST_FILE, Package};
use maka_plugin_core::{
    composition::{
        Configuration as NodeConfiguration, Input, InstanceId, Node, PackageUse, Target,
    },
    contract::{Contract, Interface, ServiceTarget},
    operation::{OperationOutcome, OperationReply, OperationResult, Receipt},
    runtime::Published,
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, error::Error, path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub type FixtureResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

#[derive(Clone)]
pub struct FixtureService {
    contract: Contract,
    implementation: FixtureImplementation,
}

#[derive(Clone)]
enum FixtureImplementation {
    Actor {
        handler: Arc<dyn Handler>,
        owner: Arc<dyn NativeOwner>,
    },
    Provider {
        implementation: String,
        export: String,
        register: fn(&mut NativeRegistry) -> Result<(), String>,
    },
}

impl FixtureService {
    pub fn new<T: Handler + NativeOwner>(contract: Contract, actor: Arc<T>) -> Self {
        Self {
            contract,
            implementation: FixtureImplementation::Actor {
                handler: actor.clone(),
                owner: actor,
            },
        }
    }

    pub fn from_provider(
        contract: Contract,
        implementation: impl Into<String>,
        export: impl Into<String>,
        register: fn(&mut NativeRegistry) -> Result<(), String>,
    ) -> Self {
        Self {
            contract,
            implementation: FixtureImplementation::Provider {
                implementation: implementation.into(),
                export: export.into(),
                register,
            },
        }
    }

    fn implementation(&self) -> &str {
        match &self.implementation {
            FixtureImplementation::Actor { .. } => "fixture.tools",
            FixtureImplementation::Provider { implementation, .. } => implementation,
        }
    }

    fn export(&self) -> &str {
        match &self.implementation {
            FixtureImplementation::Actor { .. } => "Tools",
            FixtureImplementation::Provider { export, .. } => export,
        }
    }

    fn register(&self, registry: &mut NativeRegistry) -> Result<(), String> {
        match &self.implementation {
            FixtureImplementation::Provider { register, .. } => register(registry),
            FixtureImplementation::Actor { handler, owner } => {
                let contract = self.contract.clone();
                let handler = handler.clone();
                let owner = owner.clone();
                registry.insert(
                    "fixture.tools".into(),
                    Arc::new(move |_, _| {
                        let contract = contract.clone();
                        let handler = handler.clone();
                        let owner = owner.clone();
                        Box::pin(async move {
                            NativeActivation {
                                exports: Ok(BTreeMap::from([(
                                    "Tools".into(),
                                    Published {
                                        contract,
                                        value: handler,
                                    },
                                )])),
                                owner,
                            }
                        })
                    }),
                )
            }
        }
    }
}

struct SdkCaller(Caller);

struct SdkPolicy {
    issuer: Issuer,
    native: PeerPolicy,
}
impl Policy for SdkPolicy {
    fn caller(&self, scope: &Scope) -> Option<Caller> {
        self.issuer
            .evidence::<SdkCaller>(scope)
            .map(|caller| caller.0.clone())
    }

    fn lookup_intent(
        &self,
        invocation: maka_host_runtime::application::IntentLookupInvocation<'_>,
    ) -> Result<(), String> {
        self.native.lookup_intent(invocation)
    }

    fn admit(&self, invocation: Invocation<'_>) -> Result<(), String> {
        if invocation.native_origin.is_some() {
            return self.native.admit(invocation);
        }
        if self
            .issuer
            .evidence::<SdkCaller>(invocation.scope)
            .is_some()
            && invocation.consumer.instance() == &consumer_id()
            && invocation.provider.instance() == &provider_id()
            && invocation.export == EXPORT
        {
            Ok(())
        } else {
            Err("fixture caller is not authorized for this Agent binding".into())
        }
    }

    fn recover(&self, invocation: RecoveryInvocation<'_>) -> Result<(), String> {
        if invocation.native_origin.is_some() {
            return self.native.recover(invocation);
        }
        if self
            .issuer
            .evidence::<SdkCaller>(invocation.scope)
            .is_some()
            && invocation.consumer.instance() == &consumer_id()
            && invocation.reference.namespace == provider_id()
            && invocation.reference.export == EXPORT
        {
            Ok(())
        } else {
            Err("fixture caller is not authorized for this original Agent receipt".into())
        }
    }
}

pub struct NativeFixture {
    pub root: Arc<RootStore>,
    pub state: Store,
    pub config: Arc<ConfigurationStore>,
    pub app: Application,
    issuer: Issuer,
    caller: Caller,
}

impl NativeFixture {
    /// `path` owns the fixture's Root and coordination directories. Reopening
    /// retains the actual deployment namespace, sessions, receipts and catalog.
    pub async fn open(path: &Path, configuration: Configuration) -> FixtureResult<Self> {
        Self::open_inner(path, configuration, None, None, None).await
    }

    pub async fn open_with_service(
        path: &Path,
        configuration: Configuration,
        service: FixtureService,
    ) -> FixtureResult<Self> {
        Self::open_inner(path, configuration, Some(service), None, None).await
    }

    pub async fn open_with_skills(
        path: &Path,
        configuration: Configuration,
        service: FixtureService,
        skills: &Path,
    ) -> FixtureResult<Self> {
        Self::open_inner(path, configuration, Some(service), Some(skills), None).await
    }

    pub async fn open_with_pricing(
        path: &Path,
        configuration: Configuration,
        service: FixtureService,
        pricing: Arc<dyn maka_agent_engine::pricing::Pricing>,
    ) -> FixtureResult<Self> {
        Self::open_inner(path, configuration, Some(service), None, Some(pricing)).await
    }

    async fn open_inner(
        path: &Path,
        configuration: Configuration,
        service: Option<FixtureService>,
        skills: Option<&Path>,
        pricing: Option<Arc<dyn maka_agent_engine::pricing::Pricing>>,
    ) -> FixtureResult<Self> {
        let helper = std::path::PathBuf::from(
            std::env::var_os("CARGO_BIN_EXE_maka")
                .ok_or("the CI runner must supply the actual relocated Maka helper")?,
        );
        if !helper.is_file() {
            return Err(format!(
                "build the actual Maka native helper before running Agent integration tests: {}",
                helper.display()
            )
            .into());
        }
        let namespaces = RootNamespaces {
            ownership: path.join("owners"),
            control: path.join("control"),
        };
        let root_path = path.join("root");
        let owner = Arc::new(if root_path.try_exists()? {
            RootOwner::open_existing(&root_path, &namespaces)?
        } else {
            RootOwner::create(&root_path, &namespaces)?
        });
        let migrations = [
            maka_event_log::ROOT_MIGRATIONS,
            maka_agent_state::MIGRATIONS,
        ]
        .concat();
        let root = Arc::new(RootStore::open(owner.clone(), &migrations).await?);
        let data = root.data_writer()?;
        let domain = DriverDomain::new(data.clone())?;
        let state = Store::new(data, domain)?;
        let config = Arc::new(ConfigurationStore::for_root(owner).await?);

        let source = if let Some(launch) = root.application_launch().await? {
            if launch.pending.is_some() {
                return Err("fixture application has an unfinished original launch".into());
            }
            let loaded = root
                .load_application(launch.deployment)
                .await?
                .ok_or("fixture launch has no committed application")?;
            let mut input = loaded.source().input.clone();
            let provider = input
                .instances
                .get_mut("provider")
                .ok_or("fixture application has no original Agent provider")?;
            let values = serde_json::from_value(serde_json::to_value(&configuration)?)?;
            if provider.configuration.values != values {
                provider.configuration.values = values;
                let source = root
                    .commit_application(
                        launch.deployment,
                        loaded.source().reference.revision,
                        input,
                        loaded.source().remote_exports.clone(),
                        loaded.packages().to_vec(),
                    )
                    .await?;
                root.select_committed_application_launch(source.clone(), launch.configuration)
                    .await?;
                source
            } else {
                loaded.source().reference.clone()
            }
        } else {
            let (input, packages) = composition(&configuration, service.as_ref(), skills)?;
            let source = root
                .commit_application(Uuid::new_v4(), 0, input, vec![], packages)
                .await?;
            root.select_committed_application_launch(source.clone(), json!({}))
                .await?;
            source
        };
        let catalog = Arc::new(maka_providers::catalog::Catalog::new(
            maka_providers::catalog::Snapshot::bundled()?,
        ));
        let mut native = NativeRegistry::default();
        match pricing {
            Some(pricing) => maka_agent_native::provide_with_pricing(
                &mut native,
                catalog,
                state.clone(),
                helper,
                pricing,
            )?,
            None => maka_agent_native::provide(&mut native, catalog, state.clone(), helper)?,
        }
        if skills.is_some() {
            maka_skills_native::provide(&mut native)?;
        }
        if let Some(service) = &service {
            service.register(&mut native)?;
        }
        let mut native_grants = Vec::new();
        if let Some(service) = &service {
            let methods: std::collections::BTreeSet<_> = configuration
                .tools
                .iter()
                .filter(|tool| matches!(&tool.target, ServiceTarget::Import { name } if name == "fixture"))
                .map(|tool| tool.method.clone())
                .collect();
            if !methods.is_empty() {
                let Interface::Service { methods: declared } = &service.contract.interface else {
                    return Err(
                        "fixture tool selection requires the installed service contract".into(),
                    );
                };
                if !methods.iter().all(|method| declared.contains_key(method)) {
                    return Err(
                        "selected fixture method is absent from the installed contract".into(),
                    );
                }
                native_grants.push(NativeGrant {
                    origin: provider_id(),
                    consumer: provider_id(),
                    provider: InstanceId(vec![Uuid::from_u128(3)]),
                    export: service.export().into(),
                    methods,
                    recovery: true,
                });
            }
        }
        let native_policy = PeerPolicy::with_native_grants(native_grants)?;
        let issuer = native_policy.issuer();
        let policy = Arc::new(SdkPolicy {
            issuer: issuer.clone(),
            native: native_policy,
        });
        let app = Application::start_from_store(
            root.clone(),
            source.deployment,
            native,
            issuer.clone(),
            policy,
            Some(maka_host_js::factory(Default::default())),
        )
        .await?;
        app.ready().await?;
        let consumer = app.client().activation(&consumer_id())?;
        let caller = Caller::new(Arc::new(()), source, consumer_id(), consumer.epoch());
        Ok(Self {
            root,
            state,
            config,
            app,
            issuer,
            caller,
        })
    }

    /// The scope is new live issuer evidence, never authority reconstructed from RunSpec.
    pub fn scope(&self) -> Scope {
        self.issuer
            .issue_with(
                Identity::Remote {
                    request_id: Uuid::new_v4(),
                },
                SdkCaller(self.caller.clone()),
                CancellationToken::new(),
            )
            .expect("fixture issuer is live")
    }

    pub async fn binding(&self) -> Result<Binding, String> {
        let client = self.app.client();
        let mut bindings = client
            .bind(client.activation(&consumer_id())?, EXPORT.into())
            .await?;
        if bindings.len() != 1 {
            return Err("fixture Agent import must resolve to exactly one provider".into());
        }
        Ok(bindings.remove(0))
    }

    pub async fn query(&self, method: &str, input: Value) -> Result<Value, String> {
        self.app
            .client()
            .start(
                self.binding().await?,
                method.into(),
                input,
                self.scope(),
                Attachments::new().into(),
            )
            .await?
            .result()
            .await
    }

    /// Return the actual Host receipt, including its original recovery reference.
    pub async fn mutation(
        &self,
        method: &str,
        input: Value,
        operation: Uuid,
    ) -> Result<OperationReply, String> {
        let client = self.app.client();
        let prepared = client
            .prepare_mutation(
                self.binding().await?,
                method.into(),
                input,
                self.scope(),
                operation,
                Attachments::new().into(),
            )
            .await?;
        let recovery = json!({ "reference": prepared.reference() });
        Ok(client
            .mutate_owned(prepared, recovery)
            .await?
            .result()
            .await)
    }

    pub async fn create(
        &self,
        title: &str,
        workspace: &Path,
        backend: Option<BackendPreference>,
    ) -> Result<String, String> {
        let workspace = workspace.to_str().ok_or("workspace path is not UTF-8")?;
        let value = self
            .mutation_value(
                "create",
                json!({
                    "title": title, "labels": [], "backend": backend,
                    "workspace": {"kind": "directory", "path": workspace},
                }),
            )
            .await?;
        value["session"]["id"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| "Agent create returned no session identity".into())
    }

    pub async fn send(
        &self,
        session: &str,
        message: &str,
        backend: Option<BackendPreference>,
    ) -> Result<SendResult, String> {
        let value = self.mutation_value("send", json!({
            "sessionId": session, "message": message, "delivery": "queue", "backend": backend,
        })).await?;
        serde_json::from_value(value).map_err(|error| error.to_string())
    }

    pub async fn mutation_value(&self, method: &str, input: Value) -> Result<Value, String> {
        let reply = self.mutation(method, input, Uuid::new_v4()).await?;
        match reply.receipt {
            Receipt::Recorded {
                outcome:
                    OperationOutcome::Returned {
                        result: OperationResult::Success { value },
                    },
                ..
            } => Ok(value),
            Receipt::Recorded {
                outcome:
                    OperationOutcome::Returned {
                        result: OperationResult::Failure { diagnostic },
                    },
                ..
            } => Err(diagnostic),
            receipt => Err(format!(
                "Agent {method} did not return a successful receipt: {receipt:?}"
            )),
        }
    }

    /// Reuse a previously configured fixture connection on reopen; never reset its credentials.
    pub async fn configure_model(
        &self,
        base_url: &str,
        model_id: &str,
        api_key: &str,
    ) -> FixtureResult<ModelSelection> {
        let snapshot = self.config.catalog().await?;
        if let Some(existing) = snapshot
            .connections
            .iter()
            .find(|entry| entry.slug == "fixture")
        {
            if existing.configuration != json!({"baseUrl": base_url})
                || !existing.enabled
                || !existing.enabled_model_ids.iter().any(|id| id == model_id)
            {
                return Err(
                    "existing fixture connection differs from the requested model configuration"
                        .into(),
                );
            }
            return Ok(ModelSelection {
                connection_id: existing.connection_id.clone(),
                model_id: model_id.into(),
            });
        }
        let provider = json!({
            "packageId": maka_providers::api::ID, "entryId": maka_providers::api::ID,
            "scope": "profile", "name": "openai-compatible",
        });
        let created = self.config.create_connection(serde_json::from_value(json!({
            "expectedCatalogRevision": snapshot.revision,
            "connection": {"slug": "fixture", "name": "Fixture", "provider": provider,
                "configuration": {"baseUrl": base_url}, "enabled": true, "enabledModelIds": [model_id]},
        }))?).await?;
        let CatalogMutationResult::Committed {
            connection: Some(basis),
            ..
        } = created
        else {
            return Err(format!("fixture connection was not committed: {created:?}").into());
        };
        let prepared = self
            .config
            .prepare_oauth_login(maka_agent_facts::oauth::LoginStart {
                expected_credential: None,
                attempt_id: Uuid::new_v4().to_string(),
                target: maka_agent_facts::oauth::Target::Existing {
                    expected: ConnectionCredentialTarget {
                        connection_id: basis.connection_id.clone(),
                        revision: basis.revision,
                        provider: serde_json::from_value(provider)?,
                        slug: "fixture".into(),
                        configuration: json!({"baseUrl": base_url}),
                    },
                    configuration: json!({"baseUrl": base_url}),
                },
                authentication: maka_agent_facts::provider::AuthenticationInput {
                    method: "api-key".into(),
                    input: json!({"apiKey": api_key}),
                },
            })
            .await?;
        let maka_config::oauth::enrollment::LoginPreparation::Ready(ticket) = prepared else {
            return Err("fixture credential preparation was not ready".into());
        };
        if !ticket.claim().await? {
            return Err("fixture credential ticket was not claimed".into());
        }
        let completion = ticket
            .complete(
                maka_agent_facts::provider::Credential {
                    secret: api_key.into(),
                    refresh_at: None,
                },
                1,
            )
            .await?;
        if !matches!(
            completion,
            maka_config::oauth::enrollment::LoginCompletion::Committed(_)
        ) {
            return Err("fixture credential was not committed".into());
        }
        let connection = self
            .config
            .catalog()
            .await?
            .connections
            .into_iter()
            .find(|connection| connection.connection_id == basis.connection_id)
            .ok_or("fixture connection disappeared after credential enrollment")?;
        let configured = self
            .config
            .update_connection(UpdateCatalogConnectionInput {
                expected: ConnectionVersionBasis {
                    connection_id: connection.connection_id,
                    revision: connection.revision,
                },
                changes: ConnectionCatalogEntryUpdate {
                    name: None,
                    configuration: None,
                    enabled: None,
                    enabled_model_ids: None,
                    model_overrides: Patch::Set(BTreeMap::from([(
                        model_id.into(),
                        ModelOverride {
                            code_mode: Some(false),
                            ..Default::default()
                        },
                    )])),
                    request_body_overlay: Patch::Keep,
                },
            })
            .await?;
        if !matches!(configured, CatalogMutationResult::Committed { .. }) {
            return Err(format!("fixture Direct mode was not committed: {configured:?}").into());
        }
        Ok(ModelSelection {
            connection_id: basis.connection_id,
            model_id: model_id.into(),
        })
    }

    pub async fn wait_terminal(&self, run: RunId) -> Result<RunView, StoreError> {
        let mut changes = self.state.subscribe()?;
        loop {
            changes.borrow_and_update();
            let view = self.state.frontier(run).await?;
            if view.terminal.is_some() {
                return Ok(view);
            }
            changes
                .changed()
                .await
                .map_err(|_| StoreError::ConnectionClosed)?;
        }
    }

    pub async fn shutdown(self) -> FixtureResult<()> {
        self.app.shutdown().await?;
        self.config.shutdown().await?;
        self.root.shutdown().await?;
        Ok(())
    }
}

fn provider_id() -> InstanceId {
    InstanceId(vec![Uuid::from_u128(1)])
}

fn consumer_id() -> InstanceId {
    InstanceId(vec![Uuid::from_u128(2)])
}

fn composition(
    configuration: &Configuration,
    service: Option<&FixtureService>,
    skills: Option<&Path>,
) -> FixtureResult<(Input, Vec<Package>)> {
    let mut imports = match service {
        Some(service) => {
            json!({"fixture":{"contract":service.contract,"cardinality":maka_plugin_core::contract::Cardinality::One}})
        }
        None => json!({}),
    };
    if skills.is_some() {
        imports["skills"] = json!({"contract":maka_skills_api::contract(),"cardinality":maka_plugin_core::contract::Cardinality::One});
    }
    let provider = Package::new(BTreeMap::from([(
        MANIFEST_FILE.into(),
        serde_json::to_vec(
            &json!({"schemaVersion": 1, "id": "agent", "application": {"host": {
                "implementation": {"kind": "native", "implementation": IMPLEMENTATION},
                "configuration": maka_agent_api::configuration_schema(), "imports": imports,
                "exports": {(EXPORT): {"contract": maka_agent_api::contract(), "availability": "required"}},
            }}}),
        )?,
    )]))?;
    let consumer = Package::new(BTreeMap::from([
        (
            MANIFEST_FILE.into(),
            serde_json::to_vec(&json!({
                "schemaVersion": 1, "id": "consumer", "application": {"host": {
                    "implementation": {"kind": "javascript", "module": "host.mjs", "realm": "shared"},
                    "configuration": {"type": "object", "additionalProperties": false},
                    "imports": {(EXPORT): {"contract": maka_agent_api::contract(), "cardinality": maka_plugin_core::contract::Cardinality::One}},
                    "exports": {},
                }},
            }))?,
        ),
        (
            "host.mjs".into(),
            b"export function activate() { return {}; }".to_vec(),
        ),
    ]))?;
    let node = |key, package: &Package| Node {
        key: Uuid::from_u128(key),
        package: package.application_ref().into(),
        use_package: PackageUse::Host,
        configuration: Default::default(),
        parameters: Default::default(),
        disabled: false,
        overrides: vec![],
        bindings: BTreeMap::new(),
    };
    let mut provider_bindings = BTreeMap::new();
    if let Some(service) = service {
        provider_bindings.insert(
            "fixture".into(),
            vec![Target::Instance {
                path: vec!["tools".into()],
                export: service.export().into(),
            }],
        );
    }
    if skills.is_some() {
        provider_bindings.insert(
            "skills".into(),
            vec![Target::Instance {
                path: vec!["skills".into()],
                export: maka_skills_api::EXPORT.into(),
            }],
        );
    }
    let mut input = Input {
        base: None,
        ui: None,
        instances: BTreeMap::from([
            (
                "provider".into(),
                Node {
                    configuration: NodeConfiguration {
                        values: serde_json::from_value(serde_json::to_value(configuration)?)?,
                        parameters: Default::default(),
                    },
                    bindings: provider_bindings,
                    ..node(1, &provider)
                },
            ),
            (
                "consumer".into(),
                Node {
                    bindings: BTreeMap::from([(
                        EXPORT.into(),
                        vec![Target::Instance {
                            path: vec!["provider".into()],
                            export: EXPORT.into(),
                        }],
                    )]),
                    ..node(2, &consumer)
                },
            ),
        ]),
    };
    let mut packages = vec![provider, consumer];
    if let Some(service) = service {
        let tools = Package::new(BTreeMap::from([(
            MANIFEST_FILE.into(),
            serde_json::to_vec(
                &json!({"schemaVersion":1,"id":"fixture-tools","application":{"host":{
                    "implementation":{"kind":"native","implementation":service.implementation()},
                    "configuration":{"type":"object","additionalProperties":false},
                    "imports":{},
                    "exports":{(service.export()):{"contract":service.contract,"availability":"required"}}
                }}}),
            )?,
        )]))?;
        input.instances.insert("tools".into(), node(3, &tools));
        packages.push(tools);
    }
    if let Some(skills) = skills {
        let library = Package::new(BTreeMap::from([(
            MANIFEST_FILE.into(),
            serde_json::to_vec(
                &json!({"schemaVersion":1,"id":"fixture-skills","application":{"host":{
                    "implementation":{"kind":"native","implementation":maka_skills_api::IMPLEMENTATION},
                    "configuration":maka_skills_api::configuration_schema(),
                    "imports":{},
                    "exports":{(maka_skills_api::EXPORT):{"contract":maka_skills_api::contract(),"availability":"required"}}
                }}}),
            )?,
        )]))?;
        input.instances.insert("skills".into(), Node {
            configuration: NodeConfiguration {
                values: serde_json::from_value(json!({
                    "bundled":false,"home":null,"projectRoots":[],"manage":false,"preferences":false,
                    "sources":[{"id":"fixture","label":"Fixture","path":skills}],
                }))?,
                parameters: Default::default(),
            },
            ..node(4, &library)
        });
        packages.push(library);
    }
    Ok((input, packages))
}

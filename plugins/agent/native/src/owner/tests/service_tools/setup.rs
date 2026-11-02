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

enum Service {
    Counter {
        handler: Option<Arc<Counter>>,
        query: bool,
    },
    Computer(Arc<Counter>),
    Questions,
    Forms,
    File(&'static str),
    FileEditors,
    Processes {
        health: bool,
        isolated: bool,
    },
    #[cfg(target_os = "macos")]
    Protocol,
    Skills(Skills),
    Images(images::Source),
    Web,
    Jev,
}
struct Skills {
    path: std::path::PathBuf,
    standard: bool,
    preparation: Option<Preparation>,
}
struct Preparation {
    tools: bool,
    handler: Option<(Arc<dyn Handler>, Arc<dyn NativeOwner>)>,
}

pub(in crate::owner::tests) struct Setup {
    service: Service,
    tool_name: Option<&'static str>,
    granted: bool,
    pub(in crate::owner::tests) nestable: bool,
    pub(in crate::owner::tests) confirmation: contract::ToolConfirmation,
}

impl Setup {
    fn new(service: Service) -> Self {
        Self {
            service,
            tool_name: None,
            granted: true,
            nestable: false,
            confirmation: contract::ToolConfirmation::Preapproved,
        }
    }
    pub(in crate::owner::tests) fn named(mut self, name: &'static str) -> Self {
        self.tool_name = Some(name);
        self
    }
    pub(super) fn javascript() -> Self {
        Self::new(Service::Counter {
            handler: None,
            query: false,
        })
    }
    pub(super) fn native(counter: Arc<Counter>, granted: bool) -> Self {
        Self {
            granted,
            ..Self::new(Service::Counter {
                handler: Some(counter),
                query: false,
            })
        }
    }
    pub(super) fn with_query(mut self, query: bool) -> Self {
        let Service::Counter { query: value, .. } = &mut self.service else {
            panic!("counter fixture")
        };
        *value = query;
        self
    }
    pub(in crate::owner::tests) fn forms() -> Self {
        Self::new(Service::Forms)
    }
    pub(in crate::owner::tests) fn questions() -> Self {
        Self::new(Service::Questions)
    }
    pub(in crate::owner::tests) fn files(method: &'static str) -> Self {
        Self::new(Service::File(method))
    }
    pub(super) fn file_editors() -> Self {
        Self::new(Service::FileEditors)
    }
    pub(in crate::owner::tests) fn skills(path: std::path::PathBuf) -> Self {
        Self::new(Service::Skills(Skills {
            path,
            standard: false,
            preparation: None,
        }))
    }
    pub(in crate::owner::tests) fn with_standard_sources(mut self) -> Self {
        let Service::Skills(skills) = &mut self.service else {
            panic!("skills fixture")
        };
        skills.standard = true;
        self
    }
    pub(in crate::owner::tests) fn skill_preparation(
        path: std::path::PathBuf,
        tools: bool,
    ) -> Self {
        Self::new(Service::Skills(Skills {
            path,
            standard: false,
            preparation: Some(Preparation {
                tools,
                handler: None,
            }),
        }))
    }
    pub(super) fn with_preparation(
        mut self,
        handler: Arc<dyn Handler>,
        owner: Arc<dyn NativeOwner>,
    ) -> Self {
        let Service::Skills(Skills {
            preparation: Some(preparation),
            ..
        }) = &mut self.service
        else {
            panic!("skill preparation fixture")
        };
        preparation.handler = Some((handler, owner));
        self
    }
    pub(in crate::owner::tests) fn skill_import(&self) -> Option<String> {
        matches!(
            self.service,
            Service::Skills(Skills {
                preparation: Some(_),
                ..
            })
        )
        .then(|| "service".into())
    }
    #[cfg(target_os = "macos")]
    pub(in crate::owner::tests) fn protocol() -> Self {
        Self::new(Service::Protocol)
    }
    pub(in crate::owner::tests) fn jev() -> Self {
        Self::new(Service::Jev)
    }
    pub(super) fn computer(handler: Arc<Counter>) -> Self {
        Self::new(Service::Computer(handler))
    }
    pub(in crate::owner::tests) fn web() -> Self {
        Self::new(Service::Web)
    }
    pub(in crate::owner::tests) fn processes() -> Self {
        Self::new(Service::Processes {
            health: false,
            isolated: false,
        })
    }
    #[cfg(target_os = "macos")]
    pub(in crate::owner::tests) fn health() -> Self {
        Self {
            nestable: true,
            ..Self::new(Service::Processes {
                health: true,
                isolated: false,
            })
        }
    }
    pub(in crate::owner::tests) fn images(source: images::Source) -> Self {
        Self::new(Service::Images(source))
    }
    pub(in crate::owner::tests) fn without_grant(mut self) -> Self {
        self.granted = false;
        self
    }
    pub(in crate::owner::tests) fn selections(&self) -> Vec<contract::ServiceTool> {
        self.primary_selections()
    }
    fn primary_selections(&self) -> Vec<contract::ServiceTool> {
        let methods: Vec<_> = match &self.service {
            #[cfg(target_os = "macos")]
            Service::Protocol => return vec![],
            Service::Skills(Skills {
                preparation: Some(Preparation { tools: false, .. }),
                ..
            }) => return vec![],
            Service::FileEditors => vec![
                ("readText", "InspectDocument"),
                ("write", "ReplaceDocument"),
                ("edit", "AdjustDocument"),
                ("applyPatch", "PatchDocument"),
            ],
            Service::Web => vec![("fetch", "WebFetch"), ("search", "WebSearch")],
            Service::Skills(skills) => {
                if skills.preparation.is_some() {
                    vec![("search", "FindGuide"), ("load", "LoadGuide")]
                } else {
                    vec![("search", "SkillSearch"), ("load", "Skill")]
                }
            }
            Service::Processes { health, .. } => {
                let mut methods = vec![
                    ("execute", "Execute"),
                    ("read", "ReadProcess"),
                    ("writeStdin", "WriteStdin"),
                    ("stop", "StopProcess"),
                ];
                if *health {
                    methods.push(("health", "BackgroundTaskHealth"));
                }
                methods
            }
            _ => return vec![self.selection()],
        };
        methods
            .into_iter()
            .map(|(method, name)| {
                let mut selection = self.selection();
                selection.method = method.into();
                selection.name = name.into();
                match &self.service {
                    Service::FileEditors => selection.presentation = None,
                    Service::Skills(_) => selection.input = contract::ToolInput::Skill,
                    Service::Processes { .. } => {
                        selection.input = if method == "execute" {
                            contract::ToolInput::Shell
                        } else {
                            contract::ToolInput::Json
                        };
                        selection.title = None;
                        selection.presentation = (method != "health")
                            .then(|| format!("maka.workspace.Processes@1/{method}"));
                    }
                    _ => {}
                }
                selection
            })
            .collect()
    }
    pub(in crate::owner::tests) fn selection(&self) -> contract::ServiceTool {
        let (name, description) = match self.service {
            Service::Web => ("WebFetch", "Increment the explicitly selected counter."),
            Service::File(_) | Service::FileEditors => {
                ("WorkspaceFile", "Use the selected workspace files.")
            }
            Service::Images(_) => (
                "WorkspaceFile",
                "Increment the explicitly selected counter.",
            ),
            Service::Forms => ("AskUserForm", "Increment the explicitly selected counter."),
            Service::Questions => ("AskUserQuestion", "Ask required bounded questions."),
            _ => ("Counter", "Increment the explicitly selected counter."),
        };
        contract::ServiceTool {
            nestable: self.nestable,
            input: if matches!(self.service, Service::Web) {
                contract::ToolInput::Web
            } else {
                contract::ToolInput::Json
            },
            presentation: match self.service {
                Service::File(method)
                    if matches!(
                        method,
                        "readText" | "glob" | "grep" | "write" | "edit" | "applyPatch"
                    ) =>
                {
                    Some(format!("maka.workspace.Files@1/{method}"))
                }
                Service::FileEditors => Some("maka.workspace.Files@1/readText".into()),
                _ => None,
            },
            title: None,
            confirmation: self.confirmation,
            result: if matches!(self.service, Service::Computer(_)) {
                contract::ToolResult::Computer
            } else if matches!(self.service, Service::File("readImage"))
                || matches!(&self.service, Service::Images(_))
            {
                contract::ToolResult::Image
            } else {
                contract::ToolResult::Json
            },
            name: self.tool_name.unwrap_or(name).into(),
            description: description.into(),
            target: maka_host_runtime::application::ServiceTarget::Import {
                name: "service".into(),
            },
            method: self.service.method().into(),
        }
    }
    pub(in crate::owner::tests) fn install(&self, input: &mut Input, packages: &mut Vec<Package>) {
        let mut manifest = packages[0].manifest().clone();
        let mut declaration = manifest.application.as_ref().unwrap().declaration().clone();
        let imports = &mut declaration.host.as_mut().unwrap().imports;
        imports.insert(
            "service".into(),
            Import {
                contract: self.service.contract(),
                cardinality: Cardinality::One,
            },
        );

        let provider = Package::new(BTreeMap::from([(MANIFEST_FILE.into(), {
            manifest.application =
                Some(maka_plugin_core::package::CheckedDeclaration::new(declaration).unwrap());
            serde_json::to_vec(&manifest).unwrap()
        })]))
        .unwrap();
        let node = input.instances.get_mut("provider").unwrap();
        node.package = provider.application_ref().into();
        node.bindings.insert(
            "service".into(),
            vec![Target::Instance {
                path: vec!["service".into()],
                export: self.service.export().into(),
            }],
        );

        packages[0] = provider;
        let mut exports = json!({(self.service.export()):{"contract":self.service.contract(),"availability":"required"}});
        if matches!(self.service, Service::Processes { .. }) {
            exports["terminal"] = json!({"contract":maka_workspace_api::terminal::contract(),"availability":"required"});
        }
        let mut files=BTreeMap::from([(MANIFEST_FILE.into(),serde_json::to_vec(&json!({"schemaVersion":1,"id":"fixture.counter","application":{"host":{
            "implementation":self.service.implementation(),"configuration":self.service.schema(),"imports":{},"exports":exports
        }}})).unwrap())]);
        match &self.service {
            Service::Images(source) => {
                files.insert("images.mjs".into(), source.javascript().into_bytes());
            }
            Service::Counter { handler: None, .. } => {
                let methods =
                    "write({amount}){return {effects:effects+=amount};},read(){return {effects};}";
                files.insert("counter.mjs".into(),format!(r#"let effects=0; export function activate(){{return {{Counter:{{contract:{},service:['counter']}}}};}} export const counter={{{methods}}};"#,serde_json::to_string(&counter_contract()).unwrap()).into_bytes());
            }
            _ => {}
        }
        let package = Package::new(files).unwrap();
        let roots = input.instances["provider"].configuration.values["workspaceRoots"].clone();
        input.instances.insert(
            "service".into(),
            Node {
                key: Uuid::from_u128(21),
                package: package.application_ref().into(),
                use_package: PackageUse::Host,
                configuration: NodeConfiguration {
                    values: serde_json::from_value(self.service.configuration(roots)).unwrap(),
                    parameters: Default::default(),
                },
                parameters: Default::default(),
                disabled: false,
                overrides: vec![],
                bindings: Default::default(),
            },
        );
        packages.push(package);
        if matches!(self.service, Service::Processes { health: true, .. }) {
            super::super::health::install(input, packages);
        }
        let terminal = match self.service {
            Service::Processes { .. } => {
                Some(("terminal", maka_workspace_api::terminal::contract()))
            }
            #[cfg(target_os = "macos")]
            Service::Protocol => Some(("protocol", maka_workspace_api::protocol::contract())),
            _ => None,
        };
        if let Some((import, contract)) = terminal {
            let consumer = &packages[1];
            let mut files = consumer.files().clone();
            let mut manifest = consumer.manifest().clone();
            let mut declaration = manifest.application.as_ref().unwrap().declaration().clone();
            declaration.host.as_mut().unwrap().imports.insert(
                import.into(),
                Import {
                    contract,
                    cardinality: Cardinality::One,
                },
            );
            manifest.application =
                Some(maka_plugin_core::package::CheckedDeclaration::new(declaration).unwrap());
            files.insert(MANIFEST_FILE.into(), serde_json::to_vec(&manifest).unwrap());
            let consumer = Package::new(files).unwrap();
            for name in ["a", "b"] {
                let node = input.instances.get_mut(name).unwrap();
                node.package = consumer.application_ref().into();
                node.bindings.insert(
                    import.into(),
                    vec![Target::Instance {
                        path: vec!["service".into()],
                        export: import.into(),
                    }],
                );
            }
            packages[1] = consumer;
        }
    }
    pub(in crate::owner::tests) fn provide(&self, registry: &mut NativeRegistry) {
        self.service.provide(registry);
    }
    pub(in crate::owner::tests) fn policy(&self) -> Arc<maka_transport::transport::PeerPolicy> {
        Arc::new(
            maka_transport::transport::PeerPolicy::with_native_grants(self.native_grants())
                .unwrap(),
        )
    }
    fn native_grants(&self) -> Vec<maka_transport::transport::NativeGrant> {
        use maka_transport::transport::NativeGrant;
        if !self.granted {
            return vec![];
        }
        let mut grants = vec![NativeGrant {
            origin: id(1),
            consumer: id(1),
            provider: id(21),
            export: self.service.export().into(),
            methods: self
                .selections()
                .into_iter()
                .map(|tool| tool.method)
                .chain(
                    self.service
                        .extra_methods()
                        .iter()
                        .map(|name| (*name).into()),
                )
                .collect(),
            recovery: true,
        }];
        if matches!(self.service, Service::Processes { health: true, .. }) {
            grants.push(NativeGrant {
                origin: id(1),
                consumer: id(21),
                provider: id(22),
                export: maka_web_api::EXPORT.into(),
                methods: ["probe".into()].into_iter().collect(),
                recovery: true,
            });
        }
        grants
    }
}

impl Service {
    fn contract(&self) -> Contract {
        match self {
            Self::Counter { .. } => counter_contract(),
            Self::Computer(_) => maka_workspace_api::computer::contract(),
            Self::Questions => maka_interactions_api::questions::contract(),
            Self::Forms => maka_interactions_api::forms::contract(),
            Self::File(_) | Self::FileEditors => maka_workspace_api::files::contract(),
            Self::Processes { .. } => maka_workspace_api::processes::contract(),
            #[cfg(target_os = "macos")]
            Self::Protocol => maka_workspace_api::protocol::contract(),
            Self::Skills(_) => maka_skills_api::contract(),
            Self::Images(source) => source.contract(),
            Self::Web => maka_web_api::contract(),
            Self::Jev => maka_workspace_api::jev::contract(),
        }
    }
    fn export(&self) -> &str {
        match self {
            Self::Counter { .. } => "Counter",
            Self::Computer(_) => maka_workspace_api::computer::EXPORT,
            Self::Questions => maka_interactions_api::questions::EXPORT,
            Self::Forms => maka_interactions_api::forms::EXPORT,
            Self::File(_) | Self::FileEditors => maka_workspace_api::files::EXPORT,
            Self::Processes { .. } => maka_workspace_api::processes::EXPORT,
            #[cfg(target_os = "macos")]
            Self::Protocol => maka_workspace_api::protocol::EXPORT,
            Self::Skills(_) => maka_skills_api::EXPORT,
            Self::Images(_) => "Images",
            Self::Web => maka_web_api::EXPORT,
            Self::Jev => maka_workspace_api::jev::EXPORT,
        }
    }
    fn method(&self) -> &str {
        match self {
            Self::Computer(_) => "evaluate",
            Self::Counter { query: true, .. } => "read",
            Self::Counter { .. } => "write",
            Self::Questions | Self::Forms => "ask",
            Self::File(method) => method,
            Self::FileEditors => "readText",
            Self::Processes { .. } => "execute",
            #[cfg(target_os = "macos")]
            Self::Protocol => "write",
            Self::Skills(_) => "search",
            Self::Images(_) => "produce",
            Self::Web => "fetch",
            Self::Jev => "evaluate",
        }
    }
    fn implementation(&self) -> Value {
        let name = match self {
            Self::Counter { handler: None, .. } => {
                return json!({"kind":"javascript","module":"counter.mjs","realm":"shared"});
            }
            Self::Counter { .. } => "fixture.counter",
            Self::Computer(_) => maka_workspace_api::computer::IMPLEMENTATION,
            Self::Questions => maka_interactions_api::questions::IMPLEMENTATION,
            Self::Forms => maka_interactions_api::forms::IMPLEMENTATION,
            Self::File(_) | Self::FileEditors => maka_workspace_api::files::IMPLEMENTATION,
            Self::Processes { .. } => maka_workspace_api::processes::IMPLEMENTATION,
            #[cfg(target_os = "macos")]
            Self::Protocol => maka_workspace_api::protocol::IMPLEMENTATION,
            Self::Skills(_) => maka_skills_api::IMPLEMENTATION,
            Self::Images(_) => {
                return json!({"kind":"javascript","module":"images.mjs","realm":"shared"});
            }
            Self::Web => maka_web_api::IMPLEMENTATION,
            Self::Jev => maka_workspace_api::jev::IMPLEMENTATION,
        };
        json!({"kind":"native","implementation":name})
    }
    fn schema(&self) -> Value {
        match self {
            Self::Jev => maka_workspace_api::jev::configuration_schema(),
            Self::Web => maka_web_api::configuration_schema(),
            Self::Skills(_) => maka_skills_api::configuration_schema(),
            Self::Processes { .. } => maka_workspace_api::processes::configuration_schema(),
            #[cfg(target_os = "macos")]
            Self::Protocol => maka_workspace_api::processes::configuration_schema(),
            _ => json!({"type":"object","additionalProperties":false}),
        }
    }
    fn configuration(&self, roots: Value) -> Value {
        match self {
            Self::Web | Self::Jev => json!({"network":"allowed"}),
            Self::Skills(skills) => {
                json!({"bundled":false,"home":skills.standard.then_some(&skills.path),"projectRoots":if skills.standard{roots}else{json!([])},
                "sources":if skills.standard{json!([])}else{json!([{"id":"fixture","label":"Fixture","path":skills.path}])},"manage":false,"preferences":false})
            }
            Self::Processes { isolated, .. } => {
                json!({"filesystem":{"default":"write","rules":[],"denyGlobs":[]},"network":"allowed","helper":null,"sessionOwner":id(1),"isolatedWorkspaces":isolated})
            }
            #[cfg(target_os = "macos")]
            Self::Protocol => {
                json!({"filesystem":{"default":"write","rules":[],"denyGlobs":[]},"network":"allowed","helper":null,"sessionOwner":id(1),"isolatedWorkspaces":false})
            }
            _ => json!({}),
        }
    }
    fn extra_methods(&self) -> &[&str] {
        match self {
            Self::Skills(Skills {
                preparation: Some(_),
                ..
            }) => &["prepare", "search"],
            Self::Web => &["capture"],
            Self::Computer(_) => &["state"],
            #[cfg(target_os = "macos")]
            Self::Protocol => &["run", "input"],
            _ => &[],
        }
    }
    fn provide(&self, registry: &mut NativeRegistry) {
        match self {
            Self::Counter {
                handler: Some(counter),
                ..
            } => {
                let counter = counter.clone();
                registry
                    .insert(
                        "fixture.counter".into(),
                        Arc::new(move |_, _| {
                            let counter = counter.clone();
                            Box::pin(async move {
                                NativeActivation {
                                    exports: Ok(BTreeMap::from([(
                                        "Counter".into(),
                                        Published {
                                            contract: counter_contract(),
                                            value: counter.clone() as Arc<dyn Handler>,
                                        },
                                    )])),
                                    owner: counter,
                                }
                            })
                        }),
                    )
                    .unwrap();
            }
            Self::Counter { handler: None, .. } => {}
            Self::Computer(handler) => {
                let handler = handler.clone();
                registry
                    .insert(
                        maka_workspace_api::computer::IMPLEMENTATION.into(),
                        Arc::new(move |_, _| {
                            let handler = handler.clone();
                            Box::pin(async move {
                                NativeActivation {
                                    exports: Ok(BTreeMap::from([(
                                        maka_workspace_api::computer::EXPORT.into(),
                                        Published {
                                            contract: maka_workspace_api::computer::contract(),
                                            value: handler.clone() as Arc<dyn Handler>,
                                        },
                                    )])),
                                    owner: handler,
                                }
                            })
                        }),
                    )
                    .unwrap();
            }
            Self::Questions => maka_interactions_native::questions::provide(registry).unwrap(),
            Self::Forms => maka_interactions_native::forms::provide(registry).unwrap(),
            Self::File(_) | Self::FileEditors => maka_files_native::provide(registry).unwrap(),
            Self::Processes { health, .. } => {
                maka_processes_native::provide(registry).unwrap();
                if *health {
                    maka_web::provide(registry).unwrap();
                }
            }
            #[cfg(target_os = "macos")]
            Self::Protocol => maka_processes_native::provide(registry).unwrap(),
            Self::Images(_) => {}
            Self::Web => maka_web::provide(registry).unwrap(),
            Self::Jev => maka_jev_native::provide(registry).unwrap(),
            Self::Skills(Skills {
                preparation:
                    Some(Preparation {
                        handler: Some((handler, owner)),
                        ..
                    }),
                ..
            }) => {
                let handler = handler.clone();
                let owner = owner.clone();
                registry
                    .insert(
                        maka_skills_api::IMPLEMENTATION.into(),
                        Arc::new(move |_, _| {
                            let handler = handler.clone();
                            let owner = owner.clone();
                            Box::pin(async move {
                                NativeActivation {
                                    exports: Ok(BTreeMap::from([(
                                        maka_skills_api::EXPORT.into(),
                                        Published {
                                            contract: maka_skills_api::contract(),
                                            value: handler,
                                        },
                                    )])),
                                    owner,
                                }
                            })
                        }),
                    )
                    .unwrap();
            }
            Self::Skills(_) => maka_skills_native::provide(registry).unwrap(),
        }
    }
}

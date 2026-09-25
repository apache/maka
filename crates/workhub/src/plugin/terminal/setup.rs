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
use crate::decision::Creation;
use crate::plugin::remote::failure;
use maka_plugins::{authorization::Id, execution::Target, executor, llm};
use maka_runtime::execution::{CollaborationMode, SandboxMode, WorkspaceTarget};
use serde::Serialize;

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Purpose {
    Creation,
    Coordinator,
    Delegation { assignment: String },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Route {
    purpose: Purpose,
    #[serde(default)]
    query: String,
    #[serde(default)]
    target: Option<Target>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Delegation {
    revision: Option<u64>,
    authorization: Scope,
    name: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Stamp {
    operation: uuid::Uuid,
    revision: Option<u64>,
}

fn failed(error: impl std::fmt::Display) -> Error {
    Error::Provider(error.to_string())
}

fn bounded(value: &str, limit: usize) -> String {
    let value = clean(value, false);
    value[..value.floor_char_boundary(limit.min(value.len()))].to_owned()
}

fn route(route: &Route) -> Value {
    json!({"setup": route})
}

fn title(words: &Words, purpose: &Purpose) -> String {
    match purpose {
        Purpose::Creation => words.t("New task setup", "新任务设置", "新任務設定"),
        Purpose::Coordinator => words.t("Coordinator model", "协调器模型", "協調器模型"),
        Purpose::Delegation { .. } => words.t("Task model", "任务模型", "任務模型"),
    }
}

pub(super) async fn entries(hub: &Hub, view: &mut View, cx: &Cx) -> Result<(), Error> {
    let Node::Column { children, .. } = &mut view.root else {
        return Ok(());
    };
    let creation = hub
        .0
        .assignments
        .repository
        .read::<Creation>("creation")
        .await
        .map_err(failure)?;
    let mut entry = link(
        "creation",
        title(&cx.words, &Purpose::Creation),
        json!({"setup":{"purpose":{"kind":"creation"}}}),
    );
    if let Some((_, creation)) = creation {
        if let Scope::Workspace { workspace, .. } = creation.authorization {
            let location = match workspace {
                WorkspaceTarget::HostPath { path } => path,
                WorkspaceTarget::Project { project_id } => project_id,
            };
            entry = entry.detail(bounded(&location, 1024));
        }
    } else {
        entry = entry
            .detail(cx.t(
                "Choose where new tasks run",
                "选择新任务的运行位置",
                "選擇新任務的執行位置",
            ))
            .tone(Tone::Warning);
    }
    children.insert(0, entry.into());
    children.push(
        link(
            "coordinator-model",
            title(&cx.words, &Purpose::Coordinator),
            json!({"setup":{"purpose":{"kind":"coordinator"}}}),
        )
        .into(),
    );
    view.actions.push(action(
        "discovery",
        cx.t("Task discovery access", "任务发现授权", "任務探索授權"),
    ));
    children.push(row(
        "discovery",
        vec![button("discovery", "discovery", Role::Normal)],
    ));
    Ok(())
}

pub(super) async fn read(hub: &Hub, route: Route, cx: &Cx) -> Result<View, Error> {
    let delegation = match &route.purpose {
        Purpose::Delegation { assignment } => Some(
            hub.call::<Delegation>(
                Call::DelegationModel,
                json!({"assignmentId":assignment}),
                &cx.caller,
            )
            .await?,
        ),
        _ => None,
    };
    if let Some(Delegation {
        authorization: Scope::Session { session_id },
        ..
    }) = &delegation
        && cx.caller.session_id.as_ref() != Some(session_id)
    {
        return Ok(session_handoff(&cx.words, session_id));
    }
    let Some(target) = route.target.as_ref() else {
        let models: llm::Choices = hub
            .call(Call::Models, json!({"query":route.query}), &cx.caller)
            .await?;
        let executors = if matches!(route.purpose, Purpose::Creation) {
            Some(
                hub.call::<executor::Choices>(
                    Call::Executors,
                    json!({"query":route.query}),
                    &cx.caller,
                )
                .await?,
            )
        } else {
            None
        };
        return Ok(picker(&cx.words, &route, models, executors));
    };
    target.validate().map_err(failed)?;
    if !matches!(route.purpose, Purpose::Creation) && !matches!(target, Target::Model { .. }) {
        return Err(Error::Invalid("Recovery requires a model".into()));
    }
    let creation = hub
        .0
        .assignments
        .repository
        .read::<Creation>("creation")
        .await
        .map_err(failure)?;
    form(&cx.words, &route, creation, delegation.as_ref())
}

fn session_handoff(words: &Words, session: &str) -> View {
    view_of(&words.t("Task model", "任务模型", "任務模型"), "session", vec![], column("root", vec![
        text("explanation", words.t(
            "Open this session, then choose WorkHub task models in its panels to change the model.",
            "打开此会话，再从会话面板选择 WorkHub 任务模型以更换模型。",
            "開啟此工作階段，再從工作階段面板選擇 WorkHub 任務模型以更換模型。"), Tone::Muted),
        Node::Item { key: "session".into(), title: words.t("Open task session", "打开任务会话", "開啟任務工作階段"), detail: String::new(), meta: String::new(), tone: Tone::Accent, current: false, target: view::Target::Session { session: session.into() } },
    ]))
}

pub(super) struct SessionModels(pub(super) Hub);

impl SessionModels {
    async fn route(&self, route: &Value, cx: &Cx) -> Result<Option<Route>, Error> {
        let session = cx.session()?;
        if route.is_null() {
            return Ok(None);
        }
        let place: Place = serde_json::from_value(route.clone()).map_err(failed)?;
        let Some(setup) = place.setup else {
            return Ok(None);
        };
        let Purpose::Delegation { assignment } = &setup.purpose else {
            return Err(Error::Invalid(
                "Open task model recovery from this Session".into(),
            ));
        };
        let choice: Delegation = self
            .0
            .call(
                Call::DelegationModel,
                json!({"assignmentId":assignment}),
                &cx.caller,
            )
            .await?;
        if choice.authorization
            != (Scope::Session {
                session_id: session.into(),
            })
        {
            return Err(Error::Invalid(
                "The task belongs to another authorization scope".into(),
            ));
        }
        Ok(Some(setup))
    }
}

impl App for SessionModels {
    fn read(&self, route: Value, cx: Cx) -> BoxFuture<'static, Result<View, Error>> {
        let this = Self(Hub(self.0.0.clone()));
        Box::pin(async move {
            if let Some(setup) = this.route(&route, &cx).await? {
                return read(&this.0, setup, &cx).await;
            }
            let session = cx.session()?;
            let place: Place = serde_json::from_value(route).unwrap_or_default();
            let (assignments, mut after) = this
                .0
                .0
                .assignments
                .repository
                .scan::<crate::assignment::Assignment>("assignments/", place.after)
                .await
                .map_err(failure)?;
            if assignments.len() > 32 {
                after = Some(
                    crate::assignment::key(&assignments[31].request.operation_id)
                        .map_err(failure)?,
                );
            }
            let mut children: Vec<Node> = assignments.into_iter().take(32).filter(|assignment| {
                !assignment.retired && assignment.request.authorization == (Scope::Session { session_id: session.into() })
            }).enumerate().map(|(index, assignment)| {
                link(format!("task-{index}"), bounded(&assignment.request.content.text, 256),
                    json!({"setup":{"purpose":{"kind":"delegation","assignment":assignment.request.operation_id}}})).into()
            }).collect();
            if children.is_empty() {
                children.push(text(
                    "empty",
                    cx.t(
                        "No delegated tasks for this session on this page.",
                        "此页没有属于此会话的委派任务。",
                        "此頁沒有屬於此工作階段的委派任務。",
                    ),
                    Tone::Muted,
                ));
            }
            if let Some(after) = after {
                children.push(
                    link(
                        "more",
                        cx.t("Older tasks", "更早的任务", "更早的任務"),
                        json!({"after":after}),
                    )
                    .into(),
                );
            }
            Ok(view_of(
                &cx.t(
                    "WorkHub task models",
                    "WorkHub 任务模型",
                    "WorkHub 任務模型",
                ),
                "tasks",
                vec![],
                column("root", children),
            ))
        })
    }
    fn submit(&self, submission: Submission, cx: Cx) -> BoxFuture<'static, Result<Reply, Error>> {
        let this = Self(Hub(self.0.0.clone()));
        Box::pin(async move {
            this.route(&submission.route, &cx)
                .await?
                .ok_or_else(|| Error::Invalid("Choose a delegated task".into()))?;
            submit(&this.0, submission, &cx).await
        })
    }
}

fn picker(
    words: &Words,
    current: &Route,
    models: llm::Choices,
    executors: Option<executor::Choices>,
) -> View {
    let mut items = Vec::new();
    let incomplete = !models.complete
        || models.models.len() > 20
        || executors
            .as_ref()
            .is_some_and(|page| !page.complete || page.executors.len() > 12);
    for (index, model) in models.models.into_iter().take(20).enumerate() {
        let target = Target::Model {
            model: model.model,
            thinking_level: model.default_thinking_level,
        };
        items.push(
            link(
                format!("model-{index}"),
                bounded(&model.display_name, 256),
                route(&Route {
                    target: Some(target),
                    ..current.clone()
                }),
            )
            .detail(bounded(&model.connection_name, 1024))
            .into(),
        );
    }
    if let Some(executors) = executors {
        for (index, executor) in executors.executors.into_iter().take(12).enumerate() {
            items.push(
                link(
                    format!("executor-{index}"),
                    bounded(&executor.display_name, 256),
                    route(&Route {
                        target: Some(Target::Executor {
                            executor_id: executor.id,
                            settings: Default::default(),
                        }),
                        ..current.clone()
                    }),
                )
                .detail(words.t("Plugin executor", "插件执行器", "外掛執行器"))
                .into(),
            );
        }
    }
    let mut children = vec![
        input(
            "query",
            "query",
            words.t(
                "Find a model or executor",
                "查找模型或执行器",
                "尋找模型或執行器",
            ),
        ),
        row("search", vec![button("search", "search", Role::Normal)]),
    ];
    if items.is_empty() {
        children.push(text(
            "empty",
            words.t(
                "No available choices. Configure a connection or refine the search.",
                "没有可用选项。请配置连接或调整搜索条件。",
                "沒有可用選項。請設定連線或調整搜尋條件。",
            ),
            Tone::Muted,
        ));
    } else {
        children.push(scroll("choices", 20, stack("items", items)));
    }
    if incomplete {
        children.push(text(
            "more",
            words.t(
                "Refine the search to see more choices.",
                "缩小搜索范围以查看更多选项。",
                "縮小搜尋範圍以查看更多選項。",
            ),
            Tone::Subtle,
        ));
    }
    View {
        fields: vec![line("query", &current.query, 512)],
        ..view_of(
            &title(words, &current.purpose),
            "choices",
            vec![Action {
                fields: vec!["query".into()],
                ..action("search", words.t("Search", "搜索", "搜尋"))
            }],
            column("root", children),
        )
    }
}

fn form(
    words: &Words,
    current: &Route,
    creation: Option<(u64, Creation)>,
    delegation: Option<&Delegation>,
) -> Result<View, Error> {
    let mut fields = Vec::new();
    let target = current
        .target
        .as_ref()
        .ok_or_else(|| Error::Invalid("Choose an execution target".into()))?;
    let label = match target {
        Target::Model { model, .. } => format!("{} · {}", model.connection_slug, model.model),
        Target::Executor { executor_id, .. } => executor_id.as_str().to_owned(),
    };
    let mut children = vec![text("target", clean(&label, false), Tone::Strong)];
    if matches!(current.purpose, Purpose::Creation) {
        let (kind, location, mode, collaboration) =
            match creation.as_ref().map(|(_, creation)| creation) {
                Some(Creation {
                    authorization:
                        Scope::Workspace {
                            workspace,
                            sandbox_mode,
                        },
                    settings,
                }) => {
                    let (kind, location) = match workspace {
                        WorkspaceTarget::HostPath { path } => ("path", path.clone()),
                        WorkspaceTarget::Project { project_id } => ("project", project_id.clone()),
                    };
                    (kind, location, *sandbox_mode, settings.collaboration_mode)
                }
                _ => (
                    "path",
                    String::new(),
                    SandboxMode::WorkspaceWrite,
                    CollaborationMode::Agent,
                ),
            };
        fields.extend([
            choice(
                "location-kind",
                kind,
                vec![
                    (
                        "path".into(),
                        words.t("Host directory", "Host 目录", "Host 目錄"),
                    ),
                    (
                        "project".into(),
                        words.t("Project ID", "项目 ID", "專案 ID"),
                    ),
                ],
            ),
            line("location", location, 4096),
            choice(
                "sandbox",
                if mode == SandboxMode::ReadOnly {
                    "read-only"
                } else {
                    "workspace-write"
                },
                vec![
                    ("read-only".into(), words.t("Read only", "只读", "唯讀")),
                    (
                        "workspace-write".into(),
                        words.t("Write in workspace", "可写工作区", "可寫工作區"),
                    ),
                ],
            ),
        ]);
        children.extend([
            input(
                "location-kind",
                "location-kind",
                words.t("Workspace", "工作区", "工作區"),
            ),
            input(
                "location",
                "location",
                words.t("Directory or project ID", "目录或项目 ID", "目錄或專案 ID"),
            ),
            input(
                "sandbox",
                "sandbox",
                words.t("Access", "访问权限", "存取權限"),
            ),
        ]);
        if matches!(target, Target::Model { .. }) {
            fields.push(choice(
                "collaboration",
                if collaboration == CollaborationMode::Plan {
                    "plan"
                } else {
                    "agent"
                },
                vec![
                    ("agent".into(), words.t("Act", "执行", "執行")),
                    ("plan".into(), words.t("Plan first", "先规划", "先規劃")),
                ],
            ));
            children.push(input(
                "collaboration",
                "collaboration",
                words.t("Task mode", "任务模式", "任務模式"),
            ));
        }
        children.push(text(
            "scope",
            words.t(
                "These defaults apply to new tasks. Existing tasks keep their settings.",
                "这些默认设置用于新任务。已有任务保留其设置。",
                "這些預設設定用於新任務。既有任務保留其設定。",
            ),
            Tone::Subtle,
        ));
    } else if let Some(choice) = delegation {
        children.push(text("task", clean(&choice.name, false), Tone::Muted));
        children.push(text(
            "scope",
            words.t(
                "The same delegated task keeps its original dispatch identity.",
                "继续使用同一委派任务及其原始派发标识。",
                "繼續使用同一委派任務及其原始派發識別。",
            ),
            Tone::Subtle,
        ));
    }
    let stamp = Stamp {
        operation: uuid::Uuid::new_v4(),
        revision: if matches!(current.purpose, Purpose::Creation) {
            creation.as_ref().map(|(revision, _)| *revision)
        } else {
            delegation.and_then(|value| value.revision)
        },
    };
    children.push(row(
        "save",
        vec![button("save-target", "save-target", Role::Primary)],
    ));
    Ok(View {
        actions: vec![Action {
            fields: fields.iter().map(|field| field.id.clone()).collect(),
            // These domain methods do not expose exact operation receipts.
            // In particular, reading the same current value cannot prove success.
            ..action(
                "save-target",
                words.t("Use this configuration", "使用此配置", "使用此設定"),
            )
        }],
        fields,
        ..view_of(
            &title(words, &current.purpose),
            &serde_json::to_string(&stamp).map_err(failed)?,
            vec![],
            column("root", children),
        )
    })
}

fn creation_input(
    submission: &Submission,
    target: &Target,
) -> Result<(Scope, CollaborationMode), Error> {
    let location = submission.text("location")?.trim();
    if location.is_empty() || location.len() > 4096 || location.chars().any(char::is_control) {
        return Err(Error::Invalid(
            "Enter a workspace directory or project ID".into(),
        ));
    }
    let workspace = match submission.text("location-kind")? {
        "path" => WorkspaceTarget::HostPath {
            path: location.into(),
        },
        "project" => WorkspaceTarget::Project {
            project_id: location.into(),
        },
        _ => return Err(Error::Invalid("Invalid workspace kind".into())),
    };
    let sandbox_mode = match submission.text("sandbox")? {
        "read-only" => SandboxMode::ReadOnly,
        "workspace-write" => SandboxMode::WorkspaceWrite,
        _ => return Err(Error::Invalid("Invalid workspace access".into())),
    };
    let collaboration = match target {
        Target::Executor { .. } => CollaborationMode::Agent,
        Target::Model { .. } => match submission.text("collaboration")? {
            "agent" => CollaborationMode::Agent,
            "plan" => CollaborationMode::Plan,
            _ => return Err(Error::Invalid("Invalid task mode".into())),
        },
    };
    Ok((
        Scope::Workspace {
            workspace,
            sandbox_mode,
        },
        collaboration,
    ))
}

async fn consent(
    access: &crate::Access,
    caller: &Caller,
    target: &Scope,
    grant: Option<Id>,
    operation: uuid::Uuid,
    title: String,
) -> Result<Option<Reply>, Error> {
    let capabilities = [if *target == Scope::Profile {
        Capability::ReadSessions
    } else {
        Capability::Executions
    }]
    .into();
    let request = Authorization {
        operation_id: operation,
        title,
        target: target.clone(),
        capabilities,
    };
    request.validate().map_err(failed)?;
    // A remembered background grant is not the foreground caller's authority.
    // Check that caller before opening any grant or changing plugin state.
    let authority = caller.views.authorize(request.clone()).await?;
    authority
        .finish()
        .await
        .map_err(|_| Error::CleanupUnconfirmed)?;
    let id = match grant {
        Some(id) => Some(id),
        None => access.remembered(target).await.map_err(failure)?,
    };
    if let Some(id) = id {
        match access.authorizations.open(id).await {
            Ok(authorized) => {
                let matches = authorized.grant.request.target == *target
                    && request
                        .capabilities
                        .is_subset(&authorized.grant.request.capabilities);
                authorized
                    .call
                    .finish()
                    .await
                    .map_err(|_| Error::CleanupUnconfirmed)?;
                if !matches {
                    return Err(Error::Invalid(
                        "Authorization does not match this configuration".into(),
                    ));
                }
                if grant.is_some() {
                    access.remember(id).await.map_err(failure)?;
                }
                return Ok(None);
            }
            Err(
                maka_plugins::execution::CommandError::Denied
                | maka_plugins::execution::CommandError::Revoked,
            ) if grant.is_none() => {}
            Err(error) => return Err(failure(error.into())),
        }
    }
    Ok(Some(Reply::Consent { request }))
}

pub(super) async fn discovery(hub: &Hub, submission: Submission, cx: &Cx) -> Result<Reply, Error> {
    if let Some(reply) = consent(
        &hub.0.access,
        &cx.caller,
        &Scope::Profile,
        submission.grant,
        uuid::Uuid::new_v4(),
        cx.t(
            "Allow WorkHub to discover tasks",
            "允许 WorkHub 发现任务",
            "允許 WorkHub 探索任務",
        ),
    )
    .await?
    {
        return Ok(reply);
    }
    Ok(Reply::Applied { route: Value::Null })
}

pub(super) async fn submit(hub: &Hub, submission: Submission, cx: &Cx) -> Result<Reply, Error> {
    let place: Place = serde_json::from_value(submission.route.clone()).map_err(failed)?;
    let mut current = place
        .setup
        .ok_or_else(|| Error::Invalid("Open task setup first".into()))?;
    if submission.action == "search" {
        current.query = submission.text("query")?.trim().to_owned();
        llm::Search {
            query: current.query.clone(),
        }
        .validate()
        .map_err(failed)?;
        current.target = None;
        return Ok(Reply::Applied {
            route: route(&current),
        });
    }
    let stamp: Stamp = serde_json::from_str(&submission.revision).map_err(failed)?;
    let target = current
        .target
        .as_ref()
        .ok_or_else(|| Error::Invalid("Choose an execution target".into()))?;
    target.validate().map_err(failed)?;
    let (scope, collaboration) = match &current.purpose {
        Purpose::Creation => creation_input(&submission, target)?,
        Purpose::Coordinator => (workspace(), CollaborationMode::Agent),
        Purpose::Delegation { assignment } => {
            let choice: Delegation = hub
                .call(
                    Call::DelegationModel,
                    json!({"assignmentId":assignment}),
                    &cx.caller,
                )
                .await?;
            if choice.revision != stamp.revision {
                return Ok(Reply::Conflict);
            }
            (choice.authorization, CollaborationMode::Agent)
        }
    };
    if let Some(reply) = consent(
        &hub.0.access,
        &cx.caller,
        &scope,
        submission.grant,
        stamp.operation,
        title(&cx.words, &current.purpose),
    )
    .await?
    {
        return Ok(reply);
    }
    let result = match &current.purpose {
        Purpose::Creation => {
            let creation: Creation = hub.call(Call::Template, json!({"authorization":scope,"collaborationMode":collaboration,"target":target}), &cx.caller).await?;
            crate::plugin::remote::configure_creation(&hub.0, &cx.caller, creation, stamp.revision).await
        }
        Purpose::Coordinator => hub.call::<Value>(Call::SelectModel, json!(target), &cx.caller).await,
        Purpose::Delegation { assignment } => hub.call::<Value>(Call::SelectDelegationModel, json!({"assignmentId":assignment,"expectedRevision":stamp.revision,"target":target}), &cx.caller).await,
    };
    result?;
    Ok(Reply::Applied { route: Value::Null })
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_runtime::execution::{ModelBinding, ThinkingLevel};

    /// Every method is a trap: denial must happen before restoring an old grant,
    /// reading plugin state, or acquiring any execution capability.
    struct Untouched;
    impl maka_plugins::storage::Store for Untouched {
        fn read(
            &self,
            _: String,
        ) -> BoxFuture<
            '_,
            Result<Option<maka_plugins::storage::Record>, maka_plugins::storage::StoreError>,
        > {
            panic!("denied caller read plugin state")
        }
        fn scan(
            &self,
            _: maka_plugins::storage::Scan,
        ) -> BoxFuture<'_, Result<maka_plugins::storage::Page, maka_plugins::storage::StoreError>>
        {
            panic!("denied caller scanned plugin state")
        }
        fn batch(
            &self,
            _: Vec<maka_plugins::storage::Mutation>,
        ) -> BoxFuture<
            '_,
            Result<Vec<maka_plugins::storage::Record>, maka_plugins::storage::StoreError>,
        > {
            panic!("denied caller changed plugin state")
        }
    }
    impl maka_plugins::execution::Access for Untouched {
        fn restore(
            &self,
            _: Id,
        ) -> BoxFuture<
            '_,
            Result<
                Arc<dyn maka_plugins::execution::Commands>,
                maka_plugins::execution::CommandError,
            >,
        > {
            panic!("denied caller restored execution authority")
        }
        fn acquire(
            &self,
            _: maka_plugins::call::Scope,
        ) -> BoxFuture<
            '_,
            Result<
                Arc<dyn maka_plugins::execution::Commands>,
                maka_plugins::execution::CommandError,
            >,
        > {
            panic!("denied caller acquired execution authority")
        }
    }
    impl maka_plugins::authorization::Access for Untouched {
        fn open(
            &self,
            _: Id,
        ) -> BoxFuture<
            '_,
            Result<maka_plugins::authorization::Authorized, maka_plugins::execution::CommandError>,
        > {
            panic!("denied caller borrowed a remembered grant")
        }
    }
    #[derive(Default)]
    struct Denied(std::sync::Mutex<Vec<Authorization>>);
    impl maka_plugins::remote::Views for Denied {
        fn authorize(
            &self,
            request: Authorization,
        ) -> BoxFuture<'_, Result<maka_plugins::call::Owned, Error>> {
            self.0.lock().unwrap().push(request);
            Box::pin(async {
                Err(Error::Provider(
                    "Current caller cannot authorize execution".into(),
                ))
            })
        }
        fn session(&self) -> BoxFuture<'_, Result<maka_plugins::remote::SessionView, Error>> {
            panic!("unneeded Session view")
        }
        fn workspace(
            &self,
            _: maka_plugins::remote::WorkspaceViewInput,
        ) -> BoxFuture<'_, Result<maka_plugins::remote::SessionView, Error>> {
            panic!("unneeded workspace view")
        }
        fn query_database(
            &self,
            _: maka_plugins::filesystem::database::Read,
        ) -> BoxFuture<
            '_,
            Result<
                Vec<maka_plugins::filesystem::database::Table>,
                maka_plugins::filesystem::database::Error,
            >,
        > {
            panic!("unneeded database view")
        }
    }

    #[tokio::test]
    async fn remembered_grants_never_replace_the_current_callers_authority() {
        let untouched = Arc::new(Untouched);
        let access = crate::Access {
            repository: Arc::new(crate::Repository::new(untouched.clone())),
            executions: untouched.clone(),
            authorizations: untouched,
        };
        let views = Arc::new(Denied::default());
        let scope = Scope::Session {
            session_id: "worker-a".into(),
        };
        for session in [None, Some("worker-a".to_owned())] {
            let caller = Caller {
                connection_id: uuid::Uuid::new_v4(),
                client_instance_id: "restricted".into(),
                document_id: uuid::Uuid::new_v4(),
                session_id: session,
                access: maka_plugins::remote::Access::HostPaths,
                views: views.clone(),
                resources: Arc::default(),
                cancellation: tokio_util::sync::CancellationToken::new(),
            };
            let result = consent(
                &access,
                &caller,
                &scope,
                Some(Id(uuid::Uuid::new_v4())),
                uuid::Uuid::new_v4(),
                "Choose task model".into(),
            )
            .await;
            assert!(
                matches!(result, Err(Error::Provider(message)) if message == "Current caller cannot authorize execution")
            );
        }
        let requests = views.0.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests.iter().all(|request| request.target == scope
            && request.capabilities == [Capability::Executions].into()));
    }

    #[test]
    fn session_scoped_repair_hands_off_without_offering_a_foreign_write() {
        for locale in ["en", "zh-CN", "zh-TW"] {
            let view = session_handoff(&Words::new(locale), "worker-a");
            view.validate().unwrap();
            assert!(view.actions.is_empty());
            assert!(view.fields.is_empty());
            let Node::Column { children, .. } = view.root else {
                panic!("handoff")
            };
            assert!(children.iter().any(|node| matches!(node, Node::Item { target: view::Target::Session { session }, .. } if session == "worker-a")));
        }
    }

    fn model(index: usize) -> llm::Choice {
        llm::Choice {
            model: ModelBinding {
                connection_id: format!("connection-{index}"),
                connection_slug: "local".into(),
                model: format!("model-{index}"),
            },
            connection_name: "Local".into(),
            display_name: format!("Model {index}"),
            thinking_levels: vec![ThinkingLevel::High],
            default_thinking_level: Some(ThinkingLevel::High),
            is_default: index == 0,
        }
    }

    fn target() -> Target {
        Target::Model {
            model: model(0).model,
            thinking_level: Some(ThinkingLevel::High),
        }
    }

    #[test]
    fn choices_are_bounded_and_navigation_keeps_the_exact_binding() {
        for locale in ["en", "zh-CN", "zh-TW"] {
            let current = Route {
                purpose: Purpose::Creation,
                query: "model".into(),
                target: None,
            };
            let view = picker(
                &Words::new(locale),
                &current,
                llm::Choices {
                    revision: 42,
                    complete: true,
                    models: (0..25).map(model).collect(),
                },
                Some(executor::Choices {
                    revision: 7,
                    complete: true,
                    executors: vec![],
                }),
            );
            view.validate().unwrap();
            let Node::Column { children, .. } = &view.root else {
                panic!("column")
            };
            let Node::Scroll { child, .. } = &children[2] else {
                panic!("choices")
            };
            let Node::Column {
                children: choices, ..
            } = child.as_ref()
            else {
                panic!("items")
            };
            assert_eq!(choices.len(), 20);
            let Node::Item {
                target: view::Target::Route { route },
                ..
            } = &choices[0]
            else {
                panic!("choice")
            };
            let place: Place = serde_json::from_value(route.clone()).unwrap();
            assert_eq!(place.setup.unwrap().target, Some(target()));
            assert!(matches!(children.last(), Some(Node::Text { key, .. }) if key == "more"));
        }
    }

    #[test]
    fn task_model_form_freezes_cas_without_promising_value_based_recovery() {
        let current = Route {
            purpose: Purpose::Delegation {
                assignment: "task-a".into(),
            },
            query: String::new(),
            target: Some(target()),
        };
        for locale in ["en", "zh-CN", "zh-TW"] {
            let view = form(
                &Words::new(locale),
                &current,
                None,
                Some(&Delegation {
                    revision: Some(9),
                    authorization: Scope::Session {
                        session_id: "worker-a".into(),
                    },
                    name: "Task A".into(),
                }),
            )
            .unwrap();
            view.validate().unwrap();
            let stamp: Stamp = serde_json::from_str(&view.revision).unwrap();
            assert_eq!(stamp.revision, Some(9));
            assert!(view.action("save-target").unwrap().recovery.is_none());
        }
    }

    #[test]
    fn creation_fields_preserve_workspace_permissions_and_executor_mode() {
        let mut submission = Submission {
            route: Value::Null,
            revision: String::new(),
            action: "save-target".into(),
            grant: None,
            fields: [
                ("location-kind".into(), json!("path")),
                ("location".into(), json!("/tmp/work")),
                ("sandbox".into(), json!("read-only")),
                ("collaboration".into(), json!("plan")),
            ]
            .into(),
        };
        let (scope, mode) = creation_input(&submission, &target()).unwrap();
        assert_eq!(mode, CollaborationMode::Plan);
        assert_eq!(
            scope,
            Scope::Workspace {
                workspace: WorkspaceTarget::HostPath {
                    path: "/tmp/work".into()
                },
                sandbox_mode: SandboxMode::ReadOnly
            }
        );
        let saved = Creation {
            authorization: scope.clone(),
            settings: maka_plugins::execution::RootSettings {
                target: target(),
                sandbox_mode: SandboxMode::ReadOnly,
                approval_policy: maka_runtime::execution::ApprovalPolicy::OnRequest,
                collaboration_mode: CollaborationMode::Plan,
                behavior: Default::default(),
                bound_tools: None,
                instructions: None,
            },
        };
        let view = form(
            &Words::new("en"),
            &Route {
                purpose: Purpose::Creation,
                query: String::new(),
                target: Some(target()),
            },
            Some((17, saved)),
            None,
        )
        .unwrap();
        view.validate().unwrap();
        let stamp: Stamp = serde_json::from_str(&view.revision).unwrap();
        assert_eq!(stamp.revision, Some(17));
        assert!(
            matches!(&view.fields.iter().find(|field| field.id == "sandbox").unwrap().control, view::Control::Choice { value, .. } if value == "read-only")
        );
        assert!(view.action("save-target").unwrap().recovery.is_none());
        let executor = Target::Executor {
            executor_id: "fixture.agent".to_owned().try_into().unwrap(),
            settings: Default::default(),
        };
        assert_eq!(
            creation_input(&submission, &executor).unwrap().1,
            CollaborationMode::Agent
        );
        for locale in ["en", "zh-CN", "zh-TW"] {
            form(
                &Words::new(locale),
                &Route {
                    purpose: Purpose::Creation,
                    query: String::new(),
                    target: Some(executor.clone()),
                },
                None,
                None,
            )
            .unwrap()
            .validate()
            .unwrap();
        }
        submission
            .fields
            .insert("sandbox".into(), json!("danger-full-access"));
        assert!(creation_input(&submission, &target()).is_err());
        submission
            .fields
            .insert("sandbox".into(), json!("workspace-write"));
        submission.fields.insert("location".into(), json!(" "));
        assert!(creation_input(&submission, &target()).is_err());
    }
}

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

use super::callbacks;
use maka_js_runtime::plugin::Module;
use maka_plugins::{contributions::Staged, prompt};
use maka_runtime::tools::{
    ToolDefinition, ToolHandler, ToolNesting, ToolRegistration, ToolSemantics,
};
use maka_tools::plugins::PluginTool;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Registration {
    ModelProvider {
        name: String,
        descriptor: maka_plugins::provider::Descriptor,
        callback: u32,
    },
    ModelAdapter {
        name: String,
        callback: u32,
    },
    Background {
        name: String,
        callback: u32,
    },
    Behavior {
        name: String,
        callback: u32,
        #[serde(default, rename = "nativeInput")]
        native_input: maka_plugins::session::NativeInputPolicy,
    },
    InputPreparation {
        name: String,
        callback: u32,
    },
    RemoteMethod {
        name: String,
        callback: u32,
        #[serde(default)]
        access: maka_plugins::remote::Access,
        #[serde(default, rename = "terminalView")]
        terminal_view: Option<maka_plugins::terminal_ui::Descriptor>,
    },
    RemoteStream {
        name: String,
        callback: u32,
        #[serde(default)]
        access: maka_plugins::remote::Access,
        #[serde(default, rename = "terminalView")]
        terminal_view: Option<maka_plugins::terminal_ui::Descriptor>,
    },
    #[serde(rename_all = "camelCase")]
    Executor {
        name: maka_runtime::executor::ExecutorId,
        display_name: String,
        #[serde(default)]
        capabilities: maka_plugins::executor::Capabilities,
        callback: u32,
    },
    #[serde(rename_all = "camelCase")]
    Tool {
        #[serde(flatten)]
        definition: Tool,
        callback: u32,
    },
    ToolGroup {
        tools: Vec<Tool>,
        callback: u32,
    },
    Section {
        #[serde(default)]
        format: prompt::Format,
        name: String,
        callback: u32,
        #[serde(default)]
        order: i32,
        #[serde(default)]
        complete: bool,
    },
    Variable {
        name: String,
        callback: u32,
    },
    Context {
        #[serde(default)]
        format: prompt::Format,
        name: String,
        callback: u32,
        #[serde(default)]
        order: i32,
    },
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Semantics {
    #[default]
    Parallel,
    ExclusiveStep,
    FinishTurn,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Tool {
    pub name: String,
    #[serde(default)]
    provider: Option<maka_runtime::tools::ProviderTool>,
    description: String,
    input_schema: Value,
    #[serde(default)]
    output_schema: Option<Value>,
    #[serde(default)]
    direct_only: bool,
    #[serde(default)]
    semantics: Semantics,
    #[serde(default)]
    always_visible: bool,
}
impl Tool {
    fn registration(
        self,
        handler: Arc<dyn maka_runtime::tools::ToolPreparer>,
    ) -> Result<PluginTool, String> {
        let tool = PluginTool::new(ToolRegistration {
            definition: ToolDefinition {
                freeform: None,
                output_schema: self.output_schema,
                provider: self.provider,
                name: self.name,
                description: self.description,
                input_schema: self.input_schema,
            },
            nesting: if self.direct_only {
                ToolNesting::DirectOnly
            } else {
                ToolNesting::Nestable
            },
            semantics: match self.semantics {
                Semantics::Parallel => ToolSemantics::Parallel,
                Semantics::ExclusiveStep => ToolSemantics::ExclusiveStep,
                Semantics::FinishTurn => ToolSemantics::FinishTurn,
            },
            handler: ToolHandler::Prepared(handler),
        })
        .map_err(super::message)?;
        Ok(if self.always_visible {
            tool.always_visible()
        } else {
            tool
        })
    }
}

pub(super) fn stage(
    value: Value,
    module: &Module,
    outputs: &Arc<super::executor::Outputs>,
    model_calls: &Arc<super::model::Calls>,
    calls: &Arc<super::invocation::Calls>,
    source: &super::remote::Source,
    lifecycle: &maka_plugins::fiber::Context,
) -> Result<Staged, String> {
    let registrations: Vec<Registration> = serde_json::from_value(value).map_err(super::message)?;
    stage_entries(
        registrations,
        module,
        outputs,
        model_calls,
        calls,
        source,
        lifecycle,
    )
}
pub(super) fn stage_entries(
    registrations: Vec<Registration>,
    module: &Module,
    outputs: &Arc<super::executor::Outputs>,
    model_calls: &Arc<super::model::Calls>,
    calls: &Arc<super::invocation::Calls>,
    source: &super::remote::Source,
    lifecycle: &maka_plugins::fiber::Context,
) -> Result<Staged, String> {
    if registrations.len() > 128 {
        return Err("plugin contribution limit exceeded".into());
    }
    let mut staged = Staged::default();
    for registration in registrations {
        let remote_stream = matches!(&registration, Registration::RemoteStream { .. });
        match registration {
            Registration::Background { name, callback } => {
                validate_callback(callback)?;
                staged
                    .insert(
                        name,
                        super::background::pending(
                            lifecycle,
                            Arc::new(callbacks::Callback {
                                module: module.clone(),
                                id: callback,
                                calls: calls.clone(),
                            }),
                        )?,
                    )
                    .map_err(super::message)?;
            }
            Registration::Behavior {
                name,
                callback,
                native_input,
            } => {
                validate_callback(callback)?;
                staged
                    .insert(
                        name,
                        maka_plugins::session::SessionBehavior::new(Arc::new(
                            callbacks::Behavior {
                                callback: Arc::new(callbacks::Callback {
                                    module: module.clone(),
                                    id: callback,
                                    calls: calls.clone(),
                                }),
                            },
                        ))
                        .with_native_input(native_input),
                    )
                    .map_err(super::message)?;
            }
            Registration::InputPreparation { name, callback } => {
                validate_callback(callback)?;
                staged
                    .insert(
                        name.clone(),
                        maka_plugins::input::InputPreparation(Arc::new(super::input::Input {
                            callback: Arc::new(callbacks::Callback {
                                module: module.clone(),
                                id: callback,
                                calls: calls.clone(),
                            }),
                        })),
                    )
                    .map_err(super::message)?;
            }
            Registration::RemoteMethod {
                name,
                callback,
                access,
                terminal_view,
            }
            | Registration::RemoteStream {
                name,
                callback,
                access,
                terminal_view,
            } => {
                validate_callback(callback)?;
                let handler = Arc::new(super::remote::Remote(Arc::new(callbacks::Callback {
                    module: module.clone(),
                    id: callback,
                    calls: calls.clone(),
                })));
                let handler = if remote_stream {
                    maka_plugins::remote::Handler::Stream(handler)
                } else {
                    maka_plugins::remote::Handler::Method(handler)
                };
                let mut endpoint =
                    maka_plugins::remote::Endpoint::new(source.content_digest.clone(), handler);
                endpoint.access = access;
                if let Some(descriptor) = terminal_view {
                    endpoint = endpoint
                        .with_terminal_view(descriptor)
                        .map_err(super::message)?;
                }
                staged
                    .insert(
                        maka_plugins::remote::key(&source.package_id, &name)
                            .map_err(super::message)?,
                        endpoint,
                    )
                    .map_err(super::message)?;
            }
            Registration::ModelProvider {
                name,
                descriptor,
                callback,
            } => {
                validate_callback(callback)?;
                staged
                    .insert(
                        name,
                        maka_plugins::provider::Definition::new(
                            descriptor,
                            Arc::new(super::provider::JavaScript {
                                callback: Arc::new(callbacks::Callback {
                                    module: module.clone(),
                                    id: callback,
                                    calls: calls.clone(),
                                }),
                                calls: model_calls.clone(),
                            }),
                        )
                        .map_err(super::message)?,
                    )
                    .map_err(super::message)?;
            }
            Registration::ModelAdapter { name, callback } => {
                validate_callback(callback)?;
                staged
                    .insert(
                        name,
                        maka_plugins::model::Adapter {
                            provider: Arc::new(super::model::Adapter {
                                callback: Arc::new(callbacks::Callback {
                                    module: module.clone(),
                                    id: callback,
                                    calls: calls.clone(),
                                }),
                                calls: model_calls.clone(),
                            }),
                        },
                    )
                    .map_err(super::message)?;
            }
            Registration::Executor {
                name,
                display_name,
                capabilities,
                callback,
            } => {
                validate_callback(callback)?;
                if display_name.is_empty() || display_name.len() > 256 {
                    return Err("invalid executor display name".into());
                }
                staged
                    .insert(
                        name.as_str(),
                        maka_plugins::executor::Executor {
                            id: name.clone(),
                            display_name,
                            capabilities,
                            provider: Arc::new(super::executor::Executor {
                                callback: Arc::new(callbacks::Callback {
                                    module: module.clone(),
                                    id: callback,
                                    calls: calls.clone(),
                                }),
                                outputs: outputs.clone(),
                            }),
                        },
                    )
                    .map_err(super::message)?;
            }
            Registration::Tool {
                definition,
                callback,
            } => {
                validate_callback(callback)?;
                let name = definition.name.clone();
                let handler = Arc::new(callbacks::Tool {
                    callback: Arc::new(callbacks::Callback {
                        module: module.clone(),
                        id: callback,
                        calls: calls.clone(),
                    }),
                    name: name.clone(),
                });
                staged
                    .insert(name, definition.registration(handler)?)
                    .map_err(super::message)?;
            }
            Registration::ToolGroup { tools, callback } => {
                validate_callback(callback)?;
                if tools.is_empty() || tools.len() > 128 {
                    return Err("invalid tool binding group size".into());
                }
                let names = tools.iter().map(|tool| tool.name.clone()).collect();
                let provider = Arc::new(super::binding::Provider {
                    callback: Arc::new(callbacks::Callback {
                        module: module.clone(),
                        id: callback,
                        calls: calls.clone(),
                    }),
                    names,
                });
                for definition in tools {
                    let name = definition.name.clone();
                    let tool = definition
                        .registration(provider.clone())?
                        .with_binding(provider.clone());
                    staged.insert(name, tool).map_err(super::message)?;
                }
            }
            Registration::Section {
                format,
                name,
                callback,
                order,
                complete,
            } => {
                staged
                    .insert(
                        name,
                        prompt::Section {
                            format,
                            order,
                            mode: if complete {
                                prompt::SectionMode::Complete
                            } else {
                                prompt::SectionMode::Append
                            },
                            text: provider(module, callback, calls)?,
                        },
                    )
                    .map_err(super::message)?;
            }
            Registration::Variable { name, callback } => {
                staged
                    .insert(name, prompt::Variable(provider(module, callback, calls)?))
                    .map_err(super::message)?;
            }
            Registration::Context {
                format,
                name,
                callback,
                order,
            } => {
                staged
                    .insert(
                        name,
                        prompt::DynamicContext {
                            format,
                            order,
                            text: provider(module, callback, calls)?,
                        },
                    )
                    .map_err(super::message)?;
            }
        }
    }
    Ok(staged)
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Kind {
    ModelProvider,
    ModelAdapter,
    Background,
    Behavior,
    InputPreparation,
    RemoteMethod,
    RemoteStream,
    Executor,
    Tool,
    Section,
    Variable,
    Context,
}

pub(super) fn withdraw(
    publisher: &maka_plugins::contributions::Publisher,
    context: &maka_plugins::fiber::Context,
    kind: Kind,
    names: &[String],
) -> Result<(), maka_plugins::Error> {
    match kind {
        Kind::ModelProvider => publisher.withdraw_many::<maka_plugins::provider::Definition>(names),
        Kind::ModelAdapter => publisher.withdraw_many::<maka_plugins::model::Adapter>(names),
        Kind::Background => {
            publisher.withdraw_many::<Arc<dyn maka_plugins::background::BackgroundWork>>(names)
        }
        Kind::Behavior => publisher.withdraw_many::<maka_plugins::session::SessionBehavior>(names),
        Kind::InputPreparation => {
            publisher.withdraw_many::<maka_plugins::input::InputPreparation>(names)
        }
        Kind::RemoteMethod | Kind::RemoteStream => {
            let package = context.identity()?.package_id;
            publisher.withdraw_many::<maka_plugins::remote::Endpoint>(
                &names
                    .iter()
                    .map(|name| maka_plugins::remote::key(&package, name))
                    .collect::<Result<Vec<_>, _>>()?,
            )
        }
        Kind::Executor => publisher.withdraw_many::<maka_plugins::executor::Executor>(names),
        Kind::Tool => publisher.withdraw_many::<PluginTool>(names),
        Kind::Section => publisher.withdraw_many::<prompt::Section>(names),
        Kind::Variable => publisher.withdraw_many::<prompt::Variable>(names),
        Kind::Context => publisher.withdraw_many::<prompt::DynamicContext>(names),
    }
}
fn provider(
    module: &Module,
    callback: u32,
    calls: &Arc<super::invocation::Calls>,
) -> Result<prompt::Text, String> {
    validate_callback(callback)?;
    Ok(prompt::Text::Dynamic(Arc::new(callbacks::Prompt {
        callback: Arc::new(callbacks::Callback {
            module: module.clone(),
            id: callback,
            calls: calls.clone(),
        }),
    })))
}
fn validate_callback(callback: u32) -> Result<(), String> {
    if callback != 0 {
        Ok(())
    } else {
        Err("invalid JS callback identity".into())
    }
}

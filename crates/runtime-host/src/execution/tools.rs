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

use super::{read, shell};
use crate::session::SessionConfiguration;
use maka_event_log::EventLog;
use maka_fs_tools::{
    EDIT_DESCRIPTION, EDIT_NAME, GLOB_DESCRIPTION, GLOB_NAME, GREP_DESCRIPTION, GREP_NAME,
    MutationExecutor, PATCH_DESCRIPTION, PATCH_NAME, READ_NAME, ReadExecutor, ReadLimits,
    ReadScope, WRITE_DESCRIPTION, WRITE_NAME, WriteCoordinator, WriteScope, edit_schema,
    glob_schema, grep_schema, patch_schema, write_schema,
};
use maka_process::{SHELL_NAME, ShellExecutor};
use maka_protocol::session::SandboxMode;
use maka_protocol::{OperationError, OperationErrorCode};
use maka_tools::{
    ToolCatalog, ToolDefinition, ToolHandler, ToolNesting, ToolRegistration, ToolSemantics,
};
use std::{path::PathBuf, sync::Arc};

mod live;
mod permissions;
mod preview;
pub(super) use live::NativeTools;
pub(super) use preview::validate_pending_tools;

pub(super) fn select_editing(
    catalog: ToolCatalog,
    editing: maka_runtime::execution::EditingTools,
) -> ToolCatalog {
    match editing {
        maka_runtime::execution::EditingTools::ApplyPatch => {
            catalog.excluding(&[EDIT_NAME, WRITE_NAME])
        }
        maka_runtime::execution::EditingTools::Structured => catalog.excluding(&[PATCH_NAME]),
    }
}

pub(super) fn reserve_core_names(
    catalog: &maka_plugins::contributions::Catalog,
) -> Result<(), maka_plugins::Error> {
    catalog.host_only::<maka_tools::plugins::PluginTool>()?;
    catalog.host_only::<maka_plugins::prompt::Section>()?;
    catalog.host_only::<maka_plugins::prompt::Variable>()?;
    catalog.host_only::<maka_plugins::prompt::DynamicContext>()?;
    catalog.host_only::<maka_plugins::executor::Executor>()?;
    catalog.host_only::<maka_plugins::input::InputPreparation>()?;
    catalog.host_only::<maka_plugins::session::SessionBehavior>()?;
    for name in [
        READ_NAME,
        GLOB_NAME,
        GREP_NAME,
        WRITE_NAME,
        EDIT_NAME,
        PATCH_NAME,
        SHELL_NAME,
        shell::STOP_NAME,
        shell::WRITE_STDIN_NAME,
        "AskUserQuestion",
        "tool_search",
        "exec",
        "wait",
        "code_cell",
    ] {
        catalog.reserve::<maka_tools::plugins::PluginTool>(name)?;
    }
    Ok(())
}

/// Definitions and capability identities remain Run-owned. Native calls capture
/// the current durable permission boundary during preparation, before T1.
pub(super) fn catalog(
    native: NativeTools,
    mode: SandboxMode,
    additional_tools: Vec<ToolRegistration>,
    ceiling: Option<&std::collections::BTreeSet<String>>,
) -> Result<ToolCatalog, OperationError> {
    let workspace = super::permissions::read_root(
        mode,
        std::path::Path::new(&native.cwd),
        &native.state_root,
        native.workspace_origin,
    )
    .map_err(unavailable)?;
    let mut registrations = native.registrations(mode, 0)?;
    let set = native.set;
    let live = Arc::new(live::LiveTools::new(native, &registrations));
    for registration in &mut registrations {
        registration.handler = ToolHandler::Prepared(live.clone());
        if matches!(
            registration.definition.name.as_str(),
            WRITE_NAME | EDIT_NAME | PATCH_NAME
        ) {
            registration.definition.description.push_str(
                " When a target needs additional write access, the Host requests approval for the exact files before making changes. If approval is refused or unavailable, no files are changed; do not bypass the refusal using another tool.",
            );
        }
    }
    registrations.extend(additional_tools);
    if let Some(ceiling) = ceiling {
        registrations.retain(|tool| ceiling.contains(&tool.definition.name));
    }
    ToolCatalog::new(registrations)
        .map(|catalog| catalog.with_workspace(workspace))
        .map(|catalog| {
            if set == maka_runtime::execution::NativeToolSet::Workspace {
                catalog.with_discovery()
            } else {
                catalog
            }
        })
        .map_err(unavailable)
}

fn registrations(
    native: &NativeTools,
    mode: SandboxMode,
    revision: u64,
    grants: &[maka_event_log::interactions::PermissionGrant],
) -> Result<Vec<ToolRegistration>, OperationError> {
    if native.set == maka_runtime::execution::NativeToolSet::Attachments {
        return Ok(vec![ToolRegistration {
            definition: ToolDefinition {
                freeform: None, output_schema: None, provider: None,
                name: READ_NAME.into(),
                description: "Read a supplied user attachment from this conversation. Filesystem paths and archives are unavailable. Follow next to continue a bounded page.".into(),
                input_schema: read::schema(),
            },
            handler: ToolHandler::Prepared(Arc::new(read::SessionRead::attachments(native.log.clone()))),
            nesting: ToolNesting::Nestable,
            semantics: ToolSemantics::Parallel,
        }]);
    }
    if native.profile.is_some() {
        return Err(unavailable(
            "Named Session tool profiles are not implemented",
        ));
    }
    let cwd = PathBuf::from(&native.cwd);
    let (mut sandbox, ceiling) =
        super::permissions::resolve(mode, &cwd, &native.state_root, native.workspace_origin)
            .map_err(unavailable)?;
    for grant in grants {
        sandbox = sandbox
            .with_grant(&grant.permissions, &ceiling)
            .map_err(unavailable)?;
    }
    let writes = mode != SandboxMode::ReadOnly
        || grants.iter().any(|grant| {
            grant
                .permissions
                .filesystem
                .iter()
                .any(|rule| rule.access.can_write())
        });
    let (read_scope, write_scope) = match &sandbox {
        maka_sandbox::Sandbox::Managed { filesystem, .. } => {
            let policy = Arc::new(filesystem.compile().map_err(unavailable)?);
            (
                ReadScope::Policy(policy.clone()),
                writes.then_some(WriteScope::Policy(policy)),
            )
        }
        maka_sandbox::Sandbox::Disabled | maka_sandbox::Sandbox::External { .. } => {
            (ReadScope::Unrestricted, Some(WriteScope::Unrestricted))
        }
    };
    let executor =
        ReadExecutor::new(&cwd, read_scope, ReadLimits::default()).map_err(unavailable)?;
    let mut registrations = vec![ToolRegistration {
        definition: ToolDefinition {
            freeform: None,
            output_schema: None,
            provider: None,
            name: READ_NAME.into(),
            description: read::DESCRIPTION.into(),
            input_schema: read::schema(),
        },
        nesting: ToolNesting::Nestable,
        semantics: ToolSemantics::Parallel,
        handler: ToolHandler::Prepared(Arc::new(read::SessionRead::new(
            executor.clone(),
            native.log.clone(),
        ))),
    }];
    let search = Arc::new(executor);
    for (name, description, input_schema) in [
        (GLOB_NAME, GLOB_DESCRIPTION, glob_schema()),
        (GREP_NAME, GREP_DESCRIPTION, grep_schema()),
    ] {
        registrations.push(ToolRegistration {
            definition: ToolDefinition {
                freeform: None,
                output_schema: None,
                provider: None,
                name: name.into(),
                description: description.into(),
                input_schema,
            },
            nesting: ToolNesting::Nestable,
            semantics: ToolSemantics::Parallel,
            handler: ToolHandler::Immediate(search.clone()),
        });
    }
    if let Some(scope) = write_scope {
        let executor = Arc::new(
            MutationExecutor::new(&cwd, scope, native.writes.clone()).map_err(unavailable)?,
        );
        for (name, description, input_schema) in [
            (WRITE_NAME, WRITE_DESCRIPTION, write_schema()),
            (EDIT_NAME, EDIT_DESCRIPTION, edit_schema()),
            (PATCH_NAME, PATCH_DESCRIPTION, patch_schema()),
        ] {
            registrations.push(ToolRegistration {
                definition: ToolDefinition {
                    freeform: None,
                    output_schema: None,
                    provider: None,
                    name: name.into(),
                    description: description.into(),
                    input_schema,
                },
                nesting: ToolNesting::Nestable,
                semantics: ToolSemantics::Parallel,
                handler: ToolHandler::Immediate(executor.clone()),
            });
        }
    }
    // Platform preparation must enforce the captured policy or fail closed;
    // a restricted command is never retried as an unrestricted process.
    {
        let executor = ShellExecutor::new(&cwd, sandbox)
            .map_err(unavailable)?
            .with_network_route(native.network_route.clone());
        #[cfg(target_os = "linux")]
        let executor = executor.with_network_helper(std::env::current_exe().map_err(unavailable)?);
        #[cfg(windows)]
        let executor = executor.with_backend(Arc::new(crate::sandbox::windows::Backend::new(
            &native.state_root,
            &std::env::current_exe().map_err(unavailable)?,
        )));
        let description = format!(
            "{} If the command needs additional access, supply additional_permissions and justification before executing; request only the necessary paths or network access. A failed command is not automatically retried with broader permissions and may have partial effects. Set run_in_background=true for a persistent background task; use Read with its returned ref as path to observe output. Set pty=true for terminal-dependent programs (requires background mode). Background tasks have no default timeout; foreground defaults to 120 seconds and allows at most 600 seconds.",
            executor.description()
        );
        let handler = Arc::new(shell::SessionShell::new(
            executor,
            native.shells.clone(),
            native.log.clone(),
            native.controllers.clone(),
            native.interactions.clone(),
            ceiling,
            revision,
        ));
        registrations.push(ToolRegistration {
            definition: ToolDefinition {
                freeform: None,
                output_schema: None,
                provider: None,
                name: SHELL_NAME.into(),
                description,
                input_schema: shell::schema(),
            },
            nesting: ToolNesting::Nestable,
            semantics: ToolSemantics::Parallel,
            handler: ToolHandler::Prepared(handler.clone()),
        });
        registrations.push(ToolRegistration {
            definition: ToolDefinition {
                freeform: None,
                output_schema: None,
                provider: None,
                name: shell::STOP_NAME.into(),
                description:
                    "Stop a background shell task by its runtime ref and wait for native cleanup."
                        .into(),
                input_schema: shell::stop_schema(),
            },
            nesting: ToolNesting::Nestable,
            semantics: ToolSemantics::Parallel,
            handler: ToolHandler::Prepared(handler.clone()),
        });
        registrations.push(ToolRegistration {
            definition: ToolDefinition {
                freeform: None, output_schema: None, provider: None,
                name: shell::WRITE_STDIN_NAME.into(),
                description: "Send raw input or ordered terminal actions to a background PTY, optionally with resize. Actions: {type:'text',text}, {type:'key',key,modifiers?}, {type:'mouse',event,x,y,button?,direction?,modifiers?}. Text has no terminal controls; use key enter, named navigation keys, or ctrl/alt chords. Mouse requires application-enabled SGR tracking. Returns the committed terminal cut, not output attributed to this input; use Read for later output. A connected Client controller takes precedence.".into(),
                input_schema: shell::write_stdin_schema(),
            },
            nesting: ToolNesting::Nestable,
            semantics: ToolSemantics::Parallel,
            handler: ToolHandler::Prepared(handler),
        });
    }
    Ok(registrations)
}

fn unavailable(message: impl std::fmt::Display) -> OperationError {
    OperationError {
        code: OperationErrorCode::OperationUnavailable,
        message: message.to_string(),
    }
}

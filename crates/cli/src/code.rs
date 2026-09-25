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

use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;

use maka_event_log::EventLog;
use maka_fs_tools::{
    MutationExecutor, ReadExecutor, ReadLimits, ReadScope, WriteCoordinator, WriteScope,
};
use maka_js_runtime::{
    CellAbort, CellContext, CellDiagnosticKind, CellLimits, CellResult, CellStore, CodeExecutor,
    ToolMetadata,
};
use maka_runtime::event::{EventWrite, Fact, Invocation, InvocationOutcome, RuntimeEvent};
use maka_runtime::execution::{
    ApprovalPolicy, BehaviorId, CollaborationMode, InvocationConfiguration, SandboxMode, ToolMode,
};
use maka_runtime::tools::{JournaledTools, ToolError, ToolExecutor, ToolFuture};
use maka_sandbox::{
    Sandbox,
    filesystem::{Access, Rule},
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(clap::Args)]
pub(super) struct Args {
    #[arg(long, value_name = "FILE")]
    log: PathBuf,
    /// Filesystem isolation: read-only, workspace-write (default), danger-full-access.
    #[arg(long, value_parser = parse_sandbox)]
    sandbox: Option<SandboxMode>,
    /// Approval policy: on-request (default) or never. Code cells have no approval UI.
    #[arg(long, value_parser = parse_approval)]
    ask_for_approval: Option<ApprovalPolicy>,
    /// Disable isolation and approvals. Only use for a trusted task.
    #[arg(long, conflicts_with_all = ["sandbox", "ask_for_approval"])]
    dangerously_bypass_approvals_and_sandbox: bool,
}

fn parse_sandbox(value: &str) -> Result<SandboxMode, String> {
    match value {
        "read-only" => Ok(SandboxMode::ReadOnly),
        "workspace-write" => Ok(SandboxMode::WorkspaceWrite),
        "danger-full-access" => Ok(SandboxMode::DangerFullAccess),
        _ => Err("expected read-only, workspace-write, or danger-full-access".into()),
    }
}

fn parse_approval(value: &str) -> Result<ApprovalPolicy, String> {
    match value {
        "on-request" => Ok(ApprovalPolicy::OnRequest),
        "never" => Ok(ApprovalPolicy::Never),
        _ => Err("expected on-request or never".into()),
    }
}

struct LocalTools {
    read: ReadExecutor,
    write: MutationExecutor,
}

impl ToolExecutor for LocalTools {
    fn names(&self) -> Vec<String> {
        std::iter::once("echo".into())
            .chain(self.read.names())
            .chain(self.write.names())
            .collect()
    }

    fn invoke(&self, name: String, input: Value, cancel: CancellationToken) -> ToolFuture {
        if self.read.names().contains(&name) {
            return self.read.invoke(name, input, cancel);
        }
        if self.write.names().contains(&name) {
            return self.write.invoke(name, input, cancel);
        }
        Box::pin(async move {
            match name.as_str() {
                "echo" if !cancel.is_cancelled() => Ok(input),
                _ => Err(ToolError::Failed(format!(
                    "unsupported or cancelled tool: {name}"
                ))),
            }
        })
    }
}

pub(super) async fn run(args: Args) -> Result<(), maka_runtime_host::server::HostError> {
    let (sandbox_mode, approval_policy) = if args.dangerously_bypass_approvals_and_sandbox {
        (SandboxMode::DangerFullAccess, ApprovalPolicy::Never)
    } else {
        (
            args.sandbox.unwrap_or(SandboxMode::WorkspaceWrite),
            args.ask_for_approval.unwrap_or(ApprovalPolicy::OnRequest),
        )
    };
    let cwd = std::env::current_dir()?.canonicalize()?;
    let cwd = PathBuf::from(maka_fs_tools::workspace::project::host_path(&cwd)?);
    let log = Arc::new(EventLog::open(&args.log).await?);
    let (mut sandbox, _) = maka_fs_tools::workspace::permissions::resolve(sandbox_mode, &cwd)?;
    if let Sandbox::Managed { filesystem, .. } = &mut sandbox {
        let path = args.log.canonicalize()?;
        let path = maka_fs_tools::workspace::project::host_path(&path)?;
        for suffix in ["", "-wal", "-shm", "-journal"] {
            filesystem
                .rules
                .push(Rule::exact(format!("{path}{suffix}"), Access::Deny));
        }
    }
    let (read_scope, write_scope) = match sandbox {
        Sandbox::Managed { filesystem, .. } => {
            let policy = Arc::new(filesystem.compile()?);
            (
                ReadScope::Policy(policy.clone()),
                WriteScope::Policy(policy),
            )
        }
        Sandbox::Disabled => (ReadScope::Unrestricted, WriteScope::Unrestricted),
        Sandbox::External { .. } => unreachable!("workspace presets never delegate isolation"),
    };
    let local_tools = LocalTools {
        read: ReadExecutor::new(&cwd, read_scope, ReadLimits::default())?,
        write: MutationExecutor::new(&cwd, write_scope, Arc::new(WriteCoordinator::default()))?,
    };
    let limits = CellLimits::default();
    let mut source = String::new();
    std::io::stdin()
        .take(limits.max_source_bytes as u64 + 1)
        .read_to_string(&mut source)?;
    if source.len() > limits.max_source_bytes {
        return Err("code source exceeds 64 KiB".into());
    }
    let id = || Uuid::new_v4().to_string();
    let invocation = Invocation {
        session_id: id(),
        turn_id: id(),
        run_id: id(),
        invocation_id: id(),
    };
    log.append(&EventWrite::plain(RuntimeEvent::new(
        invocation.clone(),
        Fact::InvocationOpened {
            configuration: Some(Box::new(InvocationConfiguration {
                workspace_origin: maka_runtime::execution::WorkspaceOrigin::Selected,
                system_prompt: None,
                tool_composition: None,
                workspace_identity: None,
                cwd: cwd
                    .into_os_string()
                    .into_string()
                    .map_err(|_| "code working directory is not UTF-8")?,
                sandbox_mode,
                approval_policy,
                boundary_revision: 0,
                collaboration_mode: CollaborationMode::Agent,
                orchestration_mode: BehaviorId::default(),
                tool_mode: ToolMode::CodeMode,
                model: None,
                thinking_level: None,
            })),
            input: maka_runtime::input::InvocationInput::Code {
                source: source.clone(),
            },
        },
    ))?)
    .await?;
    let engine = CodeExecutor::new(1, limits)?;
    let tools = Arc::new(JournaledTools::new(
        log.clone(),
        invocation.clone(),
        Arc::new(local_tools),
    ));
    let cancellation = CancellationToken::new();
    let signal_cancel = cancellation.clone();
    let signal = tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            signal_cancel.cancel();
        }
    });
    let context = CellContext::new(
        CellStore::default(),
        engine.limits().max_value_bytes,
        tools
            .names()
            .into_iter()
            .map(|name| ToolMetadata {
                name,
                description: String::new(),
            })
            .collect(),
    );
    let result = engine
        .execute_with_context(source, tools, cancellation, context.clone())
        .await;
    signal.abort();
    let outcome = match &result {
        Ok(CellResult::Success { .. }) => InvocationOutcome::Completed,
        Ok(CellResult::Failure { error, .. }) => InvocationOutcome::Failed {
            class: match error.kind {
                CellDiagnosticKind::ParseError => "cell_parse",
                CellDiagnosticKind::ExecutionError => "javascript",
                CellDiagnosticKind::UnknownTool => "unknown_tool",
                CellDiagnosticKind::LimitExceeded => "cell_limit",
                CellDiagnosticKind::ToolFailure => "tool_execution",
            }
            .into(),
            message: Some(error.message.chars().take(2048).collect()),
        },
        Err(CellAbort::Cancelled) => InvocationOutcome::Cancelled {
            source: "runtime_cancellation".into(),
        },
        Err(error) => InvocationOutcome::Failed {
            class: match error {
                CellAbort::Tool(_) => "tool_execution",
                CellAbort::Cancelled => unreachable!(),
                CellAbort::Internal(_) => "cell_internal",
            }
            .into(),
            message: Some(error.to_string().chars().take(2048).collect()),
        },
    };
    log.append(&EventWrite::plain(RuntimeEvent::new(
        invocation.clone(),
        Fact::InvocationEnded { outcome },
    ))?)
    .await?;
    log.shutdown().await?;
    match result {
        Ok(output) => {
            println!(
                "{}",
                json!({"invocation": invocation, "output": output, "content": context.take_output(), "notifications":context.take_notifications()})
            );
            if let CellResult::Failure { error, .. } = output {
                return Err(error.message.into());
            }
        }
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

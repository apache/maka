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

use maka_agent_facts::{
    execution::{ApprovalPolicy, SandboxMode},
    tools::{
        ToolError, ToolExecutor, ToolFuture, ToolHandler, ToolNesting, ToolRegistration,
        ToolSemantics,
    },
};
use maka_code_runtime::{CellLimits, CellStore};
use maka_event_log::root::{RootNamespaces, RootOwner};
use maka_fs_tools::{MutationExecutor, ReadExecutor, ReadScope, WriteCoordinator, WriteScope};
use maka_sandbox::{
    Sandbox,
    filesystem::{Access, Rule},
};
use maka_tools::{
    CellAdmission, CellObservation, CodeCells, CodeExecutor, ToolCatalog, ToolDefinition,
};
use serde_json::{Value, json};
use std::{io::Read, path::PathBuf, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
mod persistence;

#[derive(clap::Args)]
pub(super) struct Args {
    /// Owned State Root directory for this execution.
    #[arg(long, value_name = "DIRECTORY")]
    root: PathBuf,
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

pub(super) async fn run(args: Args) -> Result<(), maka_host_runtime::HostError> {
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
    let namespaces = RootNamespaces::for_current_account()?;
    let owner = if args.root.join(maka_event_log::root::ROOT_MARKER).exists() {
        RootOwner::open(&args.root, &namespaces)?
    } else {
        RootOwner::create(&args.root, &namespaces)?
    };
    let root = Arc::new(
        maka_transport::open_store(Arc::new(owner), &maka_product_native::root_migrations())
            .await?,
    );
    let (mut sandbox, _) = maka_fs_tools::workspace::permissions::resolve(sandbox_mode, &cwd)?;
    if let Sandbox::Managed { filesystem, .. } = &mut sandbox {
        for path in [&args.root, &namespaces.ownership, &namespaces.control] {
            let path = path.canonicalize()?;
            filesystem.rules.push(Rule::subtree(
                maka_fs_tools::workspace::project::host_path(&path)?,
                Access::Deny,
            ));
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
    let local_tools = Arc::new(LocalTools {
        read: ReadExecutor::new(&cwd, read_scope)?,
        write: MutationExecutor::new(&cwd, write_scope, Arc::new(WriteCoordinator::default()))?,
    });
    let catalog = ToolCatalog::new(
        local_tools
            .names()
            .into_iter()
            .map(|name| ToolRegistration {
                definition: ToolDefinition {
                    name,
                    description: String::new(),
                    input_schema: json!(true),
                    output_schema: None,
                    provider: None,
                    freeform: None,
                },
                nesting: ToolNesting::Nestable,
                semantics: ToolSemantics::Parallel,
                handler: ToolHandler::Immediate(local_tools.clone()),
            }),
    )
    .map_err(|error| error.to_string())?;
    let mut source = String::new();
    std::io::stdin().read_to_string(&mut source)?;
    let session_id = Uuid::new_v4().to_string();
    let binding = root
        .attach_workspace("cli-code", &json!({"path":cwd}))
        .await?;
    let stamp = maka_sandbox::workspace::BindingStamp {
        id: binding.id,
        permission_epoch: binding.permission_epoch_at_attach,
    };
    let now = persistence::now();
    let session = root.create_session(&session_id, "maka.cli.code.v1", &json!({"workspace":binding, "boundary_revision":0, "sandboxMode":sandbox_mode, "approvalPolicy":approval_policy}), u64::try_from(now.0)?).await?;
    let scope = session
        .work_scope(Some(maka_sandbox::workspace::PermissionBasis {
            boundary_revision: 0,
            binding: stamp,
        }))
        .await?;
    let executor = CodeExecutor::new(CellLimits::default())?;
    let cancellation = CancellationToken::new();
    let admission = CellAdmission::new(
        source,
        maka_agent_facts::cells::CellOwner::Standalone {
            session: session_id.clone(),
        },
        now,
    );
    let signal_cancel = cancellation.clone();
    let signal = tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            signal_cancel.cancel();
        }
    });
    let (lease, effects) = scope.accept(cancellation.clone());
    let mut coordinator = None;
    let result = async {
        let custody = lease
            .store()
            .work_custody()
            .map_err(|error| ToolError::Persistence(error.to_string()))?;
        let data = root
            .data_writer_for_work(custody.as_ref(), &session_id)
            .map_err(|error| ToolError::Persistence(error.to_string()))?;
        let cells_store = maka_agent_state::cells::CellsStore::new(data);
        let reader = cells_store.reader(session_id.clone(), tokio::runtime::Handle::current());
        let cells = CodeCells::new(executor, CellStore::new(reader));
        coordinator = Some(cells.clone());
        let port = Arc::new(persistence::Standalone {
            root: root.clone(),
            cells: cells_store,
            session: session_id.clone(),
            cell: admission.id(),
            custody,
            tools: local_tools,
            admission: Arc::default(),
        });
        let cell = cells
            .start_cell(&admission, catalog, port.clone(), cancellation.clone())
            .await?;
        loop {
            let observed = cells
                .observe_cell(
                    cell,
                    Duration::from_secs(30),
                    false,
                    port.clone(),
                    cancellation.clone(),
                    CancellationToken::new(),
                )
                .await?;
            if !matches!(&observed.observation, CellObservation::Running { .. }) {
                break Ok::<_, ToolError>(observed.observation);
            }
        }
    }
    .await;
    let cleanup = match coordinator {
        Some(cells) => cells.shutdown().await,
        None => Ok(()),
    };
    let drained = effects.settle().await;
    signal.abort();
    let unconfirmed = matches!(
        &cleanup,
        Err(ToolError::CleanupUnconfirmed(_) | ToolError::OperationCleanupUnconfirmed { .. })
    );
    if unconfirmed || drained.is_err() {
        lease.retain_unconfirmed(());
    } else {
        lease.finish();
    }
    let closed = root.shutdown().await;
    println!(
        "{}",
        json!({
            "sessionId":session_id,"cellId":admission.id(),"output":result.as_ref().ok(),
            "error":result.as_ref().err().map(ToString::to_string),
            "settlement":{"cellError":cleanup.as_ref().err().map(ToString::to_string),
                "workError":drained.as_ref().err().map(ToString::to_string),
                "rootError":closed.as_ref().err().map(ToString::to_string)}
        })
    );
    drained?;
    cleanup?;
    closed?;
    let output = result
        .map_err(|error| format!("Cell {} in Session {session_id}: {error}", admission.id()))?;
    if let CellObservation::Interrupted { report, .. } = output {
        return Err(format!("code Cell interrupted: {report}").into());
    }
    Ok(())
}

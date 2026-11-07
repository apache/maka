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

use crate::{
    protocol::{Reply, Request, Start},
    value::{from_json, to_json},
};
use maka_code_runtime::{CellDiagnostic, CellDiagnosticKind};
use monty::{MontyRun, RunProgress};
use monty_types::{
    CompileOptions, ExcType, ExtFunctionResult, MontyException, MontyObject, MontyUuid,
    NameLookupResult, OsFunctionCall, OsPolicy, PrintWriter, ResourceLimits, ResourceTracker,
    SleepMode,
};
use std::{
    io::{self, BufRead, Write},
    time::Duration,
};

const HELPERS: &[&str] = &[
    "text",
    "image",
    "audio",
    "generated_image",
    "notify",
    "store",
    "load",
    "yield_control",
    "exit",
];

/// Internal entry point of the bundled worker executable. Its allocator must be
/// monty_alloc::LimitedAllocator; never install that allocator in the Host.
pub fn run_stdio() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let heap: usize = args.next().ok_or("missing heap budget")?.parse()?;
    let timeout: u64 = args.next().ok_or("missing execution budget")?.parse()?;
    monty_alloc::set_hard_limit(monty_types::memory_limit_with_headroom(Some(heap), false))?;
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut input = stdin.lock();
    let mut output = stdout.lock();
    let start: Start = read(&mut input)?;
    write(&mut output, &Request::Ready)?;
    let result = execute(
        start,
        ResourceLimits {
            max_feed_duration: Some(Duration::from_millis(timeout)),
            max_memory: Some(heap),
            ..Default::default()
        },
        &mut input,
        &mut output,
    );
    let error = match result {
        Ok(()) => None,
        Err(WorkerError::Python(error)) => Some(diagnostic(error)),
        Err(WorkerError::Diagnostic(error)) => Some(error),
        Err(WorkerError::Protocol(error)) => return Err(error),
    };
    write(&mut output, &Request::Complete { error })?;
    Ok(())
}

enum WorkerError {
    Diagnostic(CellDiagnostic),
    Python(MontyException),
    Protocol(Box<dyn std::error::Error>),
}
impl From<MontyException> for WorkerError {
    fn from(error: MontyException) -> Self {
        Self::Python(error)
    }
}
impl From<Box<dyn std::error::Error>> for WorkerError {
    fn from(error: Box<dyn std::error::Error>) -> Self {
        Self::Protocol(error)
    }
}

fn execute(
    start: Start,
    limits: ResourceLimits,
    input: &mut impl BufRead,
    output: &mut impl Write,
) -> Result<(), WorkerError> {
    let mut inputs: Vec<_> = HELPERS
        .iter()
        .map(|name| MontyObject::function(format!("helper:{name}"), None))
        .collect();
    let mut names: Vec<String> = HELPERS.iter().map(|name| (*name).into()).collect();
    names.extend(["tools".into(), "ALL_TOOLS".into()]);
    inputs.push(MontyObject::module(
        "tools",
        MontyUuid::from_bytes(*uuid::Uuid::new_v4().as_bytes()),
        start.names.into_iter().map(|name| {
            (
                MontyObject::string(crate::tool_identifier(&name)),
                MontyObject::function(format!("tool:{name}"), None),
            )
        }),
    ));
    inputs.push(MontyObject::tuple(start.metadata.into_iter().map(|tool| {
        MontyObject::named_tuple(
            "Tool",
            ["name", "description"],
            [
                MontyObject::string(tool.name),
                MontyObject::string(tool.description),
            ],
        )
    })));
    let runner = match MontyRun::new(
        start.source,
        "code_mode.py",
        names,
        CompileOptions::default(),
    ) {
        Ok(runner) => runner.with_os_policy(OsPolicy {
            sleep: SleepMode::CallHost,
            ..Default::default()
        }),
        Err(error) => {
            return Err(WorkerError::Diagnostic(CellDiagnostic::new(
                CellDiagnosticKind::ParseError,
                error.to_string(),
            )));
        }
    };
    let mut progress = runner.start(inputs, ResourceTracker::new(limits), PrintWriter::Disabled)?;
    loop {
        progress = match progress {
            RunProgress::Complete(_) => return Ok(()),
            RunProgress::FunctionCall(call) => {
                let arguments = (|| -> Result<_, String> {
                    let args = call.args.args().map(to_json).collect::<Result<_, _>>()?;
                    let kwargs = call
                        .args
                        .kwargs()
                        .map(|(key, value)| {
                            Ok((
                                key.as_str().ok_or("keyword must be a string")?.into(),
                                to_json(value)?,
                            ))
                        })
                        .collect::<Result<_, String>>()?;
                    Ok((args, kwargs))
                })();
                let reply = match arguments {
                    Ok((args, kwargs)) => exchange(
                        input,
                        output,
                        &Request::Call {
                            id: call.call_id,
                            name: call.function_name.clone(),
                            args,
                            kwargs,
                        },
                    )?,
                    Err(error) => Reply::Error {
                        error: CellDiagnostic::new(CellDiagnosticKind::ExecutionError, error),
                    },
                };
                match reply {
                    Reply::Pending => call.resume_pending(PrintWriter::Disabled)?,
                    reply => call.resume(reply_result(reply)?, PrintWriter::Disabled)?,
                }
            }
            RunProgress::ResolveFutures(wait) => {
                let reply = exchange(
                    input,
                    output,
                    &Request::Resolve {
                        ids: wait.pending_call_ids().to_vec(),
                    },
                )?;
                let Reply::Resolved { results } = reply else {
                    return Err(protocol("expected resolved futures"));
                };
                wait.resume(
                    results
                        .into_iter()
                        .map(|(id, result)| (id, external(result)))
                        .collect(),
                    PrintWriter::Disabled,
                )?
            }
            RunProgress::OsCall(call) => {
                let (duration, asynchronous) = match call.function_call {
                    OsFunctionCall::Sleep(duration) => (duration, false),
                    OsFunctionCall::AsyncSleep(duration) => (duration, true),
                    _ => {
                        progress = call.resume(
                            MontyException::runtime_error(
                                "direct OS access is unavailable; use an authorized Host tool",
                            ),
                            PrintWriter::Disabled,
                        )?;
                        continue;
                    }
                };
                let reply = exchange(
                    input,
                    output,
                    &Request::Sleep {
                        id: call.call_id,
                        duration,
                        asynchronous,
                    },
                )?;
                let result = match reply {
                    Reply::Pending => ExtFunctionResult::Future(call.call_id),
                    reply => reply_result(reply)?,
                };
                call.resume(result, PrintWriter::Disabled)?
            }
            RunProgress::NameLookup(lookup) => {
                lookup.resume(NameLookupResult::Undefined, PrintWriter::Disabled)?
            }
        };
    }
}

fn external(result: Result<serde_json::Value, CellDiagnostic>) -> ExtFunctionResult {
    match result {
        Ok(value) => ExtFunctionResult::Return(from_json(value)),
        Err(error) => ExtFunctionResult::Error(MontyException::runtime_error(error.message)),
    }
}
fn reply_result(reply: Reply) -> Result<ExtFunctionResult, WorkerError> {
    match reply {
        Reply::Return { value } => Ok(external(Ok(value))),
        Reply::Error { error } => Ok(external(Err(error))),
        _ => Err(protocol("expected function result")),
    }
}
fn protocol(message: &str) -> WorkerError {
    WorkerError::Protocol(message.into())
}
fn exchange(
    input: &mut impl BufRead,
    output: &mut impl Write,
    request: &Request,
) -> Result<Reply, Box<dyn std::error::Error>> {
    write(output, request)?;
    read(input)
}
fn read<T: serde::de::DeserializeOwned>(
    input: &mut impl BufRead,
) -> Result<T, Box<dyn std::error::Error>> {
    let mut line = String::new();
    if input.read_line(&mut line)? == 0 {
        return Err("Host closed the worker protocol".into());
    }
    Ok(crate::protocol::decode(line.as_bytes())?)
}
fn write(
    output: &mut impl Write,
    message: &impl serde::Serialize,
) -> Result<(), Box<dyn std::error::Error>> {
    serde_json::to_writer(&mut *output, message)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}
fn diagnostic(error: MontyException) -> CellDiagnostic {
    let kind = match error.exc_type() {
        ExcType::MemoryError | ExcType::TimeoutError => CellDiagnosticKind::LimitExceeded,
        _ => CellDiagnosticKind::ExecutionError,
    };
    CellDiagnostic::new(kind, error.to_string())
}

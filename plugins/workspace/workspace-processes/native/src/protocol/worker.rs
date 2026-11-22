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
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

enum LifecycleEnd {
    Wait(Result<std::process::ExitStatus, String>),
    Failed(String),
}

#[expect(
    clippy::too_many_arguments,
    reason = "The process worker receives independent task, role, command, input and close-channel owners"
)]
pub(super) async fn run(
    owner: &Processes,
    context: &Context,
    id: Uuid,
    resource_ref: String,
    isolated: maka_process::isolated::TaskOwner,
    role: Role,
    command: maka_process::Command,
    input: mpsc::Receiver<Write>,
    mut close_receive: mpsc::Receiver<oneshot::Sender<Result<Written, String>>>,
) -> HandlerResult {
    let result:HandlerResult=async {
    let setup=match &role { Role::Runtime(_)=>None,Role::Setup(access)=>Some((access.clone(),isolated.home_capture())) };
    let mut ticket=context.scope().resources.reserve().map_err(diagnostic)?;
    ticket.start();
    let mut process=match isolated.spawn_pipe(command).await {
        Ok(process)=>process,
        Err(maka_process::isolated::SpawnError::Closed(error))=>{
            ticket.complete(Ok(()));
            return Err(HandlerError::Unknown {diagnostic:error.to_string()});
        },
        Err(maka_process::isolated::SpawnError::Unconfirmed(failure))=>{
            let diagnostic=failure.to_string();
            ticket.unconfirmed(diagnostic.clone(),failure);
            return Err(HandlerError::Unknown {diagnostic});
        },
    };
    let stop_output=CancellationToken::new();let finished=CancellationToken::new();let fault=CancellationToken::new();
    let failure=Mutex::new(None);
    let lifecycle=async {
        let mut close_open=true;
        let end=loop {
            tokio::select! {biased;
                status=process.child.wait()=>break LifecycleEnd::Wait(status.map_err(|error|error.to_string())),
                reason=async {tokio::select! {biased;
                    ()=context.scope().cancellation.cancelled()=>"Root observer closed",
                    ()=owner.drain.cancelled()=>"Protocol provider closed",
                    ()=fault.cancelled()=>"Protocol observer I/O failed",
                }}=>{
                    failure.lock().unwrap().get_or_insert_with(||reason.to_owned());
                    stop_output.cancel();
                    if let Err(error)=process.child.terminate().await {break LifecycleEnd::Failed(error.to_string());}
                    break LifecycleEnd::Wait(process.child.wait().await.map_err(|error|error.to_string()));
                },
                request=close_receive.recv(),if close_open=>{
                    let Some(reply)=request else {close_open=false;continue;};
                    let result=process.child.terminate().await.map_err(|error|error.to_string());
                    let _=reply.send(result.as_ref().map(|_|Written {bytes:0,closed:false}).map_err(Clone::clone));
                    if let Err(error)=result {break LifecycleEnd::Failed(error);}
                },
            }
        };
        if !matches!(&end,LifecycleEnd::Wait(Ok(_))) && setup.is_none() {stop_output.cancel();}
        finished.cancel();end
    };
    let output=async {
        let announced=context.emit(serde_json::to_value(Progress::Started {id,resource_ref:resource_ref.clone()}).map_err(|error|error.to_string())?).await;
        if let Err(error)=announced {
            failure.lock().unwrap().get_or_insert(error.clone());fault.cancel();
            if setup.is_none() {return Err(error);}
        }
        let (stdout,stderr)=tokio::join!(
            read(process.stdout,Stream::Stdout,context,&stop_output,&failure,&fault,setup.is_some()),
            read(process.stderr,Stream::Stderr,context,&stop_output,&failure,&fault,setup.is_some()),
        );
        stdout.and(stderr)
    };
    let (end,(),pipes)=tokio::join!(lifecycle,report(write(process.stdin,input,&finished),&failure,&fault),output);
    let (status,physical)=match end {
        LifecycleEnd::Wait(status)=>{
            #[cfg(unix)]
            let physical=process.child.local_resources_closed();
            #[cfg(not(unix))]
            let physical=status.is_ok();
            (status,physical)
        },
        LifecycleEnd::Failed(diagnostic)=>(Err(diagnostic),false),
    };
    if physical {drop(process.child);ticket.complete(Ok(()));}
    else {
        let diagnostic=status.as_ref().err().or_else(||pipes.as_ref().err()).cloned()
            .unwrap_or_else(||"Original local protocol resources remain unconfirmed".into());
        ticket.unconfirmed(diagnostic,(process.child,setup.as_ref().map(|(_,capture)|capture.clone())));
    }
    let status=status.map_err(|diagnostic|HandlerError::Unknown {diagnostic:format!("{diagnostic}; original resource: {resource_ref}")})?;
    pipes.map_err(|diagnostic|HandlerError::Unknown {diagnostic})?;
    if let Some(diagnostic)=failure.into_inner().unwrap() {return Err(HandlerError::Unknown {diagnostic});}
    if let Some((access,capture))=setup {
        // This is provisional material only. The original top-level operation
        // publishes it only after the ACP authentication ACK is confirmed.
        let home=capture.freeze().await.map_err(diagnostic)?;
        access.0.stage_home(context,home).await.map_err(diagnostic)?;
    }
    Ok(HandlerValue::Json(serde_json::to_value(Completion::Exited {
        code:status.code(),success:status.success(),stopped:false,error:None,
    }).map_err(diagnostic)?))
    }.await;
    // A queued close may arrive after child.wait while streams or the HOME
    // artifact are still settling. Only the completed original run answers it.
    close_receive.close();
    while let Some(reply) = close_receive.recv().await {
        let settled = result
            .as_ref()
            .map(|_| Written {
                bytes: 0,
                closed: true,
            })
            .map_err(|error| error.to_string());
        let _ = reply.send(settled);
    }
    result
}

async fn write(
    mut stdin: maka_process::pipe::Input,
    mut input: mpsc::Receiver<Write>,
    finished: &CancellationToken,
) -> Result<(), String> {
    loop {
        let request = tokio::select! {
            biased;
            () = finished.cancelled() => return Ok(()),
            request = input.recv() => request,
        };
        let Some(request) = request else {
            return Ok(());
        };
        let Some(bytes) = request.bytes else {
            // Host stdin EOF detaches the helper relay. It is not a kill.
            drop(stdin);
            let _ = request.reply.send(Ok(Written {
                bytes: 0,
                closed: true,
            }));
            return Ok(());
        };
        let count = bytes.len();
        let result = tokio::select! {
            biased;
            () = finished.cancelled() => Err("Protocol process ended during input".into()),
            result = stdin.write_all(&bytes) => result.map_err(|e| e.to_string()),
        };
        let failure = result.as_ref().err().cloned();
        let _ = request.reply.send(result.map(|()| Written {
            bytes: count,
            closed: false,
        }));
        if let Some(error) = failure {
            return Err(error);
        }
    }
}
async fn report(
    future: impl Future<Output = Result<(), String>>,
    failure: &Mutex<Option<String>>,
    fault: &CancellationToken,
) {
    if let Err(error) = future.await {
        failure.lock().unwrap().get_or_insert(error);
        fault.cancel();
    }
}
async fn read(
    mut source: impl AsyncRead + Unpin,
    stream: Stream,
    context: &Context,
    stop_output: &CancellationToken,
    failure: &Mutex<Option<String>>,
    fault: &CancellationToken,
    drain_on_error: bool,
) -> Result<(), String> {
    let mut buffer = vec![0; CHUNK_BYTES];
    let mut emit = true;
    loop {
        let count = tokio::select! {
            ()=stop_output.cancelled()=>return Ok(()),
            count=source.read(&mut buffer)=>count.map_err(|error|{
                let diagnostic=error.to_string();failure.lock().unwrap().get_or_insert(diagnostic.clone());fault.cancel();diagnostic
            })?,
        };
        if count == 0 {
            return Ok(());
        }
        if !emit {
            continue;
        }
        let value = serde_json::to_value(Progress::Output {
            stream,
            bytes: buffer[..count].to_vec(),
        })
        .map_err(|error| error.to_string())?;
        let result = tokio::select! {
            ()=stop_output.cancelled()=>return Ok(()),
            result=context.emit(value)=>result,
        };
        if let Err(error) = result {
            failure.lock().unwrap().get_or_insert(error.clone());
            fault.cancel();
            if !drain_on_error {
                return Err(error);
            }
            emit = false;
        }
    }
}

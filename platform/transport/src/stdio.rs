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

use std::io::{self, Read, Write};
use tokio::{io::DuplexStream, sync::oneshot};
use tokio_util::io::SyncIoBridge;

/// Process-lifetime stdio workers own no Host, deployment or effect leases.
/// An open input pipe or blocked output must not hold Tokio shutdown hostage.
pub struct Stdio {
    pub input: DuplexStream,
    pub output: DuplexStream,
    pub output_done: oneshot::Receiver<io::Result<()>>,
}

impl Stdio {
    pub fn open() -> io::Result<Self> {
        let (input, writer) = tokio::io::duplex(32 * 1024);
        let mut writer = SyncIoBridge::new(writer);
        let Output {
            writer: output,
            done: output_done,
        } = Output::open("bridge-stdout", io::stdout())?;
        std::thread::Builder::new()
            .name("bridge-stdin".into())
            .spawn(move || {
                // EOF drops the duplex writer. The async caller also checks for
                // a partial greeting before allowing any Host activation.
                let _ = io::copy(&mut io::stdin().lock(), &mut writer);
            })?;
        Ok(Self {
            input,
            output,
            output_done,
        })
    }
}

/// Blocking OS writes belong to process-lifetime threads, not Tokio's blocking
/// pool: abandoning a full pipe must not prevent the CLI runtime from exiting.
pub struct Output {
    pub writer: DuplexStream,
    pub done: oneshot::Receiver<io::Result<()>>,
}

impl Output {
    pub fn open(name: &str, mut output: impl Write + Send + 'static) -> io::Result<Self> {
        let (writer, reader) = tokio::io::duplex(32 * 1024);
        let mut reader = SyncIoBridge::new(reader);
        let (done, completion) = oneshot::channel();
        std::thread::Builder::new()
            .name(name.into())
            .spawn(move || {
                let result = (|| {
                    let mut bytes = [0; 16 * 1024];
                    loop {
                        let count = reader.read(&mut bytes)?;
                        if count == 0 {
                            return output.flush();
                        }
                        output.write_all(&bytes[..count])?;
                        output.flush()?;
                    }
                })();
                let _ = done.send(result);
            })?;
        Ok(Self {
            writer,
            done: completion,
        })
    }
}

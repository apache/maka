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

use super::{Value, model};
use std::{
    io,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

/// Interactive users may pause indefinitely between requests. Only an accepted
/// connection has a deadline; responses reuse the automated fixture's logic.
pub(super) async fn start() -> model::Provider {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let executed = Arc::new(Mutex::new(Vec::<String>::new()));
    let delegated = Arc::new(Mutex::new(Vec::<String>::new()));
    let runs = executed.clone();
    let routes = delegated.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            match tokio::time::timeout(
                Duration::from_secs(20),
                respond(&mut stream, &runs, &routes),
            )
            .await
            {
                Ok(Ok(())) => {}
                Ok(Err(error)) => eprintln!("Manual fixture connection ended: {error}"),
                Err(_) => eprintln!("Manual fixture connection exceeded its read/write deadline"),
            }
        }
    });
    model::Provider {
        url,
        executed,
        delegated,
        task,
    }
}

async fn respond(
    stream: &mut TcpStream,
    runs: &Mutex<Vec<String>>,
    routes: &Mutex<Vec<String>>,
) -> io::Result<()> {
    let (content_type, body) = match request(stream).await? {
        Some(body) => {
            let chunk = model::response(&body, runs, routes);
            (
                "text/event-stream",
                format!("data: {chunk}\n\ndata: [DONE]\n\n"),
            )
        }
        None => ("application/json", model::models().to_string()),
    };
    stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await
}

async fn request(stream: &mut TcpStream) -> io::Result<Option<Value>> {
    const LIMIT: usize = 2 * 1024 * 1024;
    let invalid = |message| io::Error::new(io::ErrorKind::InvalidData, message);
    let mut bytes = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let count = stream.read(&mut buffer).await?;
        if count == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() > LIMIT {
            return Err(invalid("fixture request exceeded its size limit"));
        }
        let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") else {
            if bytes.len() > 16384 {
                return Err(invalid("fixture header exceeded its size limit"));
            }
            continue;
        };
        if end > 16384 {
            return Err(invalid("fixture header exceeded its size limit"));
        }
        let header = std::str::from_utf8(&bytes[..end]).map_err(io::Error::other)?;
        if header.starts_with("GET /v1/models ") {
            return Ok(None);
        }
        if !header.starts_with("POST /v1/chat/completions ") {
            return Err(invalid("unexpected fixture endpoint"));
        }
        let length = header
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>())
            })
            .ok_or_else(|| invalid("missing fixture content length"))?
            .map_err(io::Error::other)?;
        if length > LIMIT - end - 4 {
            return Err(invalid("fixture body exceeded its size limit"));
        }
        if bytes.len() >= end + 4 + length {
            return serde_json::from_slice(&bytes[end + 4..end + 4 + length])
                .map(Some)
                .map_err(io::Error::other);
        }
    }
}

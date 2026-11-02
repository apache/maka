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

use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::net::TcpStream;

pub async fn read_request(socket: &mut TcpStream) -> Value {
    let mut bytes = Vec::new();
    let boundary = loop {
        let mut chunk = [0; 4096];
        let count = socket.read(&mut chunk).await.unwrap();
        assert_ne!(count, 0);
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(at) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            break at + 4;
        }
    };
    let headers = String::from_utf8_lossy(&bytes[..boundary]);
    let chunked = headers.lines().any(|line| {
        line.split_once(':').is_some_and(|(name, value)| {
            name.eq_ignore_ascii_case("transfer-encoding")
                && value.trim().eq_ignore_ascii_case("chunked")
        })
    });
    if chunked {
        let mut offset = boundary;
        let mut body = Vec::new();
        loop {
            let line_end = loop {
                if let Some(end) = bytes[offset..].windows(2).position(|pair| pair == b"\r\n") {
                    break offset + end;
                }
                read_more(socket, &mut bytes).await;
            };
            let size = usize::from_str_radix(
                std::str::from_utf8(&bytes[offset..line_end])
                    .unwrap()
                    .split(';')
                    .next()
                    .unwrap(),
                16,
            )
            .unwrap();
            offset = line_end + 2;
            if size == 0 {
                while bytes.len() < offset + 2 {
                    read_more(socket, &mut bytes).await;
                }
                assert_eq!(&bytes[offset..offset + 2], b"\r\n");
                assert_eq!(
                    bytes.len(),
                    offset + 2,
                    "unexpected bytes after request EOF"
                );
                break;
            }
            while bytes.len() < offset + size + 2 {
                read_more(socket, &mut bytes).await;
            }
            body.extend_from_slice(&bytes[offset..offset + size]);
            assert_eq!(&bytes[offset + size..offset + size + 2], b"\r\n");
            offset += size + 2;
            bytes.drain(..offset);
            offset = 0;
        }
        drop(bytes);
        return serde_json::from_slice(&body).unwrap();
    }
    let length: usize = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse().unwrap())
        })
        .unwrap();
    while bytes.len() < boundary + length {
        read_more(socket, &mut bytes).await;
    }
    serde_json::from_slice(&bytes[boundary..boundary + length]).unwrap()
}

async fn read_more(socket: &mut TcpStream, bytes: &mut Vec<u8>) {
    let mut chunk = [0; 4096];
    let count = socket.read(&mut chunk).await.unwrap();
    assert_ne!(count, 0);
    bytes.extend_from_slice(&chunk[..count]);
}

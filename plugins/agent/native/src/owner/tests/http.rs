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

//! HTTP framing shared by native provider fixtures. Production requests can
//! stream chunked bodies; the fixture still checks complete JSON and exact EOF.
use serde_json::Value;
use tokio::{io::AsyncReadExt, net::TcpStream};

pub(super) async fn read_request(socket: &mut TcpStream) -> (String, Value) {
    const MAX_BODY_BYTES: usize = 128 * 1024 * 1024;
    let mut bytes = Vec::new();
    let boundary = loop {
        let mut buffer = [0; 4096];
        let count = socket.read(&mut buffer).await.unwrap();
        assert_ne!(
            count,
            0,
            "EOF before complete HTTP headers: buffered_bytes={}",
            bytes.len()
        );
        bytes.extend_from_slice(&buffer[..count]);
        if let Some(at) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            assert!(
                at < 512 * 1024,
                "provider request headers exceed fixture budget"
            );
            break at + 4;
        }
        assert!(
            bytes.len() < 512 * 1024,
            "provider request headers exceed fixture budget"
        );
    };
    let headers = String::from_utf8(bytes[..boundary].to_vec()).unwrap();
    let header = |name: &str| {
        headers
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.trim())
    };
    let body =
        if header("transfer-encoding").is_some_and(|value| value.eq_ignore_ascii_case("chunked")) {
            let mut body = Vec::new();
            let mut offset = boundary;
            loop {
                let size_line_end = line_end(socket, &mut bytes, offset).await;
                let size = usize::from_str_radix(
                    std::str::from_utf8(&bytes[offset..size_line_end])
                        .unwrap()
                        .split(';')
                        .next()
                        .unwrap(),
                    16,
                )
                .unwrap();
                offset = size_line_end + 2;
                if size == 0 {
                    // Consume the terminating empty line, including optional trailers,
                    // before a fixture responds or starts waiting for connection close.
                    loop {
                        let end = line_end(socket, &mut bytes, offset).await;
                        if end == offset {
                            break;
                        }
                        offset = end + 2;
                    }
                    break;
                }
                assert!(
                    size <= MAX_BODY_BYTES - body.len(),
                    "provider body exceeds fixture budget"
                );
                while bytes.len() < offset + size + 2 {
                    read_more(socket, &mut bytes).await;
                }
                body.extend_from_slice(&bytes[offset..offset + size]);
                assert_eq!(&bytes[offset + size..offset + size + 2], b"\r\n");
                offset += size + 2;
            }
            body
        } else {
            let length: usize = header("content-length")
                .expect("request body framing")
                .parse()
                .unwrap();
            assert!(
                length <= MAX_BODY_BYTES,
                "provider body exceeds fixture budget"
            );
            while bytes.len() < boundary + length {
                read_more(socket, &mut bytes).await;
            }
            bytes[boundary..boundary + length].to_vec()
        };
    (headers, serde_json::from_slice(&body).unwrap())
}

async fn line_end(socket: &mut TcpStream, bytes: &mut Vec<u8>, offset: usize) -> usize {
    loop {
        if let Some(end) = bytes[offset..].windows(2).position(|pair| pair == b"\r\n") {
            return offset + end;
        }
        read_more(socket, bytes).await;
    }
}

async fn read_more(socket: &mut TcpStream, bytes: &mut Vec<u8>) {
    let mut buffer = [0; 4096];
    let count = socket.read(&mut buffer).await.unwrap();
    assert_ne!(count, 0, "EOF before complete provider HTTP request");
    bytes.extend_from_slice(&buffer[..count]);
}

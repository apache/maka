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

use super::{transport::Endpoint, *};
use maka_protocol::plugin::{RemoteRequest, RemoteResult};
use serde::de::DeserializeOwned;
use serde_json::Value;

const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_CHAIN_BYTES: usize = 32 * 1024 * 1024;
const MAX_CHAIN_PAGES: usize = 4096;

#[derive(Default)]
struct Budget {
    bytes: usize,
    pages: usize,
    continuations: HashSet<String>,
}

impl Budget {
    fn accept(&mut self, bytes: usize, continuation: Option<&str>) -> Result<(), Failure> {
        self.bytes = self.bytes.checked_add(bytes).ok_or(Failure::Overflow)?;
        self.pages += 1;
        if self.bytes > MAX_CHAIN_BYTES || self.pages > MAX_CHAIN_PAGES {
            return Err(Failure::Overflow);
        }
        if let Some(cursor) = continuation
            && !self.continuations.insert(cursor.into())
        {
            return Err(Failure::Invalid);
        }
        Ok(())
    }
}

pub(super) async fn read(
    client: &Client,
    mount: &Mount,
    document: Uuid,
    endpoint: &Endpoint,
    fence: u64,
    command: Command,
    deliveries: &mpsc::Sender<Delivery>,
) -> Result<(), Failure> {
    let direction = command.direction;
    let mut request = Read {
        mount: mount.token,
        resource: mount.resource.id.clone(),
        fence,
        direction,
        cursor: command.cursor,
    };
    let mut budget = Budget::default();
    loop {
        request.validate().map_err(|_| Failure::Invalid)?;
        let RemoteResult::Value { value } = client
            .plugin_remote(RemoteRequest::Call {
                binding: endpoint.binding.clone(),
                target: endpoint.target.clone(),
                document,
                input: serde_json::to_value(&request).map_err(|_| Failure::Invalid)?,
            })
            .await
            .map_err(|_| Failure::Remote)?
        else {
            return Err(Failure::Invalid);
        };
        let (page, bytes) = decode::<Page>(value)?;
        page.validate().map_err(|_| Failure::Invalid)?;
        if page.fence != fence {
            return Err(Failure::Invalid);
        }
        budget.accept(bytes, page.continuation.as_deref())?;
        let continuation = page.continuation.clone();
        deliver(deliveries, mount.token, Output::Page { direction, page }).await?;
        match continuation {
            Some(cursor) => {
                request.direction = Direction::Continue;
                request.cursor = Some(cursor);
            }
            None => return Ok(()),
        }
    }
}

pub(super) fn decode<T: DeserializeOwned>(value: Value) -> Result<(T, usize), Failure> {
    let bytes = serde_json::to_vec(&value).map_err(|_| Failure::Invalid)?;
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err(Failure::Overflow);
    }
    let output = serde_json::from_value(value).map_err(|_| Failure::Invalid)?;
    Ok((output, bytes.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn continuation_chains_reject_loops_and_bound_staged_bytes_and_count() {
        let mut budget = Budget::default();
        assert_eq!(budget.accept(1, Some("a")), Ok(()));
        assert_eq!(budget.accept(1, Some("b")), Ok(()));
        assert_eq!(budget.accept(1, Some("a")), Err(Failure::Invalid));
        let mut budget = Budget::default();
        assert_eq!(budget.accept(MAX_CHAIN_BYTES, None), Ok(()));
        assert_eq!(budget.accept(1, None), Err(Failure::Overflow));
        let mut budget = Budget::default();
        for _ in 0..MAX_CHAIN_PAGES {
            assert_eq!(budget.accept(1, None), Ok(()));
        }
        assert_eq!(budget.accept(1, None), Err(Failure::Overflow));
    }

    #[test]
    fn encoded_payload_limit_counts_json_escaping() {
        let oversized = Value::String("\n".repeat(MAX_MESSAGE_BYTES / 2));
        assert_eq!(decode::<String>(oversized), Err(Failure::Overflow));
        let malformed = serde_json::json!({"kind": "ready", "fence": 1, "extra": true});
        assert_eq!(decode::<Event>(malformed), Err(Failure::Invalid));
    }
}

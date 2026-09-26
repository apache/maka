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

pub(in super::super) struct Hold {
    request: Value,
    pub before: Value,
    pub entered: Value,
}

impl Hold {
    pub fn begin(
        timed: &mut timed::Timed,
        runtime: &Runtime,
        client: &maka_client::Client,
        proxy: &proxy::DelayProxy,
    ) -> Self {
        let boundary = timed.source(runtime, client, proxy);
        let armed = runtime.block_on(remote(client, "read-control", json!({"op":"arm"})));
        assert_eq!(armed["armed"], true);
        let expected = armed["entered"].as_u64().unwrap() + 1;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            timed
                .read()
                .expect("PTY while waiting for real presenter Read gate");
            let entered = runtime.block_on(remote(client, "read-control", json!({"op":"status"})));
            let requests: Vec<_> = proxy
                .records()
                .into_iter()
                .filter(|row| {
                    row["direction"] == "client_to_host"
                        && row["method"] == "board"
                        && row["remote_kind"] == "call"
                        && row["remote_input_kind"] == "read"
                        && row["received_ns"].as_u64().is_some_and(|ns| {
                            ns > boundary["fence"]["observed_ns"].as_u64().unwrap()
                        })
                        && row["forwarded_ns"].is_u64()
                })
                .collect();
            if entered["pending"] == true
                && entered["entered"] == expected
                && requests.len() == 1
                && proxy.fence()["pending_finite_requests"] == 1
            {
                let hold = Self {
                    request: requests[0].clone(),
                    entered,
                    before: json!({"stats":runtime.block_on(remote(client,"activity-stats",Value::Null)),
                        "fence":proxy.fence()}),
                };
                assert_eq!(hold.state(proxy)["pending"], true);
                return hold;
            }
            assert!(
                Instant::now() < deadline,
                "presenter Read did not enter gate: {entered}; requests={requests:?}"
            );
        }
    }

    fn state(&self, proxy: &proxy::DelayProxy) -> Value {
        let records = proxy.records();
        let reply = records.iter().find(|row| {
            row["direction"] == "host_to_client"
                && row["connection"] == self.request["connection"]
                && row["request_id"] == self.request["request_id"]
        });
        let closed = records.iter().any(|row| {
            row["direction"] == "client_to_host"
                && row["connection"] == self.request["connection"]
                && row["remote_kind"] == "close_document"
                && row["document"] == self.request["document"]
        });
        json!({"request":self.request,"reply":reply,"close_requested":closed,
            "pending":reply.is_none() && !closed})
    }

    pub fn during(&self, proxy: &proxy::DelayProxy, action: impl FnOnce() -> Value) -> Value {
        let before = self.state(proxy);
        let mut sample = action();
        let after = self.state(proxy);
        if before["pending"] != true
            || after["pending"] != true
            || self.request["forwarded_ns"].as_u64().unwrap() > sample["start_ns"].as_u64().unwrap()
        {
            sample["prior_error"] = sample["error"].clone();
            sample["error"] = json!("semantic Read was not held pending throughout local input");
            sample["duration_ns"] = Value::Null;
        }
        sample["pending_read"] =
            json!({"before":before,"after":after,"provider_entered":self.entered});
        sample
    }

    pub fn end(
        self,
        timed: &mut timed::Timed,
        runtime: &Runtime,
        client: &maka_client::Client,
        proxy: &proxy::DelayProxy,
    ) -> Value {
        let pending = self.state(proxy);
        let entered = runtime.block_on(remote(client, "read-control", json!({"op":"status"})));
        let after = json!({"stats":runtime.block_on(remote(client,"activity-stats",Value::Null)),
            "fence":proxy.fence()});
        assert_eq!(pending["pending"], true);
        assert_eq!(
            entered, self.entered,
            "provider gate state changed during local operations"
        );
        runtime.block_on(remote(client, "read-control", json!({"op":"release"})));
        let settled = timed.settled(proxy, false);
        let state = self.state(proxy);
        // Releasing a finite Read keeps its page document alive. No new finite
        // request is allowed, including local RPCs queued behind the delay.
        assert_eq!(
            settled["semantic_calls"],
            self.before["fence"]["semantic_calls"]
        );
        assert_eq!(
            settled["remote_requests_excluding_next"].as_u64().unwrap(),
            self.before["fence"]["remote_requests_excluding_next"]
                .as_u64()
                .unwrap()
        );
        let released = runtime.block_on(remote(client, "read-control", json!({"op":"status"})));
        assert_eq!(state["reply"]["result_kind"], "value");
        assert!(state["reply"]["forwarded_ns"].is_u64());
        assert_eq!(state["close_requested"], false);
        assert_eq!(released["pending"], false);
        assert_eq!(released["entered"], released["released"]);
        json!({"before":self.before,"after":after,"provider_before_release":entered,
            "provider_after_release":released,"read_after_release":state,"settled":settled})
    }
}

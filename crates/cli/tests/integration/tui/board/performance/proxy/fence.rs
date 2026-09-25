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

use serde_json::{Value, json};

pub(super) fn snapshot(records: &[Value]) -> Value {
    use std::collections::{BTreeMap, BTreeSet};
    let identity = |row: &Value| (row["connection"].to_string(), row["request_id"].to_string());
    let replies: BTreeMap<_, _> = records
        .iter()
        .filter(|row| row["direction"] == "host_to_client" && row["forwarded_ns"].is_u64())
        .map(|row| (identity(row), row))
        .collect();
    let requests: Vec<_> = records
        .iter()
        .filter(|row| row["direction"] == "client_to_host" && row["request_id"].is_string())
        .collect();
    let mut allocated = BTreeSet::new();
    let mut pages = BTreeSet::new();
    let mut closed = BTreeSet::new();
    let (mut pending, mut remote_requests, mut calls, mut latest_call_reply_ns) = (0, 0, 0, 0);
    let current = requests
        .iter()
        .rev()
        .find(|request| request["remote_kind"] == "call" && request["method"] == "board");
    let current_document = current.map(|request| {
        (
            request["connection"].to_string(),
            request["document"].to_string(),
        )
    });
    let mut watch_open = 0;
    for request in &requests {
        let reply = replies.get(&identity(request));
        if request["remote_kind"] != "next" {
            pending += usize::from(reply.is_none());
            remote_requests += usize::from(request["operation"] == "plugin.remote");
        }
        calls += usize::from(request["remote_kind"] == "call");
        let document = (
            request["connection"].to_string(),
            request["document"].to_string(),
        );
        match request["remote_kind"].as_str() {
            Some("open_document") => {
                if let Some(reply) = reply.filter(|reply| reply["result_kind"] == "document") {
                    allocated.insert((
                        request["connection"].to_string(),
                        reply["result_document"].to_string(),
                    ));
                }
            }
            Some("open") => {
                if request["method"] == "board-changed"
                    && Some(&document) == current_document.as_ref()
                    && let Some(reply) = reply.filter(|reply| reply["result_kind"] == "opened")
                {
                    watch_open = watch_open.max(reply["forwarded_ns"].as_u64().unwrap());
                }
            }
            Some("close_document")
                if reply.is_some_and(|reply| reply["result_kind"] == "closed") =>
            {
                closed.insert(document);
            }
            Some("call") => {
                if request["method"] == "board" {
                    pages.insert(document);
                }
                if let Some(reply) = reply {
                    latest_call_reply_ns =
                        latest_call_reply_ns.max(reply["forwarded_ns"].as_u64().unwrap());
                }
            }
            _ => {}
        }
    }
    let watch_refresh_settled = watch_open > 0
        && requests.iter().any(|request| {
            request["method"] == "board"
                && request["remote_input_kind"] == "read"
                && request["received_ns"].as_u64().unwrap() > watch_open
                && Some(&(
                    request["connection"].to_string(),
                    request["document"].to_string(),
                )) == current_document.as_ref()
                && replies
                    .get(&identity(request))
                    .is_some_and(|reply| reply["result_kind"] == "value")
        });
    // Page calls and observations share one live document. Only retiring
    // the page closes it; a successful finite Call does not.
    let live: BTreeSet<_> = allocated.difference(&closed).cloned().collect();
    let unowned_documents = live
        .iter()
        .filter(|document| !pages.contains(*document))
        .count();
    json!({"requests":requests.len(), "remote_requests_excluding_next":remote_requests,
        "semantic_calls":calls, "pending_finite_requests":pending,
        "live_documents":live.len(),"live_page_documents":live.len()-unowned_documents,
        "unowned_documents":unowned_documents,"watch_refresh_settled":watch_refresh_settled,
        "latest_call_reply_ns":latest_call_reply_ns})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(rows: &mut Vec<Value>, id: &str, kind: &str, doc: &str, method: &str, ns: u64) {
        rows.push(
            json!({"direction":"client_to_host","connection":1,"request_id":id,
            "operation":"plugin.remote","remote_kind":kind,"method":method,
            "document":doc,"received_ns":ns,"forwarded_ns":ns,"remote_input_kind":"read"}),
        );
    }

    fn reply(rows: &mut Vec<Value>, id: &str, kind: &str, doc: &str, ns: Option<u64>) {
        rows.push(
            json!({"direction":"host_to_client","connection":1,"request_id":id,
            "result_kind":kind,"result_document":doc,"forwarded_ns":ns}),
        );
    }

    fn page(rows: &mut Vec<Value>, doc: &str, start: u64) {
        let allocate = format!("allocate-{doc}");
        request(rows, &allocate, "open_document", "", "", start);
        reply(rows, &allocate, "document", doc, Some(start + 1));
        let read = format!("initial-{doc}");
        request(rows, &read, "call", doc, "board", start + 2);
        reply(rows, &read, "value", doc, Some(start + 3));
    }

    #[test]
    fn a_page_survives_replied_calls_but_pending_and_unforwarded_replies_do_not_settle() {
        let mut rows = vec![];
        page(&mut rows, "page", 10);
        request(&mut rows, "watch", "open", "page", "board-changed", 20);
        reply(&mut rows, "watch", "opened", "page", Some(30));
        request(&mut rows, "refresh", "call", "page", "board", 40);
        assert_eq!(snapshot(&rows)["pending_finite_requests"], 1);
        assert_eq!(snapshot(&rows)["watch_refresh_settled"], false);
        reply(&mut rows, "refresh", "value", "page", None);
        assert_eq!(snapshot(&rows)["pending_finite_requests"], 1);
        assert_eq!(snapshot(&rows)["watch_refresh_settled"], false);
        rows.last_mut().unwrap()["forwarded_ns"] = json!(50);
        request(&mut rows, "next", "next", "page", "", 60);
        let settled = snapshot(&rows);
        assert_eq!(settled["pending_finite_requests"], 0);
        assert_eq!(settled["live_page_documents"], 1);
        assert_eq!(settled["unowned_documents"], 0);
        assert_eq!(settled["watch_refresh_settled"], true);
        assert_eq!(settled["latest_call_reply_ns"], 50);

        request(&mut rows, "held", "call", "page", "board", 70);
        assert_eq!(snapshot(&rows)["pending_finite_requests"], 1);
        let requests = snapshot(&rows)["remote_requests_excluding_next"].clone();
        reply(&mut rows, "held", "value", "page", Some(80));
        assert_eq!(snapshot(&rows)["remote_requests_excluding_next"], requests);
        assert_eq!(snapshot(&rows)["live_page_documents"], 1);
        request(&mut rows, "retire", "close_document", "page", "", 90);
        assert_eq!(snapshot(&rows)["live_documents"], 1);
        reply(&mut rows, "retire", "closed", "page", Some(100));
        assert_eq!(snapshot(&rows)["live_documents"], 0);
    }

    #[test]
    fn a_new_page_requires_its_own_watch_refresh_and_unclaimed_allocations_remain_visible() {
        let mut rows = vec![];
        page(&mut rows, "first", 10);
        request(&mut rows, "watch", "open", "first", "board-changed", 20);
        reply(&mut rows, "watch", "opened", "first", Some(30));
        request(&mut rows, "refresh", "call", "first", "board", 40);
        reply(&mut rows, "refresh", "value", "first", Some(50));
        assert_eq!(snapshot(&rows)["watch_refresh_settled"], true);
        request(&mut rows, "unclaimed", "open_document", "", "", 60);
        reply(&mut rows, "unclaimed", "document", "orphan", Some(61));
        assert_eq!(snapshot(&rows)["unowned_documents"], 1);
        page(&mut rows, "second", 70);
        assert_eq!(snapshot(&rows)["watch_refresh_settled"], false);
        assert_eq!(snapshot(&rows)["live_page_documents"], 2);
    }
}

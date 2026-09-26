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
    let mut pages = BTreeMap::new();
    let mut closed = BTreeSet::new();
    let (mut pending, mut remote_requests, mut calls, mut latest_call_reply_ns) = (0, 0, 0, 0);
    let mut watches = BTreeMap::<_, u64>::new();
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
                    && let Some(reply) = reply.filter(|reply| reply["result_kind"] == "opened")
                {
                    let forwarded = reply["forwarded_ns"].as_u64().unwrap();
                    watches
                        .entry(document)
                        .and_modify(|latest| *latest = (*latest).max(forwarded))
                        .or_insert(forwarded);
                }
            }
            Some("close_document")
                if reply.is_some_and(|reply| reply["result_kind"] == "closed") =>
            {
                closed.insert(document);
            }
            Some("call") => {
                // Only the fixture's declared terminal presenters own pages.
                // A business Call or Submit without a successful Read cannot
                // turn an otherwise unclaimed allocation into a page.
                if matches!(
                    request["method"].as_str(),
                    Some("board" | "board-card" | "board-create")
                ) && request["remote_input_kind"] == "read"
                    && reply.is_some_and(|reply| reply["result_kind"] == "value")
                {
                    pages.insert(document, request["method"].as_str().unwrap());
                }
                if let Some(reply) = reply {
                    latest_call_reply_ns =
                        latest_call_reply_ns.max(reply["forwarded_ns"].as_u64().unwrap());
                }
            }
            _ => {}
        }
    }
    // Page calls and observations share one live document. Only retiring
    // the page closes it; a successful finite Call does not.
    let live: BTreeSet<_> = allocated.difference(&closed).cloned().collect();
    let unowned_documents = live
        .iter()
        .filter(|document| !pages.contains_key(*document))
        .count();
    // Every live parent or child needs its own watch and later Read. A root
    // refresh cannot stand in for a child's still-pending initial observation.
    let owned: Vec<_> = live
        .iter()
        .filter_map(|document| pages.get(document).map(|method| (document, *method)))
        .collect();
    let watch_refresh_settled = !owned.is_empty()
        && owned.iter().all(|(document, method)| {
            watches.get(*document).is_some_and(|watch_open| {
                requests.iter().any(|request| {
                    request["remote_kind"] == "call"
                        && request["method"] == *method
                        && request["remote_input_kind"] == "read"
                        && request["received_ns"].as_u64().unwrap() > *watch_open
                        && (
                            request["connection"].to_string(),
                            request["document"].to_string(),
                        ) == **document
                        && replies
                            .get(&identity(request))
                            .is_some_and(|reply| reply["result_kind"] == "value")
                })
            })
        });
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

    fn page(rows: &mut Vec<Value>, doc: &str, method: &str, start: u64) {
        let allocate = format!("allocate-{doc}");
        request(rows, &allocate, "open_document", "", "", start);
        reply(rows, &allocate, "document", doc, Some(start + 1));
        let read = format!("initial-{doc}");
        request(rows, &read, "call", doc, method, start + 2);
        reply(rows, &read, "value", doc, Some(start + 3));
    }

    #[test]
    fn a_page_survives_replied_calls_but_pending_and_unforwarded_replies_do_not_settle() {
        let mut rows = vec![];
        page(&mut rows, "page", "board", 10);
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
        page(&mut rows, "root", "board", 10);
        request(&mut rows, "watch", "open", "root", "board-changed", 20);
        reply(&mut rows, "watch", "opened", "root", Some(30));
        request(&mut rows, "refresh", "call", "root", "board", 40);
        reply(&mut rows, "refresh", "value", "root", Some(50));
        assert_eq!(snapshot(&rows)["watch_refresh_settled"], true);
        request(&mut rows, "unclaimed", "open_document", "", "", 60);
        reply(&mut rows, "unclaimed", "document", "orphan", Some(61));
        assert_eq!(snapshot(&rows)["unowned_documents"], 1);
        page(&mut rows, "card", "board-card", 70);
        assert_eq!(snapshot(&rows)["watch_refresh_settled"], false);
        assert_eq!(snapshot(&rows)["live_page_documents"], 2);
        assert_eq!(snapshot(&rows)["unowned_documents"], 1);
        // Ordinary successful Calls leave a true orphan visible.
        request(&mut rows, "stats", "call", "orphan", "activity-stats", 74);
        reply(&mut rows, "stats", "value", "", Some(75));
        request(&mut rows, "submit", "call", "orphan", "board-create", 76);
        rows.last_mut().unwrap()["remote_input_kind"] = json!("submit");
        reply(&mut rows, "submit", "value", "", Some(77));
        assert_eq!(snapshot(&rows)["unowned_documents"], 1);
        request(&mut rows, "card-watch", "open", "card", "board-changed", 80);
        reply(&mut rows, "card-watch", "opened", "card", Some(81));
        request(&mut rows, "root-read", "call", "root", "board", 82);
        reply(&mut rows, "root-read", "value", "", Some(83));
        assert_eq!(
            snapshot(&rows)["watch_refresh_settled"],
            false,
            "parent read cannot settle child watch"
        );
        request(&mut rows, "card-read", "call", "card", "board-card", 84);
        reply(&mut rows, "card-read", "value", "", None);
        assert_eq!(snapshot(&rows)["watch_refresh_settled"], false);
        assert_eq!(snapshot(&rows)["pending_finite_requests"], 1);
        rows.last_mut().unwrap()["forwarded_ns"] = json!(85);
        assert_eq!(snapshot(&rows)["watch_refresh_settled"], true);
        assert_eq!(
            snapshot(&rows)["unowned_documents"],
            1,
            "settled page watches do not hide orphans"
        );
        page(&mut rows, "form", "board-create", 90);
        assert_eq!(snapshot(&rows)["live_page_documents"], 3);
        assert_eq!(snapshot(&rows)["watch_refresh_settled"], false);
        request(&mut rows, "form-watch", "open", "form", "board-changed", 94);
        reply(&mut rows, "form-watch", "opened", "form", Some(95));
        request(&mut rows, "form-read", "call", "form", "board-create", 96);
        reply(&mut rows, "form-read", "value", "", Some(97));
        assert_eq!(snapshot(&rows)["watch_refresh_settled"], true);
        request(&mut rows, "new-watch", "open", "card", "board-changed", 98);
        reply(&mut rows, "new-watch", "opened", "card", Some(99));
        assert_eq!(
            snapshot(&rows)["watch_refresh_settled"],
            false,
            "an old read cannot settle a new watch"
        );
        request(&mut rows, "close-card", "close_document", "card", "", 100);
        reply(&mut rows, "close-card", "closed", "card", None);
        assert_eq!(snapshot(&rows)["live_page_documents"], 3);
        assert_eq!(snapshot(&rows)["watch_refresh_settled"], false);
        rows.last_mut().unwrap()["forwarded_ns"] = json!(101);
        assert_eq!(snapshot(&rows)["live_page_documents"], 2);
        assert_eq!(snapshot(&rows)["watch_refresh_settled"], true);
        assert_eq!(snapshot(&rows)["unowned_documents"], 1);
    }
}

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

use futures_util::future::BoxFuture;
use maka_capabilities::call;
use maka_capabilities::http;
use maka_web::fetch::{Error, Fetcher};
use maka_web::search::{self, Search};
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Transport {
    replies: Mutex<VecDeque<http::Response>>,
    calls: Mutex<Vec<(call::Scope, http::BufferedRequest)>>,
    started: tokio::sync::Notify,
}
impl http::Client for Transport {
    fn request(
        &self,
        scope: call::Scope,
        request: http::Request,
    ) -> BoxFuture<'_, Result<http::Response, http::Error>> {
        Box::pin(async move {
            let http::Request {
                url,
                method,
                headers,
                body,
            } = request;
            let mut upload = body.into_stream();
            let mut body = Vec::new();
            while let Some(chunk) = futures_util::StreamExt::next(&mut upload).await {
                body.extend_from_slice(&chunk.unwrap());
            }
            let request = http::BufferedRequest {
                url,
                method,
                headers,
                body,
            };
            self.calls.lock().unwrap().push((scope, request));
            self.started.notify_one();
            let reply = self.replies.lock().unwrap().pop_front();
            match reply {
                Some(reply) => Ok(reply),
                None => std::future::pending().await,
            }
        })
    }
}
#[derive(Default)]
struct Body {
    chunks: Mutex<VecDeque<Vec<u8>>>,
    closes: AtomicUsize,
    reads: AtomicUsize,
    fail_close: bool,
}
impl http::Body for Body {
    fn next(&self) -> BoxFuture<'_, Result<Option<Vec<u8>>, http::Error>> {
        Box::pin(async {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Ok(self.chunks.lock().unwrap().pop_front())
        })
    }
    fn cancel(&self) {}
    fn close(&self) -> BoxFuture<'_, Result<(), http::Error>> {
        Box::pin(async {
            self.closes.fetch_add(1, Ordering::SeqCst);
            if self.fail_close {
                Err(http::Error::CleanupUnconfirmed)
            } else {
                Ok(())
            }
        })
    }
}
fn reply(
    transport: &Transport,
    status: u16,
    url: &str,
    headers: &[(&str, &str)],
    bytes: Vec<u8>,
) -> Arc<Body> {
    let body = Arc::new(Body {
        chunks: Mutex::new(bytes.chunks(16 * 1024).map(<[u8]>::to_vec).collect()),
        ..Default::default()
    });
    transport.replies.lock().unwrap().push_back(http::Response {
        head: http::Head {
            status,
            url: url.into(),
            headers: headers
                .iter()
                .map(|(k, v)| (k.to_string(), v.as_bytes().to_vec()))
                .collect(),
        },
        body: body.clone(),
    });
    body
}
fn scope() -> call::Scope {
    call::Issuer::default()
        .issue(
            call::Identity::Remote {
                request_id: uuid::Uuid::new_v4(),
            },
            CancellationToken::new(),
        )
        .unwrap()
}

#[tokio::test]
async fn redirect_target_is_checked_before_io_and_every_response_is_closed() {
    let transport = Arc::new(Transport::default());
    let body = reply(
        &transport,
        302,
        "https://docs.example/start",
        &[("Location", "http://[::ffff:169.254.169.254]/latest")],
        b"not an article".to_vec(),
    );
    let fetcher = Fetcher::new(transport.clone());
    let parent = scope();
    assert!(matches!(
        fetcher
            .fetch(&parent, "https://docs.example/start#intro")
            .await,
        Err(Error::Metadata)
    ));
    assert_eq!(body.closes.load(Ordering::SeqCst), 1);
    assert_eq!(body.reads.load(Ordering::SeqCst), 0);
    assert_eq!(transport.calls.lock().unwrap().len(), 1);
    assert!(!parent.cancellation.is_cancelled());
    assert!(
        transport.calls.lock().unwrap()[0]
            .0
            .cancellation
            .is_cancelled()
    );

    for url in [
        "file:///etc/passwd",
        "https://u:p@example.com/",
        "http://2852039166/",
        "http://[fd00:ec2::254]/",
    ] {
        assert!(fetcher.fetch(&parent, url).await.is_err(), "{url}");
    }
    assert_eq!(transport.calls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn content_negotiation_extraction_and_limits_do_not_hide_incomplete_results() {
    let transport = Arc::new(Transport::default());
    let first = reply(
        &transport,
        302,
        "https://docs.example/old",
        &[("location", "/guide/page")],
        Vec::new(),
    );
    let html = r#"<html><head><title>Usage</title></head><body><nav>UNRELATED NAVIGATION</nav><article><h1>Using the API</h1><p>Read the <a href="../reference">reference</a> for details about requests, responses, and errors. This is the complete documented workflow for using the API.</p><pre><code>first();
  second();</code></pre><script>SECRET_SCRIPT</script></article></body></html>"#;
    let second = reply(
        &transport,
        200,
        "https://docs.example/guide/page",
        &[("Content-Type", "text/html; charset=utf-8")],
        html.as_bytes().to_vec(),
    );
    let fetcher = Fetcher::new(transport.clone());
    let parent = scope();
    let page = fetcher
        .fetch(&parent, "https://docs.example/old")
        .await
        .unwrap();
    assert_eq!(page.url, "https://docs.example/guide/page");
    assert!(
        page.content.contains("https://docs.example/reference"),
        "{}",
        page.content
    );
    assert!(
        page.content.contains("first();\n  second();"),
        "{}",
        page.content
    );
    assert!(!page.content.contains("SECRET_SCRIPT"));
    assert_eq!(first.closes.load(Ordering::SeqCst), 1);
    assert_eq!(second.closes.load(Ordering::SeqCst), 1);
    assert!(
        transport.calls.lock().unwrap()[0]
            .1
            .headers
            .iter()
            .any(|(key, value)| key == "Accept" && value.starts_with("text/markdown"))
    );

    let markdown = "文本\n".repeat(20_000);
    reply(
        &transport,
        200,
        "https://docs.example/large",
        &[("Content-Type", "text/markdown")],
        markdown.as_bytes().to_vec(),
    );
    let page = fetcher
        .fetch(&parent, "https://docs.example/large")
        .await
        .unwrap();
    assert_eq!(page.content, markdown);

    let complete = format!("{}UNIQUE_FINAL_CONTENT", "a".repeat(5 * 1024 * 1024));
    let oversized = reply(
        &transport,
        200,
        "https://docs.example/large",
        &[("Content-Type", "text/plain")],
        complete.as_bytes().to_vec(),
    );
    let page = fetcher
        .fetch(&parent, "https://docs.example/large")
        .await
        .unwrap();
    assert_eq!(page.content, complete);
    assert_eq!(oversized.closes.load(Ordering::SeqCst), 1);

    let deep = reply(
        &transport,
        200,
        "https://docs.example/deep",
        &[("Content-Type", "text/html")],
        format!("{}content{}", "<div>".repeat(150), "</div>".repeat(150)).into_bytes(),
    );
    let page = fetcher
        .fetch(&parent, "https://docs.example/deep")
        .await
        .unwrap();
    assert_eq!(
        page.content,
        format!("{}content{}", "<div>".repeat(150), "</div>".repeat(150))
    );
    assert_eq!(deep.closes.load(Ordering::SeqCst), 1);
    assert!(!parent.cancellation.is_cancelled());
}

#[tokio::test]
async fn cancellation_while_waiting_for_headers_closes_the_request_scope() {
    let transport = Arc::new(Transport::default());
    let fetcher = Fetcher::new(transport.clone());
    let parent = scope();
    let running = parent.clone();
    let task =
        tokio::spawn(async move { fetcher.fetch(&running, "https://docs.example/slow").await });
    transport.started.notified().await;
    parent.cancellation.cancel();
    assert!(matches!(task.await.unwrap(), Err(Error::Cancelled)));
    assert!(
        transport.calls.lock().unwrap()[0]
            .0
            .cancellation
            .is_cancelled()
    );
}

#[tokio::test]
async fn search_keeps_credentials_on_the_fixed_endpoint_and_settles_failure_bodies() {
    let transport = Arc::new(Transport::default());
    let search = Search::new(transport.clone());
    let parent = scope();
    let query = maka_web_api::search::Query {
        query: "Maka".into(),
        limit: 1,
    };
    for status in [302, 401, 429, 500] {
        let body = reply(
            &transport,
            status,
            "https://api.tavily.com/search",
            &[("Location", "https://elsewhere.example/")],
            b"secret response".to_vec(),
        );
        let error = search
            .query(&parent, "private-search-key", &query)
            .await
            .unwrap_err();
        assert!(match status {
            401 => matches!(error, search::Error::InvalidCredentials),
            429 => matches!(error, search::Error::RateLimited),
            _ => matches!(error, search::Error::Status(value) if value == status),
        });
        assert!(!error.to_string().contains("secret"));
        assert_eq!(body.closes.load(Ordering::SeqCst), 1);
        assert_eq!(body.reads.load(Ordering::SeqCst), 0);
    }
    let body = reply(
        &transport,
        200,
        "https://api.tavily.com/search",
        &[],
        br#"{"results":[{"title":"Maka","url":"https://example.com/","content":"Documentation"}]}"#
            .to_vec(),
    );
    let results = search
        .query(&parent, "private-search-key", &query)
        .await
        .unwrap();
    assert_eq!(results.rows.len(), 1);
    assert!(!results.truncated);
    assert_eq!(body.closes.load(Ordering::SeqCst), 1);
    let calls = transport.calls.lock().unwrap();
    assert_eq!(calls.len(), 5, "redirects cannot forward credentials");
    for (scope, request) in calls.iter() {
        assert_eq!(request.url, "https://api.tavily.com/search");
        let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(body["api_key"], "private-search-key");
        assert_eq!(body["max_results"], 1);
        assert!(scope.cancellation.is_cancelled());
    }
    assert!(!parent.cancellation.is_cancelled());
}

#[tokio::test]
async fn health_probe_reads_only_headers_without_redirects_or_repeated_fallbacks() {
    use maka_web_api::probe::{Endpoint, Input, Readiness};
    for (statuses, expected) in [
        (vec![200], "healthy"),
        (vec![302], "unknown"),
        (vec![503], "unhealthy"),
        (vec![405, 200], "healthy"),
        (vec![501, 405], "unhealthy"),
    ] {
        let transport = Arc::new(Transport::default());
        let bodies: Vec<_> = statuses
            .iter()
            .map(|status| {
                reply(
                    &transport,
                    *status,
                    "http://localhost/health",
                    &[("location", "http://other.example/")],
                    vec![0; 1024],
                )
            })
            .collect();
        let parent = scope();
        let result = maka_web::probe::probe(
            transport.clone(),
            &parent,
            Input {
                url: "http://localhost/health".into(),
            },
        )
        .await
        .unwrap();
        let Endpoint::Checked {
            http_status,
            health,
            ..
        } = result
        else {
            panic!("{result:?}")
        };
        assert_eq!(http_status, *statuses.last().unwrap());
        assert_eq!(
            match health {
                Readiness::Healthy => "healthy",
                Readiness::Unknown => "unknown",
                Readiness::Unhealthy => "unhealthy",
            },
            expected
        );
        let calls = transport.calls.lock().unwrap();
        assert_eq!(calls.len(), statuses.len());
        assert!(matches!(calls[0].1.method, http::Method::Head));
        if calls.len() == 2 {
            assert!(matches!(calls[1].1.method, http::Method::Get));
        }
        assert!(
            calls
                .iter()
                .all(|(scope, request)| scope.cancellation.is_cancelled()
                    && request.url == "http://localhost/health")
        );
        assert!(!parent.cancellation.is_cancelled());
        for body in bodies {
            assert_eq!(body.reads.load(Ordering::SeqCst), 0);
            assert_eq!(body.closes.load(Ordering::SeqCst), 1);
        }
    }
}

#[tokio::test]
async fn health_probe_rejects_invalid_targets_and_cancellation_closes_its_scope() {
    use maka_web_api::probe::Input;
    let transport = Arc::new(Transport::default());
    let parent = scope();
    for url in [
        "file:///etc/passwd",
        "https://u:p@example.com/",
        "http://example.com/#fragment",
        "",
        "not a url",
    ] {
        assert!(
            maka_web::probe::probe(transport.clone(), &parent, Input { url: url.into() })
                .await
                .is_err()
        );
    }
    assert!(transport.calls.lock().unwrap().is_empty());
    let task = tokio::spawn({
        let transport = transport.clone();
        let parent = parent.clone();
        async move {
            maka_web::probe::probe(
                transport,
                &parent,
                Input {
                    url: "http://localhost/health".into(),
                },
            )
            .await
        }
    });
    transport.started.notified().await;
    parent.cancellation.cancel();
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    assert!(
        transport.calls.lock().unwrap()[0]
            .0
            .cancellation
            .is_cancelled()
    );
}

#[tokio::test]
async fn health_probe_cannot_report_health_or_retry_when_body_cleanup_is_unconfirmed() {
    for status in [200, 405] {
        let transport = Arc::new(Transport::default());
        let body = Arc::new(Body {
            fail_close: true,
            ..Default::default()
        });
        transport.replies.lock().unwrap().push_back(http::Response {
            head: http::Head {
                status,
                url: "http://localhost/health".into(),
                headers: vec![],
            },
            body: body.clone(),
        });
        let result = maka_web::probe::probe(
            transport.clone(),
            &scope(),
            maka_web_api::probe::Input {
                url: "http://localhost/health".into(),
            },
        )
        .await;
        assert!(matches!(
            result,
            Err(maka_agent_facts::tools::ToolError::CleanupUnconfirmed(_))
        ));
        assert_eq!(transport.calls.lock().unwrap().len(), 1);
        assert_eq!(body.reads.load(Ordering::SeqCst), 0);
        assert_eq!(body.closes.load(Ordering::SeqCst), 1);
    }
}

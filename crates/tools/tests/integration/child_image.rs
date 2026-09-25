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

use crate::support::preflight as support;

use maka_event_log::EventLog;
use maka_js_runtime::{CellLimits, CodeExecutor};
use maka_runtime::{
    artifact::ArtifactSource,
    event::{Fact, ToolOutcome},
    tool_output::{DurableToolProjection, ProjectionPart, ToolSuccess},
};
use maka_tools::{
    PreparationFuture, PreparedEffect, RunTools, ToolCallContext, ToolCatalog, ToolDefinition,
    ToolHandler, ToolMode, ToolNesting, ToolPreparer, ToolRegistration, ToolSemantics,
};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

const GIF: &[u8] =
    b"GIF89a\x01\0\x01\0\x80\0\0\0\0\0\xff\xff\xff,\0\0\0\0\x01\0\x01\0\0\x02\x02D\x01\0;";

struct ImageTools(Arc<EventLog>);

impl ToolPreparer for ImageTools {
    fn names(&self) -> Vec<String> {
        vec!["read".into(), "verify".into()]
    }

    fn prepare(
        &self,
        name: String,
        input: Value,
        context: ToolCallContext,
        _: CancellationToken,
    ) -> PreparationFuture {
        let log = self.0.clone();
        Box::pin(async move {
            let effect: PreparedEffect = PreparedEffect::new(move |_| {
                Box::pin(async move {
                    if name == "read" {
                        return Ok(ToolSuccess::image(GIF.to_vec(), "image/gif".into()).unwrap());
                    }
                    // JS has received the child value. Both T2 and snapshot must
                    // already exist before it can pass that value to another tool.
                    assert_eq!(input["kind"], "image");
                    assert_eq!(input["mimeType"], "image/gif");
                    assert_eq!(input.as_object().unwrap().len(), 3);
                    assert_eq!(input["ref"]["kind"], "session_file");
                    assert_eq!(input["ref"]["sessionId"], context.invocation.session_id);
                    let prefix = log.prefix(32, 64 * 1024).await.unwrap();
                    let settled: Vec<_> = prefix
                        .events
                        .iter()
                        .filter(|stored| matches!(stored.event.fact, Fact::ToolSettled { .. }))
                        .collect();
                    assert_eq!(settled.len(), 1, "only image child has settled so far");
                    let child = &settled[0].event;
                    assert_eq!(
                        log.resolve_tool_result(&context.invocation.session_id, &child.id)
                            .await
                            .unwrap()
                            .into_json(),
                        input
                    );
                    assert!(matches!(&child.fact, Fact::ToolSettled {
                    outcome: ToolOutcome::Succeeded { model_projection: DurableToolProjection::Content { parts }, .. }, ..
                } if parts.iter().any(|part| matches!(part, ProjectionPart::Artifact { .. }))));
                    let id = input["ref"]["relativePath"].as_str().unwrap();
                    assert_eq!(
                        log.get_artifact(&context.invocation.session_id, id)
                            .await
                            .unwrap()
                            .record
                            .unwrap()
                            .source,
                        ArtifactSource::ToolResultProjection
                    );
                    assert_eq!(
                        log.read_artifact_chunk(&context.invocation.session_id, id, 0, 1024)
                            .await
                            .unwrap()
                            .unwrap()
                            .bytes,
                        GIF
                    );
                    Ok(input.into())
                })
            });
            Ok(effect)
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nested_image_is_committed_before_js_and_explicit_output_projects_it() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = Arc::new(EventLog::open(&path).await.unwrap());
    let invocation = support::invocation("image");
    log.create_session(&invocation.session_id, "create", &json!({}), 1)
        .await
        .unwrap();
    let tools = Arc::new(ImageTools(log.clone()));
    let catalog = ToolCatalog::new(["read", "verify"].map(|name| ToolRegistration {
        definition: ToolDefinition {
            freeform: None,
            output_schema: None,
            provider: None,
            name: name.into(),
            description: "image fixture".into(),
            input_schema: json!({"type":"object"}),
        },
        handler: ToolHandler::Prepared(tools.clone()),
        nesting: ToolNesting::Nestable,
        semantics: ToolSemantics::Parallel,
    }))
    .unwrap();
    let call = support::call(
        "exec",
        "exec",
        json!({"code":"const result = await tools.read({}); image(result, 'original'); text(await tools.verify(result));"}),
    );
    support::accepted(&log, &invocation, std::slice::from_ref(&call)).await;
    let run = RunTools::new(
        log.clone(),
        invocation.clone(),
        catalog,
        ToolMode::CodeMode,
        CodeExecutor::new(1, CellLimits::default()).unwrap(),
    );
    let result = run
        .capture(".", tokio_util::sync::CancellationToken::new())
        .await
        .unwrap()
        .into_step(&invocation.invocation_id)
        .invoke(&call, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result["result"]["ok"], true);
    let image: Value =
        serde_json::from_str(result["content"][1]["text"].as_str().unwrap()).unwrap();
    assert_eq!(image["kind"], "image");
    let prefix = log.prefix(32, 64 * 1024).await.unwrap();
    assert!(
        matches!(&prefix.events.last().unwrap().event.fact, Fact::ToolSettled {
        outcome: ToolOutcome::Succeeded { model_projection: DurableToolProjection::Content { parts }, .. }, ..
    } if parts.iter().any(|part| matches!(part, ProjectionPart::Artifact { image } if image.detail == Some(maka_runtime::tool_output::ImageDetail::Original))))
    );
    let artifact_id = image["ref"]["relativePath"].as_str().unwrap().to_owned();
    drop(run);
    drop(tools);
    support::close(log).await;
    let reopened = EventLog::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .read_artifact_chunk(&invocation.session_id, &artifact_id, 0, 1024)
            .await
            .unwrap()
            .unwrap()
            .bytes,
        GIF
    );
    reopened.close().await.unwrap();
}

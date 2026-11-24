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
use maka_agent_facts::{
    archive::{ArchivedPlaceholder, DEFAULT_CELL_DISPLAY_CHARS, prepare_source_projection},
    attachment::StorageRef,
    model::prompt_source::source::JsonSource,
    model::prompt_source::source::SourceBytes,
    read::MAX_PAGE_CHARS,
    tool_output::{DurableToolProjection, ImageDetail, ImageOutput, ProjectionPart},
};

fn parse_tool_content(messages_json: &str) -> TestResult<(Vec<Value>, String)> {
    let messages: Vec<Value> = serde_json::from_str(messages_json)?;
    let tool_msg = messages
        .first()
        .filter(|m| m["role"] == "tool")
        .ok_or("first message is not tool")?;
    let content = tool_msg["content"]
        .as_str()
        .ok_or("tool content is not string")?
        .to_owned();
    Ok((messages, content))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn code_mode_output_budget_tail_preview_mixed_media_and_in_cell_read() -> TestResult<()> {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .with_test_writer()
        .try_init();
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(120), async {
        let base = rig.directory.path().to_path_buf();
        std::fs::create_dir_all(base.join("workspace"))?;

        // ~18,000 UTF-16 code units of Chinese + ASCII: overflows direct 7,500 Read page,
        // fits one 65,536 in-Cell Read page and passes unarchived under default 40,000 Cell budget.
        let medium = (0..600)
            .map(|i| format!("第{i:04}行: 中文内容与ASCII混合测试数据_payload"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(base.join("workspace/medium.txt"), &medium)?;

        // ~75,000 UTF-16 code units: spans two 65,536 in-Cell Read pages.
        let large = (0..2_500)
            .map(|i| format!("第{i:04}行: 超长中文代码文件续页测试_line"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(base.join("workspace/large.txt"), &large)?;

        image::RgbImage::from_pixel(17, 13, image::Rgb([19, 23, 31]))
            .save(base.join("workspace/shot.png"))?;

        let tools = product_agent_tools(true).await?;
        let boot = bootstrap_with(&base, provider.server.base_url(), |config| {
            config["tools"] = tools;
        })
        .await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();

        let catalog = call(client, "settings", "connections", json!({"kind": "start"})).await?;
        let saved = call(
            client,
            "settings",
            "create",
            json!({
                "expectedCatalogRevision": catalog["revision"],
                "connection": {
                    "slug": "budget-acceptance",
                    "name": "Budget fixture",
                    "provider": {"packageId": "maka.providers", "entryId": "maka.providers", "scope": "profile", "name": "ollama"},
                    "configuration": {"baseUrl": provider.server.base_url()},
                    "enabled": true,
                    "enabledModelIds": ["direct-model", "code-model"],
                    "modelOverrides": {
                        "direct-model": {"codeMode": false, "apiProtocol": "openai-chat-completions", "contextWindow": 200000, "compactionThreshold": 160000},
                        "code-model": {"codeMode": true, "apiProtocol": "openai-chat-completions", "contextWindow": 200000, "compactionThreshold": 160000, "vision": true}
                    }
                }
            }),
        )
        .await?;
        assert_eq!(saved["kind"], "committed", "{saved}");
        let conn_id = saved["connection"]["connectionId"].clone();
        let direct_model = json!({"connectionId": conn_id, "modelId": "direct-model"});
        let code_model = json!({"connectionId": saved["connection"]["connectionId"], "modelId": "code-model"});

        let direct_session = create(client, &base, &direct_model, None).await?;
        let direct_id = direct_session["id"].as_str().unwrap();
        let code_session = create(client, &base, &code_model, None).await?;
        let code_id = code_session["id"].as_str().unwrap();

        // 1. Direct Read truncates medium.txt at <= 7,500 UTF-16 units with a continuation token.
        let direct_raw = tool_round(
            &rig,
            &mut provider,
            direct_id,
            false,
            "Read",
            json!({"path": "medium.txt"}),
        )
        .await?;
        let (_, direct_text) = parse_tool_content(&direct_raw)?;
        let direct_json: Value = serde_json::from_str(&direct_text)?;
        assert_eq!(direct_json["kind"], "completed", "{direct_json}");
        assert!(
            direct_json["value"]["next"].is_object(),
            "direct Read should paginate 18k file: {direct_json}"
        );
        assert!(
            direct_text.encode_utf16().count() <= MAX_PAGE_CHARS,
            "direct Read exceeded 7,500 UTF-16 budget: {}",
            direct_text.encode_utf16().count()
        );

        // 2. In-Cell Read returns all of medium.txt in one page AND passes unarchived under 40k Cell budget.
        let medium_raw = tool_round(
            &rig,
            &mut provider,
            code_id,
            false,
            "exec",
            json!({
                "code": "const r = await tools.Read({ path: 'medium.txt' }); text(JSON.stringify({ next: r.value.next, utf16: r.value.content.length })); text(r.value.content);",
                "yield_time_ms": 30000
            }),
        )
        .await?;
        let (_, medium_text) = parse_tool_content(&medium_raw)?;
        assert!(
            !medium_text.contains("\"maka.archived_tool_result\""),
            "18k Cell output should pass unarchived under default 40k budget"
        );
        assert!(medium_text.contains("\"next\":null"), "in-Cell Read should not paginate 18k file");
        assert!(medium_text.contains("第0000行: 中文内容与ASCII混合测试数据_payload"));
        assert!(medium_text.contains("第0599行: 中文内容与ASCII混合测试数据_payload"));

        // 3. In-Cell Read on ~75k Chinese file paginates at 65,536 UTF-16 and reconstructs cleanly.
        let large_raw = tool_round(
            &rig,
            &mut provider,
            code_id,
            false,
            "exec",
            json!({
                "code": "const p1 = await tools.Read({ path: 'large.txt' }); const p2 = await tools.Read(p1.value.next); text(JSON.stringify({ p1Len: p1.value.content.length, p1HasNext: Boolean(p1.value.next), p2HasNext: Boolean(p2.value.next), combinedLen: (p1.value.content + '\\n' + p2.value.content).length }));",
                "yield_time_ms": 30000
            }),
        )
        .await?;
        let (_, large_text) = parse_tool_content(&large_raw)?;
        let expected_large_len = large.encode_utf16().count();
        assert!(large_text.contains("\"p1HasNext\":true"), "{large_text}");
        assert!(large_text.contains("\"p2HasNext\":false"), "{large_text}");
        assert!(
            large_text.contains(&format!("\"combinedLen\":{expected_large_len}")),
            "expected full reconstruction length {expected_large_len}, got {large_text}"
        );
        let meta_line = large_text
            .lines()
            .find(|line| line.contains("\"p1Len\":"))
            .ok_or("missing p1Len line")?;
        let meta: Value = serde_json::from_str(meta_line)?;
        assert!(
            meta["p1Len"].as_u64().unwrap_or(0) > 50_000,
            "in-Cell Read first page should use 65,536 budget, got {meta}"
        );

        // 4. Overflowing pure-text exec archives at ~40k with tailPreview, full unclipped archive readback,
        //    and archive: Read inside Cell still respects 7,500.
        let overflow_raw = tool_round(
            &rig,
            &mut provider,
            code_id,
            false,
            "exec",
            json!({
                "code": r#"const lines = []; for (let i = 0; i < 1400; i++) { lines.push("line " + i + ": \"quoted\" C:\\build\\out 中文日志 🔥 payload_" + i); } lines.push("FINAL_BUILD_ERROR_MARKER_999"); text(lines.join("\n"));"#,
                "yield_time_ms": 30000
            }),
        )
        .await?;
        let (_, overflow_text) = parse_tool_content(&overflow_raw)?;
        let archived: Value = serde_json::from_str(&overflow_text)?;
        assert_eq!(archived["kind"], "maka.archived_tool_result", "{archived}");
        let resource_ref = archived["resourceRef"]
            .as_str()
            .ok_or("missing resourceRef")?
            .to_owned();
        assert!(resource_ref.starts_with("archive:"), "{resource_ref}");
        let page_content = archived["page"]["content"]
            .as_str()
            .ok_or("missing page.content")?;
        assert!(
            page_content.encode_utf16().count() > 30_000,
            "default 40k budget should keep ~37k head, got {}",
            page_content.encode_utf16().count()
        );
        assert!(archived["page"]["next"].is_object(), "expected page.next on overflow");
        let tail_preview = archived["tailPreview"]
            .as_str()
            .ok_or("missing tailPreview on overflow")?;
        assert!(
            tail_preview.contains("FINAL_BUILD_ERROR_MARKER_999"),
            "tailPreview missing trailing error: {tail_preview}"
        );
        let total_lines = archived["page"]["totalLines"]
            .as_u64()
            .ok_or("missing totalLines")?;

        let readback_code = format!(
            "const first = await tools.Read({{ path: {ref_json} }}); const tail = await tools.Read({{ path: {ref_json}, offset: {offset}, limit: 10 }}); text(JSON.stringify({{ firstNext: Boolean(first.value.next), firstJsonLen: JSON.stringify(first).length, hasTailMarker: tail.value.content.includes('FINAL_BUILD_ERROR_MARKER_999') }}));",
            ref_json = serde_json::to_string(&resource_ref)?,
            offset = total_lines.saturating_sub(5),
        );
        let readback_raw = tool_round(
            &rig,
            &mut provider,
            code_id,
            false,
            "exec",
            json!({"code": readback_code, "yield_time_ms": 30000}),
        )
        .await?;
        let (_, readback_text) = parse_tool_content(&readback_raw)?;
        let readback_line = readback_text
            .lines()
            .find(|line| line.contains("\"firstJsonLen\":"))
            .ok_or("missing readback json line")?;
        let readback: Value = serde_json::from_str(readback_line)?;
        assert_eq!(readback["firstNext"], json!(true), "{readback}");
        assert!(
            readback["firstJsonLen"].as_u64().unwrap() <= MAX_PAGE_CHARS as u64,
            "in-Cell archive: Read must stay <= 7,500: {readback}"
        );
        assert_eq!(
            readback["hasTailMarker"],
            json!(true),
            "unclipped tail must be readable via archive:<id>: {readback}"
        );

        // 5. Yielded Cell incremental delta (display_from): wait archives only the new delta
        //    without duplicating prior yielded output.
        let sent = call(
            client,
            "agent",
            "send",
            json!({"sessionId": code_id, "message": "Run yielding cell"}),
        )
        .await?;
        assert_eq!(sent["kind"], "queued", "{sent}");
        let (_, reply1) = provider.next().await?;
        reply1
            .send_plan(tool_response(
                "exec",
                json!({
                    "code": r#"text("FIRST_YIELD_MARKER"); await yield_control(); const lines = []; for (let i = 0; i < 1400; i++) { lines.push("delta_" + i + "_payload_0123456789_abcdefghij"); } lines.push("SECOND_WAIT_TAIL_MARKER"); text(lines.join("\n"));"#,
                    "yield_time_ms": 30000
                }),
            ));
        let (req2, reply2) = provider.next().await?;
        let yield_msg = req2["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|m| m["role"] == "tool")
            .ok_or("missing yield tool message")?;
        let yield_text = yield_msg["content"]
            .as_str()
            .ok_or("yield content missing")?;
        assert!(yield_text.contains("FIRST_YIELD_MARKER"), "{yield_text}");
        let status_line = yield_text.lines().next().ok_or("missing status line")?;
        let status_json: Value = serde_json::from_str(status_line)?;
        assert_eq!(status_json["state"], "running", "{status_json}");
        let cell_id = status_json["cell_id"]
            .as_str()
            .ok_or("missing cell_id")?
            .to_owned();

        reply2
            .send_plan(tool_response(
                "wait",
                json!({"cell_id": cell_id, "yield_time_ms": 30000}),
            ));
        let (req3, reply3) = provider.next().await?;
        let wait_msg = req3["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|m| m["role"] == "tool")
            .ok_or("missing wait tool message")?;
        let wait_text = wait_msg["content"].as_str().ok_or("wait content missing")?;
        let wait_archived: Value = serde_json::from_str(wait_text)?;
        assert_eq!(wait_archived["kind"], "maka.archived_tool_result", "{wait_archived}");
        assert!(
            !wait_archived["page"]["content"]
                .as_str()
                .unwrap()
                .contains("FIRST_YIELD_MARKER"),
            "wait delta must not duplicate previously yielded output"
        );
        assert!(
            wait_archived["tailPreview"]
                .as_str()
                .unwrap_or("")
                .contains("SECOND_WAIT_TAIL_MARKER"),
            "wait delta missing tailPreview marker: {wait_archived}"
        );
        reply3
            .reply_text("Done.");
        tokio::time::timeout(
            Duration::from_secs(20),
            quiescent_message(client, code_id, &sent["messageId"]),
        )
        .await??;

        // 6. Mixed text + image under DisplayChars: text is bounded with archive notice + tailPreview,
        //    image is preserved in order, and archive:<id> is readable.
        let mixed_raw = tool_round(
            &rig,
            &mut provider,
            code_id,
            false,
            "exec",
            json!({
                "code": r#"const lines = []; for (let i = 0; i < 1400; i++) { lines.push("mixed_" + i + "_payload_0123456789_abcdefghij"); } lines.push("MIXED_TAIL_MARKER_777"); text(lines.join("\n")); image(await tools.Read({ path: "shot.png" }));"#,
                "yield_time_ms": 30000
            }),
        )
        .await?;
        assert!(
            mixed_raw.contains("data:image/png;base64,"),
            "mixed text+image must preserve image delivery"
        );
        let (mixed_messages, mixed_tool_text) = parse_tool_content(&mixed_raw)?;
        let mixed_parts: Vec<Value> = serde_json::from_str(&mixed_tool_text)?;
        let total_part_text_chars: usize = mixed_parts
            .iter()
            .filter_map(|part| part["text"].as_str())
            .map(|text| text.encode_utf16().count())
            .sum();
        assert!(
            total_part_text_chars < 44_000,
            "mixed text+image must bound text instead of shipping full ~60k log: {total_part_text_chars}"
        );
        let mixed_notice_str = mixed_parts
            .iter()
            .rev()
            .filter_map(|part| part["text"].as_str())
            .find(|text| text.contains("\"maka.archived_tool_result\""))
            .ok_or_else(|| format!("missing mixed archive notice JSON in {mixed_parts:?}"))?;
        let mixed_notice: Value = serde_json::from_str(mixed_notice_str)?;
        assert_eq!(mixed_notice["kind"], "maka.archived_tool_result", "{mixed_notice}");
        assert!(
            mixed_notice["tailPreview"]
                .as_str()
                .unwrap_or("")
                .contains("MIXED_TAIL_MARKER_777"),
            "mixed archive notice must include tailPreview: {mixed_notice}"
        );
        let mixed_ref = mixed_notice["resourceRef"]
            .as_str()
            .ok_or("missing mixed resourceRef")?
            .to_owned();
        assert!(mixed_ref.starts_with("archive:"), "{mixed_ref}");
        assert!(
            mixed_messages.len() >= 2,
            "chat completions should carry preserved tool image"
        );
        let mixed_read_code = format!(
            "const r = await tools.Read({{ path: {} }}); text(JSON.stringify({{ ok: r.kind === 'completed', hasMixed: r.value.content.includes('mixed_0_payload') }}));",
            serde_json::to_string(&mixed_ref)?
        );
        let mixed_read_raw = tool_round(
            &rig,
            &mut provider,
            code_id,
            false,
            "exec",
            json!({"code": mixed_read_code, "yield_time_ms": 30000}),
        )
        .await?;
        let (_, mixed_read_text) = parse_tool_content(&mixed_read_raw)?;
        assert!(mixed_read_text.contains("\"ok\":true"), "{mixed_read_text}");
        assert!(mixed_read_text.contains("\"hasMixed\":true"), "{mixed_read_text}");

        // 7. Explicit zero budget (max_output_tokens: 0) on a short 120-char body must NOT leak
        //    optional body text; mandatory cellStatus + resourceRef + page.next (at=0) stay present,
        //    and both resourceRef and page.next read back the full body.
        let tiny_raw = tool_round(
            &rig,
            &mut provider,
            code_id,
            false,
            "exec",
            json!({
                "code": r#"text("ZERO_BODY_SECRET_" + "x".repeat(120));"#,
                "yield_time_ms": 30000,
                "max_output_tokens": 0
            }),
        )
        .await?;
        let (_, tiny_text) = parse_tool_content(&tiny_raw)?;
        assert!(
            !tiny_text.contains("ZERO_BODY_SECRET_"),
            "max_output_tokens: 0 must not leak optional body text: {tiny_text}"
        );
        let tiny_archived: Value = serde_json::from_str(&tiny_text)?;
        assert_eq!(tiny_archived["kind"], "maka.archived_tool_result", "{tiny_archived}");
        assert!(
            tiny_archived.get("tailPreview").is_none(),
            "tailPreview must be omitted for zero budget: {tiny_archived}"
        );
        assert_eq!(tiny_archived["cellStatus"]["state"], "completed", "{tiny_archived}");
        assert!(
            tiny_archived["cellStatus"]["cell_id"]
                .as_str()
                .is_some_and(|id| !id.is_empty()),
            "cellStatus.cell_id missing: {tiny_archived}"
        );
        assert_eq!(tiny_archived["page"]["content"].as_str(), Some(""), "{tiny_archived}");
        assert_eq!(tiny_archived["page"]["returnedLines"], 0, "{tiny_archived}");
        let tiny_ref = tiny_archived["resourceRef"]
            .as_str()
            .ok_or("missing zero-budget resourceRef")?
            .to_owned();
        let tiny_next_path = tiny_archived["page"]["next"]["path"]
            .as_str()
            .ok_or("missing zero-budget page.next.path")?
            .to_owned();
        let tiny_recover_code = format!(
            "const byRef = await tools.Read({{ path: {} }}); const byNext = await tools.Read({{ path: {} }}); text(JSON.stringify({{ refHas: byRef.value.content.includes('ZERO_BODY_SECRET_'), nextHas: byNext.value.content.includes('ZERO_BODY_SECRET_') }}));",
            serde_json::to_string(&tiny_ref)?,
            serde_json::to_string(&tiny_next_path)?,
        );
        let tiny_recover_raw = tool_round(
            &rig,
            &mut provider,
            code_id,
            false,
            "exec",
            json!({"code": tiny_recover_code, "yield_time_ms": 30000}),
        )
        .await?;
        let (_, tiny_recover_text) = parse_tool_content(&tiny_recover_raw)?;
        assert!(tiny_recover_text.contains("\"refHas\":true"), "{tiny_recover_text}");
        assert!(tiny_recover_text.contains("\"nextHas\":true"), "{tiny_recover_text}");

        // 8. Explicit zero budget on short mixed text+image must preserve the image, expose cellStatus
        //    and archive locator, leak zero optional text, and allow reading back the text marker.
        let mixed_zero_raw = tool_round(
            &rig,
            &mut provider,
            code_id,
            false,
            "exec",
            json!({
                "code": r#"text("ZERO_MIXED_SECRET_" + "x".repeat(120)); image(await tools.Read({ path: "shot.png" }));"#,
                "yield_time_ms": 30000,
                "max_output_tokens": 0
            }),
        )
        .await?;
        assert!(
            mixed_zero_raw.contains("data:image/png;base64,"),
            "zero-budget mixed output must preserve image"
        );
        assert!(
            !mixed_zero_raw.contains("ZERO_MIXED_SECRET_"),
            "zero-budget mixed output must not leak optional text"
        );
        let (_, mz_tool_text) = parse_tool_content(&mixed_zero_raw)?;
        let mz_parts: Vec<Value> = serde_json::from_str(&mz_tool_text)?;
        let mz_notice_str = mz_parts
            .last()
            .and_then(|part| part["text"].as_str())
            .ok_or("missing trailing mixed zero archive notice")?;
        let mz_notice: Value = serde_json::from_str(mz_notice_str)?;
        assert_eq!(mz_notice["kind"], "maka.archived_tool_result", "{mz_notice}");
        assert_eq!(mz_notice["cellStatus"]["state"], "completed", "{mz_notice}");
        assert!(mz_notice.get("tailPreview").is_none(), "{mz_notice}");
        let mz_ref = mz_notice["resourceRef"].as_str().ok_or("missing mixed zero ref")?;
        let mz_read_code = format!(
            "const r = await tools.Read({{ path: {} }}); text(JSON.stringify({{ hasSecret: r.value.content.includes('ZERO_MIXED_SECRET_') }}));",
            serde_json::to_string(mz_ref)?,
        );
        let mz_read_raw = tool_round(
            &rig,
            &mut provider,
            code_id,
            false,
            "exec",
            json!({"code": mz_read_code, "yield_time_ms": 30000}),
        )
        .await?;
        let (_, mz_read_text) = parse_tool_content(&mz_read_raw)?;
        assert!(mz_read_text.contains("\"hasSecret\":true"), "{mz_read_text}");

        // 9. Synchronous exec/wait interruption after yield: wait(max_tokens: 0) archives
        //    only the incremental prior_output (B) without duplicating prior yielded output (A),
        //    and Read(archive:<id>) recovers both B and the error diagnostic.
        let sent_err = call(
            client,
            "agent",
            "send",
            json!({"sessionId": code_id, "message": "Run yielding cell that throws"}),
        )
        .await?;
        assert_eq!(sent_err["kind"], "queued", "{sent_err}");
        let (_, err_reply1) = provider.next().await?;
        err_reply1
            .send_plan(tool_response(
                "exec",
                json!({
                    "code": r#"text("YIELDED_BEFORE_ERR_A"); await yield_control(); await new Promise(r => setTimeout(r, 80)); text("BEFORE_THROW_LOG_B"); throw new Error("boom failed");"#,
                    "yield_time_ms": 30000
                }),
            ));
        let (err_req2, err_reply2) = provider.next().await?;
        let err_yield_msg = err_req2["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|m| m["role"] == "tool")
            .ok_or("missing err yield tool message")?;
        let err_yield_text = err_yield_msg["content"]
            .as_str()
            .ok_or("err yield content missing")?;
        assert!(err_yield_text.contains("YIELDED_BEFORE_ERR_A"), "{err_yield_text}");
        assert!(!err_yield_text.contains("BEFORE_THROW_LOG_B"), "{err_yield_text}");
        let err_status_json: Value = serde_json::from_str(
            err_yield_text.lines().next().ok_or("missing err status line")?,
        )?;
        assert_eq!(err_status_json["state"], "running", "{err_status_json}");
        let err_cell_id = err_status_json["cell_id"]
            .as_str()
            .ok_or("missing err cell_id")?
            .to_owned();

        err_reply2
            .send_plan(tool_response(
                "wait",
                json!({"cell_id": err_cell_id, "yield_time_ms": 30000, "max_tokens": 0}),
            ));
        let (err_req3, err_reply3) = provider.next().await?;
        let err_wait_msg = err_req3["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|m| m["role"] == "tool")
            .ok_or("missing err wait tool message")?;
        let err_wait_text = err_wait_msg["content"]
            .as_str()
            .ok_or("err wait content missing")?;
        assert!(!err_wait_text.contains("BEFORE_THROW_LOG_B"), "{err_wait_text}");
        assert!(!err_wait_text.contains("YIELDED_BEFORE_ERR_A"), "{err_wait_text}");
        let err_archived: Value = serde_json::from_str(err_wait_text)?;
        assert_eq!(err_archived["kind"], "maka.archived_tool_result", "{err_archived}");
        assert_eq!(err_archived["cellStatus"]["state"], "interrupted", "{err_archived}");
        assert_eq!(err_archived["page"]["content"].as_str(), Some(""), "{err_archived}");
        let err_ref = err_archived["resourceRef"]
            .as_str()
            .ok_or("missing interrupted archive resourceRef")?
            .to_owned();
        err_reply3
            .reply_text("Done.");
        tokio::time::timeout(
            Duration::from_secs(20),
            quiescent_message(client, code_id, &sent_err["messageId"]),
        )
        .await??;

        let err_read_code = format!(
            "const r = await tools.Read({{ path: {} }}); text(JSON.stringify({{ hasB: r.value.content.includes('BEFORE_THROW_LOG_B'), hasErr: r.value.content.includes('boom failed'), hasA: r.value.content.includes('YIELDED_BEFORE_ERR_A') }}));",
            serde_json::to_string(&err_ref)?,
        );
        let err_read_raw = tool_round(
            &rig,
            &mut provider,
            code_id,
            false,
            "exec",
            json!({"code": err_read_code, "yield_time_ms": 30000}),
        )
        .await?;
        let (_, err_read_text) = parse_tool_content(&err_read_raw)?;
        assert!(err_read_text.contains("\"hasB\":true"), "{err_read_text}");
        assert!(err_read_text.contains("\"hasErr\":true"), "{err_read_text}");
        assert!(err_read_text.contains("\"hasA\":false"), "{err_read_text}");

        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
    assert!(cleanup.is_empty(), "{cleanup:?}");
    match outcome {
        Ok(result) => result??,
        Err(panic) => std::panic::resume_unwind(panic),
    }
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn archive_parity_and_recovered_cell_bounding() -> TestResult<()> {
    // 1. Default MAX_PAGE_CHARS (7,500) and Cell DisplayChars match identically across external & native paths,
    //    and DisplayChars mixed-media projections match identically across external & native paths.
    let big_text = "default-line-0123456789\n".repeat(600);
    let default_proj = DurableToolProjection::Text {
        text: big_text.clone(),
    };
    let ext_default = ArchivedPlaceholder::prepare_projection(
        "evt-default".into(),
        "call-default".into(),
        "exec".into(),
        &default_proj,
        MAX_PAGE_CHARS,
    )
    .map_err(|e| e.to_string())?
    .ok_or("expected default archive")?;

    let resources =
        maka_model::ModelPreparationResources::new(maka_model::PreparationPolicy::default())?;
    let work = resources.acquire_work().await?;
    let budget = work.budget();
    let stop = CancellationToken::new();

    let default_source = JsonSource::new(SourceBytes::Inline(axum::body::Bytes::from(
        serde_json::to_vec(&default_proj)?,
    )));
    let native_default = prepare_source_projection(
        "evt-default".into(),
        "call-default".into(),
        "exec".into(),
        default_source,
        MAX_PAGE_CHARS,
        budget.clone(),
        &stop,
    )
    .await?
    .ok_or("expected native default archive")?;

    assert_eq!(ext_default, native_default);
    let DurableToolProjection::Json { value: default_val } = &native_default else {
        panic!("expected json placeholder");
    };
    assert!(default_val["tailPreview"].is_string(), "{default_val}");
    assert!(
        default_val["page"]["content"]
            .as_str()
            .unwrap()
            .encode_utf16()
            .count()
            <= MAX_PAGE_CHARS
    );

    let mixed_proj = DurableToolProjection::Content {
        parts: vec![
            ProjectionPart::Text {
                text: "{\"state\":\"completed\"}".into(),
            },
            ProjectionPart::Artifact {
                image: ImageOutput {
                    mime_type: "image/png".into(),
                    reference: StorageRef::SessionFile {
                        session_id: "sess-1".into(),
                        relative_path: "artifacts/shot.png".into(),
                    },
                    detail: Some(ImageDetail::High),
                },
            },
            ProjectionPart::Text {
                text: format!(
                    "{}\nMIXED_PARITY_TAIL",
                    "parity-line-0123456789-abcdefghij\n".repeat(1_500)
                ),
            },
        ],
    };
    let ext_mixed = ArchivedPlaceholder::prepare_projection(
        "evt-mixed".into(),
        "call-mixed".into(),
        "exec".into(),
        &mixed_proj,
        DEFAULT_CELL_DISPLAY_CHARS,
    )
    .map_err(|e| e.to_string())?
    .ok_or("expected external mixed archive")?;
    let native_mixed = prepare_source_projection(
        "evt-mixed".into(),
        "call-mixed".into(),
        "exec".into(),
        JsonSource::new(SourceBytes::Inline(axum::body::Bytes::from(
            serde_json::to_vec(&mixed_proj)?,
        ))),
        DEFAULT_CELL_DISPLAY_CHARS,
        budget,
        &stop,
    )
    .await?
    .ok_or("expected native mixed archive")?;
    assert_eq!(ext_mixed, native_mixed);

    // 2. Async completion / RecoveredCell projection via project_cell_final bounds >40k text
    //    with [tailPreview] while preserving image parts in order.
    let mut rig = Rig::new()?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(60), async {
        use maka_agent_facts::cells::{CellEvent, CellId, CellObservation, CellOutput, CellOwner};
        let session = rig.start().await?;
        rig.assemble(&session).await?;
        let attempt = rig.attempt().await?;
        let (tool, _) = rig.tool(attempt, "exec", "cell-rec", json!({"code": "1"})).await?;
        let driver = rig.driver.as_ref().unwrap();
        let run = driver.access.execution().run_id;
        let view = driver.state.frontier(run).await?;
        let owner = view.spec.owner.clone();
        let link = AgentStepLink {
            run,
            step: view.attempts[&attempt].step,
            attempt,
        };
        let cell = CellId::for_agent(link, &tool.call);
        let huge_log = format!(
            "{}\nRECOVERED_TAIL_MARKER_888",
            "recovered-cell-line-0123456789-abcdefghij\n".repeat(1_500)
        );
        let obs = CellObservation::Completed {
            cell_id: cell,
            content: vec![
                CellOutput::Text { text: huge_log },
                CellOutput::Media {
                    content: maka_agent_facts::capability::ContentBlock::Image {
                        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=".into(),
                        mime_type: "image/png".into(),
                    },
                    detail: Some(ImageDetail::Auto),
                },
            ],
            result: json!({"ok": true, "value": null, "toolCalls": []}),
        };
        let src = ContentBlob::json(&json!({"code": "1"}))?;
        let completed = ContentBlob::json(&obs)?;
        driver.state.append(
            driver.access.claim(),
            (&view).into(),
            vec![
                Change {
                    id: cell.started_fact_id(),
                    at: at(),
                    fact: Fact::Cell {
                        event: CellEvent::Started {
                            cell,
                            owner: CellOwner::Agent {
                                link,
                                call: tool.call.clone(),
                            },
                            source: src.reference().clone(),
                        },
                    },
                },
                Change::new(
                    Fact::Cell {
                        event: CellEvent::VmBound {
                            cell,
                            binding: maka_agent_facts::cells::CellVmBinding {
                                runtime: "fixture".into(),
                                version: 1,
                                descriptor: src.reference().clone(),
                            },
                        },
                    },
                    at(),
                ),
                Change::new(
                    Fact::Cell {
                        event: CellEvent::Completed {
                            cell,
                            result: completed.reference().clone(),
                            publication: maka_agent_facts::cells::SessionPublication {
                                values: std::collections::BTreeMap::new(),
                                loaded_tools: None,
                            },
                        },
                    },
                    at(),
                ),
            ],
            vec![src, completed.clone()],
        )
        .await?;

        let history = driver.state.session_history(owner.clone(), session.clone());
        let through = history.capture().await?.through_sequence;
        let scope = maka_agent_state::artifacts::ArtifactScope {
            owner,
            session,
            run,
            through,
        };
        let (msg, _) = maka_agent_engine::preparation::project_cell_final(
            maka_agent_engine::preparation::NotificationSource::Live(&driver.state),
            &scope,
            cell,
            &maka_agent_facts::tool_output::CellFinalEvidence::Completed {
                result: completed.reference().clone(),
            },
            maka_agent_facts::language::Language::EN,
            true,
            &driver.owner.services.model_preparation_resources(),
            &CancellationToken::new(),
        )
        .await?;
        let maka_model::prompt::Message::User { content, .. } = msg else {
            panic!("expected User message from project_cell_final");
        };
        let mut combined_text = String::new();
        let mut saw_image = false;
        for part in content {
            match part {
                maka_model::prompt::ContentPart::Text { text, .. } => {
                    combined_text.push_str(&text);
                    combined_text.push('\n');
                }
                maka_model::prompt::ContentPart::File { media_type, .. } => {
                    assert_eq!(media_type, "image/png");
                    saw_image = true;
                }
            }
        }
        assert!(saw_image, "RecoveredCell projection must preserve image");
        assert!(combined_text.contains("[output truncated:"), "{combined_text}");
        assert!(combined_text.contains("[tailPreview]"), "{combined_text}");
        assert!(combined_text.contains("RECOVERED_TAIL_MARKER_888"), "{combined_text}");
        assert!(
            combined_text.encode_utf16().count() < DEFAULT_CELL_DISPLAY_CHARS + 2_000,
            "RecoveredCell text must stay bounded, got {}",
            combined_text.encode_utf16().count()
        );

        // 3. Long CellInterruption.diagnostic (>55k) + prior_output (20k) share ONE 40k budget
        //    and keep the JSON report valid.
        let (int_tool, _) = rig.tool(attempt, "exec", "cell-int", json!({"code": "2"})).await?;
        let int_cell = CellId::for_agent(link, &int_tool.call);
        let huge_diag = format!(
            "{}\nDIAG_TAIL_MARKER_555",
            "diagnostic-line-0123456789-abcdefghij\n".repeat(1_500)
        );
        let prior_log = "prior-output-line-0123456789\n".repeat(700);
        let int_report = maka_agent_facts::cells::CellInterruption {
            cell: int_cell,
            diagnostic: huge_diag,
            children: std::collections::BTreeMap::new(),
            prior_output: Some(maka_agent_facts::cells::CellPriorOutput {
                content: vec![CellOutput::Text { text: prior_log }],
            }),
        };
        let int_src = ContentBlob::json(&json!({"code": "2"}))?;
        let int_blob = ContentBlob::json(&int_report)?;
        let view2 = driver.state.frontier(run).await?;
        driver
            .state
            .append(
                driver.access.claim(),
                (&view2).into(),
                vec![
                    Change {
                        id: int_cell.started_fact_id(),
                        at: at(),
                        fact: Fact::Cell {
                            event: CellEvent::Started {
                                cell: int_cell,
                                owner: CellOwner::Agent {
                                    link,
                                    call: int_tool.call.clone(),
                                },
                                source: int_src.reference().clone(),
                            },
                        },
                    },
                    Change::new(
                        Fact::Cell {
                            event: CellEvent::VmBound {
                                cell: int_cell,
                                binding: maka_agent_facts::cells::CellVmBinding {
                                    runtime: "fixture".into(),
                                    version: 1,
                                    descriptor: int_src.reference().clone(),
                                },
                            },
                        },
                        at(),
                    ),
                    Change::new(
                        Fact::Cell {
                            event: CellEvent::Interrupted {
                                cell: int_cell,
                                report: int_blob.reference().clone(),
                            },
                        },
                        at(),
                    ),
                ],
                vec![int_src, int_blob.clone()],
            )
            .await?;
        let through2 = history.capture().await?.through_sequence;
        let scope2 = maka_agent_state::artifacts::ArtifactScope {
            owner: scope.owner.clone(),
            session: scope.session.clone(),
            run,
            through: through2,
        };
        let (int_msg, _) = maka_agent_engine::preparation::project_cell_final(
            maka_agent_engine::preparation::NotificationSource::Live(&driver.state),
            &scope2,
            int_cell,
            &maka_agent_facts::tool_output::CellFinalEvidence::Interrupted {
                report: int_blob.reference().clone(),
            },
            maka_agent_facts::language::Language::EN,
            true,
            &driver.owner.services.model_preparation_resources(),
            &CancellationToken::new(),
        )
        .await?;
        let maka_model::prompt::Message::User { content: int_parts, .. } = int_msg else {
            panic!("expected User message for interrupted cell");
        };
        let mut int_total_chars = 0usize;
        let mut int_all_text = String::new();
        for (idx, part) in int_parts.into_iter().enumerate() {
            let maka_model::prompt::ContentPart::Text { text, .. } = part else {
                continue;
            };
            if idx == 0 {
                let json_line = text.lines().nth(1).ok_or("missing report json line")?;
                let parsed: Value = serde_json::from_str(json_line)?;
                assert_eq!(parsed["state"], "interrupted");
                assert_eq!(parsed["cell"], json!(int_cell));
                let diag_str = parsed["diagnostic"].as_str().ok_or("missing diagnostic string")?;
                assert!(diag_str.contains("DIAG_TAIL_MARKER_555"), "diagnostic tail missing");
            }
            int_total_chars += text.encode_utf16().count();
            int_all_text.push_str(&text);
            int_all_text.push('\n');
        }
        assert!(
            int_total_chars < DEFAULT_CELL_DISPLAY_CHARS + 2_000,
            "interrupted diagnostic + prior_output must share one 40k budget, got {int_total_chars}"
        );
        assert!(int_all_text.contains("[output truncated:"), "{int_all_text}");

        // 4. Async CellNotification bounds on final JSON-escaped report cost
        //    (1,200 JSON lines: ~38.4k raw < 40k, >45.6k once JSON-escaped).
        let long_notice_text = format!(
            "{}NOTIFY_TAIL_MARKER_444",
            "{\"path\":\"src/lib.rs\",\"ok\":true}\n".repeat(1_200)
        );
        assert!(long_notice_text.encode_utf16().count() < DEFAULT_CELL_DISPLAY_CHARS);
        let bounded_notice_blob = ContentBlob::json(&maka_agent_facts::cells::CellNotification {
            schema_version: maka_agent_facts::cells::CELL_NOTIFICATION_SCHEMA_VERSION,
            body: maka_agent_facts::cells::CellNotificationBody::Text {
                text: long_notice_text,
            },
        })?;
        let bounded_notif_id = FactId::new();
        let view3 = driver.state.frontier(run).await?;
        driver
            .state
            .append(
                driver.access.claim(),
                (&view3).into(),
                vec![Change::new(
                    Fact::Cell {
                        event: CellEvent::NotificationQueued {
                            cell,
                            notification: bounded_notif_id,
                            content: bounded_notice_blob.reference().clone(),
                        },
                    },
                    at(),
                )],
                vec![bounded_notice_blob.clone()],
            )
            .await?;
        let through3 = history.capture().await?.through_sequence;
        let scope3 = maka_agent_state::artifacts::ArtifactScope {
            owner: scope.owner.clone(),
            session: scope.session.clone(),
            run,
            through: through3,
        };
        let (bounded_msg, _) = maka_agent_engine::preparation::project_cell_notification(
            &driver.state,
            &scope3,
            &maka_agent_state::cells::PendingNotification {
                cell,
                id: bounded_notif_id,
                content: bounded_notice_blob.reference().clone(),
            },
            maka_agent_facts::language::Language::EN,
            true,
            &driver.owner.services.model_preparation_resources(),
            &CancellationToken::new(),
        )
        .await?;
        let maka_model::prompt::Message::User {
            content: bounded_parts,
            ..
        } = bounded_msg
        else {
            panic!("expected User message for bounded notification");
        };
        let maka_model::prompt::ContentPart::Text {
            text: bounded_rendered,
            ..
        } = &bounded_parts[0]
        else {
            panic!("expected text part");
        };
        let bounded_json: Value = serde_json::from_str(bounded_rendered.lines().nth(1).unwrap())?;
        let bounded_text = bounded_json["text"].as_str().unwrap();
        assert!(bounded_text.contains("[output truncated:"));
        assert!(bounded_text.contains("NOTIFY_TAIL_MARKER_444"));
        let serialized_field_utf16 = serde_json::to_string(bounded_text)?.encode_utf16().count() - 2;
        assert!(
            serialized_field_utf16 <= DEFAULT_CELL_DISPLAY_CHARS,
            "JSON-escaped notify text field exceeded 40k budget: {serialized_field_utf16}"
        );
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    assert!(cleanup.is_empty(), "{cleanup:?}");
    match outcome {
        Ok(result) => result??,
        Err(panic) => std::panic::resume_unwind(panic),
    }
    Ok(())
}

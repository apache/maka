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

async fn click(view: &mut AppView, label: &str) {
    let mut target = support::wait_enabled_button(view, label).await;
    target.frame.origin.x.0 += target.frame.size.width.0 / 2.0;
    target.frame.origin.y.0 += target.frame.size.height.0 / 2.0;
    support::click_node(view, target);
    commit_native_events(view).await;
}

fn skill(source: &std::path::Path, name: &str, body: &str) {
    let directory = source.join(name);
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(
        directory.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: Guidance for {name}\n---\n{body}"),
    )
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn configuration_pages_manage_real_host_skills_and_mcp_without_creating_conversations() {
    tokio::time::timeout(Duration::from_secs(120), async {
        let fixture = Fixture::configured(Default::default()).await;
        let client = fixture.client().await;
        let home = fixture.directory.path().join("assistant-home");
        let source = fixture.directory.path().join("skill-source");
        skill(&source, "alpha-guide", "Alpha instructions before update");
        skill(&source, "beta-guide", "Beta instructions");
        std::fs::write(source.join("alpha-guide/removed.txt"), "obsolete resource").unwrap();
        let original_id = Uuid::new_v4();
        let reserved = client
            .settings_mutation(
                original_id,
                "skills",
                "delete",
                json!({"reference":"user:maka:uninstalled"}),
                maka_capabilities::call::Attachments::new(),
            )
            .await
            .unwrap();
        assert!(
            client
                .pending_settings()
                .await
                .unwrap()
                .iter()
                .any(|operation| operation.id == original_id && operation.endpoint == "skills")
        );
        reserved.close().await.unwrap();
        client.abandon_unprepared(original_id).await.unwrap();
        let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
        view.resize(160, 80);
        wait_editable_composer(&mut view).await;
        click(&mut view, "Connections & models").await;
        click(&mut view, "Settings section Skills").await;
        click(&mut view, "Add skills").await;
        fill(&mut view, "Skill source", source.to_str().unwrap()).await;
        click(&mut view, "Discover skills").await;
        wait_view(&mut view, |screen| {
            screen.contains("Select skills to install") && screen.contains("alpha-guide")
        })
        .await;
        click(&mut view, home.join(".maka/skills").to_str().unwrap()).await;
        activate(&mut view, "alpha-guide").await;
        activate(&mut view, "beta-guide").await;
        support::evidence("skills-source-selection", &view.snapshot());
        support::evidence_cells("skills-source-selection", &view);
        click(&mut view, "Install selected skills").await;
        wait_view(&mut view, |screen| {
            screen.contains("alpha-guide")
                && screen.contains("beta-guide")
                && screen.contains("Effective")
        })
        .await;
        let alpha = home.join(".maka/skills/alpha-guide");
        let beta = home.join(".maka/skills/beta-guide");
        assert!(alpha.join("SKILL.md").exists() && beta.join("SKILL.md").exists());
        let screen = view.snapshot();
        support::evidence("skills-managed-cards", &screen);
        support::evidence_cells("skills-managed-cards", &view);
        std::fs::remove_file(source.join("alpha-guide/removed.txt")).unwrap();
        skill(&source, "alpha-guide", "Alpha instructions after update");
        std::fs::write(alpha.join("local-only.txt"), "local edit").unwrap();
        click(
            &mut view,
            &format!("Update skill alpha-guide at {}", alpha.display()),
        )
        .await;
        wait_view(&mut view, |screen| screen.contains("Skill updated.")).await;
        assert!(!alpha.join("removed.txt").exists() && !alpha.join("local-only.txt").exists());
        click(
            &mut view,
            &format!("Details for skill alpha-guide at {}", alpha.display()),
        )
        .await;
        wait_view(&mut view, |screen| {
            screen.contains("Alpha instructions after update")
        })
        .await;
        click(&mut view, "Back").await;
        click(
            &mut view,
            &format!("Delete skill alpha-guide at {}", alpha.display()),
        )
        .await;
        click(&mut view, "Delete").await;
        wait_view(&mut view, |screen| screen.contains("Skill deleted.")).await;
        assert!(!alpha.exists() && beta.join("SKILL.md").exists());
        click(&mut view, "Settings section MCP servers").await;
        click(&mut view, "Choose project…").await;
        click(&mut view, "Browse folder Workspace").await;
        click(&mut view, "Use this workspace folder").await;
        click(&mut view, "Add MCP server").await;
        fill(&mut view, "Server name", "docs").await;
        click(&mut view, "Streamable HTTP").await;
        fill(&mut view, "Server URL", "https://example.invalid/mcp").await;
        support::evidence("mcp-project-editor", &view.snapshot());
        support::evidence_cells("mcp-project-editor", &view);
        activate(&mut view, "Save MCP server").await;
        wait_view(&mut view, |screen| screen.contains("MCP server saved.")).await;
        let file = fixture.directory.path().join("workspace/.agents/mcp.json");
        let mut config: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(
            config["mcpServers"]["docs"]["url"],
            "https://example.invalid/mcp"
        );
        config["customRoot"] = json!({"preserve":true});
        config["mcpServers"]["docs"]["customServer"] = json!({"preserve":true});
        config["mcpServers"]["other"] = json!({"url":"https://other.example.invalid/mcp"});
        std::fs::write(&file, serde_json::to_vec(&config).unwrap()).unwrap();
        click(&mut view, "Refresh").await;
        wait_view(&mut view, |screen| screen.contains("other")).await;
        click(
            &mut view,
            &format!("Edit MCP server docs at {}", file.display()),
        )
        .await;
        fill(&mut view, "Server URL", "https://example.invalid/updated").await;
        activate(&mut view, "Save MCP server").await;
        wait_view(&mut view, |screen| {
            screen.contains("MCP server saved.")
                && screen.contains("https://example.invalid/updated")
        })
        .await;
        let saved: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(saved["customRoot"], config["customRoot"]);
        assert_eq!(
            saved["mcpServers"]["docs"]["customServer"],
            config["mcpServers"]["docs"]["customServer"]
        );
        assert_eq!(saved["mcpServers"]["other"], config["mcpServers"]["other"]);
        let status = client
            .query("agent", "projectMcp", json!({"sessionId":fixture.session}))
            .await
            .unwrap();
        assert_eq!(status["trusted"], false);
        support::evidence("mcp-project-cards", &view.snapshot());
        support::evidence_cells("mcp-project-cards", &view);
        click(
            &mut view,
            &format!("Delete MCP server docs at {}", file.display()),
        )
        .await;
        click(&mut view, "Delete").await;
        wait_view(&mut view, |screen| screen.contains("MCP server deleted.")).await;
        let saved: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert!(saved["mcpServers"].get("docs").is_none());
        assert_eq!(saved["mcpServers"]["other"], config["mcpServers"]["other"]);
        click(&mut view, "Add MCP server").await;
        fill(&mut view, "Server name", "local-docs").await;
        fill(&mut view, "Command", "npx").await;
        activate(&mut view, "Add argument").await;
        fill(&mut view, "Argument", "@example/mcp").await;
        activate(&mut view, "Advanced options").await;
        activate(&mut view, "Add row").await;
        fill(&mut view, "Name", "DOCS_TOKEN").await;
        fill(&mut view, "Value", "fixture-token").await;
        fill(
            &mut view,
            "Forward Host environment variables (one per line)",
            "DOCS_HOME",
        )
        .await;
        activate(&mut view, "Save MCP server").await;
        wait_view(&mut view, |screen| {
            screen.contains("MCP server saved.")
                && screen.contains("local-docs")
                && screen.contains("npx")
        })
        .await;
        let saved: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(saved["mcpServers"]["local-docs"]["command"], "npx");
        assert_eq!(
            saved["mcpServers"]["local-docs"]["args"],
            json!(["@example/mcp"])
        );
        assert_eq!(
            saved["mcpServers"]["local-docs"]["env"],
            json!({"DOCS_TOKEN":"fixture-token"})
        );
        assert_eq!(
            saved["mcpServers"]["local-docs"]["passEnv"],
            json!(["DOCS_HOME"])
        );
        click(
            &mut view,
            &format!("Delete MCP server local-docs at {}", file.display()),
        )
        .await;
        click(&mut view, "Delete").await;
        wait_view(&mut view, |screen| {
            screen.contains("MCP server deleted.") && !screen.contains("local-docs")
        })
        .await;
        let sessions = client
            .query(
                "agent",
                "list",
                json!({"filter":"all","position":{"kind":"start"}}),
            )
            .await
            .unwrap();
        assert_eq!(sessions["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 0);
        drop(view);
        drop(bindings);
        client.close().await.unwrap();
        fixture.finish().await;
    })
    .await
    .unwrap();
}

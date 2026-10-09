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

//! Connects to the Runtime Host of a State Root and prints its status.
//!
//! ```sh
//! cargo run -p host-client --example status -- --root <state-root-path>
//! ```
//!
//! The Host must already be running for that root (see `docs/dev-host.md`).

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context as _, Result, bail};
use futures_lite::future;
use host_client::{
    ConnectOptions, Connected, Connection, discover_host, random_client_instance_id,
};
use host_protocol::{
    ClientHello, ProjectCatalogPageItem, ProjectCatalogQuery, ProjectCatalogQueryInput,
    ProjectCatalogQueryResult, ProjectCatalogView, SessionCatalogItem, SessionCatalogQuery,
    SessionCatalogQueryInput, SessionCatalogQueryResult,
};

const READY_TIMEOUT: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

fn main() -> Result<()> {
    let root = parse_root()?;
    let host = future::block_on(discover_host(&root))
        .with_context(|| format!("no running Runtime Host found for {}", root.display()))?;
    let registration = &host.registration;
    println!("State Root      {}", root.display());
    println!("rootId          {}", host.root_id);
    println!("control dir     {}", host.control_directory.display());
    println!(
        "registration    pid {} · {} · state {} · epoch {} · {}",
        registration.pid,
        registration.lifecycle_mode.as_ref().map_or("unknown lifecycle", |mode| mode.as_str()),
        registration.state,
        registration.compatibility_epoch,
        registration.endpoint
    );

    let hello = ClientHello::new(random_client_instance_id());
    let options = ConnectOptions::default()
        .with_expected_root_id(host.root_id.clone())
        .with_expected_host_epoch(registration.host_epoch.clone());

    future::block_on(async {
        let Connected { connection, pump, pushes, .. } =
            Connection::connect(&registration.endpoint, hello, options)
                .await
                .context("handshake failed")?;
        let (pump_result, session_result) = future::zip(pump, async {
            let result = run_session(&connection).await;
            connection.shutdown();
            result
        })
        .await;
        session_result?;
        pump_result.context("connection ended with an error")?;
        let unsolicited = pushes.len();
        if unsolicited > 0 {
            println!("pushes          {unsolicited} unsolicited frame(s) received");
        }
        Ok(())
    })
}

async fn run_session(connection: &Connection) -> Result<()> {
    let accepted = connection.accepted();
    println!(
        "accepted        connection {} · protocol {} · epoch {} · composition {}@{} · state {}{}",
        accepted.connection_id,
        accepted.selected_protocol,
        accepted.compatibility_epoch,
        accepted.composition_id,
        accepted.composition_revision,
        accepted.state,
        if accepted.cooperative_handoff == Some(true) { " · cooperative handoff" } else { "" }
    );
    println!("hostEpoch       {}", accepted.host_epoch);

    let status = connection.wait_until_ready(READY_TIMEOUT).await.context("host.status failed")?;
    println!(
        "host.status     state {} · connections {} · active operations {} · residencies {}{}",
        status.state,
        status.connections,
        status.active_operations,
        status.active_residencies,
        if status.peer_endpoint.is_some() { " · peer endpoint published" } else { "" }
    );

    let mut input = SessionCatalogQueryInput::ListStart;
    let mut total = 0;
    loop {
        let result = connection
            .request_with_timeout::<SessionCatalogQuery>(&input, REQUEST_TIMEOUT)
            .await
            .context("session.catalog.query failed")?;
        let (revision, sessions, next_cursor) = match result {
            SessionCatalogQueryResult::Page { revision, sessions, next_cursor } => {
                (revision, sessions, next_cursor)
            }
            SessionCatalogQueryResult::RevisionChanged { .. } => {
                println!("session catalog changed while paging; restarting");
                input = SessionCatalogQueryInput::ListStart;
                total = 0;
                continue;
            }
            other => bail!("unexpected session.catalog.query result: {other:?}"),
        };
        if total == 0 {
            println!("session.catalog revision {revision}");
        }
        for item in &sessions {
            print_session(item);
        }
        total += sessions.len();
        match next_cursor {
            Some(cursor) => input = SessionCatalogQueryInput::ListContinue { revision, cursor },
            None => break,
        }
    }
    println!("sessions        {total}");
    print_projects(connection).await
}

/// The first page of `project.catalog.query` in the locations view: each
/// project with its state and folders.
async fn print_projects(connection: &Connection) -> Result<()> {
    let input = ProjectCatalogQueryInput::ListStart { view: ProjectCatalogView::Locations };
    let result = connection
        .request_with_timeout::<ProjectCatalogQuery>(&input, REQUEST_TIMEOUT)
        .await
        .context("project.catalog.query failed")?;
    let ProjectCatalogQueryResult::Page { revision, project_count, items, next_cursor, .. } =
        result
    else {
        bail!("unexpected project.catalog.query result: {result:?}");
    };
    println!("project.catalog revision {revision} · {project_count} project(s)");
    for item in items {
        match item {
            ProjectCatalogPageItem::Project { id, name, archived_at, available, .. } => println!(
                "  - {id} · {name:?}{}{}",
                if archived_at.is_some() { " · archived" } else { "" },
                if available { "" } else { " · folder missing" }
            ),
            ProjectCatalogPageItem::Location { location, .. } => {
                println!("      {}", location.path)
            }
            _ => {}
        }
    }
    if next_cursor.is_some() {
        println!("  (more projects on later pages)");
    }
    Ok(())
}

fn print_session(item: &SessionCatalogItem) {
    match item {
        SessionCatalogItem::Session(session) => println!(
            "  - {} · {:?} · {} · {} · {}{}{}",
            session.id,
            session.name,
            session.status,
            session.model,
            session.workspace.host_cwd,
            if session.is_archived { " · archived" } else { "" },
            if session.is_flagged { " · flagged" } else { "" }
        ),
        SessionCatalogItem::UnsupportedLegacy(record) => {
            println!("  - {} · unsupported legacy record ({})", record.id, record.reason);
        }
    }
}

fn parse_root() -> Result<PathBuf> {
    let mut args = std::env::args().skip(1);
    let mut root = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--root" => root = Some(PathBuf::from(args.next().context("--root needs a path")?)),
            "-h" | "--help" => {
                println!("usage: status --root <state-root-path>");
                std::process::exit(0);
            }
            other => bail!("unknown argument {other:?} (usage: status --root <state-root-path>)"),
        }
    }
    root.context("missing --root <state-root-path>")
}

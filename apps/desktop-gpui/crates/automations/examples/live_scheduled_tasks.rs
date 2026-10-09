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

//! Reads a running Runtime Host's scheduled tasks and Daily Review through
//! this crate's wire types and checks that each answer re-encodes to what
//! the Host sent; with `--seed`, first creates sample tasks for the
//! Scheduled tasks page (a reminder due in a minute, which then waits for
//! Maka Desktop's delivery; a bot delivery; a daily task, paused; a cron
//! task), and tries Trigger now on the reminder; with `--run-review`,
//! generates today's Daily Review report (with the configured model).
//!
//! ```sh
//! cargo run -p automations --example live_scheduled_tasks -- --root <state-root> [--seed] [--run-review]
//! ```
//!
//! The Host must already be running for that root (see `docs/dev-host.md`).
//! Use a development State Root: `--seed` writes into it.

use std::error::Error;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_lite::future;
use host_client::{
    ConnectOptions, Connected, Connection, discover_host, random_client_instance_id,
};
use host_protocol::{
    ClientHello, DailyReviewMutateInput, DailyReviewMutateResult, DailyReviewQueryInput,
    DailyReviewQueryResult, DailyReviewRange, Operation, ScheduledTaskBotPlatform,
    ScheduledTaskCalendarRecurrence, ScheduledTaskDraft, ScheduledTaskEffect, ScheduledTaskMutate,
    ScheduledTaskMutateInput, ScheduledTaskMutateResult, ScheduledTaskQueryInput,
    ScheduledTaskQueryResult, ScheduledTaskSchedule,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

const TIMEOUT: Duration = Duration::from_secs(20);

fn main() -> Result<()> {
    let mut root = None;
    let mut seed = false;
    let mut run_review = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--root" => root = args.next().map(PathBuf::from),
            "--seed" => seed = true,
            "--run-review" => run_review = true,
            other => return Err(format!("unknown argument {other:?}").into()),
        }
    }
    let root = root.ok_or("--root <state-root> is required")?;
    let host = future::block_on(discover_host(&root))?;
    let options = ConnectOptions::default()
        .with_expected_root_id(host.root_id.clone())
        .with_expected_host_epoch(host.registration.host_epoch.clone());
    let hello = ClientHello::new(random_client_instance_id());
    future::block_on(async {
        let Connected { connection, pump, .. } =
            Connection::connect(&host.registration.endpoint, hello, options).await?;
        let (pump, session) = future::zip(pump, async {
            let result = run(&connection, seed, run_review).await;
            connection.shutdown();
            result
        })
        .await;
        session?;
        pump?;
        Ok(())
    })
}

async fn run(connection: &Connection, seed: bool, run_review: bool) -> Result<()> {
    connection.wait_until_ready(TIMEOUT).await?;
    if seed {
        seed_tasks(connection).await?;
    }
    let page: ScheduledTaskQueryResult =
        checked(connection, "scheduled-task.query", &ScheduledTaskQueryInput::first_page()).await?;
    if let ScheduledTaskQueryResult::Page { revision, tasks, .. } = &page {
        println!("scheduled tasks at revision {revision}:");
        for task in tasks {
            println!(
                "  {} · {} · {:?} · next {:?}",
                task.id, task.title, task.status, task.next_fire_at
            );
        }
    }
    let summary: DailyReviewQueryResult = checked(
        connection,
        "daily-review.query",
        &DailyReviewQueryInput::Summary { day_span: 1, offset_days: 0 },
    )
    .await?;
    if let DailyReviewQueryResult::Summary { summary } = &summary {
        println!(
            "today: {} tasks, {} model calls",
            summary.totals.session_count, summary.totals.request_count
        );
    }
    let _: DailyReviewQueryResult = checked(
        connection,
        "daily-review.query",
        &DailyReviewQueryInput::Archives { before_archive_id: None, limit: 32 },
    )
    .await?;
    let _: DailyReviewQueryResult =
        checked(connection, "daily-review.query", &DailyReviewQueryInput::Config).await?;
    if run_review {
        let input = DailyReviewMutateInput::run(DailyReviewRange::Day, 0);
        let result: DailyReviewMutateResult =
            checked(connection, "daily-review.mutate", &input).await?;
        if let DailyReviewMutateResult::Archive { archive } = result {
            println!("report {} · {:?}", archive.id, archive.status);
            let _: DailyReviewQueryResult = checked(
                connection,
                "daily-review.query",
                &DailyReviewQueryInput::Archive { archive_id: archive.id.clone() },
            )
            .await?;
        }
    }
    Ok(())
}

/// Sends `input` raw, decodes the answer as `T`, and fails unless encoding
/// it gives back what the Host sent.
async fn checked<I: Serialize, T: Serialize + DeserializeOwned>(
    connection: &Connection,
    operation: &str,
    input: &I,
) -> Result<T> {
    let raw =
        connection.request_value(operation, serde_json::to_value(input)?, Some(TIMEOUT)).await?;
    let decoded: T = serde_json::from_value(raw.clone())?;
    let encoded = serde_json::to_value(&decoded)?;
    if !same(&encoded, &raw) {
        return Err(
            format!("{operation} does not round-trip:\n  sent {raw}\n  read {encoded}").into()
        );
    }
    println!("{operation} {} round-trips", input_kind(input));
    Ok(decoded)
}

/// JSON equality with numbers compared by value (`0` and `0.0` alike).
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter().all(|(key, value)| b.get(key).is_some_and(|other| same(value, other)))
        }
        _ => a == b,
    }
}

fn input_kind<I: Serialize>(input: &I) -> String {
    serde_json::to_value(input)
        .ok()
        .and_then(|value| value["kind"].as_str().map(str::to_owned))
        .unwrap_or_default()
}

async fn seed_tasks(connection: &Connection) -> Result<()> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64;
    let hour = 60 * 60 * 1000;
    let drafts = [
        ScheduledTaskDraft::new(
            "Stand-up",
            "Prepare three bullet points for the stand-up.",
            ScheduledTaskSchedule::Once { run_at: now + 60 * 1000 },
            ScheduledTaskEffect::local(),
        ),
        ScheduledTaskDraft::new(
            "Weekend task review",
            "Review this week's tasks and outline next week.",
            ScheduledTaskSchedule::Cron { expression: "0 20 * * 0".into(), start_at: now + hour },
            ScheduledTaskEffect::bot(ScheduledTaskBotPlatform::Telegram, "42"),
        ),
        ScheduledTaskDraft::new(
            "Water the plants",
            "",
            ScheduledTaskSchedule::Calendar {
                recurrence: ScheduledTaskCalendarRecurrence::Daily,
                anchor_at: now + 20 * hour,
            },
            ScheduledTaskEffect::local(),
        ),
        ScheduledTaskDraft::new(
            "Clean up Downloads",
            "Organize screenshots, installers, and temporary documents in Downloads by type.",
            ScheduledTaskSchedule::Cron { expression: "30 18 * * *".into(), start_at: now + hour },
            ScheduledTaskEffect::local(),
        ),
    ];
    let mut ids = Vec::new();
    for draft in drafts {
        let created: ScheduledTaskMutateResult = checked(
            connection,
            ScheduledTaskMutate::NAME,
            &ScheduledTaskMutateInput::Create { input: draft },
        )
        .await?;
        if let ScheduledTaskMutateResult::Task { task } = created {
            println!("created {} ({})", task.id, task.title);
            ids.push(task.id);
        }
    }
    if let Some(plants) = ids.get(2) {
        let _: ScheduledTaskMutateResult = checked(
            connection,
            ScheduledTaskMutate::NAME,
            &ScheduledTaskMutateInput::Pause { task_id: plants.clone() },
        )
        .await?;
    }
    // Trigger now on a reminder: no client delivers it here, so the Host
    // holds the fire and says so.
    if let Some(downloads) = ids.get(3) {
        let input = serde_json::to_value(ScheduledTaskMutateInput::TriggerNow {
            task_id: downloads.clone(),
        })?;
        match connection.request_value(ScheduledTaskMutate::NAME, input, Some(TIMEOUT)).await {
            Ok(value) => println!("trigger_now answered {value}"),
            Err(error) => println!("trigger_now refused: {error}"),
        }
    }
    Ok(())
}

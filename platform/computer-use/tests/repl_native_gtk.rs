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

#![cfg(all(target_os = "linux", feature = "native-desktop"))]

//! Candidate GTK public-AX recorder; input requires `MAKA_NATIVE_GTK_ACTIONS=1`.
//! Run only inside the task-owned Xvfb/DBus/WM namespace after Root review.

use maka_agent_facts::{
    language::Language,
    tools::{ToolError, ToolExecutor, ToolFuture},
};
use maka_capabilities::computer::Desktop;
use maka_code_runtime::{CellContext, CellLimits, CellOutput, CellResult, CellStore};
use maka_computer_use::{
    Driver, InvocationContext, Session, SessionOwner, facade,
    protocol::{Action, Command},
};
use maka_js_runtime::repl::Repl;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    io::{self, Read},
    os::unix::process::ExitStatusExt,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

type Recorded<T> = Result<T, Box<dyn Error + Send + Sync>>;
const MARKER: &str = "__maka_gtk_candidate__";
const SESSION_ID: &str = "native-gtk-observation-fixture";

#[path = "support/native_gtk_focus_scroll.rs"]
mod held_focus_scroll;

struct Bridge {
    session: Arc<Mutex<Session>>,
    calls: Arc<Mutex<Vec<Value>>>,
    allow_clicks: bool,
    allow_scroll: bool,
    record_typed_errors: bool,
}

impl ToolExecutor for Bridge {
    fn names(&self) -> Vec<String> {
        vec!["cua".into()]
    }

    fn invoke(&self, _: String, input: Value, cancellation: CancellationToken) -> ToolFuture {
        let session = self.session.clone();
        let calls = self.calls.clone();
        let allow_clicks = self.allow_clicks;
        let allow_scroll = self.allow_scroll;
        let record_typed_errors = self.record_typed_errors;
        Box::pin(async move {
            let result = async {
                let command: Command = serde_json::from_value(input.clone())
                    .map_err(|error| ToolError::Failed(error.to_string()))?;
                let observation = matches!(
                    &command,
                    Command::Documentation
                        | Command::GetApp { .. }
                        | Command::Observe {
                            kind: maka_computer_use::protocol::ObservationKind::Ax,
                            ..
                        }
                );
                let click = allow_clicks
                    && matches!(
                        &command,
                        Command::Action {
                            action: Action::Click { .. } | Action::LinuxClick { .. },
                            ..
                        }
                    );
                let scroll = allow_scroll
                    && matches!(&command, Command::Action { action: Action::LinuxScroll { .. }, .. });
                if !observation && !click && !scroll {
                    return Err(ToolError::Failed(
                        "GTK recorder accepts observations and explicitly enabled click/scroll probes only".into(),
                    ));
                }
                session
                    .lock()
                    .await
                    .invoke(
                        command,
                        &InvocationContext::new(SESSION_ID, "fixture-turn"),
                        &cancellation,
                        Language::En,
                    )
                    .await
            }
            .await;
            let outcome = match &result {
                Ok(value) => json!({"ok":true,"value":value}),
                Err(error) if record_typed_errors => {
                    json!({"ok":false,"error":error.to_string(),"typed_error":held_focus_scroll::tool_error(error)})
                }
                Err(error) => json!({"ok":false,"error":error.to_string()}),
            };
            calls
                .lock()
                .await
                .push(json!({"input":input,"result":outcome}));
            result
        })
    }
}

fn refuse(message: impl Into<String>) -> Box<dyn Error + Send + Sync> {
    io::Error::other(message.into()).into()
}

fn required_path(name: &str) -> Recorded<PathBuf> {
    let path = PathBuf::from(
        std::env::var_os(name)
            .ok_or_else(|| refuse(format!("explicit task-owned {name} path is required")))?,
    );
    if !path.is_absolute() {
        return Err(refuse(format!("{name} must be absolute")));
    }
    Ok(path)
}

fn read_json(path: &Path) -> Recorded<Value> {
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}

fn write_json(path: &Path, value: &Value) -> Recorded<()> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, bytes)?;
    std::fs::rename(temporary, path)?;
    Ok(())
}

fn digest(path: &Path) -> Recorded<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(hex::encode(hash.finalize()))
}

fn marker(parts: &[CellOutput]) -> Recorded<Value> {
    let mut values = parts.iter().filter_map(|part| match part {
        CellOutput::Text { text } => serde_json::from_str::<Value>(text)
            .ok()
            .and_then(|value| value.get(MARKER).cloned()),
        _ => None,
    });
    let first = values
        .next()
        .ok_or_else(|| refuse("public observation marker missing"))?;
    if values.next().is_some() {
        return Err(refuse("public observation marker appeared more than once"));
    }
    Ok(first)
}

async fn cell(repl: &Repl, bridge: Arc<Bridge>, source: String, path: &Path) -> Recorded<Value> {
    let store = CellStore::temporary()
        .map_err(|error| refuse(format!("{:?}: {}", error.kind, error.message)))?;
    let context = CellContext::new(store, vec![])
        .map_err(|error| refuse(format!("{:?}: {}", error.kind, error.message)))?;
    let result = repl
        .evaluate(
            source.clone(),
            bridge,
            CancellationToken::new(),
            context.clone(),
            Duration::from_secs(20),
        )
        .await;
    let outputs = context.take_output();
    let serialized = match &result {
        Ok(value) => serde_json::to_value(value)?,
        Err(error) => json!({"transport_error":error.to_string()}),
    };
    write_json(
        path,
        &json!({"source":source,"result":serialized,"outputs":outputs}),
    )?;
    if !matches!(result, Ok(CellResult::Success { .. })) {
        return Err(refuse(format!(
            "public observation cell failed; see {}",
            path.display()
        )));
    }
    marker(&outputs)
}

struct GtkFixture {
    child: tokio::process::Child,
    output: PathBuf,
}

impl GtkFixture {
    fn start(source: &Path, output: &Path) -> Recorded<Self> {
        if output.exists() {
            return Err(refuse("use a fresh GTK fixture output directory"));
        }
        let stdout = std::fs::File::create(output.with_extension("stdout.log"))?;
        let stderr = std::fs::File::create(output.with_extension("stderr.log"))?;
        let mut command = tokio::process::Command::new("/usr/bin/python3.12");
        command.arg(source);
        held_focus_scroll::configure_fixture(&mut command)?;
        let child = command
            .env("MAKA_ATSPI_FIXTURE_OUTPUT", output)
            .env("NO_AT_BRIDGE", "0")
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(stderr)
            .kill_on_drop(true)
            .spawn()?;
        Ok(Self {
            child,
            output: output.to_owned(),
        })
    }

    async fn ready(&mut self) -> Recorded<Value> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        let path = self.output.join("ready.json");
        loop {
            if path.is_file() {
                let ready = read_json(&path)?;
                let pid = ready["pid"]
                    .as_u64()
                    .ok_or_else(|| refuse("fixture PID absent"))?;
                if self.child.id().map(u64::from) != Some(pid) {
                    return Err(refuse("ready.json PID does not match the task-owned child"));
                }
                let mut ids = Vec::new();
                for role in ["target", "other"] {
                    let window = &ready["windows"][role];
                    let id = window["window_id"]
                        .as_u64()
                        .ok_or_else(|| refuse("fixture XID absent"))?;
                    if window["pid"] != pid || id == 0 {
                        return Err(refuse(format!(
                            "fixture window identity is invalid: {role}"
                        )));
                    }
                    ids.push(id);
                }
                if ids[0] == ids[1] {
                    return Err(refuse("fixture windows have the same XID"));
                }
                return Ok(ready);
            }
            if let Some(status) = self.child.try_wait()? {
                return Err(refuse(format!(
                    "GTK fixture exited before readiness: {status}"
                )));
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(refuse("GTK fixture did not realize its windows"));
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    fn oracles(&self) -> Recorded<Value> {
        let target = read_json(&self.output.join("target-state.json"))?;
        let other = read_json(&self.output.join("other-state.json"))?;
        let events = match std::fs::read_to_string(self.output.join("events.jsonl")) {
            Ok(text) => text
                .lines()
                .map(serde_json::from_str::<Value>)
                .collect::<Result<Vec<_>, _>>()?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error.into()),
        };
        Ok(json!({"target":target,"other":other,"events":events}))
    }

    async fn finish(&mut self) -> Recorded<Value> {
        let already_exited = self.child.try_wait()?;
        let termination = if already_exited.is_some() {
            "already_exited"
        } else {
            self.child.start_kill()?;
            "owned_fixture_start_kill"
        };
        let status = tokio::time::timeout(Duration::from_secs(10), self.child.wait()).await??;
        Ok(json!({"termination":termination,"code":status.code(),"signal":status.signal()}))
    }
}

async fn native_ax_receipt(
    bridge: &Bridge,
    since: usize,
    state: &str,
    pid: u64,
    xid: u64,
) -> Recorded<Value> {
    let calls = bridge.calls.lock().await;
    let mut reads = calls[since..].iter().filter(|call| {
        call["input"]["method"] == "observe"
            && call["input"]["kind"] == "ax"
            && call["result"]["ok"] == true
            && call["result"]["value"]["state"] == state
    });
    let read = reads
        .next()
        .ok_or_else(|| refuse("same-call AX observation receipt missing"))?;
    if reads.next().is_some() {
        return Err(refuse("same-cell AX observation receipt is ambiguous"));
    }
    let handle = &read["input"]["handle"];
    if handle["kind"] != "app" || handle["id"].as_str().is_none_or(str::is_empty) {
        return Err(refuse("AX receipt did not use an application handle"));
    }
    let binding = calls
        .iter()
        .rev()
        .find(|call| {
            call["input"]["method"] == "getApp"
                && call["result"]["ok"] == true
                && call["result"]["value"]["handle"] == *handle
        })
        .ok_or_else(|| refuse("AX receipt handle has no successful binding receipt"))?;
    if binding["result"]["value"]["binding"]["pid"] != pid
        || binding["result"]["value"]["binding"]["windowId"] != xid
    {
        return Err(refuse(
            "AX receipt handle does not identify the known fixture PID/XID",
        ));
    }
    let metadata = read["result"]["value"]["nativeAX"].clone();
    native_rows(&metadata)?;
    Ok(metadata)
}

fn native_rows(metadata: &Value) -> Recorded<&[Value]> {
    if metadata["source"] != "at_spi" {
        return Err(refuse("own GTK observation did not use AT-SPI"));
    }
    let observation = &metadata["observation"];
    if observation["elements_complete"] != true
        || observation["truncated"] == true
        || observation["native_profile"]["trusted"] != true
    {
        return Err(refuse(format!(
            "own GTK native AX observation is not complete and trusted: {observation}"
        )));
    }
    metadata["rows"]
        .as_array()
        .filter(|rows| !rows.is_empty())
        .map(Vec::as_slice)
        .ok_or_else(|| refuse("same-observation native AX rows are missing"))
}

fn native_aliases(metadata: &Value) -> Recorded<BTreeMap<String, String>> {
    let rows = native_rows(metadata)?;
    let mut aliases = BTreeMap::new();
    let mut public_ids = BTreeSet::new();
    for (index, row) in rows.iter().enumerate() {
        let native = row["native_id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| refuse("native row ID missing"))?;
        let public = row["id"]
            .as_str()
            .ok_or_else(|| refuse("native row public alias missing"))?;
        let id = public.parse::<u64>()?;
        if id.to_string() != public
            || !public_ids.insert(id)
            || aliases.insert(native.into(), public.into()).is_some()
        {
            return Err(refuse(
                "own GTK native/public identity rows are repeated or noncanonical",
            ));
        }
        let depth = row["depth"]
            .as_u64()
            .ok_or_else(|| refuse("native row depth missing"))?;
        match row["parent"].as_u64() {
            Some(parent)
                if parent < index as u64
                    && rows[parent as usize]["depth"]
                        .as_u64()
                        .is_some_and(|parent_depth| depth == parent_depth + 1) => {}
            None if row["parent"].is_null() && index == 0 && depth == 0 => {}
            _ => return Err(refuse("own GTK raw parent/depth relation is invalid")),
        }
    }
    Ok(aliases)
}

fn public_row(row: &str) -> Recorded<(u64, &str)> {
    let (id, body) = row
        .trim_start_matches('\t')
        .split_once(' ')
        .ok_or_else(|| refuse(format!("public AX row has no numeric ID: {row}")))?;
    if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(refuse(format!("public AX row ID is not decimal: {row}")));
    }
    let index = id.parse::<u64>()?;
    if index.to_string() != id {
        return Err(refuse(format!("public AX row ID is noncanonical: {row}")));
    }
    Ok((index, body))
}

fn button_row_matches(row: &str, label: &str) -> bool {
    public_row(row)
        .ok()
        .and_then(|(_, body)| body.strip_prefix("push button "))
        .and_then(|body| {
            if body.starts_with('(') {
                body.split_once(") ").map(|(_, body)| body)
            } else {
                Some(body)
            }
        })
        .and_then(|body| body.strip_prefix(label))
        .is_some_and(|suffix| suffix.is_empty() || suffix.starts_with(", "))
}

fn native_clickable(row: &Value) -> bool {
    row["actions"].as_array().is_some_and(|actions| {
        actions
            .iter()
            .any(|action| action.as_str() == Some("click"))
    }) && ["enabled", "sensitive", "showing"].iter().all(|state| {
        row["states"]
            .as_array()
            .is_some_and(|states| states.iter().any(|value| value.as_str() == Some(*state)))
    })
}

struct ObservedButton {
    id: u64,
    row: String,
    native_id: String,
    raw_preorder: usize,
}

fn observed_button(state: &str, metadata: &Value, label: &str) -> Recorded<ObservedButton> {
    if state.lines().next() != Some("Accessibility source: at_spi") {
        return Err(refuse("public GTK AX source header is invalid"));
    }
    let mut matching = native_rows(metadata)?
        .iter()
        .enumerate()
        .filter(|(_, row)| row["name"] == label && row["role"] == "push button");
    let (raw_preorder, native) = matching
        .next()
        .ok_or_else(|| refuse(format!("native button missing: {label}")))?;
    if matching.next().is_some() {
        return Err(refuse(format!("native button is ambiguous: {label}")));
    }
    if !native_clickable(native) {
        return Err(refuse(format!(
            "native button is not enabled, sensitive, showing and clickable: {label}"
        )));
    }
    let id = native["id"]
        .as_str()
        .ok_or_else(|| refuse("native row public alias missing"))?;
    let index = id.parse::<u64>()?;
    if index.to_string() != id {
        return Err(refuse("native row public alias is not canonical"));
    }
    let native_id = native["native_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| refuse("native button ID is missing"))?;
    let mut rows = state.lines().skip(1).filter(|row| {
        public_row(row).is_ok_and(|(id, _)| id == index) && button_row_matches(row, label)
    });
    let row = rows
        .next()
        .ok_or_else(|| refuse(format!("correlated public AX button missing: {label}")))?;
    if rows.next().is_some() {
        return Err(refuse(format!(
            "correlated public AX button is ambiguous: {label}"
        )));
    }
    Ok(ObservedButton {
        id: index,
        row: row.into(),
        native_id: native_id.into(),
        raw_preorder,
    })
}

struct ObservedGridButton {
    id: u64,
    name: String,
    row: String,
    native_id: String,
    raw_preorder: usize,
    native_grid_ordinal: usize,
}

fn public_indices(state: &str) -> Recorded<BTreeSet<u64>> {
    if state.lines().next() != Some("Accessibility source: at_spi") {
        return Err(refuse("public GTK AX source header is invalid"));
    }
    let mut indices = BTreeSet::new();
    for row in state.lines().skip(1) {
        let (index, _) = public_row(row)?;
        if !indices.insert(index) {
            return Err(refuse(format!(
                "public AX index is noncanonical or repeated: {row}"
            )));
        }
    }
    Ok(indices)
}

fn large_ax_buttons(
    ready: &Value,
    public_ax: &Value,
    native_ax: &Value,
) -> Recorded<Option<Vec<ObservedGridButton>>> {
    let Some(large) = ready.get("large_ax") else {
        return Ok(None);
    };
    const BUTTON_COUNT: usize = 1200;
    let names = large["button_names"]
        .as_array()
        .ok_or_else(|| refuse("large GTK fixture button_names are missing"))?;
    if large["button_count"] != BUTTON_COUNT || names.len() != BUTTON_COUNT {
        return Err(refuse(
            "large GTK fixture must declare exactly 1200 buttons",
        ));
    }
    let names = names
        .iter()
        .map(|name| {
            name.as_str()
                .filter(|name| !name.is_empty())
                .ok_or_else(|| refuse("large GTK fixture button name is invalid"))
        })
        .collect::<Recorded<BTreeSet<_>>>()?;
    if names.len() != BUTTON_COUNT {
        return Err(refuse("large GTK fixture button names are not unique"));
    }
    for field in ["widget_visible", "widget_mapped", "widget_sensitive"] {
        if large[field] != BUTTON_COUNT {
            return Err(refuse(format!(
                "large GTK fixture does not have 1200 {field} controls"
            )));
        }
    }
    let layout = &large["own_layout"];
    let width = layout["client_width"]
        .as_i64()
        .filter(|value| *value > 0)
        .ok_or_else(|| refuse("large GTK fixture client width is invalid"))?;
    let height = layout["client_height"]
        .as_i64()
        .filter(|value| *value > 0)
        .ok_or_else(|| refuse("large GTK fixture client height is invalid"))?;
    if layout["outside_client_names"].as_array().map(Vec::len) != Some(0) {
        return Err(refuse(
            "large GTK fixture reports controls outside its client",
        ));
    }
    let rectangles = layout["button_rectangles"]
        .as_array()
        .filter(|rectangles| rectangles.len() == BUTTON_COUNT)
        .ok_or_else(|| refuse("large GTK fixture must report 1200 control rectangles"))?;
    let mut rectangle_names = BTreeSet::new();
    for rectangle in rectangles {
        let name = rectangle["name"]
            .as_str()
            .ok_or_else(|| refuse("large GTK fixture rectangle name is missing"))?;
        let [Some(x), Some(y), Some(control_width), Some(control_height)] =
            ["x", "y", "width", "height"].map(|field| rectangle[field].as_i64())
        else {
            return Err(refuse(format!(
                "large GTK fixture rectangle is invalid: {name}"
            )));
        };
        if !rectangle_names.insert(name)
            || x < 0
            || y < 0
            || control_width <= 0
            || control_height <= 0
            || x.checked_add(control_width)
                .is_none_or(|right| right > width)
            || y.checked_add(control_height)
                .is_none_or(|bottom| bottom > height)
        {
            return Err(refuse(format!(
                "large GTK fixture rectangle is repeated or outside its client: {name}"
            )));
        }
    }
    if rectangle_names != names {
        return Err(refuse(
            "large GTK fixture rectangles and button names differ",
        ));
    }
    let target = public_ax["target"]
        .as_str()
        .ok_or_else(|| refuse("large GTK target public AX is missing"))?;
    let other = public_ax["other"]
        .as_str()
        .ok_or_else(|| refuse("large GTK sibling public AX is missing"))?;
    for (role, state) in [("target", target), ("other", other)] {
        let sibling = if role == "target" { "other" } else { "target" };
        for field in ["title", "entry_name", "button_name"] {
            let name = ready["windows"][sibling][field]
                .as_str()
                .ok_or_else(|| refuse(format!("large GTK sibling {field} is missing")))?;
            if state.contains(name) {
                return Err(refuse(format!(
                    "large GTK {role} public AX contains sibling {field}"
                )));
            }
        }
    }
    let target_rows = native_rows(&native_ax["target"])?;
    let native_grid_order: BTreeMap<_, _> = target_rows
        .iter()
        .enumerate()
        .filter(|(_, row)| {
            row["role"] == "push button"
                && row["name"]
                    .as_str()
                    .is_some_and(|name| names.contains(name))
                && native_clickable(row)
        })
        .enumerate()
        .map(|(ordinal, (preorder, row))| (row["name"].as_str().unwrap(), (preorder, ordinal)))
        .collect();
    if native_grid_order.len() != BUTTON_COUNT {
        return Err(refuse(
            "native AX does not expose 1200 uniquely named enabled/showing/clickable grid buttons",
        ));
    }
    let mut buttons = Vec::with_capacity(BUTTON_COUNT);
    let mut missing = Vec::new();
    for name in names {
        if other.lines().any(|row| button_row_matches(row, name)) {
            return Err(refuse(format!(
                "large GTK sibling public AX contains target control: {name}"
            )));
        }
        if !target.lines().any(|row| button_row_matches(row, name)) {
            missing.push(name);
            continue;
        }
        let button = observed_button(target, &native_ax["target"], name)?;
        let &(raw_preorder, native_grid_ordinal) = native_grid_order
            .get(name)
            .ok_or_else(|| refuse("native grid ordinal missing"))?;
        buttons.push(ObservedGridButton {
            id: button.id,
            name: name.to_owned(),
            row: button.row,
            native_id: button.native_id,
            raw_preorder,
            native_grid_ordinal,
        });
    }
    if !missing.is_empty() {
        return Err(refuse(format!(
            "large GTK public AX exposes {}/1200 expected buttons; {} missing, first: {}",
            buttons.len(),
            missing.len(),
            missing[0]
        )));
    }
    for (role, state) in [("target", target), ("other", other)] {
        if state.to_ascii_lowercase().contains("incomplete") {
            return Err(refuse(format!("large GTK {role} public AX is incomplete")));
        }
    }
    Ok(Some(buttons))
}

fn oracle_clicks(snapshot: &Value, role: &str) -> Recorded<i64> {
    snapshot[role]["clicks"]
        .as_i64()
        .ok_or_else(|| refuse(format!("independent {role} counter is missing")))
}

fn appended_events<'a>(before: &Value, after: &'a Value) -> Recorded<&'a [Value]> {
    let previous = before["events"]
        .as_array()
        .ok_or_else(|| refuse("previous fixture events are missing"))?;
    let current = after["events"]
        .as_array()
        .ok_or_else(|| refuse("current fixture events are missing"))?;
    if !current.starts_with(previous) {
        return Err(refuse("independent fixture event history was rewritten"));
    }
    Ok(&current[previous.len()..])
}

fn target_acknowledged(
    before: &Value,
    after: &Value,
    expected_control: Option<&str>,
) -> Recorded<bool> {
    let events = appended_events(before, after)?;
    Ok(
        oracle_clicks(after, "target")? == oracle_clicks(before, "target")? + 1
            && after["other"] == before["other"]
            && after["target"]["text"] == "seed-target"
            && after["target"]["saved"] == "seed-target"
            && events.len() == 1
            && events[0]["role"] == "target"
            && events[0]["event"] == "clicked"
            && events[0]["clicks"] == after["target"]["clicks"]
            && events[0]["text"] == "seed-target"
            && expected_control.is_none_or(|control| {
                after["target"]["last_clicked_control"] == control
                    && events[0]["control"] == control
            }),
    )
}

struct ClickProbe {
    id: &'static str,
    argument: Option<Value>,
    expected_refusal: Option<String>,
    expected_target_delta: i64,
    positive_control: bool,
    expected_control: Option<String>,
}

async fn record_actions(
    repl: &Repl,
    bridge: Arc<Bridge>,
    fixture: &GtkFixture,
    capture: &mut Value,
    output: &Path,
    late_button: Option<&ObservedGridButton>,
) -> Recorded<()> {
    let mut buttons = Vec::new();
    for role in ["target", "other"] {
        let label = capture["initial_fixture"]["windows"][role]["button_name"]
            .as_str()
            .ok_or_else(|| refuse(format!("{role} button label missing")))?;
        let state = capture["public_ax"][role]
            .as_str()
            .ok_or_else(|| refuse(format!("{role} public AX missing")))?;
        let button = observed_button(state, &capture["native_ax"][role], label)?;
        capture["observed_save_ids"][role] = json!({"public_id":button.id.to_string(),"public_line":button.row,"native_id":button.native_id,"raw_preorder":button.raw_preorder});
        buttons.push(button);
    }
    let target = buttons[0].id;
    let other = buttons[1].id;
    if target == other
        || capture["large_ax_validation"]["id_scope"]["status"] == "target_sibling_overlap"
    {
        return Err(refuse(
            "target and sibling public IDs overlap; foreign-window action cannot be issued safely",
        ));
    }
    let tree_refusal = "element is not in this window's AT-SPI tree; refresh get_window_state()";
    let unknown_id =
        |id| format!("Unknown element ID {id} for this window; refresh get_window_state()");
    let save_control = capture["initial_fixture"].get("large_ax").and_then(|_| {
        capture["initial_fixture"]["windows"]["target"]["button_name"]
            .as_str()
            .map(str::to_owned)
    });
    let mut probes = vec![
        ClickProbe {
            id: "target-public-number",
            argument: Some(json!(target)),
            expected_refusal: None,
            expected_target_delta: 1,
            positive_control: true,
            expected_control: save_control.clone(),
        },
        ClickProbe {
            id: "target-public-string",
            argument: Some(json!(target.to_string())),
            expected_refusal: None,
            expected_target_delta: 1,
            positive_control: true,
            expected_control: save_control.clone(),
        },
        ClickProbe {
            id: "target-public-leading-zero",
            argument: Some(json!(format!("0{target}"))),
            expected_refusal: Some(unknown_id(format!("0{target}"))),
            expected_target_delta: 0,
            positive_control: false,
            expected_control: None,
        },
        ClickProbe {
            id: "target-null",
            argument: Some(Value::Null),
            expected_refusal: Some(tree_refusal.into()),
            expected_target_delta: 0,
            positive_control: false,
            expected_control: None,
        },
        ClickProbe {
            id: "target-invalid-string",
            argument: Some(json!("not-an-element")),
            expected_refusal: Some(tree_refusal.into()),
            expected_target_delta: 0,
            positive_control: false,
            expected_control: None,
        },
        ClickProbe {
            id: "target-native-id",
            argument: Some(json!(buttons[0].native_id)),
            expected_refusal: None,
            expected_target_delta: 1,
            positive_control: true,
            expected_control: save_control,
        },
        ClickProbe {
            id: "other-public-number-on-target",
            argument: Some(json!(other)),
            expected_refusal: Some(unknown_id(other.to_string())),
            expected_target_delta: 0,
            positive_control: false,
            expected_control: None,
        },
        ClickProbe {
            id: "other-native-id-on-target",
            argument: Some(json!(buttons[1].native_id)),
            expected_refusal: Some(tree_refusal.into()),
            expected_target_delta: 0,
            positive_control: false,
            expected_control: None,
        },
    ];
    if let Some(button) = late_button {
        probes.push(ClickProbe {
            id: "target-late-public-number",
            argument: Some(json!(button.id)),
            expected_refusal: None,
            expected_target_delta: 1,
            positive_control: true,
            expected_control: Some(button.name.clone()),
        });
    }
    capture["actions"] = json!([]);
    capture["reference_recording"] =
        json!("original-gtk-atspi/run-20261026T150349Z/reference/capture.json");
    let capture_path = output.join("capture.json");
    let mut failures = Vec::new();
    let mut differences = Vec::new();
    for probe in probes {
        let expected_result = match &probe.expected_refusal {
            Some(message) => {
                json!({"ok":false,"error":{"name":"Error","message":message,"string":format!("Error: {message}")}})
            }
            None => json!({"ok":true,"valueType":"undefined"}),
        };
        let before = fixture.oracles()?;
        let mut row = json!({"id":probe.id,"positive_control":probe.positive_control,"before":before,
            "expected_result":expected_result,"expected_counter_delta":{"target":probe.expected_target_delta,"other":0}});
        if let Some(control) = &probe.expected_control {
            row["expected_clicked_control"] = json!(control);
            row["expectation_source"] = json!(
                "Independent large-fixture positive control selected from this Candidate public AX; no reference-process ID was substituted"
            );
        }
        let transcript = output
            .join("transcripts")
            .join(format!("action-{}.json", probe.id));
        if let Some(argument) = probe.argument {
            let call = format!("await gtkAppTarget.click({argument});");
            row["call"] = json!(call);
            row["status"] = json!("issued");
            row["transcript"] = json!({"path":format!("transcripts/action-{}.json",probe.id)});
            capture["actions"]
                .as_array_mut()
                .ok_or_else(|| refuse("action rows missing"))?
                .push(row.clone());
            let attempted = capture["actions"]
                .as_array()
                .ok_or_else(|| refuse("action rows missing"))?
                .iter()
                .filter(|row| row["status"] != "unverified")
                .count();
            capture["input_actions_attempted"] = json!(attempted);
            write_json(&capture_path, capture)?;
            let source = format!(
                "try {{ const value={call} nodeRepl.write(JSON.stringify({{{MARKER}:{{ok:true,valueType:typeof value,value}}}})); }} catch(error) {{ nodeRepl.write(JSON.stringify({{{MARKER}:{{ok:false,error:{{name:error?.name,message:error?.message,string:String(error)}}}}}})); }}"
            );
            let evaluated = cell(repl, bridge.clone(), source, &transcript).await;
            if transcript.is_file() {
                row["transcript"] = json!({"path":format!("transcripts/action-{}.json",probe.id),"sha256":digest(&transcript)?});
                let receipt = capture["actions"]
                    .as_array_mut()
                    .and_then(|rows| rows.last_mut())
                    .ok_or_else(|| refuse("issued action receipt missing"))?;
                receipt["transcript"] = row["transcript"].clone();
                if let Ok(result) = &evaluated {
                    receipt["result"] = result.clone();
                }
                write_json(&capture_path, capture)?;
            }
            let result = evaluated?;
            let fulfilled = result["ok"] == true;
            let started = tokio::time::Instant::now();
            // Match the reference recorder's acknowledgement and refusal windows.
            let observation_window = Duration::from_millis(if fulfilled { 5000 } else { 300 });
            let mut refusal_no_effect = true;
            let after = loop {
                let after = fixture.oracles()?;
                refusal_no_effect &= after == before;
                if (fulfilled
                    && target_acknowledged(&before, &after, probe.expected_control.as_deref())?)
                    || started.elapsed() >= observation_window
                {
                    break after;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            };
            let delta = json!({"target":oracle_clicks(&after,"target")? - oracle_clicks(&before,"target")?,
                "other":oracle_clicks(&after,"other")? - oracle_clicks(&before,"other")?});
            let acknowledged =
                target_acknowledged(&before, &after, probe.expected_control.as_deref())?;
            row["status"] = json!("recorded");
            row["result"] = result.clone();
            row["after"] = after.clone();
            row["events"] = json!(appended_events(&before, &after)?);
            row["counter_delta"] = delta.clone();
            row["counter_acknowledged"] = json!(acknowledged);
            row["oracle_wait_ms"] = json!(started.elapsed().as_millis());
            row["refusal_observation_window_ms"] = if fulfilled {
                Value::Null
            } else {
                json!(started.elapsed().as_millis())
            };
            row["refusal_no_effect"] = if fulfilled {
                Value::Null
            } else {
                json!(refusal_no_effect)
            };
            row["reference_result_matches"] = json!(result == expected_result);
            row["reference_counter_matches"] = json!(delta == row["expected_counter_delta"]);
            if fulfilled && !acknowledged {
                failures.push(format!(
                    "{}: fulfilled without exactly one independent target acknowledgement",
                    probe.id
                ));
            }
            if !fulfilled && !refusal_no_effect {
                failures.push(format!(
                    "{}: refusal changed independent fixture state",
                    probe.id
                ));
            }
            if result != expected_result || delta != row["expected_counter_delta"] {
                differences.push(probe.id);
            }
            *capture["actions"]
                .as_array_mut()
                .and_then(|rows| rows.last_mut())
                .ok_or_else(|| refuse("issued action row missing"))? = row;
        } else {
            return Err(refuse(
                "every enabled click probe requires its own observed argument",
            ));
        }
        let rows = capture["actions"]
            .as_array_mut()
            .ok_or_else(|| refuse("action rows missing"))?;
        let current = rows
            .last_mut()
            .ok_or_else(|| refuse("recorded action row missing"))?;
        current["transcript"] = json!({"path":format!("transcripts/action-{}.json",probe.id),"sha256":digest(&transcript)?});
        let attempted = rows
            .iter()
            .filter(|row| row["status"] != "unverified")
            .count();
        capture["input_actions_attempted"] = json!(attempted);
        write_json(&capture_path, capture)?;
    }
    let rows = capture["actions"]
        .as_array()
        .ok_or_else(|| refuse("action rows missing"))?;
    let unverified = rows
        .iter()
        .filter(|row| row["status"] == "unverified")
        .count();
    let acknowledged = rows
        .iter()
        .filter(|row| row["counter_acknowledged"] == true)
        .count();
    let fulfilled = rows
        .iter()
        .filter(|row| row["result"]["ok"] == true)
        .count();
    let refused = rows
        .iter()
        .filter(|row| row["result"]["ok"] == false)
        .count();
    let positive_controls = rows
        .iter()
        .filter(|row| row["positive_control"] == true)
        .all(|row| {
            row["reference_result_matches"] == true
                && row["reference_counter_matches"] == true
                && row["counter_acknowledged"] == true
        });
    capture["input_actions_performed"] = json!(acknowledged);
    capture["input_actions_with_counter_ack"] = json!(acknowledged);
    capture["input_actions_fulfilled"] = json!(fulfilled);
    capture["input_actions_refused"] = json!(refused);
    capture["input_actions_unverified"] = json!(unverified);
    capture["action_oracle_failures"] = json!(failures);
    capture["action_reference_differences"] = json!(differences);
    capture["action_positive_controls_verified"] = json!(positive_controls);
    capture["action_recording_completed"] = json!(true);
    capture["action_parity_verified"] =
        json!(failures.is_empty() && differences.is_empty() && unverified == 0);
    write_json(&capture_path, capture)?;
    if !failures.is_empty() || !differences.is_empty() {
        return Err(refuse(format!(
            "GTK action evidence has oracle failures {failures:?} or reference differences {differences:?}"
        )));
    }
    Ok(())
}

async fn bind_observation(
    repl: &Repl,
    bridge: Arc<Bridge>,
    role: &str,
    pid: u64,
    xid: u64,
    path: &Path,
) -> Recorded<Value> {
    let variable = if role == "target" {
        "gtkAppTarget"
    } else {
        "gtkAppOther"
    };
    let source = format!(
        "try {{ globalThis.{variable}=await cua.getApp({{windowId:{xid}}}); const state=await {variable}.getAXState({{emit:false}}); nodeRepl.write(JSON.stringify({{{MARKER}:{{ok:true,state}}}})); }} catch(error) {{ nodeRepl.write(JSON.stringify({{{MARKER}:{{ok:false,error:String(error)}}}})); }}"
    );
    let since = bridge.calls.lock().await.len();
    let value = cell(repl, bridge.clone(), source, path).await?;
    let state = value["state"]
        .as_str()
        .filter(|_| value["ok"] == true)
        .ok_or_else(|| refuse(format!("epoch observation failed for {role}: {value}")))?;
    let metadata = native_ax_receipt(&bridge, since, state, pid, xid).await?;
    native_aliases(&metadata)?;
    let receipt = json!({"window_id":xid,"state":state,"nativeAX":metadata});
    write_json(&path.with_extension("native-ax.json"), &receipt)?;
    Ok(receipt)
}

async fn record_epoch_lifetime(
    repl: &mut Option<Repl>,
    owner: &SessionOwner,
    bridge: Arc<Bridge>,
    fixture: &GtkFixture,
    capture: &mut Value,
    output: &Path,
) -> Recorded<()> {
    let before = fixture.oracles()?;
    let actions_before = bridge
        .calls
        .lock()
        .await
        .iter()
        .filter(|call| call["input"]["method"] == "action")
        .count();
    let capture_path = output.join("capture.json");
    let pid = capture["initial_fixture"]["pid"]
        .as_u64()
        .ok_or_else(|| refuse("epoch fixture PID missing"))?;
    capture["epoch_lifetime"] = json!({
        "kind":"candidate_epoch_recreation","official_js_reset_executed":false,
        "api":"Repl::close/new and SessionOwner::new_epoch after close_native; same logical owner and fixture",
        "input_actions_before":actions_before,"before":before,"completed":false,
    });
    for role in ["target", "other"] {
        let xid = capture["initial_fixture"]["windows"][role]["window_id"]
            .as_u64()
            .ok_or_else(|| refuse("epoch fixture XID missing"))?;
        let path = output
            .join("transcripts")
            .join(format!("{role}-rebind.json"));
        let observed = bind_observation(
            repl.as_ref().ok_or_else(|| refuse("REPL missing"))?,
            bridge.clone(),
            role,
            pid,
            xid,
            &path,
        )
        .await?;
        if native_aliases(&observed["nativeAX"])? != native_aliases(&capture["native_ax"][role])? {
            return Err(refuse(format!(
                "same-epoch rebind changed retained native aliases for {role}"
            )));
        }
        capture["epoch_lifetime"]["rebind"][role] = observed;
        write_json(&capture_path, capture)?;
    }
    if fixture.oracles()? != before {
        return Err(refuse(
            "same-epoch observation/rebind changed independent fixture state",
        ));
    }
    let old_repl = repl.take().ok_or_else(|| refuse("old REPL missing"))?;
    tokio::time::timeout(Duration::from_secs(15), old_repl.close()).await??;
    {
        let mut session = bridge.session.lock().await;
        let old = session.native_epoch();
        tokio::time::timeout(Duration::from_secs(15), session.close_native()).await??;
        let mut next = owner.new_epoch()?;
        next.configure(Desktop::Local, vec![], Language::En)?;
        let new_epoch = next.native_epoch();
        if old == new_epoch {
            return Err(refuse("epoch recreation reused its native epoch identity"));
        }
        capture["epoch_lifetime"]["old_native_epoch"] = json!(old.to_string());
        capture["epoch_lifetime"]["new_native_epoch"] = json!(new_epoch.to_string());
        *session = next;
    }
    *repl = Some(Repl::new(facade(), CellLimits::default())?);
    let cleared = cell(
        repl.as_ref().ok_or_else(|| refuse("new REPL missing"))?, bridge.clone(),
        format!("nodeRepl.write(JSON.stringify({{{MARKER}:{{cleared:typeof gtkAppTarget==='undefined'&&typeof gtkAppOther==='undefined'}}}}));"),
        &output.join("transcripts").join("epoch-globals-cleared.json"),
    ).await?;
    if cleared["cleared"] != true {
        return Err(refuse("new REPL retained old app bindings"));
    }
    capture["epoch_lifetime"]["old_bindings_cleared"] = json!(true);
    let mut all_ids = BTreeSet::new();
    let mut expected_count = 0;
    // Reverse observation order makes accidental map/counter retention visible.
    for role in ["other", "target"] {
        let xid = capture["initial_fixture"]["windows"][role]["window_id"]
            .as_u64()
            .ok_or_else(|| refuse("epoch fixture XID missing"))?;
        let path = output
            .join("transcripts")
            .join(format!("{role}-new-epoch.json"));
        let observed = bind_observation(
            repl.as_ref().ok_or_else(|| refuse("new REPL missing"))?,
            bridge.clone(),
            role,
            pid,
            xid,
            &path,
        )
        .await?;
        let initial = native_aliases(&capture["native_ax"][role])?;
        let current = native_aliases(&observed["nativeAX"])?;
        if initial.keys().collect::<BTreeSet<_>>() != current.keys().collect::<BTreeSet<_>>() {
            return Err(refuse(format!(
                "epoch control did not retain the same own-fixture native IDs for {role}"
            )));
        }
        if initial == current {
            return Err(refuse(format!(
                "reversed fresh epoch retained old aliases for {role}"
            )));
        }
        expected_count += current.len();
        for id in current.values() {
            all_ids.insert(id.parse::<u64>()?);
        }
        capture["epoch_lifetime"]["new_epoch"][role] = observed;
        write_json(&capture_path, capture)?;
    }
    if all_ids.first() != Some(&0) || all_ids.len() != expected_count {
        return Err(refuse(
            "new epoch aliases do not restart at zero with disjoint window IDs",
        ));
    }
    let after = fixture.oracles()?;
    let actions_after = bridge
        .calls
        .lock()
        .await
        .iter()
        .filter(|call| call["input"]["method"] == "action")
        .count();
    if before != after || actions_before != actions_after {
        return Err(refuse(
            "epoch recreation issued input or changed independent fixture state",
        ));
    }
    capture["epoch_lifetime"]["after"] = after;
    capture["epoch_lifetime"]["input_actions_after"] = json!(actions_after);
    capture["epoch_lifetime"]["same_native_ids_retained"] = json!(true);
    capture["epoch_lifetime"]["aliases_reassigned_from_zero"] = json!(true);
    capture["epoch_lifetime"]["completed"] = json!(true);
    write_json(&capture_path, capture)?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires Root's private task-owned Xvfb/DBus/WM GTK namespace and explicit fixture/output paths"]
async fn linux_native_gtk_observation_fixture() -> Recorded<()> {
    let allow_clicks = match std::env::var("MAKA_NATIVE_GTK_ACTIONS") {
        Ok(value) if value == "1" => true,
        Err(std::env::VarError::NotPresent) => false,
        _ => {
            return Err(refuse(
                "MAKA_NATIVE_GTK_ACTIONS must be absent or exactly 1",
            ));
        }
    };
    let focus_scroll_mode = held_focus_scroll::Mode::from_env()?;
    if focus_scroll_mode.is_some() && allow_clicks {
        return Err(refuse(
            "focus/scroll mode and legacy GTK actions are mutually exclusive",
        ));
    }
    let allow_clicks = allow_clicks
        || matches!(
            focus_scroll_mode,
            Some(held_focus_scroll::Mode::Focus | held_focus_scroll::Mode::Actions)
        );
    let allow_scroll = matches!(
        focus_scroll_mode,
        Some(held_focus_scroll::Mode::Scroll | held_focus_scroll::Mode::Actions)
    );
    if std::env::var("MAKA_NATIVE_GTK_PRIVATE_DESKTOP").as_deref() != Ok("task-owned-xvfb-dbus") {
        return Err(refuse(
            "explicit private-desktop invocation marker is required",
        ));
    }
    if std::env::var("HOME").as_deref() != Ok("/home/test")
        || std::env::var_os("DISPLAY").is_none()
        || std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_none()
    {
        return Err(refuse(
            "run only through Root's private bwrap/DBus/Xvfb recipe",
        ));
    }
    let source = required_path("MAKA_NATIVE_GTK_FIXTURE")?;
    let output = required_path("MAKA_NATIVE_GTK_OUTPUT")?;
    if !source.is_file() || !output.is_dir() || output.join("capture.json").exists() {
        return Err(refuse(
            "existing fixture and fresh private evidence directory are required",
        ));
    }
    let transcripts = output.join("transcripts");
    std::fs::create_dir(&transcripts)?;
    let executable = std::env::current_exe()?;
    let binary_hash = tokio::task::spawn_blocking(move || digest(&executable)).await??;
    let mut capture = json!({
        "kind":"controlled-candidate-gtk-public-ax-observation", "role":"candidate",
        "mode":if allow_clicks { "actions" } else { "observe" },
        "completed":false, "runtime_pid":std::process::id(), "input_actions_performed":0,
        "input_actions_attempted":0,
        "scope":if allow_clicks { "Public own-GTK element clicks using same-observation public/native IDs, followed by zero-input epoch checks" } else { "Public getApp/getAXState plus zero-input epoch checks for exact task-owned GTK PID/XIDs" },
        "input_actions_performed_semantics":"Input effects acknowledged by independent task-owned fixture counters and clicked events; attempts and unverified rows are separate",
        "input_identities":{"fixture_sha256":digest(&source)?,"binary_sha256":binary_hash,
            "compiled_facade_sha256":hex::encode(Sha256::digest(facade().as_bytes()))},
        "native_metadata_origin":"nativeAX comes from the same successful Bridge Observe result as each public state string; native IDs are metadata, never independent action authority.",
        "isolation_marker_limit":"Explicit invocation guard; actual namespace ownership comes from Root's retained private-desktop receipt.",
        "observations":[]
    });
    let capture_path = output.join("capture.json");
    write_json(&capture_path, &capture)?;
    let driver = Arc::new(Mutex::new(Driver::default()));
    let owner = SessionOwner::new(driver.clone());
    let mut session = owner.new_epoch()?;
    session.configure(Desktop::Local, vec![], Language::En)?;
    let bridge = Arc::new(Bridge {
        session: Arc::new(Mutex::new(session)),
        calls: Arc::new(Mutex::new(Vec::new())),
        allow_clicks,
        allow_scroll,
        record_typed_errors: focus_scroll_mode.is_some(),
    });
    let mut repl = Some(Repl::new(facade(), CellLimits::default())?);
    let mut fixture = GtkFixture::start(&source, &output.join("fixture"))?;
    let operation: Recorded<()> = async {
        let ready = if focus_scroll_mode.is_some() {
            held_focus_scroll::ready(&mut fixture).await?
        } else {
            fixture.ready().await?
        };
        capture["fixture_pid"] = ready["pid"].clone();
        capture["initial_fixture"] = ready.clone();
        write_json(&capture_path, &capture)?;
        for role in ["target", "other"] {
            let window = &ready["windows"][role];
            let xid = window["window_id"].as_u64().ok_or_else(|| refuse("known XID missing"))?;
            let variable = if role == "target" { "gtkAppTarget" } else { "gtkAppOther" };
            let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
            let mut attempt = 0;
            loop {
                let source = format!(
                    "try {{ globalThis.{variable}=await cua.getApp({{windowId:{xid}}}); nodeRepl.write(JSON.stringify({{{MARKER}:{{ok:true}}}})); }} catch(error) {{ nodeRepl.write(JSON.stringify({{{MARKER}:{{ok:false,error:String(error)}}}})); }}"
                );
                let path = transcripts.join(format!("{role}-bind-{attempt}.json"));
                let value = cell(repl.as_ref().ok_or_else(|| refuse("REPL missing"))?, bridge.clone(), source, &path).await?;
                capture["observations"].as_array_mut().ok_or_else(|| refuse("capture observations missing"))?
                    .push(json!({"role":role,"kind":"bind","result":value,"path":format!("transcripts/{role}-bind-{attempt}.json"),"sha256":digest(&path)?}));
                write_json(&capture_path, &capture)?;
                if value["ok"] == true { break; }
                if focus_scroll_mode.is_some() { return Err(refuse(format!("focus/scroll own GTK bind failed without retry: {role}"))); }
                if tokio::time::Instant::now() >= deadline { return Err(refuse(format!("own GTK window could not bind: {role}"))); }
                tokio::time::sleep(Duration::from_millis(50)).await;
                attempt += 1;
            }
            attempt = 0;
            loop {
                let source = format!(
                    "try {{ const state=await {variable}.getAXState({{emit:false}}); nodeRepl.write(JSON.stringify({{{MARKER}:{{ok:true,state}}}})); }} catch(error) {{ nodeRepl.write(JSON.stringify({{{MARKER}:{{ok:false,error:String(error)}}}})); }}"
                );
                let path = transcripts.join(format!("{role}-public-ax-{attempt}.json"));
                let receipt_start = bridge.calls.lock().await.len();
                let value = cell(repl.as_ref().ok_or_else(|| refuse("REPL missing"))?, bridge.clone(), source, &path).await?;
                capture["observations"].as_array_mut().ok_or_else(|| refuse("capture observations missing"))?
                    .push(json!({"role":role,"kind":"public_ax","result":value,"path":format!("transcripts/{role}-public-ax-{attempt}.json"),"sha256":digest(&path)?}));
                write_json(&capture_path, &capture)?;
                let sibling = if role == "target" { "other" } else { "target" };
                if let Some(state) = value["state"].as_str()
                    && value["ok"] == true
                    && state.contains(window["entry_name"].as_str().ok_or_else(|| refuse("entry label missing"))?)
                    && state.contains(window["button_name"].as_str().ok_or_else(|| refuse("button label missing"))?)
                    && !state.contains(ready["windows"][sibling]["title"].as_str().ok_or_else(|| refuse("sibling title missing"))?)
                {
                    let metadata = native_ax_receipt(&bridge, receipt_start, state, ready["pid"].as_u64().ok_or_else(|| refuse("fixture PID missing"))?, xid).await?;
                    native_aliases(&metadata)?;
                    capture["public_ax"][role] = json!(state);
                    capture["native_ax"][role] = metadata.clone();
                    write_json(&output.join(format!("{role}-public-ax.json")), &json!({"role":role,"window_id":xid,"state":state,"nativeAX":metadata}))?;
                    break;
                }
                if focus_scroll_mode.is_some() { return Err(refuse(format!("focus/scroll own GTK AX gate failed without retry: {role}"))); }
                if tokio::time::Instant::now() >= deadline { return Err(refuse(format!("own GTK AX labels/scope unavailable: {role}"))); }
                tokio::time::sleep(Duration::from_millis(50)).await;
                attempt += 1;
            }
        }
        if ready.get("large_ax").is_some() {
            capture["large_ax_positive_controls_verified"] = json!(false);
            write_json(&capture_path, &capture)?;
        }
        let target_aliases = native_aliases(&capture["native_ax"]["target"])?;
        let other_aliases = native_aliases(&capture["native_ax"]["other"])?;
        let target_raw_ids: BTreeSet<_> = target_aliases.values().collect();
        let other_raw_ids: BTreeSet<_> = other_aliases.values().collect();
        if !target_raw_ids.is_disjoint(&other_raw_ids) {
            return Err(refuse("all-node aliases overlap between own target and sibling windows"));
        }
        if !target_aliases.keys().collect::<BTreeSet<_>>().is_disjoint(&other_aliases.keys().collect::<BTreeSet<_>>()) {
            return Err(refuse("raw target and sibling trees share fixture native IDs"));
        }
        capture["raw_id_scope_verified"] = json!(true);
        if let Some(mode) = focus_scroll_mode {
            return held_focus_scroll::record(
                mode, repl.as_ref().ok_or_else(|| refuse("REPL missing"))?, bridge.clone(),
                &mut fixture, &ready, &mut capture, &output,
            ).await;
        }
        let large_buttons = large_ax_buttons(&ready, &capture["public_ax"], &capture["native_ax"])?;
        let mut deferred_id_scope_error = None;
        let late_button = if let Some(buttons) = &large_buttons {
            let button = buttons
                .iter()
                .max_by_key(|button| button.native_grid_ordinal)
                .filter(|button| button.raw_preorder >= 1000 && button.native_grid_ordinal >= 1000)
                .ok_or_else(|| refuse("large GTK has no correlated native grid button beyond raw preorder and eligible ordinal 1000"))?;
            capture["large_ax_validation"] = json!({
                "verified_button_count":buttons.len(),
                "each_label_exactly_once":true,
                "each_button_clickable":true,
                "complete_and_sibling_excluded":true,
                "fixture_controls_visible_mapped_sensitive_and_inside_client":true,
                "observed_buttons":buttons.iter().map(|button| json!({"name":button.name,"public_id":button.id,"native_id":button.native_id,"raw_preorder":button.raw_preorder,"native_grid_ordinal":button.native_grid_ordinal})).collect::<Vec<_>>(),
                "selected_late_button":{"name":button.name,"public_id":button.id,"public_line":button.row,"native_id":button.native_id,"raw_preorder":button.raw_preorder,"native_grid_ordinal":button.native_grid_ordinal},
                "selection":"Highest eligible native grid ordinal correlated to this Candidate public row; raw preorder and eligible ordinal both >=1000; no reference IDs or fixture creation order",
                "id_scope":{"verified":false,"status":"pending"}
            });
            write_json(&capture_path, &capture)?;
            let id_scope: Recorded<_> = (|| {
                let target = capture["public_ax"]["target"]
                    .as_str()
                    .ok_or_else(|| refuse("large GTK target public AX is missing"))?;
                let other = capture["public_ax"]["other"]
                    .as_str()
                    .ok_or_else(|| refuse("large GTK sibling public AX is missing"))?;
                Ok((public_indices(target)?, public_indices(other)?))
            })();
            let (target_indices, other_indices) = match id_scope {
                Ok(indices) => indices,
                Err(error) => {
                    capture["large_ax_validation"]["id_scope"] =
                        json!({"verified":false,"status":"invalid_public_indices","reason":error.to_string()});
                    write_json(&capture_path, &capture)?;
                    return Err(error);
                }
            };
            let overlapping_ids = target_indices.intersection(&other_indices).copied().collect::<Vec<_>>();
            capture["large_ax_validation"]["id_scope"] = json!({
                "verified":overlapping_ids.is_empty(),
                "status":if overlapping_ids.is_empty() { "verified" } else { "target_sibling_overlap" },
                "all_public_ids_unique_within_each_tree":true,
                "target_sibling_ids_disjoint":overlapping_ids.is_empty(),
                "overlapping_public_ids":overlapping_ids,
                "failure_deferred_for_own_target_actions":!overlapping_ids.is_empty() && allow_clicks,
                "reason":if overlapping_ids.is_empty() { Value::Null } else { json!("large GTK target and sibling public IDs overlap") }
            });
            write_json(&capture_path, &capture)?;
            if !overlapping_ids.is_empty() {
                let reason = format!(
                    "large GTK target and sibling public IDs overlap: {overlapping_ids:?}; complete1200-button AX evidence retained"
                );
                if allow_clicks {
                    deferred_id_scope_error = Some(reason);
                } else {
                    return Err(refuse(reason));
                }
            }
            capture["large_ax_positive_controls_verified"] = json!(overlapping_ids.is_empty());
            Some(button)
        } else {
            None
        };
        let oracles = fixture.oracles()?;
        for role in ["target", "other"] {
            if oracles[role]["clicks"] != 0 || oracles[role]["text"] != format!("seed-{role}")
                || !oracles[role]["saved"].is_null()
            {
                return Err(refuse(format!("observation altered independent GTK state: {role}")));
            }
        }
        if !oracles["events"].as_array().ok_or_else(|| refuse("fixture events missing"))?.is_empty() {
            return Err(refuse("observation-only run produced fixture input events"));
        }
        capture["before_actions"] = oracles.clone();
        capture["final_fixture"] = oracles;
        capture["public_label_scope_positive_controls_verified"] = json!(true);
        capture["observation_positive_controls_verified"] = json!(true);
        write_json(&capture_path, &capture)?;
        let action_result = if allow_clicks {
            record_actions(
                repl.as_ref().ok_or_else(|| refuse("REPL missing"))?,
                bridge.clone(),
                &fixture,
                &mut capture,
                &output,
                late_button,
            ).await
        } else {
            Ok(())
        };
        if let Some(scope_error) = deferred_id_scope_error {
            let action_recording_completed = capture["action_recording_completed"] == true;
            capture["action_parity_verified"] = json!(false);
            capture["large_ax_validation"]["id_scope"]["failure_reported_after_own_target_action_attempts"] = json!(true);
            capture["large_ax_validation"]["id_scope"]["own_target_action_recording_completed"] = json!(action_recording_completed);
            write_json(&capture_path, &capture)?;
            return Err(refuse(match action_result {
                Ok(()) => scope_error,
                Err(error) => format!("{scope_error}; GTK action recording also failed: {error}"),
            }));
        }
        action_result?;
        record_epoch_lifetime(&mut repl, &owner, bridge.clone(), &fixture, &mut capture, &output).await?;
        Ok(())
    }.await;
    if let Err(error) = &operation {
        capture["error"] = json!(error.to_string());
    }
    if focus_scroll_mode.is_some() {
        held_focus_scroll::retain_final_events(&fixture, &mut capture);
    } else {
        match fixture.oracles() {
            Ok(oracles) => capture["final_fixture"] = oracles,
            Err(error) => capture["fixture_oracle_error"] = json!(error.to_string()),
        }
    }
    capture["bridge_calls"] = json!(*bridge.calls.lock().await);
    let mut cleanup_errors = Vec::new();
    if let Some(repl) = repl.take() {
        match tokio::time::timeout(Duration::from_secs(15), repl.close()).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => cleanup_errors.push(format!("repl: {error}")),
            Err(error) => cleanup_errors.push(format!("repl timeout: {error}")),
        }
    }
    match tokio::time::timeout(Duration::from_secs(15), async {
        bridge.session.lock().await.close().await
    })
    .await
    {
        Ok(Ok(())) => {}
        Ok(Err(error)) => cleanup_errors.push(format!("session: {error}")),
        Err(error) => cleanup_errors.push(format!("session timeout: {error}")),
    }
    match tokio::time::timeout(Duration::from_secs(15), async {
        driver.lock().await.close().await
    })
    .await
    {
        Ok(Ok(())) => {}
        Ok(Err(error)) => cleanup_errors.push(format!("driver: {error}")),
        Err(error) => cleanup_errors.push(format!("driver timeout: {error}")),
    }
    match fixture.finish().await {
        Ok(status) => capture["fixture_exit"] = status,
        Err(error) => cleanup_errors.push(format!("fixture: {error}")),
    }
    capture["cleanup_errors"] = json!(cleanup_errors);
    capture["completed"] = json!(operation.is_ok() && cleanup_errors.is_empty());
    write_json(&capture_path, &capture)?;
    eprintln!("MAKA_NATIVE_GTK_CAPTURE {}", capture_path.display());
    operation?;
    if !cleanup_errors.is_empty() {
        return Err(refuse(format!("cleanup failed: {cleanup_errors:?}")));
    }
    Ok(())
}

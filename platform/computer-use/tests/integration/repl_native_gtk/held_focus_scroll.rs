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

//! Private opt-in focus/scroll evidence, sharing the existing GTK recorder.

use super::{
    Bridge, GtkFixture, MARKER, Recorded, appended_events, cell, digest, native_rows, public_row,
    refuse, required_path, write_json,
};
use maka_agent_facts::tools::{ToolError, ToolExecutor};
use maka_js_runtime::repl::Repl;
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    io::{self, Write},
    os::unix::process::ExitStatusExt,
    path::Path,
    sync::Arc,
    time::Duration,
};
use tokio_util::sync::CancellationToken;

pub(super) const VERSION: &str = "held-candidate-focus-scroll-20261027-v2";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Mode {
    Observe,
    Focus,
    Scroll,
    Actions,
}

impl Mode {
    pub(super) fn from_env() -> Recorded<Option<Self>> {
        match std::env::var("MAKA_NATIVE_GTK_FOCUS_SCROLL") {
            Err(std::env::VarError::NotPresent) => Ok(None),
            Ok(value) => match value.as_str() {
                "observe" => Ok(Some(Self::Observe)),
                "focus" => Ok(Some(Self::Focus)),
                "scroll" => Ok(Some(Self::Scroll)),
                "actions" => Ok(Some(Self::Actions)),
                _ => Err(refuse(
                    "MAKA_NATIVE_GTK_FOCUS_SCROLL must be observe, focus, scroll or actions",
                )),
            },
            Err(error) => Err(refuse(error.to_string())),
        }
    }

    pub(super) fn allows_input(self) -> bool {
        self != Self::Observe
    }

    fn name(self) -> &'static str {
        match self {
            Self::Observe => "observe",
            Self::Focus => "focus",
            Self::Scroll => "scroll",
            Self::Actions => "actions",
        }
    }
}

pub(super) fn configure_fixture(command: &mut tokio::process::Command) -> Recorded<()> {
    if Mode::from_env()?.is_none() {
        return Ok(());
    }
    for (option, variable) in [
        ("--event-decoder", "MAKA_NATIVE_GTK_EVENT_DECODER"),
        ("--base-source", "MAKA_NATIVE_GTK_BASE_SOURCE"),
    ] {
        let source = required_path(variable)?;
        if !source.is_file() {
            return Err(refuse(format!(
                "explicit fixture input is absent: {variable}"
            )));
        }
        command.arg(option).arg(source);
    }
    Ok(())
}

pub(super) async fn ready(fixture: &mut GtkFixture) -> Recorded<Value> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let path = fixture.output.join("ready.json");
    loop {
        match std::fs::read(&path) {
            Ok(bytes) => {
                let ready: Value = serde_json::from_slice(&bytes)?;
                ensure(
                    fixture.child.id().map(u64::from) == ready["pid"].as_u64(),
                    "fixture ready PID does not match owned child",
                )?;
                let mut ids = BTreeSet::new();
                for role in ["target", "other"] {
                    let window = &ready["windows"][role];
                    let xid = window["window_id"]
                        .as_u64()
                        .filter(|id| *id > 0)
                        .ok_or_else(|| refuse("fixture ready XID absent"))?;
                    ensure(
                        window["pid"] == ready["pid"] && ids.insert(xid),
                        "fixture ready identities differ or repeat",
                    )?;
                }
                return Ok(ready);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        ensure(
            fixture.child.try_wait()?.is_none(),
            "fixture exited before readiness",
        )?;
        if tokio::time::Instant::now() >= deadline {
            return Err(refuse("fixture ready publication timed out"));
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

pub(super) fn retain_final_events(fixture: &GtkFixture, capture: &mut Value) {
    match events(&fixture.output) {
        Ok(rows) => capture["fixture_events"] = json!(rows),
        Err(error) => capture["fixture_event_error"] = json!(error.to_string()),
    }
}

fn ensure(condition: bool, message: &str) -> Recorded<()> {
    if condition {
        Ok(())
    } else {
        Err(refuse(message))
    }
}

fn number(value: &Value, field: &str) -> Recorded<i64> {
    value[field]
        .as_i64()
        .ok_or_else(|| refuse(format!("fixture lacks integer {field}")))
}

fn events(output: &Path) -> Recorded<Vec<Value>> {
    let text = match std::fs::read_to_string(output.join("events.jsonl")) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    // The FIFO writer can be in the middle of its last JSONL line.
    let end = text.rfind('\n').map_or(0, |index| index + 1);
    let rows = text[..end]
        .lines()
        .filter(|line| !line.is_empty())
        .map(serde_json::from_str::<Value>)
        .collect::<Result<Vec<_>, _>>()?;
    for (index, row) in rows.iter().enumerate() {
        ensure(
            row["log_sequence"].as_u64() == Some(index as u64 + 1),
            "fixture log sequence is incomplete or repeats",
        )?;
    }
    Ok(rows)
}

fn require_value(value: &Value, ready: &Value) -> Recorded<()> {
    ensure(
        value["raw_sequence"].as_u64().is_some() && value["log_sequence"].as_u64().is_some(),
        "fixture ACK lacks event sequence boundaries",
    )?;
    ensure(
        value["filter"]["installed"] == true && value["filter"]["errors"] == 0,
        "fixture GDK filter is absent or reported errors",
    )?;
    for gate in [
        "clients_disjoint",
        "clients_on_screen",
        "scroll_pads_visible_and_inside_client",
    ] {
        ensure(
            value["layout"][gate] == true,
            "fixture actual layout gate failed",
        )?;
    }
    ensure(
        value["writer_errors"].as_array().is_some_and(Vec::is_empty),
        "fixture writer reported errors",
    )?;
    for role in ["target", "other"] {
        let actual = &value["x11"]["windows"][role];
        ensure(
            actual["window_id"] == ready["windows"][role]["window_id"]
                && actual["pid"] == ready["pid"],
            "fixture ACK changed known own-window identity",
        )?;
        ensure(
            value["models"][role]["pid"] == ready["pid"]
                && value["models"][role]["window_id"] == actual["window_id"],
            "fixture model identity differs from queried own window",
        )?;
    }
    ensure(
        value["x11"]["pointer"]["same_screen"] == true,
        "pointer is not on the task screen",
    )
}

async fn control(
    fixture: &mut GtkFixture,
    ready: &Value,
    output: &Path,
    capture: &mut Value,
    sequence: &mut u32,
    command: &str,
    detail: Value,
) -> Recorded<Value> {
    ensure(
        fixture.child.try_wait()?.is_none(),
        "owned GTK fixture has exited",
    )?;
    *sequence += 1;
    let id = format!("candidate-{:05}-{command}", *sequence);
    let mut request = detail;
    request["id"] = json!(id);
    request["command"] = json!(command);
    let input = matches!(command, "setup" | "filter-positive-control");
    let row_index = capture["fixture_controls"]
        .as_array()
        .ok_or_else(|| refuse("control rows absent"))?
        .len();
    capture["fixture_controls"].as_array_mut().ok_or_else(|| refuse("control rows absent"))?
        .push(json!({"id":id,"command":command,"request":request,"classification":if input {"setup-input"} else {"observation"},"status":"staged"}));
    write_json(&output.join("capture.json"), capture)?;
    let path = fixture
        .output
        .join("control/requests")
        .join(format!("{id}.json"));
    let reply_path = fixture
        .output
        .join("control/replies")
        .join(format!("{id}.json"));
    ensure(
        !path.exists() && !reply_path.exists(),
        "fresh fixture control identity required",
    )?;
    let temporary = path.with_extension("json.tmp");
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    serde_json::to_writer(&mut file, &request)?;
    file.write_all(b"\n")?;
    drop(file);
    std::fs::rename(temporary, path)?;
    capture["fixture_controls"][row_index]["status"] = json!("published");
    if input {
        let count = capture["setup_input_commands_published"]
            .as_u64()
            .unwrap_or(0);
        capture["setup_input_commands_published"] = json!(count + 1);
    }
    write_json(&output.join("capture.json"), capture)?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut missing_reads = 0_u64;
    let bytes = loop {
        match std::fs::read(&reply_path) {
            Ok(bytes) => break bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                missing_reads += 1;
                if tokio::time::Instant::now() >= deadline {
                    return Err(refuse(format!("fixture control reply timed out: {id}")));
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(error) => return Err(error.into()),
        }
    };
    let reply: Value = serde_json::from_slice(&bytes)?;
    ensure(
        reply["id"] == id && reply["command"] == command,
        "fixture control reply identity differs",
    )?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    let through_ack = loop {
        let mut rows = events(&fixture.output)?;
        if let Some(index) = rows
            .iter()
            .position(|row| row["event"] == "control-ack" && row["id"] == id)
        {
            rows.truncate(index + 1);
            break rows;
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(refuse(format!(
                "fixture FIFO writer did not flush ACK: {id}"
            )));
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let ack = through_ack
        .last()
        .ok_or_else(|| refuse("control ACK disappeared"))?;
    let relative = format!("controls/{id}.json");
    let transcript = output.join(&relative);
    write_json(
        &transcript,
        &json!({"request":request,"reply":reply,"ack_event":ack}),
    )?;
    capture["fixture_controls"][row_index]["status"] = json!(if reply["ok"] == true {
        "acknowledged"
    } else {
        "refused"
    });
    capture["fixture_controls"][row_index]["reply_missing_reads"] = json!(missing_reads);
    capture["fixture_controls"][row_index]["transcript"] =
        json!({"path":relative,"sha256":digest(&transcript)?});
    if input && reply["ok"] == true {
        let count = capture["setup_input_commands_acknowledged"]
            .as_u64()
            .unwrap_or(0);
        capture["setup_input_commands_acknowledged"] = json!(count + 1);
    }
    write_json(&output.join("capture.json"), capture)?;
    ensure(
        reply["ok"] == true,
        "fixture control refused; inspect retained reply",
    )?;
    require_value(&reply["value"], ready)?;
    Ok(json!({"id":id,"value":reply["value"],"ack_event":ack,"events":through_ack}))
}

fn require_setup(value: &Value, focus_role: &str) -> Recorded<()> {
    ensure(
        value["x11"]["focus"]["role"] == focus_role,
        "queried actual focus does not match setup",
    )?;
    let pointer = &value["x11"]["pointer"];
    let rect = &value["x11"]["windows"]["other"]["client_root_rect"];
    let x = number(pointer, "root_x")?;
    let y = number(pointer, "root_y")?;
    ensure(
        x == number(rect, "x")? + 20 && y == number(rect, "y")? + 20,
        "queried physical pointer does not match other-window parking",
    )?;
    let target = &value["x11"]["windows"]["target"]["client_root_rect"];
    let tx = number(target, "x")?;
    let ty = number(target, "y")?;
    ensure(
        !(tx <= x
            && x < tx + number(target, "width")?
            && ty <= y
            && y < ty + number(target, "height")?),
        "parked physical pointer entered target",
    )
}

fn same_focus_pointer(before: &Value, after: &Value) -> bool {
    before["x11"]["focus"]["window_id"] == after["x11"]["focus"]["window_id"]
        && [
            "root_id",
            "child_id",
            "root_x",
            "root_y",
            "state",
            "same_screen",
        ]
        .into_iter()
        .all(|key| before["x11"]["pointer"][key] == after["x11"]["pointer"][key])
}

fn correlated(
    capture: &Value,
    ready: &Value,
    snapshot: &Value,
    role: &str,
    kind: &str,
) -> Recorded<Value> {
    let window = &ready["windows"][role];
    let label = window[if kind == "save" {
        "button_name"
    } else {
        "scroll_pad_name"
    }]
    .as_str()
    .ok_or_else(|| refuse("fixture control label absent"))?;
    let state = capture["public_ax"][role]
        .as_str()
        .ok_or_else(|| refuse("public AX missing"))?;
    let public = state
        .lines()
        .filter_map(|line| public_row(line).ok().map(|(id, body)| (id, body, line)))
        .filter(|(_, body, _)| body.contains(label))
        .collect::<Vec<_>>();
    let rows = native_rows(&capture["native_ax"][role])?;
    let raw = rows
        .iter()
        .filter(|row| row["name"] == label)
        .collect::<Vec<_>>();
    ensure(
        public.len() == 1 && raw.len() == 1,
        "own control public/raw correlation is ambiguous",
    )?;
    let raw = raw[0];
    let public_id = public[0].0.to_string();
    ensure(
        raw["id"].as_str() == Some(public_id.as_str()),
        "public/raw control aliases differ",
    )?;
    let native = raw["native_id"]
        .as_str()
        .filter(|id| !id.is_empty() && !id.bytes().all(|byte| byte.is_ascii_digit()))
        .ok_or_else(|| refuse("fresh native identity absent"))?;
    let states = raw["states"]
        .as_array()
        .ok_or_else(|| refuse("native control states absent"))?;
    for required in ["showing", "visible"] {
        ensure(
            states.iter().any(|state| state == required),
            "fresh native control is not Showing/Visible",
        )?;
    }
    if kind == "save" {
        ensure(
            raw["actions"]
                .as_array()
                .is_some_and(|actions| actions.iter().any(|action| action == "click")),
            "fresh Save has no click action",
        )?;
    } else {
        ensure(
            raw["element_index"].is_null(),
            "ScrollPad unexpectedly has a Candidate actionable element index",
        )?;
        ensure(
            raw["actions"].is_null() || raw["actions"].as_array().is_some_and(Vec::is_empty),
            "ScrollPad unexpectedly has native actions",
        )?;
        ensure(
            !states.iter().any(|state| {
                [
                    "focusable",
                    "focused",
                    "editable",
                    "selected",
                    "checkable",
                    "checked",
                    "indeterminate",
                    "expanded",
                ]
                .iter()
                .any(|name| state == *name)
            }),
            "ScrollPad unexpectedly has indexable state",
        )?;
        let widget = &snapshot["widgets"][role]["scroll_pad"];
        ensure(
            widget["visible"] == true
                && widget["mapped"] == true
                && widget["can_focus"] == false
                && number(widget, "width")? > 0
                && number(widget, "height")? > 0,
            "passive ScrollPad widget controls failed",
        )?;
    }
    Ok(
        json!({"role":role,"kind":kind,"label":label,"public_id":public[0].0.to_string(),"public_line":public[0].2,"native_id":native,"raw_row":raw}),
    )
}

#[derive(Clone, Copy)]
enum Effect {
    Left,
    Right,
    Wheel,
    None,
}

struct Probe {
    id: &'static str,
    call: String,
    effect: Effect,
    expected_error: Option<&'static str>,
    already_focused: bool,
    no_native_input: bool,
    native_zero: bool,
}

fn probes(identities: &Value, mode: Mode) -> Recorded<Vec<Probe>> {
    let save = serde_json::to_string(&identities["target"]["save"]["native_id"])?;
    let pad = serde_json::to_string(&identities["target"]["scroll_pad"]["native_id"])?;
    let other = serde_json::to_string(&identities["other"]["scroll_pad"]["native_id"])?;
    let public = identities["target"]["scroll_pad"]["public_id"]
        .as_str()
        .ok_or_else(|| refuse("pad public ID missing"))?;
    let mut rows = Vec::new();
    let ordinary = |id, call, effect, already_focused| Probe {
        id,
        call,
        effect,
        expected_error: None,
        already_focused,
        no_native_input: false,
        native_zero: false,
    };
    if matches!(mode, Mode::Focus | Mode::Actions) {
        rows.push(ordinary(
            "focus-native-default-left",
            format!("await gtkAppTarget.click({save})"),
            Effect::Left,
            false,
        ));
        rows.push(Probe {
            id: "focus-native-pad-left-no-action",
            call: format!("await gtkAppTarget.click({pad})"),
            effect: Effect::None,
            expected_error: Some(
                "AT-SPI element does not expose actions; refresh get_window_state(): AT-SPI element does not implement Action",
            ),
            already_focused: false,
            no_native_input: true,
            native_zero: false,
        });
        rows.push(ordinary(
            "focus-native-pad-right",
            format!("await gtkAppTarget.click({pad},{{mouseButton:\"right\"}})"),
            Effect::Right,
            false,
        ));
        rows.push(ordinary(
            "focus-native-right",
            format!("await gtkAppTarget.click({save},{{mouseButton:\"right\"}})"),
            Effect::Right,
            false,
        ));
        rows.push(ordinary(
            "focus-native-left-already-focused",
            format!("await gtkAppTarget.click({save})"),
            Effect::Left,
            true,
        ));
    }
    if matches!(mode, Mode::Scroll | Mode::Actions) {
        rows.push(ordinary(
            "scroll-public-number-down-100",
            format!("await gtkAppTarget.scroll({public},\"down\",{{pixels:100}})"),
            Effect::Wheel,
            false,
        ));
        rows.push(ordinary(
            "scroll-native-d-100",
            format!("await gtkAppTarget.scroll({pad},\"d\",{{pixels:100}})"),
            Effect::Wheel,
            false,
        ));
        for (id, target) in [
            ("scroll-sibling-native-refusal", other),
            ("scroll-null-refusal", "null".into()),
        ] {
            rows.push(Probe {
                id,
                call: format!("await gtkAppTarget.scroll({target},\"down\",{{pixels:100}})"),
                effect: Effect::None,
                expected_error: Some(
                    "element is not in this window's AT-SPI tree; refresh get_window_state()",
                ),
                already_focused: false,
                no_native_input: true,
                native_zero: false,
            });
        }
        rows.push(Probe {
            id: "scroll-public-zero-early",
            call: format!("await gtkAppTarget.scroll({pad},\"down\",{{pixels:0}})"),
            effect: Effect::None,
            expected_error: Some("pixels must be a positive finite number."),
            already_focused: false,
            no_native_input: true,
            native_zero: false,
        });
        rows.push(Probe { id:"scroll-raw-zero-after-position", call:"Candidate Bridge Command::Action::LinuxScroll with same bound handle, native element_id and pixels:0".into(), effect:Effect::None,
            expected_error:Some("pixels must be non-zero"), already_focused:false, no_native_input:false, native_zero:true });
        rows.push(ordinary(
            "scroll-native-down-already-focused",
            format!("await gtkAppTarget.scroll({pad},\"down\",{{pixels:100}})"),
            Effect::Wheel,
            true,
        ));
    }
    if let Some(index) = rows.iter().position(|probe| probe.native_zero) {
        let terminal = rows.remove(index);
        rows.push(terminal);
    }
    Ok(rows)
}

fn model_delta(before: &Value, after: &Value) -> Recorded<Value> {
    let mut result = json!({});
    for role in ["target", "other"] {
        let a = &before["models"][role];
        let b = &after["models"][role];
        result[role] = json!({"clicks":number(b,"clicks")?-number(a,"clicks")?,
            "scroll_signals":number(b,"scroll_signals")?-number(a,"scroll_signals")?,
            "adjustment_changes":number(b,"adjustment_changes")?-number(a,"adjustment_changes")?,
            "adjustment_value":b["adjustment"]["value"].as_f64().unwrap_or(0.0)-a["adjustment"]["value"].as_f64().unwrap_or(0.0),
            "text_changed":a["text"]!=b["text"],"saved_before":a["saved"],"saved_after":b["saved"]});
    }
    Ok(result)
}

fn checks(probe: &Probe, row: &Value) -> Vec<Value> {
    let mut checks = Vec::new();
    let mut check = |name: &str, passed| checks.push(json!({"name":name,"passed":passed}));
    check(
        "API result matches expected success/refusal",
        row["result"]["ok"] == probe.expected_error.is_none(),
    );
    if let Some(expected) = probe.expected_error {
        check(
            "Refusal preserves expected native/facade text",
            if probe.native_zero {
                row["result"]["error"]["inner_message"].as_str() == Some(expected)
            } else {
                row["result"]["error"]["message"].as_str() == Some(expected)
            },
        );
    }
    let raw = row["raw_events"].as_array().map_or(&[][..], Vec::as_slice);
    let count = |kind: &str, button: Option<u64>| {
        raw.iter()
            .filter(|event| {
                event["window_role"] == "target"
                    && event["type"] == kind
                    && button.is_none_or(|button| event["button"].as_u64() == Some(button))
                    && event["send_event"] == true
            })
            .count()
    };
    let delta = &row["model_delta"];
    let no_effect = |role: &str| {
        delta[role]["clicks"] == 0
            && delta[role]["scroll_signals"] == 0
            && delta[role]["adjustment_changes"] == 0
            && delta[role]["text_changed"] == false
            && delta[role]["saved_before"] == delta[role]["saved_after"]
    };
    let stable = row["actual_focus_pointer_unchanged"] == true;
    let body: &[&str] = match probe.effect {
        Effect::Left | Effect::None => &[],
        Effect::Right => &[
            "enter",
            "motion",
            "enter",
            "motion",
            "button_press",
            "button_release",
        ],
        Effect::Wheel => &["enter", "motion", "button_press", "button_release"],
    };
    if !probe.no_native_input {
        let mut expected = Vec::new();
        if !probe.already_focused {
            expected.push("focus_in");
        }
        expected.extend_from_slice(body);
        if !probe.already_focused {
            expected.push("focus_out");
        }
        check(
            "Exact target synthetic event order matches retained Original own-fixture receipt",
            raw.len() == expected.len()
                && raw.iter().zip(expected).all(|(event, expected)| {
                    event["window_role"] == "target"
                        && event["send_event"] == true
                        && event["type"] == expected
                }),
        );
    }
    match probe.effect {
        Effect::Left => {
            check(
                "Only target Save acknowledged one click",
                delta["target"]["clicks"] == 1 && delta["other"]["clicks"] == 0,
            );
            check("Left preserved actual focus and pointer", stable);
        }
        Effect::Right => {
            check(
                "Target received exactly two synthetic motions",
                count("motion", None) == 2
                    && raw
                        .iter()
                        .filter(|event| {
                            event["window_role"] == "target" && event["type"] == "motion"
                        })
                        .count()
                        == 2,
            );
            check(
                "Target received one synthetic button3 pair",
                count("button_press", Some(3)) == 1 && count("button_release", Some(3)) == 1,
            );
            check(
                "Right has no default Save effect",
                delta["target"]["clicks"] == 0,
            );
            check("Right preserved actual focus and pointer", stable);
            if probe.id == "focus-native-pad-right" {
                check(
                    "Passive pad Right preserved the complete target widget model",
                    no_effect("target"),
                );
            }
        }
        Effect::Wheel => {
            check(
                "Target received one synthetic down detent pair",
                count("button_press", Some(5)) == 1 && count("button_release", Some(5)) == 1,
            );
            check("Scroll preserved actual focus and pointer", stable);
            check(
                "Target independently acknowledged scroll or adjustment",
                delta["target"]["scroll_signals"]
                    .as_i64()
                    .is_some_and(|value| value > 0)
                    || delta["target"]["adjustment_changes"]
                        .as_i64()
                        .is_some_and(|value| value > 0),
            );
        }
        Effect::None => {}
    }
    if !matches!(probe.effect, Effect::None) {
        check("Sibling widget model is unchanged", no_effect("other"));
        check(
            "Sibling received no pointer or button input",
            !raw.iter().any(|event| {
                event["window_role"] == "other"
                    && matches!(
                        event["type"].as_str(),
                        Some("enter" | "leave" | "motion" | "button_press" | "button_release")
                    )
            }),
        );
    }
    let focus = raw
        .iter()
        .filter(|event| {
            event["window_role"] == "target"
                && event["send_event"] == true
                && matches!(event["type"].as_str(), Some("focus_in" | "focus_out"))
        })
        .collect::<Vec<_>>();
    if probe.already_focused {
        check(
            "Already-focused call emitted no synthetic FocusIn/Out",
            focus.is_empty(),
        );
    } else if matches!(probe.effect, Effect::Left | Effect::Right | Effect::Wheel)
        || probe.native_zero
    {
        check(
            "Target synthetic FocusIn precedes FocusOut",
            focus
                .iter()
                .position(|event| event["type"] == "focus_in")
                .is_some_and(|index| {
                    focus[index + 1..]
                        .iter()
                        .any(|event| event["type"] == "focus_out")
                }),
        );
    }
    if probe.no_native_input {
        check("No raw input in bounded refusal window", raw.is_empty());
        check(
            "Refusal changed neither widget nor actual focus/pointer",
            no_effect("target") && no_effect("other") && stable,
        );
    }
    if probe.native_zero {
        check(
            "Native zero emitted no pointer or wheel receipts",
            !raw.iter().any(|event| {
                matches!(
                    event["type"].as_str(),
                    Some("enter" | "motion" | "button_press" | "button_release")
                )
            }),
        );
        check(
            "Native zero changed neither widget nor actual focus/pointer",
            no_effect("target") && no_effect("other") && stable,
        );
    }
    checks
}

fn aggregate_checks(capture: &mut Value) -> Recorded<bool> {
    let actions = capture["actions"]
        .as_array()
        .ok_or_else(|| refuse("action rows absent"))?;
    let failures = actions
        .iter()
        .flat_map(|row| {
            row["expectation_checks"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|check| check["passed"] != true)
                .map(|check| json!({"id":row["id"],"check":check["name"]}))
        })
        .collect::<Vec<_>>();
    let passed = failures.is_empty();
    capture["action_oracle_failures"] = json!(failures);
    capture["effect_expectations_verified"] = json!(passed);
    Ok(passed)
}

pub(super) fn tool_error(error: &ToolError) -> Value {
    let (kind, message) = match error {
        ToolError::Failed(message) => ("failed", message.as_str()),
        ToolError::Io { message, .. } => ("io", message.as_str()),
        ToolError::Persistence(message) => ("persistence", message.as_str()),
        ToolError::OutcomeUnknown(message) => ("outcomeUnknown", message.as_str()),
        ToolError::OperationUnknown { message, .. } => ("operationUnknown", message.as_str()),
        ToolError::OperationCleanupUnconfirmed { message, .. } => {
            ("operationCleanupUnconfirmed", message.as_str())
        }
        ToolError::CleanupUnconfirmed(message) => ("cleanupUnconfirmed", message.as_str()),
    };
    json!({"kind":kind,"inner_message":message,"message":error.to_string(),"debug":format!("{error:?}")})
}

fn uncertain_error(error: &Value) -> bool {
    matches!(
        error["kind"].as_str(),
        Some(
            "outcomeUnknown"
                | "operationUnknown"
                | "operationCleanupUnconfirmed"
                | "cleanupUnconfirmed"
        )
    )
}

fn wire_hold_ms(raw: &[Value]) -> Option<u32> {
    let press = raw
        .iter()
        .position(|event| event["type"] == "button_press")?;
    let release = raw[press + 1..].iter().find(|event| {
        event["type"] == "button_release"
            && event["window_id"] == raw[press]["window_id"]
            && event["button"] == raw[press]["button"]
    })?;
    let before = u32::try_from(raw[press]["x_timestamp_ms"].as_u64()?).ok()?;
    let after = u32::try_from(release["x_timestamp_ms"].as_u64()?).ok()?;
    Some(after.wrapping_sub(before))
}

pub(super) async fn record(
    mode: Mode,
    repl: &Repl,
    bridge: Arc<Bridge>,
    fixture: &mut GtkFixture,
    ready: &Value,
    capture: &mut Value,
    output: &Path,
) -> Recorded<()> {
    std::fs::create_dir(output.join("controls"))?;
    capture["kind"] = json!("controlled-candidate-held-gtk-focus-scroll");
    capture["mode"] = json!(mode.name());
    capture["focus_scroll_version"] = json!(VERSION);
    capture["scope"] = json!(
        "Existing public GTK recorder with explicit own-window focus/scroll probes; raw zero uses the existing Candidate Command/ToolExecutor boundary, not Sky API equivalence"
    );
    capture["fixture_controls"] = json!([]);
    capture["actions"] = json!([]);
    capture["recording_completed"] = json!(false);
    capture["settlement_verified"] = json!(false);
    capture["source_expectations_verified"] = json!(false);
    capture["case_order_adaptation"] = json!(
        "Candidate raw native-zero runs last so a typed uncertain result cannot precede another actuator; Original order remains separately recorded"
    );
    capture["setup_input_commands_published"] = json!(0);
    capture["setup_input_commands_acknowledged"] = json!(0);
    capture["input_actions_attempted"] = json!(0);
    capture["input_actions_performed"] = if mode == Mode::Observe {
        json!(0)
    } else {
        Value::Null
    };
    capture["input_actions_performed_semantics"] = json!(
        "No performed-input count is inferred from a fulfilled/refused call. Attempts, raw receipts, widget effects and setup input are recorded separately."
    );
    capture["observation_window"] = json!({"setup_settle_ms":200,"after_each_tool_result_ms":500,"semantics":"Bounded fixture ACK intervals; no later-event or server-generation timing claim"});
    let mut sequence = 0;
    let operation: Recorded<()> = async {
        let baseline = control(fixture,ready,output,capture,&mut sequence,"snapshot",json!({})).await?;
        let mut identities = json!({});
        for role in ["target","other"] {
            for kind in ["save","scroll_pad"] {
                identities[role][kind] = correlated(capture,ready,&baseline["value"],role,kind)?;
            }
            let sibling = if role=="target" {"other"} else {"target"};
            let state = capture["public_ax"][role].as_str().ok_or_else(|| refuse("public state missing"))?;
            for label in ["title","entry_name","button_name","scroll_pad_name"] {
                let label=ready["windows"][sibling][label].as_str().ok_or_else(|| refuse("sibling fixture label absent"))?;
                ensure(!state.contains(label) && !native_rows(&capture["native_ax"][role])?.iter().any(|row|row["name"]==label),
                    "own-window public/native AX contains sibling labels")?;
            }
            ensure(baseline["value"]["models"][role]["clicks"]==0 && baseline["value"]["models"][role]["text"]==format!("seed-{role}"),
                "observation changed own fixture Save/text controls")?;
        }
        capture["before_actions"] = baseline;
        capture["observed_identities"] = identities.clone();
        capture["observation_positive_controls_verified"] = json!(true);
        write_json(&output.join("capture.json"),capture)?;
        if mode.allows_input() {
            let filter=control(fixture,ready,output,capture,&mut sequence,"filter-positive-control",json!({"role":"target"})).await?;
            let receipt=&filter["value"]["filter_positive_control"];
            let rows=filter["events"].as_array().ok_or_else(||refuse("filter events absent"))?.iter()
                .filter(|event|event["event"]=="raw-xevent" && event["setup_probe_id"]==filter["id"]).collect::<Vec<_>>();
            ensure(receipt["event_mask"]==0 && receipt["xsend_status"].as_i64().is_some_and(|value|value>0)
                && receipt["observed_raw_sequence"].as_u64().is_some()
                && rows.len()==1 && rows[0]["raw_sequence"]==receipt["observed_raw_sequence"]
                && rows[0]["window_id"]==ready["windows"]["target"]["window_id"] && rows[0]["send_event"]==true && rows[0]["type"]=="motion",
                "mask0 filter positive control lacks actual in-process receipt")?;
            capture["filter_positive_control"] = filter;
        }
        let probes=probes(&identities,mode)?;
        let planned_count=probes.len();
        capture["planned_actions"]=json!(probes.iter().map(|probe|probe.id).collect::<Vec<_>>());
        for probe in probes {
            let focus_role=if probe.already_focused {"target"} else {"other"};
            let setup=control(fixture,ready,output,capture,&mut sequence,"setup",json!({"focus_role":focus_role,"pointer_role":"other","pointer_local":[20,20]})).await?;
            ensure(["focus_matches","pointer_matches","pointer_outside_target"].iter().all(|field|setup["value"]["setup_ack"][*field]==true),"fixture setup ACK failed")?;
            require_setup(&setup["value"],focus_role)?;
            tokio::time::sleep(Duration::from_millis(200)).await;
            let before=control(fixture,ready,output,capture,&mut sequence,"snapshot",json!({})).await?;
            require_setup(&before["value"],focus_role)?;
            let index=capture["actions"].as_array().ok_or_else(||refuse("action rows absent"))?.len();
            capture["actions"].as_array_mut().ok_or_else(||refuse("action rows absent"))?.push(json!({"id":probe.id,"call":probe.call,
                "api_layer":if probe.native_zero {"candidate-raw-command"} else {"public-App"},
                "setup":{"specification":{"focus_role":focus_role,"pointer_role":"other","pointer_local":[20,20]},"control_id":setup["id"],"acknowledged":setup["value"]["setup_ack"]},"before":before,"status":"issued"}));
            capture["input_actions_attempted"]=json!(index+1);
            write_json(&output.join("capture.json"),capture)?;
            let transcript=output.join("transcripts").join(format!("action-{}.json",probe.id));
            let call_start=bridge.calls.lock().await.len();
            let mut terminal_failure=None;
            let result=if probe.native_zero {
                let calls=bridge.calls.lock().await;
                let binding=calls.iter().rev().find(|call|call["input"]["method"]=="getApp" && call["result"]["ok"]==true
                    && call["result"]["value"]["binding"]["pid"]==ready["pid"]
                    && call["result"]["value"]["binding"]["windowId"]==ready["windows"]["target"]["window_id"])
                    .ok_or_else(||refuse("target bound handle receipt absent"))?;
                let input=json!({"method":"action","handle":binding["result"]["value"]["handle"],"action":{"kind":"linuxScroll",
                    "input":{"element_id":identities["target"]["scroll_pad"]["native_id"],"direction":"down","pixels":0}}});
                drop(calls);
                let cancellation=CancellationToken::new();
                let outcome=tokio::time::timeout(Duration::from_secs(20),bridge.invoke("cua".into(),input.clone(),cancellation.clone())).await;
                let result=match outcome {
                    Ok(Ok(value))=>json!({"ok":true,"value":value}),
                    Ok(Err(error))=>{
                        let metadata=tool_error(&error);
                        if uncertain_error(&metadata) { terminal_failure=Some(error.to_string()); }
                        json!({"ok":false,"error":metadata})
                    },
                    Err(error)=>{
                        cancellation.cancel();
                        terminal_failure=Some(format!("raw command timed out: {error}"));
                        json!({"ok":false,"request_error":error.to_string()})
                    },
                };
                write_json(&transcript,&json!({"api_layer":"candidate-raw-command","input":input,"result":result}))?;
                Ok(result)
            } else {
                let source=format!("try {{ const value={}; nodeRepl.write(JSON.stringify({{{MARKER}:{{ok:true,valueType:typeof value,value}}}})); }} catch(error) {{ nodeRepl.write(JSON.stringify({{{MARKER}:{{ok:false,error:{{name:error?.name,message:error?.message,string:String(error)}}}}}})); }}",probe.call);
                cell(repl,bridge.clone(),source,&transcript).await
            };
            let started=tokio::time::Instant::now();
            tokio::time::sleep(Duration::from_millis(500)).await;
            let after=control(fixture,ready,output,capture,&mut sequence,"snapshot",json!({})).await?;
            let new_events=appended_events(&before,&after)?.to_vec();
            let raw=new_events.iter().filter(|event|event["event"]=="raw-xevent").cloned().collect::<Vec<_>>();
            let call_receipts={ let calls=bridge.calls.lock().await; calls[call_start..].to_vec() };
            if let Some(call)=call_receipts.iter().find(|call|uncertain_error(&call["result"]["typed_error"])) {
                terminal_failure=Some(call["result"]["error"].as_str().unwrap_or("typed uncertain tool result").to_owned());
            }
            let row=&mut capture["actions"][index];
            row["after"]=after.clone();
            row["bridge_calls"]=json!(call_receipts);
            row["terminal_uncertainty"]=json!(terminal_failure);
            row["post_result_observation_ms"]=json!(started.elapsed().as_millis());
            row["events"]=json!(new_events);
            row["wire_hold_ms"]=json!(wire_hold_ms(&raw));
            row["wire_hold_semantics"]=json!("First same-button X timestamp difference, wrapping u32; no callback/server-generation timing equivalence or lower bound asserted");
            row["raw_events"]=json!(raw);
            row["model_delta"]=model_delta(&before["value"],&after["value"])?;
            row["actual_focus_pointer_unchanged"]=json!(same_focus_pointer(&before["value"],&after["value"]));
            match &result { Ok(value)=>row["result"]=value.clone(),Err(error)=>row["request_error"]=json!(error.to_string()) }
            row["transcript"]=json!({"path":format!("transcripts/action-{}.json",probe.id),"sha256":digest(&transcript)?});
            row["expectation_checks"]=json!(checks(&probe,row));
            row["status"]=json!(if result.is_ok() {"recorded"} else {"request-failed-observed"});
            capture["recording_completed"]=json!(index+1==planned_count);
            aggregate_checks(capture)?;
            write_json(&output.join("capture.json"),capture)?;
            result?; // Never retry or issue a second uncertain actuator.
            if let Some(reason)=terminal_failure {
                capture["terminal_uncertainty"]=json!({"id":probe.id,"reason":reason,"next_actuator_issued":false});
                write_json(&output.join("capture.json"),capture)?;
                return Err(refuse("typed uncertain result or timeout: no further actuator admitted"));
            }
        }
        ensure(aggregate_checks(capture)?,"candidate focus/scroll expectation failed; inspect retained observations")?;
        capture["settlement_verified"]=json!(true);
        capture["recording_completed"]=json!(true);
        capture["source_expectations_verified"]=json!(true);
        Ok(())
    }.await;
    if let Err(error) = &operation {
        capture["focus_scroll_error"] = json!(error.to_string());
    }
    let cleanup: Recorded<()> = async {
        capture["final_snapshot"] = control(
            fixture,
            ready,
            output,
            capture,
            &mut sequence,
            "snapshot",
            json!({}),
        )
        .await?;
        capture["fixture_shutdown"] = control(
            fixture,
            ready,
            output,
            capture,
            &mut sequence,
            "shutdown",
            json!({}),
        )
        .await?;
        let status = tokio::time::timeout(Duration::from_secs(10), fixture.child.wait()).await??;
        capture["fixture_shutdown_exit"] = json!({"code":status.code(),"signal":status.signal()});
        ensure(
            status.success(),
            "own GTK fixture did not exit successfully after acknowledged shutdown",
        )?;
        Ok(())
    }
    .await;
    if let Err(error) = &cleanup {
        capture["focus_scroll_cleanup_error"] = json!(error.to_string());
    }
    write_json(&output.join("capture.json"), capture)?;
    operation?;
    cleanup
}

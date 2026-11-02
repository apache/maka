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

//! The public plugin schemas describe the original strict PTY wire types.
use maka_agent_facts::terminal::TerminalScreen;
use maka_agent_facts::terminal::TerminalSize;
use maka_agent_facts::terminal::input::InputAction;
use maka_agent_facts::terminal::input::encode_controller_actions;
use serde_json::json;

#[test]
fn terminal_input_schema_preserves_strict_wire_shapes_and_live_encoding() {
    let schema = schemars::schema_for!(InputAction);
    let validator = jsonschema::validator_for(&serde_json::to_value(schema).unwrap()).unwrap();
    let size = TerminalSize::new(80, 24).unwrap();
    let modes = TerminalScreen::new(size).input;
    for (value, encoded) in [
        (json!({"type":"text","text":"中文😀"}), "中文😀"),
        (
            json!({"type":"paste","text":"a\r\nb\t"}),
            "\x1b[200~a\nb\t\x1b[201~",
        ),
        (json!({"type":"key","key":"c","modifiers":["ctrl"]}), "\x03"),
        (
            json!({"type":"key","key":"tab","modifiers":["shift"]}),
            "\x1b[Z",
        ),
        (json!({"type":"key","key":"arrow_up"}), "\x1b[A"),
        (
            json!({"type":"key","key":"f12","modifiers":["alt","ctrl"]}),
            "\x1b[24;7~",
        ),
        // An actual terminal without mouse tracking ignores pointer events.
        (
            json!({"type":"mouse","event":"press","x":0,"y":1,"button":"left"}),
            "",
        ),
        (json!({"type":"mouse","event":"move","x":0,"y":1}), ""),
        (
            json!({"type":"mouse","event":"scroll","x":0,"y":1,"direction":"up"}),
            "",
        ),
    ] {
        assert!(validator.is_valid(&value), "schema rejected {value}");
        let action: InputAction = serde_json::from_value(value).unwrap();
        let wire = serde_json::to_value(&action).unwrap();
        assert!(
            validator.is_valid(&wire),
            "schema rejected canonical output {wire}"
        );
        assert_eq!(serde_json::from_value::<InputAction>(wire).unwrap(), action);
        assert_eq!(
            encode_controller_actions(&[action], modes, size, true).unwrap(),
            encoded
        );
    }
    for value in [
        json!({"type":"text","text":""}),
        json!({"type":"text","text":"text\n"}),
        json!({"type":"text","text":"\x1b[31m"}),
        json!({"type":"text","text":"text","modifiers":[]}),
        json!({"type":"paste","text":"\x1b[201~"}),
        json!({"type":"paste","text":"\u{0085}"}),
        json!({"type":"key","key":"f13"}),
        json!({"type":"key","key":"enter\n"}),
        json!({"type":"key","key":"enter","modifiers":["ctrl","ctrl"]}),
        json!({"type":"key","key":"enter","modifiers":null}),
        json!({"type":"mouse","event":"move","x":-1,"y":0}),
        json!({"type":"mouse","event":"move","x":0.5,"y":0}),
        json!({"type":"mouse","event":"move","x":9007199254740992u64,"y":0}),
        json!({"type":"mouse","event":"move","x":0,"y":0,"button":null}),
        json!({"type":"mouse","event":"move","x":0,"y":0,"direction":null}),
    ] {
        assert!(!validator.is_valid(&value), "schema accepted {value}");
        assert!(serde_json::from_value::<InputAction>(value).is_err());
    }
}

#[test]
fn terminal_size_schema_carries_native_allocation_limits_in_both_directions() {
    let screen = TerminalScreen::new(TerminalSize::new(240, 100).unwrap());
    for schema in [
        schemars::schema_for!(TerminalScreen),
        schemars::generate::SchemaSettings::draft2020_12()
            .for_serialize()
            .into_generator()
            .into_root_schema_for::<TerminalScreen>(),
    ] {
        let validator = jsonschema::validator_for(&serde_json::to_value(schema).unwrap()).unwrap();
        let mut value = serde_json::to_value(&screen).unwrap();
        assert!(validator.is_valid(&value));
        for size in [
            json!({"cols":1,"rows":1}),
            json!({"cols":1025,"rows":1}),
            json!({"cols":80,"rows":0}),
            json!({"cols":80,"rows":1025}),
            json!({"cols":80.5,"rows":24}),
            json!({"cols":80,"rows":24,"unknown":true}),
        ] {
            value["size"] = size;
            assert!(!validator.is_valid(&value), "schema accepted {value}");
            assert!(serde_json::from_value::<TerminalScreen>(value.clone()).is_err());
        }
    }
}

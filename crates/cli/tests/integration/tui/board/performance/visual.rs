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
use alacritty_terminal::{
    Term,
    event::VoidListener,
    grid::Dimensions,
    index::{Column, Line},
    term::{Config, cell::Cell},
    vte::ansi,
};

pub(super) struct Visual {
    parser: ansi::Processor,
    term: Term<VoidListener>,
}

struct Size(TerminalSize);
impl Dimensions for Size {
    fn columns(&self) -> usize {
        self.0.cols().into()
    }
    fn screen_lines(&self) -> usize {
        self.0.rows().into()
    }
    fn total_lines(&self) -> usize {
        self.screen_lines()
    }
}

impl Visual {
    pub fn new(size: TerminalSize) -> Self {
        Self {
            parser: ansi::Processor::new(),
            term: Term::new(Config::default(), &Size(size), VoidListener),
        }
    }

    pub fn write(&mut self, mut text: &str, size: TerminalSize) {
        if self.term.columns() != usize::from(size.cols())
            || self.term.screen_lines() != usize::from(size.rows())
        {
            self.term.resize(Size(size));
        }
        // Match the existing Screen's UTF-8 boundary handling. The null listener
        // emits no terminal replies or clipboard effects from this observer.
        while !text.is_empty() {
            let end = text.floor_char_boundary(256.min(text.len()));
            self.parser.advance(&mut self.term, &text.as_bytes()[..end]);
            self.parser.stop_sync(&mut self.term);
            text = &text[end..];
        }
    }

    pub fn cells(&self, row: usize, col: usize, length: usize) -> Vec<Cell> {
        (col..col + length)
            .map(|x| self.term.grid()[Line(row as i32)][Column(x)].clone())
            .collect()
    }
}

fn evidence(cells: &[Cell]) -> Value {
    json!(
        cells
            .iter()
            .map(|cell| json!({"text":cell.c.to_string(),
        "foreground":format!("{:?}",cell.fg),"background":format!("{:?}",cell.bg),
        "flags":format!("{:?}",cell.flags)}))
            .collect::<Vec<_>>()
    )
}

pub(super) fn drag(
    timed: &mut timed::Timed,
    proxy: &proxy::DelayProxy,
    report: &mut report::Report,
    rtt: u64,
    hold: Option<&pending::gate::Hold>,
) {
    let (row, col) = timed::position(&timed.screen(), ANCHOR);
    let baseline = timed.visual.as_ref().unwrap().cells(row, col, ANCHOR.len());
    assert_eq!(
        baseline.iter().map(|cell| cell.c).collect::<String>(),
        ANCHOR
    );
    let selected = |timed: &timed::Timed, count: usize| {
        let cells = timed
            .visual
            .as_ref()
            .unwrap()
            .cells(row, col, baseline.len());
        cells
            .iter()
            .zip(&baseline)
            .enumerate()
            .all(|(index, (cell, original))| {
                cell.c == original.c && (cell.bg != original.bg) == (index < count)
            })
    };
    let press = format!(
        "\x1b[<0;{};{}M\x1b[<32;{};{}M",
        col + 1,
        row + 1,
        col + 5,
        row + 1
    );
    let before_screen = timed.screen();
    let mut action = || timed.observed(press.as_bytes(), |t| selected(t, 5));
    let setup = match hold {
        Some(hold) => hold.during(proxy, action),
        None => action(),
    };
    report.emit(
        json!({"kind":"drag_setup","stage":"press","added_rtt_ms":rtt,
        "pending":hold.is_some(),"input_sgr":press,"sample":setup,
        "screen_before":before_screen,"screen_after":timed.screen(),
        "selection":{"row":row,"column":col,"selected_cells":5,
            "baseline":evidence(&baseline),"before":evidence(&baseline),
            "after":evidence(&timed.visual.as_ref().unwrap().cells(row,col,baseline.len()))}}),
    );
    assert!(
        setup["error"].is_null(),
        "press failure retained as drag_setup"
    );
    for index in 0..report.warmup() + report.count() {
        for (suffix, count) in [("extend", 12), ("shrink", 5)] {
            let before = timed
                .visual
                .as_ref()
                .unwrap()
                .cells(row, col, baseline.len());
            let bytes = format!("\x1b[<32;{};{}M", col + count, row + 1);
            let mut sample = || timed.observed(bytes.as_bytes(), |t| selected(t, count));
            let mut value = match hold {
                Some(hold) => hold.during(proxy, sample),
                None => sample(),
            };
            value["selection"] = json!({"row":row,"column":col,"selected_cells":count,
                "baseline":evidence(&baseline),"before":evidence(&before),
                "after":evidence(&timed.visual.as_ref().unwrap().cells(row,col,baseline.len()))});
            let operation = format!(
                "{}_drag_{suffix}",
                if hold.is_some() { "pending" } else { "idle" }
            );
            if !report.sample(rtt, &operation, index, value) {
                return;
            }
        }
    }
    timed
        .tui
        .send(format!("\x1b[<0;{};{}m", col + 5, row + 1).as_bytes());
    let before_screen = timed.screen();
    let before = timed
        .visual
        .as_ref()
        .unwrap()
        .cells(row, col, baseline.len());
    let mut action = || timed.observed(b"\x1b", |t| selected(t, 0));
    let cleared = match hold {
        Some(hold) => hold.during(proxy, action),
        None => action(),
    };
    report.emit(
        json!({"kind":"drag_setup","stage":"clear","added_rtt_ms":rtt,
        "pending":hold.is_some(),"input_sgr":"\u{1b}","sample":cleared,
        "screen_before":before_screen,"screen_after":timed.screen(),
        "selection":{"row":row,"column":col,"selected_cells":0,
            "baseline":evidence(&baseline),"before":evidence(&before),
            "after":evidence(&timed.visual.as_ref().unwrap().cells(row,col,baseline.len()))}}),
    );
    assert!(
        cleared["error"].is_null(),
        "clear failure retained as drag_setup"
    );
}

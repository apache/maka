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
impl Cursor {
    pub(super) fn checkpoint(&mut self) {
        let w = &self.writer;
        self.checkpoints.push(Checkpoint {
            operation: self.operation,
            offset: self.offset,
            label: self.label,
            width: w.width,
            indent: w.indent,
            rows: w.rows,
            solid_rows: w.solid_rows,
            last_source: w.last_source,
            last_nonempty: w.last_nonempty,
            logical_line: w.logical_line,
            logical_nonempty: w.logical_nonempty,
            logical_len: w.logical_len,
            style: w.style,
            word_wrap: w.word_wrap,
            band: w.band.clone(),
        });
        if self.checkpoints.len() > 256 {
            let mut index = 0;
            self.checkpoints.retain(|_| {
                let keep = index % 2 == 0;
                index += 1;
                keep
            });
            self.stride *= 2;
        }
    }
    pub(super) fn restore(&mut self, point: Checkpoint) {
        self.operation = point.operation;
        self.offset = point.offset;
        self.label = point.label;
        self.complete = false;
        self.active_table = None;
        let mut writer = Writer::new(point.width as u16);
        writer.window = Some(self.window.clone());
        writer.retain_text = false;
        writer.colors = self.document.colors;
        writer.max_grapheme = self.document.max_grapheme;
        writer.indent = point.indent;
        writer.rows = point.rows;
        writer.solid_rows = point.solid_rows;
        writer.last_source = point.last_source;
        writer.last_nonempty = point.last_nonempty;
        writer.logical_line = point.logical_line;
        writer.logical_nonempty = point.logical_nonempty;
        writer.logical_len = point.logical_len;
        writer.style = point.style;
        writer.word_wrap = point.word_wrap;
        writer.band = point.band;
        self.writer = writer;
    }
}

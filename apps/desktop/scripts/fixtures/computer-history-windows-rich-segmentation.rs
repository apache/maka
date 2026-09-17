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

// Names mirror Windows APIs used by the extracted code. Its unsafe blocks are
// intentionally retained, but these adapters do not call native COM or the OS.
#![allow(non_snake_case, non_upper_case_globals, unused_unsafe)]
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

mod windows {
    pub mod core {
        #[derive(Clone, Copy, Debug, PartialEq)]
        pub struct HRESULT(pub i32);
        #[derive(Debug)]
        pub struct Error(HRESULT);
        impl Error {
            pub fn from_hresult(value: HRESULT) -> Self {
                Self(value)
            }
            pub fn code(&self) -> HRESULT {
                self.0
            }
        }
        pub type Result<T> = std::result::Result<T, Error>;
    }
}
const MAX_BYTES: usize = 8192;
const UIA_E_TIMEOUT: u32 = 0x80131505;
const UIA_E_NOTSUPPORTED: u32 = 0x80040204;
const TextPatternRangeEndpoint_Start: i32 = 0;
const TextPatternRangeEndpoint_End: i32 = 1;
const UIA_IsHiddenAttributeId: i32 = 40013;
const VT_BOOL: i32 = 11;
struct Variant {
    tag: i32,
    Anonymous: VariantA,
}
struct VariantA {
    Anonymous: VariantB,
}
struct VariantB {
    Anonymous: VariantC,
}
struct VariantC {
    boolVal: (i16,),
}
impl Variant {
    fn vt(&self) -> i32 {
        self.tag
    }
    fn from(value: i32) -> Self {
        Self {
            tag: if value == 0 || value == 1 {
                VT_BOOL
            } else {
                13
            },
            Anonymous: VariantA {
                Anonymous: VariantB {
                    Anonymous: VariantC {
                        boolVal: (if value == 0 { 0 } else { -1 },),
                    },
                },
            },
        }
    }
}
fn nonhidden_attribute(value: &Variant) -> bool {
    value.vt() == VT_BOOL && value.Anonymous.Anonymous.Anonymous.boolVal.0 == 0
}
#[derive(Default)]
struct CaptureFailures {
    timed_out: Cell<bool>,
    provider_failed: Cell<bool>,
}
#[derive(Default)]
struct Script {
    document: RefCell<(Vec<u16>, Vec<bool>)>,
    find_calls: Cell<usize>,
    text_reads: Cell<usize>,
    calls: Cell<usize>,
    viewport_reads: Cell<usize>,
    fragment_true: Cell<bool>,
    find_fault: Cell<i32>,
    attribute_unknown: Cell<bool>,
    move_fault: Cell<i32>,
    move_at: Cell<usize>,
    moves: Cell<usize>,
    wrong_owner: Cell<bool>,
    mutate_after_text: Cell<i32>,
    expire_find: Cell<bool>,
    fail_find: Cell<u32>,
    expire_at: Cell<usize>,
    drift_after_reads: Cell<usize>,
    expired: Cell<bool>,
    revoked: Cell<bool>,
    deny: Cell<bool>,
}
struct Target {
    script: Rc<Script>,
    failures: CaptureFailures,
}
impl Target {
    fn within_deadline(&self) -> bool {
        if self.script.expired.get() {
            self.failures.timed_out.set(true);
            false
        } else {
            true
        }
    }
    fn current(&self) -> Option<()> {
        (self.within_deadline() && !self.script.revoked.get()).then_some(())
    }
    /* TARGET */
}
#[derive(Clone)]
struct IUIAutomationElement;
struct NonhiddenText {
    runs: Vec<NonhiddenRun>,
}
struct NonhiddenRun {
    visible_index: usize,
    range: IUIAutomationTextRange,
    text: Vec<u16>,
    maximum: i32,
}
struct VisibleText {
    element: IUIAutomationElement,
    pattern: Pattern,
    ranges: Vec<IUIAutomationTextRange>,
    nonhidden: Option<NonhiddenText>,
}
struct Pattern {
    script: Rc<Script>,
}
impl Pattern {
    fn GetVisibleRanges(&self) -> windows::core::Result<Ranges> {
        self.script
            .viewport_reads
            .set(self.script.viewport_reads.get() + 1);
        let moved = self.script.drift_after_reads.get() > 0
            && self.script.text_reads.get() >= self.script.drift_after_reads.get();
        Ok(Ranges(vec![IUIAutomationTextRange::new(
            &self.script,
            if moved { 1 } else { 0 },
            self.script.document.borrow().0.len() as i32,
        )]))
    }
}
struct Ranges(Vec<IUIAutomationTextRange>);
impl Ranges {
    fn Length(&self) -> windows::core::Result<i32> {
        Ok(self.0.len() as i32)
    }
    fn GetElement(&self, index: i32) -> windows::core::Result<IUIAutomationTextRange> {
        Ok(self.0[index as usize].clone())
    }
}
#[derive(Clone)]
struct IUIAutomationTextRange {
    ends: Rc<Cell<(i32, i32)>>,
    script: Rc<Script>,
}
impl IUIAutomationTextRange {
    fn new(script: &Rc<Script>, start: i32, end: i32) -> Self {
        Self {
            ends: Rc::new(Cell::new((start, end))),
            script: script.clone(),
        }
    }
    fn GetEnclosingElement(&self) -> windows::core::Result<IUIAutomationElement> {
        Ok(IUIAutomationElement)
    }
    fn CompareEndpoints(
        &self,
        endpoint: i32,
        other: &Self,
        other_endpoint: i32,
    ) -> windows::core::Result<i32> {
        let n = self.script.calls.get() + 1;
        self.script.calls.set(n);
        if self.script.expire_at.get() == n {
            self.script.expired.set(true);
        }
        let position = |range: &Self, e| {
            if e == 0 {
                range.ends.get().0
            } else {
                range.ends.get().1
            }
        };
        Ok(position(self, endpoint) - position(other, other_endpoint))
    }
    fn GetAttributeValue(&self, _: i32) -> windows::core::Result<Variant> {
        if self.script.attribute_unknown.get() {
            return Ok(Variant::from(3));
        }
        let document = self.script.document.borrow();
        let (start, end) = self.ends.get();
        let flags = &document.1[start as usize..end as usize];
        Ok(Variant::from(if flags.iter().all(|v| !v) {
            0
        } else if flags.iter().all(|v| *v) {
            1
        } else {
            2
        }))
    }
    fn Clone(&self) -> windows::core::Result<Self> {
        Ok(Self::new(
            &self.script,
            self.ends.get().0,
            self.ends.get().1,
        ))
    }
    // FindAttribute promises a matching subset, not a maximal run. Deliberately
    // fragment false matches so a return to per-match reading fails behaviorally.
    fn FindAttribute(&self, value: bool) -> windows::core::Result<Option<Self>> {
        self.script.find_calls.set(self.script.find_calls.get() + 1);
        if self.script.expire_find.get() {
            self.script.expired.set(true);
        }
        if self.script.fail_find.get() != 0 {
            return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                self.script.fail_find.get() as i32,
            )));
        }
        let (start, end) = self.ends.get();
        match self.script.find_fault.get() {
            1 => return Ok(Some(Self::new(&self.script, start, start))),
            2 => return Ok(Some(Self::new(&self.script, start - 1, end))),
            3 => return Ok(Some(Self::new(&self.script, start, end + 1))),
            4 => return Ok(None),
            _ => (),
        }
        let document = self.script.document.borrow();
        let hidden = &document.1;
        let Some(first) = (start..end).find(|i| hidden[*i as usize] == value) else {
            return Ok(None);
        };
        let last = if !value || self.script.fragment_true.get() {
            first + 1
        } else {
            (first..end)
                .find(|i| hidden[*i as usize] != value)
                .unwrap_or(end)
        };
        Ok(Some(Self::new(&self.script, first, last)))
    }
    fn MoveEndpointByRange(
        &self,
        endpoint: i32,
        other: &Self,
        other_endpoint: i32,
    ) -> windows::core::Result<()> {
        let n = self.script.moves.get() + 1;
        self.script.moves.set(n);
        let fault = if self.script.move_at.get() == 0 || self.script.move_at.get() == n {
            self.script.move_fault.get()
        } else {
            0
        };
        if fault == 1 {
            return Ok(());
        }
        let at = if other_endpoint == 0 {
            other.ends.get().0
        } else {
            other.ends.get().1
        };
        let (mut start, mut end) = self.ends.get();
        if endpoint == 0 {
            start = at;
            if start > end {
                end = start;
            }
        } else {
            end = at;
            if end < start {
                start = end;
            }
        }
        if fault == 2 {
            end += 1;
        }
        self.ends.set((start, end));
        Ok(())
    }
    fn GetText(&self, maximum: i32) -> windows::core::Result<Vec<u16>> {
        let (start, end) = self.ends.get();
        let mut document = self.script.document.borrow_mut();
        let (text, hidden) = &mut *document;
        assert!(
            start >= 0 && end >= start && end as usize <= text.len(),
            "GetText outside range"
        );
        assert!(
            hidden[start as usize..end as usize].iter().all(|v| !v),
            "GetText leaked hidden content"
        );
        self.script.text_reads.set(self.script.text_reads.get() + 1);
        let value = text[start as usize..end.min(start + maximum) as usize].to_vec();
        match self.script.mutate_after_text.get() {
            1 => hidden[start as usize] = true,
            2 => self.script.deny.set(true),
            3 => self.script.revoked.set(true),
            4 => self.script.expired.set(true),
            5 => self.ends.set((end, end)),
            6 => text[start as usize] = 88,
            _ => (),
        }
        Ok(value)
    }
}
struct Capture {
    target: Target,
    visible_text: Vec<VisibleText>,
    text_limit: usize,
    text: String,
}
impl Capture {
    fn document(parts: &[(&str, bool)]) -> Self {
        let script = Rc::new(Script::default());
        for (text, hidden) in parts {
            let units: Vec<_> = text.encode_utf16().collect();
            script
                .document
                .borrow_mut()
                .1
                .extend(std::iter::repeat_n(*hidden, units.len()));
            script.document.borrow_mut().0.extend(units);
        }
        Self {
            target: Target {
                script,
                failures: CaptureFailures::default(),
            },
            visible_text: Vec::new(),
            text_limit: 8192,
            text: String::new(),
        }
    }
    fn read<T>(&self, read: impl FnOnce() -> windows::core::Result<T>) -> Option<T> {
        self.target.read(read)
    }
    fn rich_element_current(&self, _: &IUIAutomationElement, _: &NonhiddenText) -> Option<()> {
        (!self.target.script.deny.get()).then_some(())
    }
    // Identity is a deterministic admission result, not an emulation of COM
    // identity/PID/HWND/password/ancestry validation.
    fn same_element(
        &self,
        _: Option<&IUIAutomationElement>,
        _: Option<&IUIAutomationElement>,
    ) -> Option<()> {
        (!self.target.script.wrong_owner.get()).then_some(())
    }
    fn root_current(&self) -> Option<()> {
        self.target.current()
    }
    fn scope_current(&self) -> Option<()> {
        Some(())
    }
    fn visible(&self, _: &IUIAutomationElement) -> Option<bool> {
        (!self.target.script.deny.get()).then_some(true)
    }
    /* CHECKS */
    fn acquire(&mut self) -> Option<Option<String>> {
        let element = &IUIAutomationElement;
        let mut nonhidden = NonhiddenText { runs: Vec::new() };
        let pattern = Pattern {
            script: self.target.script.clone(),
        };
        let ranges = self.read(|| pattern.GetVisibleRanges())?;
        let count = self.read(|| ranges.Length())?;
        /* ACQUISITION */
    }
}
/* HELPERS */

#[test]
fn fragmented_false_body_a_hidden_tail_is_coalesced() {
    let body = "SYNTHETIC_BODY_A_complete_visible_prefix";
    let mut c = Capture::document(&[(body, false), ("SECRET", true)]);
    let result = c.acquire().flatten().unwrap();
    println!(
        "body_tail: searches={} witnesses={} reads={}",
        c.target.script.find_calls.get(),
        c.visible_text[0].nonhidden.as_ref().unwrap().runs.len(),
        c.target.script.text_reads.get()
    );
    assert_eq!(result, body);
    assert_eq!(c.visible_text[0].nonhidden.as_ref().unwrap().runs.len(), 1);
    assert_eq!(c.target.script.text_reads.get(), 1);
    assert!(c.final_visible_text_check().is_some());
}
#[test]
fn whole_visible_and_leading_middle_trailing_multiple_hidden_spans() {
    for parts in [
        vec![("0123456789abcdefghijklmnopqrstuvwxyz", false)],
        vec![("H", true), ("alpha", false)],
        vec![("alpha", false), ("H", true), ("beta", false)],
        vec![("alpha", false), ("H", true)],
        vec![
            ("H", true),
            ("alpha", false),
            ("HH", true),
            ("beta", false),
            ("H", true),
        ],
        vec![("HHH", true)],
    ] {
        let expected = parts
            .iter()
            .filter(|(_, h)| !h)
            .map(|(s, _)| *s)
            .collect::<Vec<_>>()
            .join("\n");
        let mut c = Capture::document(&parts);
        assert_eq!(c.acquire().flatten().as_deref(), Some(expected.as_str()));
        assert_eq!(
            c.target.script.text_reads.get(),
            parts.iter().filter(|(_, h)| !h).count()
        );
        assert!(c.final_visible_text_check().is_some());
    }
}
#[test]
fn invalid_missing_delimiter_unknown_attribute_and_corrupt_moves_never_read() {
    for fault in 1..=4 {
        let mut c = Capture::document(&[("alpha", false), ("hidden", true)]);
        c.target.script.find_fault.set(fault);
        assert!(c.acquire().flatten().is_none_or(|text| text.is_empty()));
        assert_eq!(c.target.script.text_reads.get(), 0);
    }
    for mode in 0..=2 {
        let mut c = Capture::document(&[("alpha", false), ("H", true)]);
        c.target.script.attribute_unknown.set(mode == 0);
        c.target.script.move_fault.set(mode);
        assert!(c.acquire().is_none());
        assert_eq!(c.target.script.text_reads.get(), 0);
    }
}
#[test]
fn provider_errors_and_search_expiry_remain_fail_closed_and_classified() {
    for code in [UIA_E_TIMEOUT, UIA_E_NOTSUPPORTED, 0x80004005] {
        let mut c = Capture::document(&[("alpha", false), ("H", true)]);
        c.target.script.fail_find.set(code);
        assert!(c.acquire().is_none());
        assert_eq!(c.target.failures.timed_out.get(), code == UIA_E_TIMEOUT);
        assert_eq!(c.target.failures.provider_failed.get(), code == 0x80004005);
        assert_eq!(c.target.script.text_reads.get(), 0);
    }
    let mut c = Capture::document(&[("alpha", false), ("H", true)]);
    c.target.script.expire_find.set(true);
    assert!(c.acquire().is_none());
    assert!(c.target.failures.timed_out.get());
    assert_eq!(c.target.script.text_reads.get(), 0);
}
#[test]
fn later_cursor_advance_corruption_discards_the_already_read_prefix() {
    for fault in 1..=2 {
        let mut c = Capture::document(&[("alpha", false), ("H", true), ("tail", false)]);
        c.target.script.move_fault.set(fault);
        c.target.script.move_at.set(2);
        assert!(c.acquire().is_none());
        assert_eq!(c.target.script.moves.get(), 2);
        assert_eq!(c.target.script.text_reads.get(), 1);
        assert!(
            c.visible_text.is_empty(),
            "failed capture must not publish a witness"
        );
    }
    let mut c = Capture::document(&[("BODY_A", false)]);
    c.target.script.wrong_owner.set(true);
    assert!(c.acquire().is_none());
    assert_eq!(c.target.script.text_reads.get(), 0);
}
#[test]
fn mutation_during_read_discards_capture_or_fails_final_witness() {
    for mode in 1..=6 {
        let mut c = Capture::document(&[("alpha", false), ("H", true)]);
        c.target.script.mutate_after_text.set(mode);
        let result = c.acquire();
        assert!(
            result.is_none() || c.final_visible_text_check().is_none(),
            "mutation mode {mode}"
        );
    }
}
#[test]
fn hidden_fragment_scan_and_raw_whitespace_budget_are_bounded() {
    let mut c = Capture::document(&[(&"H".repeat(64), true), ("BODY_A", false)]);
    c.target.script.fragment_true.set(true);
    assert_eq!(c.acquire().flatten().as_deref(), Some(""));
    assert_eq!(c.target.script.find_calls.get(), 16);
    assert_eq!(c.target.script.text_reads.get(), 0);
    let mut c = Capture::document(&[(&" ".repeat(64), false), ("H", true), ("BODY_A", false)]);
    c.text_limit = 8;
    assert!(c.acquire().is_some());
    assert_eq!(c.target.script.text_reads.get(), 1);
    let run = &c.visible_text[0].nonhidden.as_ref().unwrap().runs[0];
    assert_eq!(run.maximum, 9);
    assert_eq!(run.text.len(), 9);
}
#[test]
fn acquisition_expiry_at_each_endpoint_prevents_further_work() {
    let parts = [("H", true), ("BODY_A", false), ("H", true), ("tail", false)];
    let mut reference = Capture::document(&parts);
    assert!(reference.acquire().is_some());
    let boundaries = reference.target.script.calls.get();
    assert!(boundaries > 6);
    for at in 1..=boundaries {
        let mut c = Capture::document(&parts);
        c.target.script.expire_at.set(at);
        assert!(c.acquire().is_none(), "deadline after endpoint {at}");
        assert!(c.target.failures.timed_out.get());
        assert_eq!(c.target.script.calls.get(), at, "no endpoint after expiry");
    }
}
#[test]
fn witnesses_remain_independent_and_final_viewport_is_rechecked_after_text() {
    let mut c = Capture::document(&[("H", true), ("BODY_A", false), ("H", true), ("tail", false)]);
    assert_eq!(c.acquire().flatten().as_deref(), Some("BODY_A\ntail"));
    let witness = &c.visible_text[0];
    let runs = &witness.nonhidden.as_ref().unwrap().runs;
    assert_eq!(witness.ranges[0].ends.get(), (0, 12));
    assert_eq!(runs[0].range.ends.get(), (1, 7));
    assert_eq!(runs[1].range.ends.get(), (8, 12));
    assert!(!Rc::ptr_eq(&runs[0].range.ends, &runs[1].range.ends));
    assert!(!Rc::ptr_eq(&runs[0].range.ends, &witness.ranges[0].ends));
    assert!(c.final_visible_text_check().is_some());
    c.target
        .script
        .drift_after_reads
        .set(c.target.script.text_reads.get() + 1);
    let previous = c.target.script.viewport_reads.get();
    assert!(c.final_visible_text_check().is_none());
    assert_eq!(c.target.script.viewport_reads.get() - previous, 2);
}
#[test]
fn utf16_cut_preserves_raw_witness_and_bounded_public_text() {
    let mut c = Capture::document(&[("A\u{1f600}BODY_A", false), ("H", true)]);
    c.text_limit = 1;
    assert_eq!(c.acquire().flatten().as_deref(), Some("A"));
    let run = &c.visible_text[0].nonhidden.as_ref().unwrap().runs[0];
    assert_eq!(run.maximum, 2);
    assert_eq!(run.text, vec![65, 0xd83d]);
    assert!(c.final_visible_text_check().is_some());
}

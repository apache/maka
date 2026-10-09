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

//! `daily-review.query` and `daily-review.mutate`: the activity summary of
//! a day or a range of days, the generated reports (archives) the Host
//! keeps, and the Daily Review settings.
//!
//! Source: `packages/runtime-host/src/protocol/daily-review.ts`
//! (`DAILY_REVIEW_OPERATION_SPECS`, `decodeDailyReviewQueryInput`,
//! `decodeDailyReviewQueryResult`, `decodeDailyReviewMutateInput`,
//! `decodeDailyReviewMutateResult`, `requireConfig`, `requireArchive`,
//! `requireArchiveSummary`, `requireSummary`, `requireTotals`) and the
//! domain types in `packages/core/src/daily-review.ts`.
//!
//! Days are local-time days on the Host (`localDayBoundsAt`); an archive's
//! id is `YYYY-MM-DD-{range}d` and a new run for the same day and range
//! replaces it. The archive list is read newest first in pages of at most
//! [`DAILY_REVIEW_PAGE_MAX_ITEMS`], each page before the last one's id.
//! Queries fail with `host_not_ready`, `host_draining`,
//! `operation_unavailable`, `invalid_request`, `projection_incomplete`,
//! `persistence_failed`, or `internal_failure` (`QUERY_ERRORS`); a mutation
//! also with `operation_conflict` (`MUTATION_ERRORS`).

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::Operation;

/// `DAILY_REVIEW_PAGE_MAX_ITEMS`: archives per page.
pub const DAILY_REVIEW_PAGE_MAX_ITEMS: u32 = 32;
/// `DAILY_REVIEW_OFFSET_DAYS_MAX`: how many days back (or ahead) a summary
/// or a run may be offset.
pub const DAILY_REVIEW_OFFSET_DAYS_MAX: i64 = 3_650;
/// The longest range a summary spans (`daySpan`).
pub const DAILY_REVIEW_DAY_SPAN_MAX: u32 = 30;

/// `DailyReviewRange`: how many days a review covers, `1 | 7 | 30` on the
/// wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum DailyReviewRange {
    Day,
    Week,
    Month,
    /// A range this client does not recognize, kept as its day count.
    Other(u32),
}

impl DailyReviewRange {
    /// `DAILY_REVIEW_RANGES`, in Desktop's order.
    pub const ALL: [Self; 3] = [Self::Day, Self::Week, Self::Month];

    /// The number of days.
    pub fn days(self) -> u32 {
        match self {
            Self::Day => 1,
            Self::Week => 7,
            Self::Month => 30,
            Self::Other(days) => days,
        }
    }

    pub fn from_days(days: u32) -> Self {
        match days {
            1 => Self::Day,
            7 => Self::Week,
            30 => Self::Month,
            other => Self::Other(other),
        }
    }
}

impl Serialize for DailyReviewRange {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u32(self.days())
    }
}

impl<'de> Deserialize<'de> for DailyReviewRange {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        u32::deserialize(deserializer).map(Self::from_days)
    }
}

wire_enum! {
    /// `DailyReviewArchiveStatus` (`DAILY_REVIEW_ARCHIVE_STATUSES`).
    pub enum DailyReviewArchiveStatus {
        Ok = "ok",
        /// No model to write the report with.
        NoModel = "no_model",
        /// Nothing happened in the range.
        NoData = "no_data",
        Failed = "failed",
        Skipped = "skipped",
    }
}

wire_enum! {
    /// `DailyReviewTrigger`.
    pub enum DailyReviewTrigger {
        /// The daily run at the configured time.
        Cron = "cron",
        Manual = "manual",
    }
}

/// `DailyReviewConfig` (`requireConfig`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct DailyReviewConfig {
    pub enabled: bool,
    /// Local `HH:mm`.
    pub execute_time: String,
    /// `connectionSlug::modelId`; empty for the default task model.
    pub model_key: String,
}

impl DailyReviewConfig {
    pub fn new(
        enabled: bool,
        execute_time: impl Into<String>,
        model_key: impl Into<String>,
    ) -> Self {
        Self { enabled, execute_time: execute_time.into(), model_key: model_key.into() }
    }
}

/// `DayRangeMs`: a local day's (or range's) bounds, `from_ms` inclusive,
/// `to_ms` exclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct DailyReviewDay {
    pub from_ms: u64,
    pub to_ms: u64,
}

/// `DailyReviewTotals` (`requireTotals`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct DailyReviewTotals {
    /// Tasks with a message in the range.
    pub session_count: u64,
    /// Model calls.
    pub request_count: u64,
    pub total_tokens: u64,
    pub cost_usd: f64,
    pub error_count: u64,
}

/// `DailyReviewSessionRow` (`requireSession`): an active task of the range.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct DailyReviewSessionRow {
    pub id: String,
    pub name: String,
    pub last_message_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_preview: Option<String>,
}

/// `DailyReviewTopEntry` (`requireTopEntry`): a model or a tool, by use.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct DailyReviewTopEntry {
    pub key: String,
    pub label: String,
    pub requests: u64,
    pub total_tokens: u64,
    pub cost_usd: f64,
}

/// `DailyReviewSummary` (`requireSummary`): the range's activity, with at
/// most eight (`DAILY_REVIEW_LIST_LIMIT`) tasks, models, and tools.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct DailyReviewSummary {
    pub day: DailyReviewDay,
    pub totals: DailyReviewTotals,
    /// Most recent first.
    pub sessions: Vec<DailyReviewSessionRow>,
    pub top_tools: Vec<DailyReviewTopEntry>,
    pub top_models: Vec<DailyReviewTopEntry>,
}

/// `DailyReviewArchiveSectionContent`: a report's Markdown sections, each
/// present only when written.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct DailyReviewSections {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gaps: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

/// `DailyReviewArchiveSummary` (`requireArchiveSummary`): an archive
/// without its sections, as the list gives it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct DailyReviewArchiveSummary {
    /// `YYYY-MM-DD-{range}d`.
    pub id: String,
    pub day: DailyReviewDay,
    pub range: DailyReviewRange,
    pub status: DailyReviewArchiveStatus,
    pub generated_at: u64,
    pub trigger: DailyReviewTrigger,
    pub model_key: String,
    pub totals: DailyReviewTotals,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

/// `DailyReviewArchive` (`requireArchive`): a generated report.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct DailyReviewArchive {
    pub id: String,
    pub day: DailyReviewDay,
    pub range: DailyReviewRange,
    pub status: DailyReviewArchiveStatus,
    pub generated_at: u64,
    pub trigger: DailyReviewTrigger,
    pub model_key: String,
    pub sections: DailyReviewSections,
    pub totals: DailyReviewTotals,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

/// `DailyReviewQueryInput` (`decodeDailyReviewQueryInput`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum DailyReviewQueryInput {
    /// The Daily Review settings and their revision.
    Config,
    /// The activity of `day_span` days (1 to 30) ending `offset_days` from
    /// today (0 today, -1 yesterday).
    #[serde(rename_all = "camelCase")]
    Summary { day_span: u32, offset_days: i64 },
    /// Up to `limit` archives (1 to 32), newest first, before
    /// `before_archive_id` (`None`: from the newest).
    #[serde(rename_all = "camelCase")]
    Archives { before_archive_id: Option<String>, limit: u32 },
    #[serde(rename_all = "camelCase")]
    Archive { archive_id: String },
}

/// `DailyReviewQueryResult` (`decodeDailyReviewQueryResult`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum DailyReviewQueryResult {
    Config {
        revision: u64,
        config: DailyReviewConfig,
    },
    Summary {
        summary: Box<DailyReviewSummary>,
    },
    /// `next_before_archive_id` is the last archive's id when there are
    /// more, `None` at the end.
    #[serde(rename_all = "camelCase")]
    Archives {
        archives: Vec<DailyReviewArchiveSummary>,
        before_archive_id: Option<String>,
        next_before_archive_id: Option<String>,
    },
    /// `None`: no archive with that id.
    Archive {
        archive: Option<Box<DailyReviewArchive>>,
    },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `DailyReviewMutateInput` (`decodeDailyReviewMutateInput`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum DailyReviewMutateInput {
    /// Replace the settings read at `expected_revision`.
    #[serde(rename_all = "camelCase")]
    UpdateConfig { expected_revision: u64, config: DailyReviewConfig },
    /// Generate a report now. An empty `model_key_override` uses the
    /// configured model; without `replace_existing` a report the day and
    /// range already have is kept (Desktop never replaces).
    #[serde(rename_all = "camelCase")]
    Run {
        range: DailyReviewRange,
        offset_days: i64,
        model_key_override: String,
        replace_existing: bool,
    },
    #[serde(rename_all = "camelCase")]
    Delete { archive_id: String },
}

impl DailyReviewMutateInput {
    /// A report of `range` ending `offset_days` from today, with the
    /// configured model, keeping one already generated (Desktop's
    /// `runOnce`).
    pub fn run(range: DailyReviewRange, offset_days: i64) -> Self {
        Self::Run { range, offset_days, model_key_override: String::new(), replace_existing: false }
    }
}

/// `DailyReviewMutateResult` (`decodeDailyReviewMutateResult`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum DailyReviewMutateResult {
    ConfigCommitted {
        revision: u64,
        config: DailyReviewConfig,
    },
    ConfigUnchanged {
        revision: u64,
        config: DailyReviewConfig,
    },
    /// The settings moved since `expected_revision`: read them again.
    #[serde(rename_all = "camelCase")]
    RevisionConflict {
        expected_revision: u64,
        actual_revision: u64,
    },
    /// The report the run generated (or kept).
    Archive {
        archive: Box<DailyReviewArchive>,
    },
    /// `deleted` is false when there was no such archive.
    #[serde(rename_all = "camelCase")]
    Deleted {
        archive_id: String,
        deleted: bool,
    },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `daily-review.query` (mode `query`).
#[derive(Debug)]
pub enum DailyReviewQuery {}

impl Operation for DailyReviewQuery {
    const NAME: &'static str = "daily-review.query";
    type Input = DailyReviewQueryInput;
    type Output = DailyReviewQueryResult;
}

/// `daily-review.mutate` (mode `command`).
#[derive(Debug)]
pub enum DailyReviewMutate {}

impl Operation for DailyReviewMutate {
    const NAME: &'static str = "daily-review.mutate";
    type Input = DailyReviewMutateInput;
    type Output = DailyReviewMutateResult;
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    // `archive()` and `archiveSummary()` of
    // packages/runtime-host/src/__tests__/daily-review-protocol.test.ts
    // (2026-08-03 in the Host's zone; the bounds here are UTC+8).
    fn archive() -> Value {
        json!({
            "id": "2026-08-03-1d", "day": {"fromMs": 1_785_686_400_000_u64,
                                            "toMs": 1_785_772_800_000_u64},
            "range": 1, "status": "ok", "generatedAt": 1_785_686_400_001_u64,
            "trigger": "manual", "modelKey": "openrouter::openrouter/free",
            "sections": {"summary": "One review."},
            "totals": {"sessionCount": 1, "requestCount": 2, "totalTokens": 3, "costUsd": 0.0,
                       "errorCount": 0}
        })
    }

    fn archive_summary() -> Value {
        let mut summary = archive();
        summary.as_object_mut().expect("object").remove("sections");
        summary
    }

    fn round_trip<T: Serialize + serde::de::DeserializeOwned>(wire: &Value) -> T {
        let decoded: T = serde_json::from_value(wire.clone()).expect("decode");
        assert_eq!(&serde_json::to_value(&decoded).expect("encode"), wire);
        decoded
    }

    #[test]
    fn queries_encode_as_the_host_decodes_them() {
        let cases = [
            (DailyReviewQueryInput::Config, json!({"kind": "config"})),
            (
                DailyReviewQueryInput::Summary { day_span: 7, offset_days: -7 },
                json!({"kind": "summary", "daySpan": 7, "offsetDays": -7}),
            ),
            (
                DailyReviewQueryInput::Archives { before_archive_id: None, limit: 32 },
                json!({"kind": "archives", "beforeArchiveId": null, "limit": 32}),
            ),
            (
                DailyReviewQueryInput::Archives {
                    before_archive_id: Some("2026-08-03-1d".into()),
                    limit: 32,
                },
                json!({"kind": "archives", "beforeArchiveId": "2026-08-03-1d", "limit": 32}),
            ),
            (
                DailyReviewQueryInput::Archive { archive_id: "2026-08-03-1d".into() },
                json!({"kind": "archive", "archiveId": "2026-08-03-1d"}),
            ),
        ];
        for (input, wire) in cases {
            assert_eq!(serde_json::to_value(&input).expect("encode"), wire);
            round_trip::<DailyReviewQueryInput>(&wire);
        }
    }

    #[test]
    fn a_summary_an_archive_page_and_an_archive_decode() {
        let summary = json!({"kind": "summary", "summary": {
            "day": {"fromMs": 10, "toMs": 20},
            "totals": {"sessionCount": 2, "requestCount": 5, "totalTokens": 1200,
                       "costUsd": 0.25, "errorCount": 1},
            "sessions": [
                {"id": "s1", "name": "Refactor the parser", "lastMessageAt": 18,
                 "lastMessagePreview": "Done."},
                {"id": "s2", "name": "", "lastMessageAt": 12}
            ],
            "topTools": [{"key": "Read", "label": "Read", "requests": 4, "totalTokens": 0,
                          "costUsd": 0.0}],
            "topModels": [{"key": "openai::gpt-5", "label": "gpt-5", "requests": 5,
                           "totalTokens": 1200, "costUsd": 0.25}]
        }});
        let DailyReviewQueryResult::Summary { summary } = round_trip(&summary) else {
            panic!("a summary");
        };
        assert_eq!(summary.totals.request_count, 5);
        assert_eq!(summary.sessions[1].last_message_preview, None);
        assert_eq!(summary.top_models[0].cost_usd, 0.25);

        let page = json!({"kind": "archives", "archives": [archive_summary()],
                          "beforeArchiveId": null, "nextBeforeArchiveId": "2026-08-03-1d"});
        let DailyReviewQueryResult::Archives { archives, next_before_archive_id, .. } =
            round_trip(&page)
        else {
            panic!("an archive page");
        };
        assert_eq!(archives[0].range, DailyReviewRange::Day);
        assert_eq!(archives[0].trigger, DailyReviewTrigger::Manual);
        assert_eq!(next_before_archive_id.as_deref(), Some("2026-08-03-1d"));

        let mut failed = archive();
        failed["status"] = json!("no_model");
        failed["errorMessage"] = json!("No model is configured.");
        failed["sections"] = json!({});
        let DailyReviewQueryResult::Archive { archive: Some(archive) } =
            round_trip(&json!({"kind": "archive", "archive": failed}))
        else {
            panic!("an archive");
        };
        assert_eq!(archive.status, DailyReviewArchiveStatus::NoModel);
        assert_eq!(archive.sections, DailyReviewSections::default());
        assert_eq!(
            round_trip::<DailyReviewQueryResult>(&json!({"kind": "archive", "archive": null})),
            DailyReviewQueryResult::Archive { archive: None }
        );
        let config = json!({"kind": "config", "revision": 3, "config": {
            "enabled": true, "executeTime": "08:00", "modelKey": ""}});
        let DailyReviewQueryResult::Config { revision, config } = round_trip(&config) else {
            panic!("the config");
        };
        assert_eq!((revision, config.execute_time.as_str()), (3, "08:00"));
    }

    #[test]
    fn mutations_encode_and_their_results_decode() {
        assert_eq!(
            serde_json::to_value(DailyReviewMutateInput::run(DailyReviewRange::Week, -1))
                .expect("encode"),
            json!({"kind": "run", "range": 7, "offsetDays": -1, "modelKeyOverride": "",
                   "replaceExisting": false})
        );
        for wire in [
            json!({"kind": "delete", "archiveId": "2026-08-03-1d"}),
            json!({"kind": "update_config", "expectedRevision": 3,
                   "config": {"enabled": false, "executeTime": "21:30", "modelKey": "a::b"}}),
        ] {
            round_trip::<DailyReviewMutateInput>(&wire);
        }
        let run = json!({"kind": "archive", "archive": archive()});
        let DailyReviewMutateResult::Archive { archive } = round_trip(&run) else {
            panic!("an archive");
        };
        assert_eq!(archive.sections.summary.as_deref(), Some("One review."));
        for wire in [
            json!({"kind": "deleted", "archiveId": "2026-08-03-1d", "deleted": true}),
            json!({"kind": "revision_conflict", "expectedRevision": 3, "actualRevision": 4}),
            json!({"kind": "config_committed", "revision": 4,
                   "config": {"enabled": true, "executeTime": "08:00", "modelKey": ""}}),
            json!({"kind": "config_unchanged", "revision": 4,
                   "config": {"enabled": true, "executeTime": "08:00", "modelKey": ""}}),
        ] {
            round_trip::<DailyReviewMutateResult>(&wire);
        }
    }
}

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

//! Usage in the terminal: what this session has cost beside it, and a
//! settings category with usage over time and the prices behind it. Totals
//! say what is unknown rather than counting it as zero.

use super::remote::Insights;
use futures_util::future::BoxFuture;
use maka_plugins::{
    contributions::Staged,
    remote::{Caller, Error, Method, key},
    terminal_ui::{
        Context, Descriptor, Placement, Text, VERSION,
        app::{self, App, Cx, Submission, Words},
        view::{self, Action, Confirm, Node, Reply, Role, Tone, View, build::*},
    },
};
use serde::Deserialize;
use serde_json::{Value, json};

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

pub(super) fn publish(
    insights: Insights,
    package: &str,
    staged: &mut Staged,
) -> Result<(), String> {
    let endpoints = [
        (
            "usage",
            app::endpoint(
                Session(insights.clone()),
                Descriptor::new(Text::localized("Usage", "用量", "用量"), Context::Session)
                    .placement(Placement::Panel)
                    .icon("$", "$")
                    .order(50),
            )
            .map_err(message)?,
        ),
        (
            "terminal",
            app::endpoint(
                Overview(insights),
                Descriptor::new(
                    Text::localized("Usage & pricing", "用量与价格", "用量與價格"),
                    Context::Application,
                )
                .placement(Placement::Settings)
                .icon("$", "$")
                .order(30),
            )
            .map_err(message)?,
        ),
    ];
    for (method, endpoint) in endpoints {
        staged
            .insert(key(package, method).map_err(message)?, endpoint)
            .map_err(message)?;
    }
    Ok(())
}

#[derive(Deserialize)]
struct Activity {
    page: Cursor,
}
#[derive(Deserialize)]
struct Cursor {
    cursor: String,
}
#[derive(Deserialize)]
struct Summarized {
    summary: Summary,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    models: Totals,
    tools: Tools,
    by_provider: Vec<Provider>,
    by_model: Vec<Model>,
    by_tool: Vec<Tool>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Totals {
    calls: u64,
    error: u64,
    input: Tokens,
    output: Tokens,
    cache_read: Tokens,
    cost: Cost,
}
#[derive(Deserialize)]
struct Tokens {
    known: u64,
    missing: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cost {
    known_usd: f64,
    unvalued: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tools {
    calls: u64,
    error: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Provider {
    provider_id: Option<String>,
    totals: Totals,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Model {
    model_id: String,
    totals: Totals,
}
#[derive(Deserialize)]
struct Tool {
    name: String,
    totals: Tools,
}

/// Totals for a span of time, for one session or everything.
async fn summary(
    insights: &Insights,
    caller: &Caller,
    from: f64,
    session: Option<&str>,
) -> Result<Summary, Error> {
    let to = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| Error::Provider(error.to_string()))?
        .as_millis() as f64;
    let activity: Activity = decode(
        insights
            .call(
                json!({"kind":"activity","operationId":uuid::Uuid::new_v4(),
                    "read":{"kind":"start","filter":{"from":from,"to":to,"sessionId":session}}}),
                caller.clone(),
            )
            .await?,
    )?;
    let summarized: Summarized = decode(
        insights
            .call(
                json!({"kind":"summary","operationId":uuid::Uuid::new_v4(),"cursor":activity.page.cursor}),
                caller.clone(),
            )
            .await?,
    )?;
    Ok(summarized.summary)
}
fn decode<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, Error> {
    if value.get("kind").and_then(Value::as_str) == Some("refresh_required") {
        return Err(Error::Provider(
            "Usage changed while reading; refresh".into(),
        ));
    }
    serde_json::from_value(value).map_err(|error| Error::Provider(error.to_string()))
}

fn money(usd: f64) -> String {
    if usd == 0.0 {
        "$0".into()
    } else if usd < 1.0 {
        format!("${usd:.4}")
    } else {
        format!("${usd:.2}")
    }
}
fn count(value: u64) -> String {
    match value {
        0..1_000 => value.to_string(),
        1_000..1_000_000 => format!("{:.1}K", value as f64 / 1e3),
        _ => format!("{:.1}M", value as f64 / 1e6),
    }
}
/// A cost, and how many calls it could not value.
fn cost(words: &Words, totals: &Totals) -> String {
    let known = money(totals.cost.known_usd);
    if totals.cost.unvalued == 0 {
        known
    } else {
        words.t(
            &format!("{known} + {} unpriced", totals.cost.unvalued),
            &format!("{known} + {} 次未定价", totals.cost.unvalued),
            &format!("{known} + {} 次未定價", totals.cost.unvalued),
        )
    }
}
fn tokens(words: &Words, totals: &Totals) -> String {
    let missing = totals.input.missing + totals.output.missing;
    let mut line = words.t(
        &format!(
            "{} in · {} out · {} cached",
            count(totals.input.known),
            count(totals.output.known),
            count(totals.cache_read.known)
        ),
        &format!(
            "输入 {} · 输出 {} · 缓存 {}",
            count(totals.input.known),
            count(totals.output.known),
            count(totals.cache_read.known)
        ),
        &format!(
            "輸入 {} · 輸出 {} · 快取 {}",
            count(totals.input.known),
            count(totals.output.known),
            count(totals.cache_read.known)
        ),
    );
    if missing > 0 {
        line.push_str(&words.t(
            &format!(" · {missing} calls unreported"),
            &format!(" · {missing} 次未报告"),
            &format!(" · {missing} 次未回報"),
        ));
    }
    line
}
fn view(
    title: String,
    revision: String,
    actions: Vec<Action>,
    fields: Vec<view::Field>,
    root: Node,
) -> View {
    View {
        version: VERSION,
        title,
        revision,
        fields,
        actions,
        root,
    }
}

/// What this session has cost so far.
struct Session(Insights);

impl App for Session {
    fn read(&self, route: Value, cx: Cx) -> BoxFuture<'static, Result<View, Error>> {
        let insights = self.0.clone();
        Box::pin(async move {
            if !route.is_null() {
                return Err(Error::Invalid("Invalid usage route".into()));
            }
            let session = cx.session()?.to_owned();
            let summary = summary(&insights, &cx.caller, 0.0, Some(&session)).await?;
            Ok(session_view(&cx.words, &summary))
        })
    }
    fn submit(&self, _: Submission, _: Cx) -> BoxFuture<'static, Result<Reply, Error>> {
        Box::pin(async { Err(Error::Invalid("Usage is read-only".into())) })
    }
}

fn session_view(words: &Words, summary: &Summary) -> View {
    let title = words.t("Usage", "用量", "用量");
    let models = &summary.models;
    if models.calls == 0 && summary.tools.calls == 0 {
        return view(
            title,
            "0".into(),
            vec![],
            vec![],
            column(
                "root",
                vec![text(
                    "empty",
                    words.t("Nothing used yet.", "还没有用量。", "還沒有用量。"),
                    Tone::Muted,
                )],
            ),
        );
    }
    let mut children = vec![
        heading("cost", cost(words, models)),
        text("tokens", tokens(words, models), Tone::Muted),
        text(
            "calls",
            words.t(
                &format!(
                    "{} model calls · {} tool calls",
                    models.calls, summary.tools.calls
                ),
                &format!(
                    "模型调用 {} 次 · 工具调用 {} 次",
                    models.calls, summary.tools.calls
                ),
                &format!(
                    "模型呼叫 {} 次 · 工具呼叫 {} 次",
                    models.calls, summary.tools.calls
                ),
            ),
            Tone::Muted,
        ),
    ];
    let errors = models.error + summary.tools.error;
    if errors > 0 {
        children.push(text(
            "errors",
            words.t(
                &format!("{errors} failed"),
                &format!("{errors} 次失败"),
                &format!("{errors} 次失敗"),
            ),
            Tone::Warning,
        ));
    }
    let top: Vec<Node> = summary
        .by_model
        .iter()
        .take(3)
        .enumerate()
        .map(|(index, model)| {
            spans(
                format!("model-{index}"),
                vec![
                    (view::build::clean(&model.model_id, false), Tone::Normal),
                    (
                        format!("  {}", money(model.totals.cost.known_usd)),
                        Tone::Subtle,
                    ),
                ],
            )
        })
        .collect();
    if !top.is_empty() {
        children.push(stack("models", top));
    }
    view(
        title,
        format!("{}:{}", models.calls, summary.tools.calls),
        vec![],
        vec![],
        column("root", children),
    )
}

/// Usage over time and the prices behind it.
struct Overview(Insights);

#[derive(Deserialize, Default)]
#[serde(default)]
struct Place {
    tab: Option<String>,
    range: Option<String>,
    model: Option<String>,
    offset: Option<u64>,
    revision: Option<u64>,
}

#[derive(Deserialize)]
struct Priced {
    page: Prices,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Prices {
    Page {
        revision: u64,
        entries: Vec<Entry>,
        #[serde(rename = "nextOffset")]
        next_offset: Option<u64>,
    },
    RevisionChanged {},
}
#[derive(Deserialize)]
#[serde(tag = "source", rename_all = "snake_case")]
enum Entry {
    Builtin { pricing: Pricing },
    Custom { pricing: Pricing },
}
#[derive(Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Pricing {
    model_key: String,
    #[serde(rename = "inputUsdPer1M")]
    input: f64,
    #[serde(rename = "outputUsdPer1M")]
    output: f64,
    #[serde(
        rename = "cacheReadUsdPer1M",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    cache_read: Option<f64>,
    #[serde(
        rename = "cacheWriteUsdPer1M",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    cache_write: Option<f64>,
}
impl Entry {
    fn pricing(&self) -> &Pricing {
        match self {
            Self::Builtin { pricing } | Self::Custom { pricing } => pricing,
        }
    }
}

const RANGES: [(&str, f64); 4] = [
    ("24h", 86_400_000.0),
    ("7d", 604_800_000.0),
    ("30d", 2_592_000_000.0),
    ("all", f64::INFINITY),
];

impl Overview {
    async fn prices(
        &self,
        caller: &Caller,
        place: &Place,
    ) -> Result<(u64, Vec<Entry>, Option<u64>), Error> {
        let query = match (place.offset, place.revision) {
            (Some(offset), Some(revision)) => {
                json!({"kind":"continue","revision":revision,"offset":offset})
            }
            _ => json!({"kind":"start"}),
        };
        let priced: Priced = decode(
            self.0
                .call(json!({"kind":"prices","query":query}), caller.clone())
                .await?,
        )?;
        match priced.page {
            Prices::Page {
                revision,
                entries,
                next_offset,
            } => Ok((revision, entries, next_offset)),
            Prices::RevisionChanged {} => Err(Error::Provider("Prices changed; refresh".into())),
        }
    }
}

impl App for Overview {
    fn read(&self, route: Value, cx: Cx) -> BoxFuture<'static, Result<View, Error>> {
        let this = Overview(self.0.clone());
        Box::pin(async move {
            let words = &cx.words;
            let place: Place = serde_json::from_value(route).unwrap_or_default();
            if place.tab.as_deref() == Some("pricing") {
                let (revision, entries, next) = this.prices(&cx.caller, &place).await?;
                if let Some(model) = &place.model {
                    let entry = entries
                        .iter()
                        .find(|entry| &entry.pricing().model_key == model);
                    return Ok(price(words, revision, model, entry));
                }
                return Ok(pricing(words, revision, &entries, next));
            }
            let range = place.range.unwrap_or_else(|| "7d".into());
            let span = RANGES
                .iter()
                .find(|(id, _)| *id == range)
                .map_or(RANGES[1].1, |(_, span)| *span);
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|error| Error::Provider(error.to_string()))?
                .as_millis() as f64;
            let from = if span.is_finite() {
                (now - span).max(0.0)
            } else {
                0.0
            };
            let summary = summary(&this.0, &cx.caller, from, None).await?;
            Ok(overview(words, &range, &summary))
        })
    }

    fn submit(&self, submission: Submission, cx: Cx) -> BoxFuture<'static, Result<Reply, Error>> {
        let this = Overview(self.0.clone());
        Box::pin(async move {
            let revision: u64 = submission
                .revision
                .parse()
                .map_err(|_| Error::Invalid("Invalid price revision".into()))?;
            let rate = |id: &str| -> Result<Option<f64>, Error> {
                let text = submission.text(id)?.trim();
                if text.is_empty() {
                    return Ok(None);
                }
                text.parse::<f64>()
                    .ok()
                    .filter(|rate| rate.is_finite() && *rate >= 0.0)
                    .map(Some)
                    .ok_or_else(|| Error::Invalid(format!("Invalid rate {id}")))
            };
            let mutation = match submission.action.as_str() {
                "save" => {
                    let model_key = match submission.route.get("model").and_then(Value::as_str) {
                        Some(model) if !model.is_empty() => model.to_owned(),
                        _ => submission.text("model")?.trim().to_owned(),
                    };
                    let (Ok(Some(input)), Ok(Some(output)), Ok(cache_read), Ok(cache_write)) = (
                        rate("input"),
                        rate("output"),
                        rate("cache_read"),
                        rate("cache_write"),
                    ) else {
                        return Ok(Reply::Rejected {
                            message: cx.t(
                                "Enter rates in US dollars per million tokens.",
                                "请以每百万 token 的美元价格填写。",
                                "請以每百萬 token 的美元價格填寫。",
                            ),
                        });
                    };
                    json!({"kind":"upsert","pricing":Pricing { model_key, input, output, cache_read, cache_write }})
                }
                "reset" => {
                    let model = submission
                        .route
                        .get("model")
                        .and_then(Value::as_str)
                        .ok_or_else(|| Error::Invalid("No model".into()))?;
                    json!({"kind":"delete","modelKey":model})
                }
                _ => return Err(Error::Invalid("Unknown pricing action".into())),
            };
            let updated = this
                .0
                .call(
                    json!({"kind":"update_price","operationId":uuid::Uuid::new_v4(),
                        "update":{"expectedRevision":revision,"mutation":mutation}}),
                    cx.caller,
                )
                .await;
            match updated {
                Ok(value)
                    if value.pointer("/receipt/kind").and_then(Value::as_str)
                        == Some("revision_conflict") =>
                {
                    Ok(Reply::Conflict)
                }
                Ok(_) => Ok(Reply::Applied {
                    route: json!({"tab":"pricing"}),
                }),
                Err(Error::Invalid(message) | Error::Provider(message)) => Ok(Reply::Rejected {
                    message: view::build::clean(&message, false)
                        .chars()
                        .take(256)
                        .collect(),
                }),
                Err(error) => Err(error),
            }
        })
    }
}

fn tabs_for(words: &Words, current: &str) -> Node {
    tabs(
        "tabs",
        current,
        vec![
            (
                "overview".into(),
                words.t("Usage", "用量", "用量"),
                json!({"tab":"overview"}),
            ),
            (
                "pricing".into(),
                words.t("Pricing", "价格", "價格"),
                json!({"tab":"pricing"}),
            ),
        ],
    )
}

fn overview(words: &Words, range: &str, summary: &Summary) -> View {
    let ranges = tabs(
        "range",
        range,
        RANGES
            .iter()
            .map(|(id, _)| {
                let label = match *id {
                    "24h" => words.t("Day", "一天", "一天"),
                    "7d" => words.t("Week", "一周", "一週"),
                    "30d" => words.t("Month", "一个月", "一個月"),
                    _ => words.t("All", "全部", "全部"),
                };
                ((*id).into(), label, json!({"tab":"overview","range":id}))
            })
            .collect(),
    );
    let models = &summary.models;
    let mut children = vec![
        tabs_for(words, "overview"),
        ranges,
        heading("cost", cost(words, models)),
        text("tokens", tokens(words, models), Tone::Muted),
    ];
    let rows = |key: &str, title: String, items: Vec<(String, String)>| -> Option<Node> {
        (!items.is_empty()).then(|| {
            stack(
                key.to_owned(),
                std::iter::once(text("title", title, Tone::Subtle))
                    .chain(
                        items
                            .into_iter()
                            .enumerate()
                            .map(|(index, (name, detail))| {
                                spans(
                                    format!("row-{index}"),
                                    vec![
                                        (view::build::clean(&name, false), Tone::Normal),
                                        (format!("  {detail}"), Tone::Subtle),
                                    ],
                                )
                            }),
                    )
                    .collect(),
            )
        })
    };
    children.extend(rows(
        "providers",
        words.t("By provider", "按提供商", "按提供者"),
        summary
            .by_provider
            .iter()
            .take(8)
            .map(|provider| {
                (
                    provider
                        .provider_id
                        .clone()
                        .unwrap_or_else(|| words.t("Unknown", "未知", "未知")),
                    cost(words, &provider.totals),
                )
            })
            .collect(),
    ));
    children.extend(rows(
        "models",
        words.t("By model", "按模型", "按模型"),
        summary
            .by_model
            .iter()
            .take(12)
            .map(|model| {
                (
                    model.model_id.clone(),
                    format!("{} · {}", cost(words, &model.totals), model.totals.calls),
                )
            })
            .collect(),
    ));
    children.extend(rows(
        "tools",
        words.t("Tools", "工具", "工具"),
        summary
            .by_tool
            .iter()
            .take(12)
            .map(|tool| {
                (
                    tool.name.clone(),
                    format!("{} · {} ×", tool.totals.calls, tool.totals.error),
                )
            })
            .collect(),
    ));
    view(
        words.t("Usage & pricing", "用量与价格", "用量與價格"),
        format!("{range}:{}", models.calls),
        vec![],
        vec![],
        scroll("root", 60, column("body", children)),
    )
}

fn rates(pricing: &Pricing) -> String {
    format!("${} / ${}", pricing.input, pricing.output)
}

fn pricing(words: &Words, revision: u64, entries: &[Entry], next: Option<u64>) -> View {
    let mut items: Vec<Node> = entries
        .iter()
        .map(|entry| {
            let pricing = entry.pricing();
            link(
                format!("price-{}", pricing.model_key).replace('/', ":"),
                view::build::clean(&pricing.model_key, false),
                json!({"tab":"pricing","model":pricing.model_key}),
            )
            .detail(words.t(
                &format!("{} per million tokens in / out", rates(pricing)),
                &format!("每百万 token 输入 / 输出 {}", rates(pricing)),
                &format!("每百萬 token 輸入 / 輸出 {}", rates(pricing)),
            ))
            .meta(match entry {
                Entry::Custom { .. } => words.t("Custom", "自定义", "自訂"),
                Entry::Builtin { .. } => words.t("Built in", "内置", "內建"),
            })
            .into()
        })
        .collect();
    items.push(
        link(
            "add",
            words.t("Price another model", "为其它模型定价", "為其他模型定價"),
            json!({"tab":"pricing","model":""}),
        )
        .into(),
    );
    if let Some(offset) = next {
        items.push(
            link(
                "more",
                words.t("More", "更多", "更多"),
                json!({"tab":"pricing","offset":offset,"revision":revision}),
            )
            .into(),
        );
    }
    view(
        words.t("Usage & pricing", "用量与价格", "用量與價格"),
        revision.to_string(),
        vec![],
        vec![],
        column(
            "root",
            vec![tabs_for(words, "pricing"), stack("prices", items)],
        ),
    )
}

fn price(words: &Words, revision: u64, model: &str, entry: Option<&Entry>) -> View {
    let pricing = entry.map(Entry::pricing);
    let rate = |value: Option<f64>| value.map_or_else(String::new, |value| value.to_string());
    let mut fields = vec![
        view::build::line("input", rate(pricing.map(|p| p.input)), 32),
        view::build::line("output", rate(pricing.map(|p| p.output)), 32),
        view::build::line("cache_read", rate(pricing.and_then(|p| p.cache_read)), 32),
        view::build::line("cache_write", rate(pricing.and_then(|p| p.cache_write)), 32),
    ];
    let mut inputs = vec![];
    let mut sent = vec![];
    if model.is_empty() {
        fields.insert(0, view::build::line("model", "", 256));
        inputs.push(input("model", "model", words.t("Model", "模型", "模型")));
        sent.push("model".to_owned());
    }
    for (id, en, zh_cn, zh_tw) in [
        ("input", "Input", "输入", "輸入"),
        ("output", "Output", "输出", "輸出"),
        ("cache_read", "Cache read", "缓存读取", "快取讀取"),
        ("cache_write", "Cache write", "缓存写入", "快取寫入"),
    ] {
        inputs.push(input(id, id, words.t(en, zh_cn, zh_tw)));
        sent.push(id.to_owned());
    }
    let mut actions = vec![Action {
        fields: sent,
        ..view::build::action("save", words.t("Save", "保存", "儲存"))
    }];
    let mut buttons = vec![button("save", "save", Role::Primary)];
    if matches!(entry, Some(Entry::Custom { .. })) {
        actions.push(Action {
            confirm: Some(Confirm {
                title: words.t("Remove this price?", "移除这个价格？", "移除這個價格？"),
                message: words.t(
                    "The built-in price applies again, or the model becomes unpriced.",
                    "将恢复内置价格；没有内置价格的模型会变为未定价。",
                    "將恢復內建價格；沒有內建價格的模型會變為未定價。",
                ),
                destructive: true,
            }),
            ..view::build::action("reset", words.t("Remove", "移除", "移除"))
        });
        buttons.push(button("reset", "reset", Role::Destructive));
    }
    let title = if model.is_empty() {
        words.t("New price", "新价格", "新價格")
    } else {
        view::build::clean(model, false)
    };
    view(
        title,
        revision.to_string(),
        actions,
        fields,
        column(
            "root",
            vec![
                text(
                    "unit",
                    words.t(
                        "US dollars per million tokens. Cache rates default to the input rate.",
                        "单位为每百万 token 美元。缓存价格默认等于输入价格。",
                        "單位為每百萬 token 美元。快取價格預設等於輸入價格。",
                    ),
                    Tone::Muted,
                ),
                stack("form", inputs),
                row("controls", buttons),
            ],
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn totals(calls: u64, usd: f64, unvalued: u64) -> Totals {
        Totals {
            calls,
            error: 0,
            input: Tokens {
                known: 12_300,
                missing: 0,
            },
            output: Tokens {
                known: 900,
                missing: 1,
            },
            cache_read: Tokens {
                known: 0,
                missing: 0,
            },
            cost: Cost {
                known_usd: usd,
                unvalued,
            },
        }
    }
    fn summary() -> Summary {
        Summary {
            models: totals(3, 0.4213, 1),
            tools: Tools { calls: 5, error: 1 },
            by_provider: vec![Provider {
                provider_id: Some("openai".into()),
                totals: totals(3, 0.42, 0),
            }],
            by_model: vec![Model {
                model_id: "gpt".into(),
                totals: totals(3, 0.42, 0),
            }],
            by_tool: vec![Tool {
                name: "Read".into(),
                totals: Tools { calls: 5, error: 1 },
            }],
        }
    }

    #[test]
    fn usage_says_what_it_could_not_count_and_prices_edit_in_place() {
        let words = Words::new("en");
        let view = session_view(&words, &summary());
        view.validate().unwrap();
        let text = serde_json::to_string(&view).unwrap();
        assert!(text.contains("$0.4213 + 1 unpriced") && text.contains("12.3K in"));
        assert!(text.contains("1 calls unreported") && text.contains("1 failed"));
        overview(&words, "7d", &summary()).validate().unwrap();
        let entries = vec![Entry::Custom {
            pricing: Pricing {
                model_key: "openai/gpt".into(),
                input: 1.0,
                output: 4.0,
                cache_read: None,
                cache_write: None,
            },
        }];
        pricing(&words, 3, &entries, Some(20)).validate().unwrap();
        let edit = price(&words, 3, "openai/gpt", entries.first());
        edit.validate().unwrap();
        assert!(edit.action("reset").unwrap().confirm.is_some());
        let new = price(&words, 3, "", None);
        new.validate().unwrap();
        assert_eq!(new.fields.len(), 5);
    }
}

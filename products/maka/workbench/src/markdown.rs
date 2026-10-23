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

//! CommonMark/GFM presentation, independent of Host content.

use ::markdown::{ParseOptions, mdast::AlignKind, mdast::Node};
use nsh_core::ui::prelude::*;
use std::collections::BTreeMap;

mod source;

/// A literal UTF-8 interval or one indivisible Markdown transformation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PropEnum)]
pub enum MarkdownSourceKind {
    Literal,
    Replacement,
}

/// Local rendered UTF-16 ranges address the original document in UTF-8 bytes.
#[derive(Clone, Debug, PartialEq, JsObject)]
pub struct MarkdownSourceSegment {
    pub start: u32,
    pub end: u32,
    pub source_start: u64,
    pub source_end: u64,
    pub kind: MarkdownSourceKind,
}

/// Inline content; unsupported constructs retain their complete source spelling.
#[derive(Clone, Debug, PartialEq, JsObject)]
pub struct MarkdownRun {
    pub key: String,
    pub source: Vec<MarkdownSourceSegment>,
    pub text: String,
    pub strong: bool,
    pub emphasis: bool,
    pub strike: bool,
    pub code: bool,
    pub link: Option<MarkdownLink>,
    pub image: Option<MarkdownImage>,
}

/// One logical link, including all of its separately styled inline runs.
#[derive(Clone, Debug, PartialEq, JsObject)]
pub struct MarkdownLink {
    pub key: String,
    pub target: String,
}

/// An authored image destination; the original scoped file reader resolves it.
#[derive(Clone, Debug, PartialEq, JsObject)]
pub struct MarkdownImage {
    pub target: String,
    pub alt: String,
}

/// Rendering supported by the terminal application's rich text primitives.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PropEnum)]
pub enum MarkdownBlockKind {
    Paragraph,
    Heading,
    Code,
    Table,
    Literal,
    Rule,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PropEnum)]
pub enum MarkdownTableAlignment {
    Left,
    Center,
    Right,
}

#[derive(Clone, Debug, PartialEq, JsObject)]
pub struct MarkdownTableCell {
    pub key: String,
    pub runs: Vec<MarkdownRun>,
}

#[derive(Clone, Debug, PartialEq, JsObject)]
pub struct MarkdownTableRow {
    pub key: String,
    pub cells: Vec<MarkdownTableCell>,
}

/// Rows retain their natural cell count; the first row is the table header.
#[derive(Clone, Debug, PartialEq, JsObject)]
pub struct MarkdownTable {
    pub columns: Vec<MarkdownTableAlignment>,
    pub rows: Vec<MarkdownTableRow>,
}

/// A block's key uses its starting source offset, so appending text preserves it.
#[derive(Clone, Debug, PartialEq, JsObject)]
pub struct MarkdownBlock {
    pub key: String,
    pub source: Vec<MarkdownSourceSegment>,
    pub kind: MarkdownBlockKind,
    pub indent: u32,
    pub quote: u32,
    pub marker: String,
    pub runs: Vec<MarkdownRun>,
    pub text: String,
    pub level: u32,
    pub language: String,
    pub table: Option<MarkdownTable>,
}

/// Stateless, local Markdown presentation; it reads no files and follows no URLs.
#[class]
pub struct Markdown;

#[class]
impl Markdown {
    /// Parse on the launcher's existing blocking pool, away from the UI thread.
    pub async fn parse(this: Instance<Self>, source: String) -> Result<Vec<MarkdownBlock>, String> {
        drop(this);
        tokio::task::spawn_blocking(move || parse_source(&source))
            .await
            .map_err(|error| format!("Markdown worker failed: {error}"))?
    }
}

/// The runtime and declaration generator share this one native export.
pub fn registry() -> Registry {
    let mut registry = Registry::ui_set("maka/markdown");
    registry.value("markdown", || Instance::new(Markdown));
    registry
}

fn parse_source(source: &str) -> Result<Vec<MarkdownBlock>, String> {
    let root =
        ::markdown::to_mdast(source, &ParseOptions::gfm()).map_err(|error| error.to_string())?;
    let mut output = Presentation {
        source,
        blocks: Vec::new(),
        references: BTreeMap::new(),
    };
    output.collect_references(&root);
    output.visit(&root, Context::default())?;
    Ok(output.blocks)
}

#[derive(Clone, Copy, Default)]
struct Context {
    indent: u32,
    quote: u32,
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
struct Marks {
    strong: bool,
    emphasis: bool,
    strike: bool,
    code: bool,
}

struct Presentation<'a> {
    source: &'a str,
    blocks: Vec<MarkdownBlock>,
    references: BTreeMap<String, String>,
}

impl Presentation<'_> {
    fn collect_references(&mut self, node: &Node) {
        if let Node::Definition(definition) = node {
            self.references
                .entry(definition.identifier.clone())
                .or_insert_with(|| definition.url.clone());
        }
        if let Some(children) = node.children() {
            for child in children {
                self.collect_references(child);
            }
        }
    }

    fn visit(&mut self, node: &Node, context: Context) -> Result<(), String> {
        match node {
            Node::Root(root) => {
                for child in &root.children {
                    self.visit(child, context)?;
                }
            }
            Node::Blockquote(quote) => {
                for child in &quote.children {
                    self.visit(
                        child,
                        Context {
                            quote: context.quote + 1,
                            ..context
                        },
                    )?;
                }
            }
            Node::List(list) => {
                for (index, child) in list.children.iter().enumerate() {
                    let Node::ListItem(item) = child else {
                        unreachable!("Markdown list children are list items");
                    };
                    let mut marker = if list.ordered {
                        format!("{}.", u64::from(list.start.unwrap_or(1)) + index as u64)
                    } else {
                        "•".into()
                    };
                    if let Some(checked) = item.checked {
                        marker.push_str(if checked { " [x]" } else { " [ ]" });
                    }
                    // An empty item, or one beginning with a nested list, still
                    // has its own marker before its descendants.
                    let first = self.blocks.len();
                    if item.children.is_empty() || begins_with_list(item.children.first()) {
                        self.blocks.push(self.block(
                            child,
                            MarkdownBlockKind::Paragraph,
                            Context {
                                indent: context.indent + 1,
                                ..context
                            },
                        ));
                    }
                    for child in &item.children {
                        self.visit(
                            child,
                            Context {
                                indent: context.indent + 1,
                                ..context
                            },
                        )?;
                    }
                    if let Some(block) = self.blocks.get_mut(first) {
                        block.marker = marker;
                    }
                }
            }
            Node::Paragraph(paragraph) => {
                self.phrasing(
                    node,
                    &paragraph.children,
                    MarkdownBlockKind::Paragraph,
                    0,
                    context,
                )?;
            }
            Node::Heading(heading) => {
                self.phrasing(
                    node,
                    &heading.children,
                    MarkdownBlockKind::Heading,
                    u32::from(heading.depth),
                    context,
                )?;
            }
            Node::Code(code) => {
                let mut block = self.block(node, MarkdownBlockKind::Code, context);
                block.text.clone_from(&code.value);
                block.source = source::code(self.source, node, &code.value)?;
                block.language = code.lang.clone().unwrap_or_default();
                self.blocks.push(block);
            }
            Node::Table(table) => {
                let mut columns = table
                    .align
                    .iter()
                    .map(|alignment| match alignment {
                        AlignKind::Left | AlignKind::None => MarkdownTableAlignment::Left,
                        AlignKind::Center => MarkdownTableAlignment::Center,
                        AlignKind::Right => MarkdownTableAlignment::Right,
                    })
                    .collect::<Vec<_>>();
                let mut rows = Vec::new();
                for row_node in &table.children {
                    let Node::TableRow(row) = row_node else {
                        unreachable!("Markdown table children are table rows");
                    };
                    let mut cells = Vec::new();
                    for cell_node in &row.children {
                        let Node::TableCell(cell) = cell_node else {
                            unreachable!("Markdown table row children are table cells");
                        };
                        let mut runs = Vec::new();
                        for child in &cell.children {
                            inline(
                                self.source,
                                &self.references,
                                child,
                                Marks::default(),
                                None,
                                context.quote,
                                &mut runs,
                            )?;
                        }
                        cells.push(MarkdownTableCell {
                            key: format!("table-cell:{}", start(cell_node)),
                            runs,
                        });
                    }
                    // Keep every parsed cell, including an overfull row, instead
                    // of discarding content beyond the delimiter's columns.
                    if cells.len() > columns.len() {
                        columns.resize(cells.len(), MarkdownTableAlignment::Left);
                    }
                    rows.push(MarkdownTableRow {
                        key: format!("table-row:{}", start(row_node)),
                        cells,
                    });
                }
                let mut block = self.block(node, MarkdownBlockKind::Table, context);
                block.text = raw(self.source, node).into();
                block.source = source::literal(start(node), &block.text);
                block.table = Some(MarkdownTable { columns, rows });
                self.blocks.push(block);
            }
            Node::ThematicBreak(_) => {
                let mut block = self.block(node, MarkdownBlockKind::Rule, context);
                block.text = raw(self.source, node).into();
                block.source = source::literal(start(node), &block.text);
                self.blocks.push(block);
            }
            // Link definitions are metadata, not rendered document content.
            Node::Definition(_) => {}
            // HTML and footnotes keep their complete source spelling.
            _ => {
                let mut block = self.block(node, MarkdownBlockKind::Literal, context);
                block.text = raw(self.source, node).into();
                block.source = source::literal(start(node), &block.text);
                self.blocks.push(block);
            }
        }
        Ok(())
    }

    fn block(&self, node: &Node, kind: MarkdownBlockKind, context: Context) -> MarkdownBlock {
        MarkdownBlock {
            key: format!("{}:{}", kind.js_name(), start(node)),
            source: Vec::new(),
            kind,
            indent: context.indent,
            quote: context.quote,
            marker: String::new(),
            runs: Vec::new(),
            text: String::new(),
            level: 0,
            language: String::new(),
            table: None,
        }
    }

    fn phrasing(
        &mut self,
        node: &Node,
        children: &[Node],
        kind: MarkdownBlockKind,
        level: u32,
        context: Context,
    ) -> Result<(), String> {
        let mut block = self.block(node, kind, context);
        for child in children {
            inline(
                self.source,
                &self.references,
                child,
                Marks::default(),
                None,
                context.quote,
                &mut block.runs,
            )?;
        }
        block.level = level;
        self.blocks.push(block);
        Ok(())
    }
}

fn begins_with_list(node: Option<&Node>) -> bool {
    match node {
        Some(Node::List(_)) => true,
        Some(Node::Blockquote(quote)) => begins_with_list(quote.children.first()),
        _ => false,
    }
}

fn inline(
    source: &str,
    references: &BTreeMap<String, String>,
    node: &Node,
    marks: Marks,
    link: Option<&MarkdownLink>,
    quote: u32,
    runs: &mut Vec<MarkdownRun>,
) -> Result<(), String> {
    let image = match node {
        Node::Image(value) => Some((&value.url, &value.alt)),
        Node::ImageReference(value) => references
            .get(&value.identifier)
            .map(|target| (target, &value.alt)),
        _ => None,
    };
    if let Some((target, alt)) = image {
        // This is the native Text attachment's real object-replacement atom,
        // not a hidden text/caption substitute for the image's geometry.
        runs.push(MarkdownRun {
            key: format!("image:{}", start(node)),
            source: vec![MarkdownSourceSegment {
                start: 0,
                end: 1,
                source_start: start(node) as u64,
                source_end: (start(node) + raw(source, node).len()) as u64,
                kind: MarkdownSourceKind::Replacement,
            }],
            text: "\u{fffc}".into(),
            strong: marks.strong,
            emphasis: marks.emphasis,
            strike: marks.strike,
            code: marks.code,
            link: link.cloned(),
            image: Some(MarkdownImage {
                target: target.clone(),
                alt: alt.clone(),
            }),
        });
        return Ok(());
    }
    let linked = match node {
        Node::Link(value) => Some((&value.children, &value.url)),
        Node::LinkReference(value) => references
            .get(&value.identifier)
            .map(|target| (&value.children, target)),
        _ => None,
    };
    if let Some((children, target)) = linked {
        let target = MarkdownLink {
            key: format!("link:{}", start(node)),
            target: target.clone(),
        };
        for child in children {
            inline(source, references, child, marks, Some(&target), quote, runs)?;
        }
        return Ok(());
    }
    let children = match node {
        Node::Strong(strong) => Some((
            &strong.children,
            Marks {
                strong: true,
                ..marks
            },
        )),
        Node::Emphasis(emphasis) => Some((
            &emphasis.children,
            Marks {
                emphasis: true,
                ..marks
            },
        )),
        Node::Delete(delete) => Some((
            &delete.children,
            Marks {
                strike: true,
                ..marks
            },
        )),
        _ => None,
    };
    if let Some((children, marks)) = children {
        for child in children {
            inline(source, references, child, marks, link, quote, runs)?;
        }
        return Ok(());
    }
    let (text, marks) = match node {
        Node::Text(text) => (&*text.value, marks),
        Node::InlineCode(code) => (
            &*code.value,
            Marks {
                code: true,
                ..marks
            },
        ),
        Node::Break(_) => ("\n", marks),
        _ => (raw(source, node), marks),
    };
    if text.is_empty() {
        return Ok(());
    }
    let mut mapped = match node {
        Node::Text(_) => source::text(source, node, text, quote)?,
        Node::InlineCode(_) => source::inline_code(source, node, text, quote)?,
        Node::Break(_) => source::line_break(source, node),
        _ => source::literal(start(node), text),
    };
    if let Some(previous) = runs.last_mut()
        && previous.image.is_none()
        && previous.strong == marks.strong
        && previous.emphasis == marks.emphasis
        && previous.strike == marks.strike
        && previous.code == marks.code
        && previous.link.as_ref() == link
    {
        let shift = previous.source.last().map_or(0, |segment| segment.end);
        for segment in &mut mapped {
            segment.start += shift;
            segment.end += shift;
        }
        previous.source.extend(mapped);
        previous.text.push_str(text);
        return Ok(());
    }
    runs.push(MarkdownRun {
        key: format!("inline:{}", start(node)),
        source: mapped,
        text: text.into(),
        strong: marks.strong,
        emphasis: marks.emphasis,
        strike: marks.strike,
        code: marks.code,
        link: link.cloned(),
        image: None,
    });
    Ok(())
}

fn start(node: &Node) -> usize {
    node.position()
        .expect("Markdown parser assigns source positions")
        .start
        .offset
}

fn raw<'a>(source: &'a str, node: &Node) -> &'a str {
    let position = node
        .position()
        .expect("Markdown parser assigns source positions");
    &source[position.start.offset..position.end.offset]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixed_blocks_keep_structure_and_nested_inline_marks() {
        let blocks = parse_source(
            "# Heading\n\nPlain **bold and *both***, ~~gone~~ and `code`.\n\n> quote\n\n3. first\n\n   second\n\n- [x] done\n\n```rust\nlet answer = 42;\n```\n\n---",
        )
        .unwrap();
        assert_eq!(blocks[0].kind, MarkdownBlockKind::Heading);
        assert_eq!(blocks[0].level, 1);
        assert_eq!(blocks[0].runs[0].text, "Heading");
        assert!(
            blocks[1]
                .runs
                .iter()
                .any(|run| run.strong && run.emphasis && run.text == "both")
        );
        assert!(
            blocks[1]
                .runs
                .iter()
                .any(|run| run.strike && run.text == "gone")
        );
        assert!(
            blocks[1]
                .runs
                .iter()
                .any(|run| run.code && run.text == "code")
        );
        assert_eq!(blocks[2].quote, 1);
        assert_eq!(blocks[3].marker, "3.");
        assert_eq!(blocks[4].marker, "");
        assert_eq!(blocks[5].marker, "• [x]");
        assert_eq!(blocks[6].kind, MarkdownBlockKind::Code);
        assert_eq!(blocks[6].language, "rust");
        assert_eq!(blocks[6].text, "let answer = 42;");
        assert_eq!(blocks[7].kind, MarkdownBlockKind::Rule);
        assert_eq!(blocks[7].text, "---");
    }

    #[test]
    fn unicode_offsets_and_append_preserve_block_and_run_identity() {
        let first = parse_source("你好 **粗体** 👩🏽‍💻 e\u{301}").unwrap();
        let next = parse_source("你好 **粗体** 👩🏽‍💻 e\u{301} more").unwrap();
        assert_eq!(first[0].key, next[0].key);
        assert_eq!(first[0].runs[0].key, next[0].runs[0].key);
        assert_eq!(first[0].runs[1].text, "粗体");
        assert_eq!(
            first[0].runs[0].source,
            [MarkdownSourceSegment {
                start: 0,
                end: 3,
                source_start: 0,
                source_end: 7,
                kind: MarkdownSourceKind::Literal,
            }]
        );
        assert_eq!(
            first[0].runs[1].source,
            [MarkdownSourceSegment {
                start: 0,
                end: 2,
                source_start: 9,
                source_end: 15,
                kind: MarkdownSourceKind::Literal,
            }]
        );
        assert_eq!(
            first[0].runs[2].source,
            [MarkdownSourceSegment {
                start: 0,
                end: 11,
                source_start: 17,
                source_end: 37,
                kind: MarkdownSourceKind::Literal,
            }]
        );
        assert_eq!(first[0].runs[2].text, " 👩🏽‍💻 e\u{301}");
        assert_eq!(next[0].runs[1].key, first[0].runs[1].key);
    }

    #[test]
    fn source_addresses_keep_entities_escapes_and_inline_code_atomic() {
        let blocks = parse_source("A &amp; \\* &#x1F642; ` a🙂 `").unwrap();
        assert_eq!(blocks[0].runs[0].text, "A & * 🙂 ");
        let ranges: Vec<_> = blocks[0].runs[0]
            .source
            .iter()
            .map(|segment| {
                (
                    segment.start,
                    segment.end,
                    segment.source_start,
                    segment.source_end,
                    segment.kind,
                )
            })
            .collect();
        assert_eq!(
            ranges,
            [
                (0, 2, 0, 2, MarkdownSourceKind::Literal),
                (2, 3, 2, 7, MarkdownSourceKind::Replacement),
                (3, 4, 7, 8, MarkdownSourceKind::Literal),
                (4, 5, 8, 10, MarkdownSourceKind::Replacement),
                (5, 6, 10, 11, MarkdownSourceKind::Literal),
                (6, 8, 11, 20, MarkdownSourceKind::Replacement),
                (8, 9, 20, 21, MarkdownSourceKind::Literal),
            ]
        );
        let invalid = parse_source("&amp; &#999999999999999999999999;").unwrap();
        assert_eq!(invalid[0].runs[0].text, "& &#999999999999999999999999;");
        for original in ["&#00000038;", "&#x0000026;"] {
            let invalid = parse_source(&format!("&amp; {original}")).unwrap();
            assert_eq!(invalid[0].runs[0].text, format!("& {original}"));
        }
        assert_eq!(blocks[0].runs[1].text, "a🙂");
        assert_eq!(
            blocks[0].runs[1].source,
            [MarkdownSourceSegment {
                start: 0,
                end: 3,
                source_start: 23,
                source_end: 28,
                kind: MarkdownSourceKind::Literal,
            }]
        );
        for (original, expected, ranges) in [
            ("a \nb", "a\nb", vec![(0, 1, 0, 1), (1, 3, 2, 4)]),
            ("a\t \nb", "a\nb", vec![(0, 1, 0, 1), (1, 3, 3, 5)]),
            (
                "a\n  &#32;b",
                "a\n b",
                vec![(0, 2, 0, 2), (2, 3, 4, 9), (3, 4, 9, 10)],
            ),
        ] {
            let blocks = parse_source(original).unwrap();
            let run = &blocks[0].runs[0];
            assert_eq!(run.text, expected);
            assert_eq!(
                run.source
                    .iter()
                    .map(|segment| (
                        segment.start,
                        segment.end,
                        segment.source_start,
                        segment.source_end,
                    ))
                    .collect::<Vec<_>>(),
                ranges,
            );
        }
    }

    #[test]
    fn tables_keep_columns_rows_empty_cells_and_nested_inline_marks() {
        let source = "| 左 **列** | *中* | 右 | 默认 |\n| :--- | :---: | ---: | --- |\n| **粗 *斜*** | ~~删~~ | `码🙂` | |\n| 👩🏽‍💻 e\u{301} | | [原](https://example.test) ![图](image.png) | 尾 |";
        let blocks = parse_source(source).unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].kind, MarkdownBlockKind::Table);
        assert_eq!(blocks[0].text, source);
        let table = blocks[0].table.as_ref().unwrap();
        assert_eq!(
            table.columns,
            [
                MarkdownTableAlignment::Left,
                MarkdownTableAlignment::Center,
                MarkdownTableAlignment::Right,
                MarkdownTableAlignment::Left,
            ]
        );
        let text = table
            .rows
            .iter()
            .map(|row| {
                row.cells
                    .iter()
                    .map(|cell| {
                        cell.runs
                            .iter()
                            .map(|run| run.text.as_str())
                            .collect::<String>()
                    })
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            text,
            [
                vec!["左 列", "中", "右", "默认"],
                vec!["粗 斜", "删", "码🙂", ""],
                vec!["👩🏽‍💻 e\u{301}", "", "原 \u{fffc}", "尾",],
            ]
        );
        assert!(table.rows[0].cells[0].runs[1].strong);
        assert!(table.rows[0].cells[1].runs[0].emphasis);
        let nested = &table.rows[1].cells[0].runs[1];
        assert_eq!(nested.text, "斜");
        assert!(nested.strong && nested.emphasis);
        assert!(table.rows[1].cells[1].runs[0].strike);
        assert!(table.rows[1].cells[2].runs[0].code);
        assert!(table.rows[1].cells[3].runs.is_empty());
        assert!(table.rows[2].cells[1].runs.is_empty());
        assert_eq!(
            table
                .rows
                .iter()
                .map(|row| row.key.as_str())
                .collect::<std::collections::HashSet<_>>()
                .len(),
            3
        );
        assert_eq!(
            table
                .rows
                .iter()
                .flat_map(|row| row.cells.iter().map(|cell| cell.key.as_str()))
                .collect::<std::collections::HashSet<_>>()
                .len(),
            12
        );
    }

    #[test]
    fn table_append_keeps_existing_row_cell_and_inline_identity() {
        let source = "前言🙂\n\n| 标题 | 数量 |\n| --- | ---: |\n| **值** | 1";
        let first = parse_source(source).unwrap();
        let next = parse_source(&format!("{source}2 |\n| 新 | 3 |")).unwrap();
        assert_eq!(first[1].key, next[1].key);
        let before = first[1].table.as_ref().unwrap();
        let after = next[1].table.as_ref().unwrap();
        assert_eq!(before.rows.len(), 2);
        assert_eq!(after.rows.len(), 3);
        for (before, after) in before.rows.iter().zip(&after.rows) {
            assert_eq!(before.key, after.key);
            assert_eq!(before.cells.len(), after.cells.len());
            for (before, after) in before.cells.iter().zip(&after.cells) {
                assert_eq!(before.key, after.key);
                assert_eq!(before.runs[0].key, after.runs[0].key);
            }
        }
        assert_eq!(before.rows[1].cells[1].runs[0].text, "1");
        assert_eq!(after.rows[1].cells[1].runs[0].text, "12");
        assert_eq!(after.rows[2].cells[0].runs[0].text, "新");
        assert_eq!(after.rows[2].cells[1].runs[0].text, "3");
        assert!(first[0].table.is_none());
    }

    #[test]
    fn code_fences_keep_exact_utf8_whitespace_and_trailing_blank_line() {
        let blocks =
            parse_source("```rust\n  let 你好 = \"👩🏽‍💻 e\u{301}\";  \n\tprintln!(\"完成\");\n\n```")
                .unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].kind, MarkdownBlockKind::Code);
        assert_eq!(blocks[0].language, "rust");
        assert_eq!(
            blocks[0].text.as_bytes(),
            "  let 你好 = \"👩🏽‍💻 e\u{301}\";  \n\tprintln!(\"完成\");\n".as_bytes()
        );
        assert!(blocks[0].table.is_none());
        let indented = parse_source("    ```\n    x\n    ```").unwrap();
        assert_eq!(indented[0].text, "```\nx\n```");
        assert_eq!(
            indented[0]
                .source
                .iter()
                .map(|segment| (
                    segment.start,
                    segment.end,
                    segment.source_start,
                    segment.source_end,
                ))
                .collect::<Vec<_>>(),
            [(0, 4, 4, 8), (4, 6, 12, 14), (6, 9, 18, 21)]
        );
        let nul = parse_source("```\na\0b\n```").unwrap();
        assert_eq!(nul[0].text, "a\0b");
        assert_eq!(
            nul[0].source,
            [MarkdownSourceSegment {
                start: 0,
                end: 3,
                source_start: 4,
                source_end: 7,
                kind: MarkdownSourceKind::Literal,
            }]
        );
    }

    #[test]
    fn links_keep_their_own_identity_targets_and_nested_styles() {
        let source = "[plain **粗体** *斜体*](https://example.test/a)[next](https://example.test/a) [文档][Docs]\n\n[docs]: ./报告%20原文.txt\n";
        let blocks = parse_source(source).unwrap();
        assert_eq!(
            blocks.len(),
            1,
            "reference definitions are not visible prose"
        );
        let runs = &blocks[0].runs;
        assert_eq!(
            runs.iter().map(|run| run.text.as_str()).collect::<String>(),
            "plain 粗体 斜体next 文档"
        );
        let first = runs[0].link.as_ref().unwrap();
        assert_eq!(first.target, "https://example.test/a");
        assert!(
            runs.iter()
                .any(|run| run.strong && run.text == "粗体" && run.link.as_ref() == Some(first))
        );
        assert!(
            runs.iter()
                .any(|run| run.emphasis && run.text == "斜体" && run.link.as_ref() == Some(first))
        );
        let next = runs
            .iter()
            .find(|run| run.text == "next")
            .unwrap()
            .link
            .as_ref()
            .unwrap();
        assert_eq!(next.target, first.target);
        assert_ne!(
            next.key, first.key,
            "adjacent links to one URL remain distinct keyboard targets"
        );
        assert_eq!(
            runs.last().unwrap().link.as_ref().unwrap().target,
            "./报告%20原文.txt"
        );
    }

    #[test]
    fn workspace_images_keep_mixed_text_references_and_atomic_source_addresses() {
        let source = "前🙂 **![图](./图%20原.png)** 中 ![第二][image] 后 [![链接图](preview.png)](report.txt) ![missing][unknown]\n\n[image]: ./second.png\n";
        let blocks = parse_source(source).unwrap();
        assert_eq!(blocks.len(), 1);
        let runs = &blocks[0].runs;
        assert_eq!(
            runs.iter().map(|run| run.text.as_str()).collect::<String>(),
            "前🙂 \u{fffc} 中 \u{fffc} 后 \u{fffc} ![missing][unknown]"
        );
        let images = runs
            .iter()
            .filter(|run| run.image.is_some())
            .collect::<Vec<_>>();
        assert_eq!(images.len(), 3);
        for (run, syntax, target, alt) in [
            (images[0], "![图](./图%20原.png)", "./图%20原.png", "图"),
            (images[1], "![第二][image]", "./second.png", "第二"),
            (images[2], "![链接图](preview.png)", "preview.png", "链接图"),
        ] {
            assert_eq!(run.text, "\u{fffc}");
            assert_eq!(
                run.image.as_ref().unwrap(),
                &MarkdownImage {
                    target: target.into(),
                    alt: alt.into()
                }
            );
            let start = source.find(syntax).unwrap() as u64;
            assert_eq!(
                run.source,
                [MarkdownSourceSegment {
                    start: 0,
                    end: 1,
                    source_start: start,
                    source_end: start + syntax.len() as u64,
                    kind: MarkdownSourceKind::Replacement,
                }]
            );
        }
        assert!(images[0].strong);
        assert!(images[0].link.is_none());
        assert_eq!(images[2].link.as_ref().unwrap().target, "report.txt");
        let following = runs.iter().find(|run| run.text == " 中 ").unwrap();
        let start = source.find(" 中 ").unwrap() as u64;
        assert_eq!(
            following.source,
            [MarkdownSourceSegment {
                start: 0,
                end: 3,
                source_start: start,
                source_end: start + 5,
                kind: MarkdownSourceKind::Literal,
            }]
        );
        assert!(following.image.is_none());
    }

    #[test]
    fn unsupported_constructs_keep_complete_source_without_activation() {
        let source = "[label](https://example.test/target) ![alt](image.png) [^note]\n\n| left | right |\n| --- | --- |\n| 一 | 二 |\n\n<div>HTML</div>\n\n[id]: https://example.test/definition\n\n[^note]: footnote\n\n$E = mc^2$ \\(x\\) \\[y\\]";
        let blocks = parse_source(source).unwrap();
        assert_eq!(blocks[0].runs[0].text, "label");
        assert_eq!(blocks[0].runs[1].text, " ");
        assert_eq!(blocks[0].runs[2].text, "\u{fffc}");
        assert_eq!(
            blocks[0].runs[2].image.as_ref().unwrap(),
            &MarkdownImage {
                target: "image.png".into(),
                alt: "alt".into()
            }
        );
        assert_eq!(blocks[0].runs[3].text, " [^note]");
        assert_eq!(
            blocks[0].runs[0].link.as_ref().unwrap().target,
            "https://example.test/target"
        );
        assert!(blocks[0].runs[1].link.is_none());
        for original in [
            "<div>HTML</div>",
            // The footnote container includes its final line ending.
            "[^note]: footnote\n",
        ] {
            assert!(
                blocks.iter().any(|block| block.kind == MarkdownBlockKind::Literal && block.text == original),
                "missing exact literal {original:?} in {blocks:#?}",
            );
        }
        assert_eq!(blocks.last().unwrap().runs[0].text, "$E = mc^2$ (x) [y]");
    }

    #[test]
    fn long_rich_response_keeps_every_formatted_block_and_inline_run() {
        let paragraph = "完整内容".repeat(400);
        let mut source = (1..=60)
            .map(|number| format!("段落 {number} **{paragraph}**"))
            .collect::<Vec<_>>()
            .join("\n\n");
        source.push_str("\n\n");
        source.push_str(&"**bold** plain ".repeat(1100));
        source.push_str("**last**");
        let blocks = parse_source(&source).unwrap();
        assert_eq!(blocks.len(), 61);
        for (index, block) in blocks[..60].iter().enumerate() {
            assert_eq!(block.kind, MarkdownBlockKind::Paragraph);
            assert_eq!(block.runs[0].text, format!("段落 {} ", index + 1));
            assert_eq!(block.runs[1].text, paragraph);
            assert!(block.runs[1].strong);
        }
        let rich = &blocks[60];
        assert_eq!(rich.kind, MarkdownBlockKind::Paragraph);
        assert_eq!(rich.runs.len(), 2201);
        assert!(rich.runs[..2200].as_chunks::<2>().0.iter().all(|pair| {
            pair[0].strong && pair[0].text == "bold" && !pair[1].strong && pair[1].text == " plain "
        }));
        assert_eq!(rich.runs[2200].text, "last");
        assert!(rich.runs[2200].strong);
    }

    #[test]
    fn empty_list_items_keep_their_marker() {
        let blocks = parse_source("-\n- filled").unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].marker, "•");
        assert!(blocks[0].runs.is_empty());
        assert_eq!(blocks[1].marker, "•");
        assert_eq!(blocks[1].runs[0].text, "filled");
    }

    #[test]
    fn nested_list_through_quote_keeps_both_item_markers() {
        let blocks = parse_source("- > 3. nested").unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].marker, "•");
        assert!(blocks[0].runs.is_empty());
        assert_eq!(blocks[1].marker, "3.");
        assert_eq!(blocks[1].quote, 1);
        assert_eq!(blocks[1].runs[0].text, "nested");
    }
}

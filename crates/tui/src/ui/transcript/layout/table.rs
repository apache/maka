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
use pulldown_cmark::Alignment;

struct Cell<'a> {
    events: Vec<(Event<'a>, Range<usize>)>,
    source: usize,
}

pub(super) fn render<'a>(
    writer: &mut Writer,
    source: &str,
    alignments: Vec<Alignment>,
    events: &mut impl Iterator<Item = (Event<'a>, Range<usize>)>,
    ascii: bool,
) -> Result<(), &'static str> {
    const MAX_CELLS: usize = 32_768;
    const MAX_EVENTS: usize = 262_144;
    let columns = alignments.len();
    if columns == 0 || columns > 128 {
        return Err("Table column capacity exceeded");
    }
    let mut rows: Vec<Vec<Cell<'a>>> = vec![];
    let mut cells = 0;
    let mut count = 0;
    for (event, range) in events.by_ref() {
        count += 1;
        if count > MAX_EVENTS {
            return Err("Table event capacity exceeded");
        }
        match event {
            Event::End(TagEnd::Table) => break,
            Event::Start(Tag::TableHead | Tag::TableRow) => rows.push(vec![]),
            Event::End(TagEnd::TableHead | TagEnd::TableRow | TagEnd::TableCell) => {}
            Event::Start(Tag::TableCell) => {
                cells += 1;
                if cells > MAX_CELLS {
                    return Err("Table cell capacity exceeded");
                }
                rows.last_mut().ok_or("Table cell without row")?.push(Cell {
                    events: vec![],
                    source: range.start,
                });
            }
            event => rows
                .last_mut()
                .and_then(|row| row.last_mut())
                .ok_or("Table content without cell")?
                .events
                .push((event, range)),
        }
    }
    if rows.is_empty() || rows.iter().any(|row| row.len() != columns) {
        return Err("Invalid table geometry");
    }
    writer.boundary()?;
    let indent = writer.indent.min(writer.width.saturating_sub(1));
    let width = writer.width - indent;
    if width < columns + (columns - 1) * 3 {
        stacked(writer, source, &rows, width, indent, ascii)?;
    } else {
        grid(writer, source, &rows, &alignments, width, indent, ascii)?;
    }
    writer.logical("\n");
    writer.gap()
}

fn semantic(writer: &mut Writer, layout: &mut Layout, separator: &str) -> Result<(), &'static str> {
    writer.logical(separator);
    let start = writer.text.len();
    writer.logical(&layout.text);
    if writer.bytes > MAX_BYTES {
        return Err("Transcript layout exceeds local capacity");
    }
    for span in layout.lines.iter_mut().flat_map(|line| &mut line.mapping) {
        span.logical.start += start;
        span.logical.end += start;
    }
    Ok(())
}

fn cell(
    cell: &Cell<'_>,
    source: &str,
    width: usize,
    ascii: bool,
    colors: crate::theme::Palette,
) -> Result<Layout, &'static str> {
    let mut layout = render_events(
        source,
        cell.events.iter().cloned(),
        width as u16,
        ascii,
        true,
        &mut syntax::Cache::new(colors),
    )?;
    if cell.events.is_empty() {
        layout.lines[0].source = cell.source;
    }
    Ok(layout)
}
fn append(writer: &mut Writer, mut line: VisualLine, indent: usize) -> Result<(), &'static str> {
    if indent > 0 {
        line.line.spans.insert(0, Span::raw(" ".repeat(indent)));
        for span in &mut line.mapping {
            span.display.start += indent;
            span.display.end += indent;
        }
    }
    let bytes = std::mem::size_of::<VisualLine>()
        + line.mapping.len() * std::mem::size_of::<SourceSpan>()
        + line
            .line
            .spans
            .iter()
            .map(|span| std::mem::size_of::<Span<'static>>() + span.content.len())
            .sum::<usize>();
    if writer.lines.len() >= MAX_LINES || writer.bytes + bytes > MAX_BYTES {
        return Err("Transcript layout exceeds local capacity");
    }
    writer.bytes += bytes;
    writer.lines.push(line);
    Ok(())
}
fn grid(
    writer: &mut Writer,
    source: &str,
    rows: &[Vec<Cell<'_>>],
    align: &[Alignment],
    width: usize,
    indent: usize,
    ascii: bool,
) -> Result<(), &'static str> {
    let columns = align.len();
    let available = width - (columns - 1) * 3;
    let mut preferred = vec![1; columns];
    for row in rows {
        for (column, item) in row.iter().enumerate() {
            let layout = cell(item, source, available, ascii, writer.colors)?;
            preferred[column] = preferred[column].max(
                layout
                    .lines
                    .iter()
                    .map(|line| line.line.width())
                    .max()
                    .unwrap_or(1),
            );
        }
    }
    // Fitting one CJK glyph per column is not a readable table. Preserve at least
    // four cells for nontrivial columns, while genuinely short columns stay compact.
    if preferred.iter().map(|size| (*size).min(4)).sum::<usize>() > available {
        return stacked(writer, source, rows, width, indent, ascii);
    }
    // Water-fill the columns: short labels do not steal space from long descriptions.
    let mut low = 1;
    let mut high = available;
    while low < high {
        let mid = (low + high).div_ceil(2);
        if preferred.iter().map(|size| (*size).min(mid)).sum::<usize>() <= available {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    let mut widths: Vec<_> = preferred.iter().map(|size| (*size).min(low)).collect();
    let mut left = available - widths.iter().sum::<usize>();
    for (size, preferred) in widths.iter_mut().zip(&preferred) {
        if left > 0 && *size < *preferred {
            *size += 1;
            left -= 1;
        }
    }
    for (row_index, row) in rows.iter().enumerate() {
        let mut layouts = Vec::with_capacity(columns);
        let mut bytes = 0;
        for (column, (item, width)) in row.iter().zip(&widths).enumerate() {
            let mut layout = cell(item, source, *width, ascii, writer.colors)?;
            semantic(
                writer,
                &mut layout,
                if column > 0 {
                    "\t"
                } else if row_index > 0 {
                    "\n"
                } else {
                    ""
                },
            )?;
            bytes += layout.bytes;
            if bytes > MAX_BYTES {
                return Err("Table row capacity exceeded");
            }
            layouts.push(layout);
        }
        let height = layouts
            .iter()
            .map(|layout| layout.lines.len())
            .max()
            .unwrap_or(1);
        for y in 0..height {
            let mut line = Line::default();
            let mut mapping = vec![];
            let mut display = 0;
            let mut position = None;
            for (column, (layout, width)) in layouts.iter().zip(&widths).enumerate() {
                if column > 0 {
                    line.spans.push(Span::styled(
                        if ascii { " | " } else { " │ " },
                        Style::default().fg(writer.colors.subtle),
                    ));
                    display += if ascii { " | " } else { " │ " }.len();
                }
                let content = layout.lines.get(y);
                if let Some(content) = content {
                    position.get_or_insert(content.source);
                }
                let used = content.map_or(0, |line| line.line.width());
                let padding = width.saturating_sub(used);
                let before = match align[column] {
                    Alignment::Right => padding,
                    Alignment::Center => padding / 2,
                    _ => 0,
                };
                line.spans.push(Span::raw(" ".repeat(before)));
                display += before;
                if let Some(content) = content {
                    mapping.extend(content.mapping.iter().cloned().map(|mut span| {
                        span.display.start += display;
                        span.display.end += display;
                        span
                    }));
                    display += content
                        .line
                        .spans
                        .iter()
                        .map(|span| span.content.len())
                        .sum::<usize>();
                    line.spans
                        .extend(content.line.spans.iter().cloned().map(|span| {
                            if row_index == 0 {
                                span.patch_style(Style::default().add_modifier(Modifier::BOLD))
                            } else {
                                span
                            }
                        }));
                }
                line.spans.push(Span::raw(" ".repeat(padding - before)));
                display += padding - before;
            }
            append(
                writer,
                VisualLine {
                    line,
                    source: position.unwrap_or(row[0].source),
                    mapping,
                },
                indent,
            )?;
        }
        if row_index == 0 {
            let line = widths
                .iter()
                .map(|width| if ascii { "-" } else { "─" }.repeat(*width))
                .collect::<Vec<_>>()
                .join(if ascii { "-+-" } else { "─┼─" });
            append(
                writer,
                VisualLine {
                    line: Line::styled(line, Style::default().fg(writer.colors.subtle)),
                    source: row.last().unwrap().source,
                    mapping: vec![],
                },
                indent,
            )?;
        }
    }
    Ok(())
}
fn stacked(
    writer: &mut Writer,
    source: &str,
    rows: &[Vec<Cell<'_>>],
    width: usize,
    indent: usize,
    ascii: bool,
) -> Result<(), &'static str> {
    // A narrow terminal gets labeled fields, not squeezed columns or silently hidden cells.
    let mut headers = Vec::with_capacity(rows[0].len());
    let mut bytes = 0;
    for (column, item) in rows[0].iter().enumerate() {
        let mut header = cell(item, source, width, ascii, writer.colors)?;
        semantic(writer, &mut header, if column > 0 { "\t" } else { "" })?;
        bytes += header.bytes;
        if bytes > MAX_BYTES {
            return Err("Table header capacity exceeded");
        }
        headers.push(header);
    }
    if rows.len() == 1 {
        for header in headers {
            for line in header.lines {
                append(writer, line, indent)?;
            }
        }
    } else {
        for row in &rows[1..] {
            for (column, (item, header)) in row.iter().zip(&headers).enumerate() {
                for line in &header.lines {
                    let mut line = line.clone();
                    line.source = item.source; // Repeated labels belong to this record's cell.
                    line.mapping.clear(); // Repeated labels are decoration, not this cell's value.
                    line.line = line.line.patch_style(
                        Style::default()
                            .fg(writer.colors.accent)
                            .add_modifier(Modifier::BOLD),
                    );
                    append(writer, line, indent)?;
                }
                let mut layout = cell(item, source, width, ascii, writer.colors)?;
                semantic(writer, &mut layout, if column > 0 { "\t" } else { "\n" })?;
                for line in layout.lines {
                    append(writer, line, indent)?;
                }
            }
            append(
                writer,
                VisualLine {
                    line: Line::default(),
                    source: row.last().unwrap().source,
                    mapping: vec![],
                },
                indent,
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tables_align_unicode_wrap_cells_and_stack_without_losing_values() {
        let text = "| Name | Count | Center |\n| :--- | ---: | :---: |\n| **中文🦀** | 7 | ok |\n| long description wraps here | 123 | z |\n";
        let wide = markdown(text, 64, false).unwrap();
        let lines: Vec<_> = wide
            .lines
            .iter()
            .map(|line| line.line.to_string())
            .collect();
        let separators: Vec<Vec<_>> = lines
            .iter()
            .filter(|line| line.contains('│'))
            .map(|line| {
                line.match_indices('│')
                    .map(|(byte, _)| line[..byte].width())
                    .collect()
            })
            .collect();
        assert!(separators.windows(2).all(|pair| pair[0] == pair[1]));
        assert!(lines.iter().any(|line| line.contains("    7")));
        assert!(
            wide.lines
                .iter()
                .flat_map(|line| &line.line.spans)
                .any(|span| span.content.contains("中文")
                    && span.style.add_modifier.contains(Modifier::BOLD))
        );
        for width in [1, 5, 12, 24, 64] {
            let layout = markdown(text, width, false).unwrap();
            assert_eq!(
                layout.text,
                "Name\tCount\tCenter\n中文🦀\t7\tok\nlong description wraps here\t123\tz"
            );
            assert!(
                layout
                    .lines
                    .iter()
                    .all(|line| line.line.width() <= width as usize)
            );
            let visible: String = layout
                .lines
                .iter()
                .map(|line| line.line.to_string())
                .collect();
            assert!(visible.contains('7') && visible.contains('z'));
        }
        let narrow = markdown(text, 5, true).unwrap();
        let visible: String = narrow
            .lines
            .iter()
            .map(|line| line.line.to_string())
            .collect();
        assert!(
            visible.contains("Count7"),
            "narrow records retain their column label"
        );
        assert!(visible.contains("123"));
        let eight = "| 项目 | 数量 | 状态 | 耗时 | 负责人 | 分支 | 备注 | 校验 |\n|---|---:|:---:|---|---|---|---|---|\n| 中文🦀 | 7 | 正常 | 2ms | A | main | 通过 | 是 |\n";
        let compact = markdown(eight, 40, false).unwrap();
        let visible: String = compact
            .lines
            .iter()
            .map(|line| line.line.to_string())
            .collect();
        assert!(
            visible.contains("数量7") && !visible.contains('│'),
            "narrow CJK tables use labeled fields, not unreadable one-glyph columns"
        );
        let many = format!(
            "|{}|\n|{}|\n",
            vec!["x"; 129].join("|"),
            vec!["---"; 129].join("|")
        );
        assert!(markdown(&many, 80, false).is_err());
    }
}

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

use nsh_base::text_view::{Block, Inline, MarkdownOptions, Parser};

fn emphasis(body: &str, suffix: &str) -> Block {
    Block::paragraph(vec![
        Inline::Strong {
            content: vec![Inline::text(body)],
        },
        Inline::text(suffix),
    ])
}

#[test]
fn cjk_emphasis_keeps_punctuation_inside_the_emphasis() {
    for (body, suffix) in [
        ("结论：", "继续"),
        ("“甲”和“乙”", "都是重点"),
        ("营收（同比 +12%）", "增长明显"),
        ("增长12%", "明显"),
    ] {
        let source = format!("**{body}**{suffix}");
        assert_eq!(
            Parser::new().markdown(&source).blocks,
            vec![emphasis(body, suffix)],
            "{source}"
        );
    }
    assert_eq!(
        Parser::new()
            .markdown("他说**“不行”**然后，*注：*继续，~~旧价：~~新价")
            .blocks,
        vec![Block::paragraph(vec![
            Inline::text("他说"),
            Inline::Strong {
                content: vec![Inline::text("“不行”")]
            },
            Inline::text("然后，"),
            Inline::Emphasis {
                content: vec![Inline::text("注：")]
            },
            Inline::text("继续，"),
            Inline::Strikethrough {
                content: vec![Inline::text("旧价：")]
            },
            Inline::text("新价"),
        ])]
    );
}

fn code_body(block: &Block) -> &str {
    match block {
        Block::CodeBlock(code) => &code.code,
        Block::Blockquote { children, .. } if children.len() == 1 => code_body(&children[0]),
        Block::List { items, .. } if items.len() == 1 && items[0].children.len() == 1 => {
            code_body(&items[0].children[0])
        }
        _ => panic!("expected one code block, optionally inside containers: {block:?}"),
    }
}

#[test]
fn code_in_quotes_lists_and_html_keeps_its_literal_body_beside_cjk_prose() {
    for literal in [
        "```\n**原文：**继续\n```",
        "    **原文：**继续",
        ">     **原文：**继续",
        "- >     **原文：**继续",
        "1. >     **原文：**继续",
        "- > >     **原文：**继续",
        "<pre>**原文：**继续</pre>",
    ] {
        let source = format!("**前文：**继续\n\n{literal}\n\n**后文：**继续");
        let document = Parser::new().markdown(&source);
        let [before, code, after] = document.blocks.as_slice() else {
            panic!("{source}: {document:?}");
        };
        assert_eq!(before, &emphasis("前文：", "继续"), "{source}");
        assert_eq!(code_body(code), "**原文：**继续", "{source}");
        assert_eq!(after, &emphasis("后文：", "继续"), "{source}");
    }
}

#[test]
fn raw_html_across_blank_lines_preserves_text_without_disabling_adjacent_emphasis() {
    // Literal mode exposes the restored source even for hidden scripts and comments.
    let parser = Parser::new().options(MarkdownOptions {
        html: false,
        ..MarkdownOptions::default()
    });
    for raw in [
        "<pre>\n\n**原文：**继续\n</pre>",
        "<script>\n\n**原文：**继续\n</script>",
        "<!--\n\n**原文：**继续\n-->",
    ] {
        let source = format!("**前文：**继续\n\n{raw}\n\n**后文：**继续");
        let document = parser.markdown(&source);
        let [before, html, after] = document.blocks.as_slice() else {
            panic!("{source}: {document:?}");
        };
        assert_eq!(before, &emphasis("前文：", "继续"), "{source}");
        assert_eq!(html.plain_text(), raw, "{source}");
        assert_eq!(after, &emphasis("后文：", "继续"), "{source}");
    }
}

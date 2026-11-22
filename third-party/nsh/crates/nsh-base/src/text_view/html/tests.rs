use super::*;
use crate::text_view::MarkdownExtension;

fn doc(source: &str) -> Vec<Block> {
    parse(&Parser::new(), source).blocks
}

fn t(text: &str) -> Inline {
    Inline::text(text)
}

fn p(content: Vec<Inline>) -> Block {
    Block::Paragraph { content }
}

fn cell(text: &str) -> TableCell {
    TableCell::new(if text.is_empty() {
        vec![]
    } else {
        vec![t(text)]
    })
}

#[test]
fn paragraphs_and_containers() {
    assert_eq!(
        doc("<p>One</p><p>Two</p>"),
        vec![p(vec![t("One")]), p(vec![t("Two")])]
    );
    // Inline runs between blocks of a container are paragraphs.
    assert_eq!(
        doc("<div>before<section><p>inner</p></section>after <span>span</span></div>"),
        vec![
            p(vec![t("before")]),
            p(vec![t("inner")]),
            p(vec![t("after span")])
        ]
    );
    // Empty paragraphs are dropped.
    assert_eq!(doc("<p>  </p><div>\n</div><p><br></p>"), vec![]);
    // A bare fragment is a paragraph.
    assert_eq!(
        doc("Hello <b>world</b>"),
        vec![p(vec![
            t("Hello "),
            Inline::Strong {
                content: vec![t("world")]
            }
        ])]
    );
}

#[test]
fn whitespace_collapses() {
    assert_eq!(
        doc("<p>\n   a \t\n b  <em> c </em>  d\u{a0}\u{a0}e   </p>"),
        vec![p(vec![
            t("a b "),
            Inline::Emphasis {
                content: vec![t("c")]
            },
            t(" d\u{a0}\u{a0}e"),
        ])]
    );
    // No space at the start of a line after a break, none before it.
    assert_eq!(
        doc("<p>a <br>  b</p>"),
        vec![p(vec![t("a"), Inline::Break, t("b")])]
    );
    // A space at the end of a link goes after it.
    assert_eq!(
        doc("<p><a href=\"/x\">link </a>next</p>"),
        vec![p(vec![
            Inline::Link {
                url: "/x".into(),
                title: None,
                content: vec![t("link")]
            },
            t(" next"),
        ])]
    );
    // Text nodes merge.
    assert_eq!(doc("<p>a<span>b</span>c</p>"), vec![p(vec![t("abc")])]);
}

#[test]
fn inline_elements() {
    let blocks = doc(concat!(
        "<p><strong>s</strong><b>b</b><em>e</em><i>i</i><cite>c</cite><del>d</del><s>s</s>",
        "<u>u</u><ins>n</ins><mark>m</mark><sup>2</sup><sub>0</sub>",
        "<code>let  x</code><tt>tt</tt><kbd><kbd>Ctrl</kbd>+<kbd>C</kbd></kbd>",
        "<a href=\"https://a.b\" title=\"T\">l</a><a name=\"x\">plain</a>",
        "<img src=\"i.png\" alt=\"A\" title=\"I\"><q>q</q><abbr title=\"x\">ab</abbr><small>sm</small>",
        "</p>"
    ));
    assert_eq!(
        blocks,
        vec![p(vec![
            Inline::Strong {
                content: vec![t("s")]
            },
            Inline::Strong {
                content: vec![t("b")]
            },
            Inline::Emphasis {
                content: vec![t("e")]
            },
            Inline::Emphasis {
                content: vec![t("i")]
            },
            Inline::Emphasis {
                content: vec![t("c")]
            },
            Inline::Strikethrough {
                content: vec![t("d")]
            },
            Inline::Strikethrough {
                content: vec![t("s")]
            },
            Inline::Underline {
                content: vec![t("u")]
            },
            Inline::Underline {
                content: vec![t("n")]
            },
            Inline::Highlight {
                content: vec![t("m")],
                color: None,
            },
            Inline::Superscript {
                content: vec![t("2")]
            },
            Inline::Subscript {
                content: vec![t("0")]
            },
            Inline::Code {
                code: "let x".into()
            },
            Inline::Code { code: "tt".into() },
            Inline::Keyboard {
                text: "Ctrl+C".into()
            },
            Inline::Link {
                url: "https://a.b".into(),
                title: Some("T".into()),
                content: vec![t("l")]
            },
            t("plain"),
            Inline::Image(Image {
                src: "i.png".into(),
                alt: "A".into(),
                title: Some("I".into()),
                ..Image::default()
            }),
            t("\u{201c}q\u{201d}ab"),
            Inline::Small {
                content: vec![t("sm")]
            },
        ])]
    );
}

#[test]
fn entities_are_decoded() {
    assert_eq!(
        doc("<p>a &amp; b &lt;c&gt; &copy; &#x4e2d;</p>"),
        vec![p(vec![t("a & b <c> \u{a9} \u{4e2d}")])]
    );
}

#[test]
fn headings_have_anchors() {
    assert_eq!(
        doc("<h1>Getting started!</h1><h2>Intro</h2><h3 id=\"own\">Intro</h3><h2>Intro</h2>"),
        vec![
            Block::Heading {
                level: 1,
                content: vec![t("Getting started!")],
                anchor: Some("getting-started".into())
            },
            Block::Heading {
                level: 2,
                content: vec![t("Intro")],
                anchor: Some("intro".into())
            },
            Block::Heading {
                level: 3,
                content: vec![t("Intro")],
                anchor: Some("own".into())
            },
            Block::Heading {
                level: 2,
                content: vec![t("Intro")],
                anchor: Some("intro-1".into())
            },
        ]
    );
}

#[test]
fn blockquote_rule_and_image() {
    assert_eq!(
        doc("<blockquote><p>q</p>tail</blockquote><hr><img src=\"a.png\">"),
        vec![
            Block::Blockquote {
                children: vec![p(vec![t("q")]), p(vec![t("tail")])],
                alert: None
            },
            Block::Rule,
            p(vec![Inline::Image(Image {
                src: "a.png".into(),
                ..Image::default()
            })]),
        ]
    );
    // GitHub's alerts.
    assert_eq!(
        doc(concat!(
            "<div class=\"markdown-alert markdown-alert-warning\">",
            "<p class=\"markdown-alert-title\"><svg><path/></svg>Warning</p><p>Careful</p></div>"
        )),
        vec![Block::Blockquote {
            children: vec![p(vec![t("Careful")])],
            alert: Some(Alert::Warning)
        }]
    );
}

#[test]
fn lists() {
    assert_eq!(
        doc("<ol start=\"3\"><li>a</li><li>b<ul><li>c</li></ul></li></ol>"),
        vec![Block::List {
            ordered: true,
            start: 3,
            loose: false,
            items: vec![
                ListItem::new(vec![p(vec![t("a")])]),
                ListItem::new(vec![
                    p(vec![t("b")]),
                    Block::List {
                        ordered: false,
                        start: 1,
                        loose: false,
                        items: vec![ListItem::new(vec![p(vec![t("c")])])],
                    },
                ]),
            ],
        }]
    );
    assert_eq!(
        doc("<ul><li><p>a</p></li></ul>"),
        vec![Block::List {
            ordered: false,
            start: 1,
            loose: true,
            items: vec![ListItem::new(vec![p(vec![t("a")])])],
        }]
    );
}

#[test]
fn task_lists() {
    let blocks = doc(concat!(
        "<ul><li><input type=\"checkbox\" checked disabled> done</li>",
        "<li><input type=checkbox> todo</li>",
        "<li><p><input type=\"checkbox\"> in p</p></li><li>plain</li></ul>"
    ));
    let Block::List { items, .. } = &blocks[0] else {
        panic!("{blocks:?}")
    };
    let states: Vec<_> = items.iter().map(|i| i.checked).collect();
    assert_eq!(states, vec![Some(true), Some(false), Some(false), None]);
    assert_eq!(items[0].children, vec![p(vec![t("done")])]);
    assert_eq!(items[2].children, vec![p(vec![t("in p")])]);
}

#[test]
fn pre_keeps_text() {
    assert_eq!(
        doc(
            "<pre><code class=\"hljs language-rust\">fn main() {\n    <span>x</span>  &lt;y&gt;\n}\n</code></pre>"
        ),
        vec![Block::CodeBlock(CodeBlock::new(
            Some("rust".into()),
            "fn main() {\n    x  <y>\n}"
        ))]
    );
    assert_eq!(
        doc("<pre>a\n\n  b</pre>"),
        vec![Block::CodeBlock(CodeBlock::new(None, "a\n\n  b"))]
    );
}

#[test]
fn tables() {
    let blocks = doc(concat!(
        "<table><caption>Cap</caption><thead><tr><th align=\"left\">A</th>",
        "<th style=\"text-align: center\">B</th><th>C</th></tr></thead>",
        "<tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td><td align=right>5</td><td>6</td></tr></tbody>",
        "</table>"
    ));
    assert_eq!(
        blocks,
        vec![
            p(vec![t("Cap")]),
            Block::Table(Table {
                align: vec![
                    ColumnAlign::Left,
                    ColumnAlign::Center,
                    ColumnAlign::None,
                    ColumnAlign::None
                ],
                head: vec![cell("A"), cell("B"), cell("C"), cell("")],
                rows: vec![
                    vec![cell("1"), cell("2"), cell(""), cell("")],
                    vec![cell("3"), cell("4"), cell("5"), cell("6")]
                ],
            }),
        ]
    );
}

#[test]
fn table_without_head_and_spans() {
    let blocks = doc(
        "<table><tr><td>a</td><td>b</td></tr><tr><td colspan=2 style='text-align:right'>c</td></tr></table>",
    );
    assert_eq!(
        blocks,
        vec![Block::Table(Table {
            align: vec![ColumnAlign::Right, ColumnAlign::Right],
            head: vec![cell("a"), cell("b")],
            rows: vec![vec![TableCell {
                colspan: Some(2),
                ..cell("c")
            }]],
        })]
    );
}

#[test]
fn details() {
    assert_eq!(
        doc("<details open><summary>More <b>info</b></summary><p>Body</p>text</details>"),
        vec![Block::Details {
            open: true,
            summary: vec![
                t("More "),
                Inline::Strong {
                    content: vec![t("info")]
                }
            ],
            children: vec![p(vec![t("Body")]), p(vec![t("text")])],
        }]
    );
    assert_eq!(
        doc("<details>x</details>"),
        vec![Block::Details {
            open: false,
            summary: vec![],
            children: vec![p(vec![t("x")])],
        }]
    );
}

#[test]
fn definition_lists() {
    assert_eq!(
        doc("<dl><dt>Term</dt><dd>Meaning</dd></dl>"),
        vec![
            p(vec![Inline::Strong {
                content: vec![t("Term")]
            }]),
            p(vec![t("Meaning")]),
        ]
    );
}

#[test]
fn figure() {
    assert_eq!(
        doc("<figure><img src=\"a.png\" alt=\"A\"><figcaption>Caption</figcaption></figure>"),
        vec![
            p(vec![Inline::Image(Image {
                src: "a.png".into(),
                alt: "A".into(),
                title: None,
                ..Image::default()
            })]),
            p(vec![t("Caption")]),
        ]
    );
}

#[test]
fn whole_page() {
    let blocks = doc(concat!(
        "<!DOCTYPE html><html><head><title>Title</title><style>p{}</style>",
        "<script>alert(1)</script></head><body><!-- comment --><nav hidden>menu</nav>",
        "<article><h1>Story</h1><p>Text<script>x()</script></p>",
        "<template><p>t</p></template><noscript>ns</noscript></article></body></html>"
    ));
    assert_eq!(
        blocks,
        vec![
            Block::Heading {
                level: 1,
                content: vec![t("Story")],
                anchor: Some("story".into())
            },
            p(vec![t("Text")]),
        ]
    );
}

#[test]
fn malformed_html() {
    assert_eq!(
        doc("<p>a<b>bold<i>both</p><p>next"),
        vec![
            p(vec![
                t("a"),
                Inline::Strong {
                    content: vec![
                        t("bold"),
                        Inline::Emphasis {
                            content: vec![t("both")]
                        }
                    ]
                }
            ]),
            p(vec![Inline::Strong {
                content: vec![Inline::Emphasis {
                    content: vec![t("next")]
                }]
            }]),
        ]
    );
    // Never panics, whatever it is given.
    for source in [
        "",
        "<",
        "</p>",
        "<table><td>x",
        "<ul><li><ul>",
        "<<>>&&;",
        "<pre>",
        "<details><summary>",
    ] {
        doc(source);
        inlines(&Parser::new(), source);
    }
    let deep = "<div><span>".repeat(5000) + "x";
    doc(&deep);
    inlines(&Parser::new(), &deep);
}

#[test]
fn tag_extensions() {
    let parser = Parser::new().extension(MarkdownExtension::tag("callout", "Callout"));
    let blocks = parse(&parser, "<Callout kind=\"tip\"><p>Use <b>it</b></p></Callout><p>See <callout kind=x>this</callout>.</p>")
        .blocks;
    assert_eq!(
        blocks,
        vec![
            Block::Custom(
                CustomNode::new("callout")
                    .with_attribute("kind", "tip")
                    .with_text("Use it")
                    .with_children(vec![p(vec![
                        t("Use "),
                        Inline::Strong {
                            content: vec![t("it")]
                        }
                    ])])
            ),
            p(vec![
                t("See "),
                Inline::Custom(
                    CustomNode::new("callout")
                        .with_attribute("kind", "x")
                        .with_text("this")
                        .with_content(vec![t("this")])
                ),
                t("."),
            ]),
        ]
    );
    // Written as JSX writes an empty element.
    let blocks = parse(&parser, "<Callout kind=\"a\" /><p>after</p>").blocks;
    assert_eq!(
        blocks,
        vec![
            Block::Custom(CustomNode::new("callout").with_attribute("kind", "a")),
            p(vec![t("after")]),
        ]
    );
}

#[test]
fn pattern_extensions() {
    let parser = Parser::new().extension(MarkdownExtension::pattern("mention", r"@(\w+)"));
    let blocks = parse(&parser, "<p>hi <b>@ann</b> <code>@not</code></p>").blocks;
    assert_eq!(
        blocks,
        vec![p(vec![
            t("hi "),
            Inline::Strong {
                content: vec![Inline::Custom(
                    CustomNode::new("mention")
                        .with_text("@ann")
                        .with_attribute("1", "ann")
                )]
            },
            t(" "),
            Inline::Code {
                code: "@not".into()
            },
        ])]
    );
}

#[test]
fn math() {
    assert_eq!(
        doc(concat!(
            "<p>Area <span class=\"katex\"><math><semantics><mi>r</mi>",
            "<annotation encoding=\"application/x-tex\">\\pi r^2</annotation></semantics></math>",
            "<span class=\"katex-html\" aria-hidden=\"true\">πr2</span></span></p>"
        )),
        vec![p(vec![
            t("Area "),
            Inline::Math {
                tex: "\\pi r^2".into()
            }
        ])]
    );
}

#[test]
fn fragments() {
    let parser = Parser::new();
    assert_eq!(
        inlines(&parser, "<b>x</b>"),
        vec![Inline::Strong {
            content: vec![t("x")]
        }]
    );
    assert_eq!(inlines(&parser, "<br>"), vec![Inline::Break]);
    assert_eq!(
        inlines(&parser, " <sup>2</sup> "),
        vec![
            t(" "),
            Inline::Superscript {
                content: vec![t("2")]
            },
            t(" ")
        ]
    );
    assert_eq!(
        inlines(&parser, "<p>a</p><p>b</p>"),
        vec![t("a"), Inline::Break, t("b")]
    );
    assert_eq!(
        blocks(&parser, "<div>\n<p>x</p>\n</div>"),
        vec![p(vec![t("x")])]
    );
}

/// An image of `src` sized `width` × `height`.
fn sized(src: &str, width: Option<ImageLength>, height: Option<ImageLength>) -> Inline {
    Inline::Image(Image {
        width,
        height,
        ..Image::new(src)
    })
}

fn pt(points: f32) -> Option<ImageLength> {
    Some(ImageLength::Points(nsh_core::geometry::Points(points)))
}

fn pct(fraction: f32) -> Option<ImageLength> {
    Some(ImageLength::Fraction(nsh_core::geometry::Percentage(
        fraction,
    )))
}

#[test]
fn image_lengths_parse_as_gpui_kit_reads_them() {
    // gpui-kit's `test_value_to_length`.
    assert_eq!(ImageLength::parse("100px"), pt(100.0));
    assert_eq!(ImageLength::parse("100%"), pct(1.0));
    assert_eq!(ImageLength::parse("56%"), pct(0.56));
    assert_eq!(ImageLength::parse("240"), pt(240.0));
    assert_eq!(ImageLength::parse(" 32 px "), pt(32.0));
    assert_eq!(ImageLength::parse("12.5"), pt(12.5));
    for bad in ["", "auto", "2em", "-4", "px", "%", "NaN", "inf"] {
        assert_eq!(ImageLength::parse(bad), None, "{bad}");
    }
}

#[test]
fn images_keep_their_size() {
    // gpui-kit's `test_image`: attributes, then the style's.
    assert_eq!(
        doc(
            r#"<img src="https://example.com/image.png" alt="Example" width="100" height="200" title="Example Image" />"#
        ),
        vec![p(vec![Inline::Image(Image {
            alt: "Example".into(),
            title: Some("Example Image".into()),
            width: pt(100.0),
            height: pt(200.0),
            ..Image::new("https://example.com/image.png")
        })])]
    );
    assert_eq!(
        doc(r#"<img src="a.png" style="width: 80%" />"#),
        vec![p(vec![sized("a.png", pct(0.8), None)])]
    );
    assert_eq!(
        doc(r#"<img src="a.png" style="width:120px;height:40px">"#),
        vec![p(vec![sized("a.png", pt(120.0), pt(40.0))])]
    );
    // An attribute wins over the style; each side is read on its own.
    assert_eq!(
        doc(r#"<img src="a.png" width="10" style="width: 50px; height: 20px">"#),
        vec![p(vec![sized("a.png", pt(10.0), pt(20.0))])]
    );
    // What is not a length is no size.
    assert_eq!(
        doc(r#"<img src="a.png" width="auto" height="2em">"#),
        vec![p(vec![sized("a.png", None, None)])]
    );
    // `data:` URLs are sources as any other.
    assert_eq!(
        doc(r#"<img src="data:image/png;base64,iVBORw0KGgo=" width="16">"#),
        vec![p(vec![sized(
            "data:image/png;base64,iVBORw0KGgo=",
            pt(16.0),
            None
        )])]
    );
}

#[test]
fn images_in_text_and_links() {
    // gpui-kit's fixture: avatars inside a sentence stay in its flow.
    assert_eq!(
        doc(
            r#"<p>Avatars <img src="a.png" alt="A" width="32" height="32" /> and <img src="b.png" width="32" height="32"> here.</p>"#
        ),
        vec![p(vec![
            t("Avatars "),
            Inline::Image(Image {
                alt: "A".into(),
                width: pt(32.0),
                height: pt(32.0),
                ..Image::new("a.png")
            }),
            t(" and "),
            sized("b.png", pt(32.0), pt(32.0)),
            t(" here."),
        ])]
    );
    // A linked image: the link holds it (a press on it is the link's).
    assert_eq!(
        doc(r#"<a href="https://x.y"><img src="a.png" width="20"></a>"#),
        vec![p(vec![Inline::Link {
            url: "https://x.y".into(),
            title: None,
            content: vec![sized("a.png", pt(20.0), None)],
        }])]
    );
}

#[test]
fn mark_colors() {
    // gpui-kit's `test_mark`: `color` first, then the style's background.
    let marks = |html: &str| -> Vec<Option<String>> {
        let blocks = doc(html);
        let Some(Block::Paragraph { content }) = blocks.first() else {
            panic!("{blocks:?}");
        };
        content
            .iter()
            .filter_map(|i| match i {
                Inline::Highlight { color, .. } => Some(color.clone()),
                _ => None,
            })
            .collect()
    };
    assert_eq!(marks("<p>Hello <mark>world</mark></p>"), vec![None]);
    assert_eq!(
        marks(
            r#"<p><mark color="blue">blue</mark> and <mark style="background-color: #336699">hex</mark></p>"#
        ),
        vec![Some("#3b82f6".into()), Some("#336699".into())]
    );
    assert_eq!(
        marks(r##"<p><mark color="#abc" style="background-color: red">a</mark></p>"##),
        vec![Some("#abc".into())]
    );
    // CSS colors in the style, as CSS means them; the rest is no color.
    assert_eq!(
        marks(
            r#"<p><mark style="background-color: rgb(1 2 3)">a</mark><mark color="nope">b</mark></p>"#
        ),
        vec![Some("rgb(1 2 3)".into()), None]
    );
}

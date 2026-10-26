//! Compile and exercise the public types as an existing external engine does.
use nsh_core::{
    AttachmentAlignments, AttributedText, Points, ResolvedTextStyle, Size, TextAttachment,
    TextEngine, TextLayout, VerticalAlign,
};

struct ExistingEngine;
impl TextEngine for ExistingEngine {
    type Prepared = Vec<TextAttachment>;

    fn prepare(&self, text: &AttributedText) -> Self::Prepared {
        text.attachments.clone()
    }

    fn measure(&self, _: &Self::Prepared, _: Option<Points>) -> Size<Points> {
        Size::new(Points(10.0), Points(20.0))
    }

    fn layout(&self, _: &Self::Prepared, _: Size<Points>) -> TextLayout {
        panic!("this test only prepares text")
    }
}

#[test]
fn existing_attachment_literals_and_engines_remain_compatible() {
    let attachment = TextAttachment {
        index: 0,
        width: Points(10.0),
        height: Points(20.0),
    };
    // Enumerate the fields: alignment must not migrate the source break
    // from TextAttachment to AttributedText.
    let mut text = AttributedText {
        text: String::new(),
        spans: Vec::new(),
        align: Default::default(),
        max_lines: 0,
        ellipsize: Default::default(),
        no_wrap: false,
        shadow: None,
        links: Vec::new(),
        test_ids: Vec::new(),
        writing_direction: None,
        rtl: false,
        selectable: None,
        selection_color: None,
        attachments: vec![attachment],
    };
    let engine = ExistingEngine;
    assert_eq!(engine.prepare(&text), vec![attachment]);
    let mut alignments = AttachmentAlignments::default();
    alignments.set(0, VerticalAlign::Middle);
    // The new method has a default, so an old engine still works.
    assert_eq!(engine.prepare_aligned(&text, &alignments), vec![attachment]);

    text.attachments.clear();
    alignments.push(
        &mut text,
        Size::new(Points(10.0), Points(20.0)),
        VerticalAlign::TextTop,
        ResolvedTextStyle::default(),
    );
    assert_eq!(text.attachments, vec![attachment]);
    assert_eq!(alignments.get(0), VerticalAlign::TextTop);
}

#[test]
fn shared_engines_receive_alignment_separately_from_legacy_text() {
    let engine = std::rc::Rc::new(nsh_core::ApproxTextEngine);
    let mut text = AttributedText::default();
    let style = ResolvedTextStyle {
        font_size: Points(10.0),
        ..Default::default()
    };
    let mut alignments = AttachmentAlignments::default();
    alignments.push(
        &mut text,
        Size::new(Points(8.0), Points(6.0)),
        VerticalAlign::Middle,
        style,
    );
    let baseline = engine.layout(
        &engine.prepare(&text),
        Size::new(Points(100.0), Points(12.0)),
    );
    let aligned = engine.layout(
        &engine.prepare_aligned(&text, &alignments),
        Size::new(Points(100.0), Points(12.0)),
    );
    assert_eq!(engine.attachments(&baseline)[0].unwrap().y, Points(6.0));
    assert_eq!(engine.attachments(&aligned)[0].unwrap().y, Points(6.5));
    assert_ne!(alignments.layout_hash(&text), text.layout_hash());
    alignments.set(0, VerticalAlign::Baseline);
    assert_eq!(alignments.layout_hash(&text), text.layout_hash());
}

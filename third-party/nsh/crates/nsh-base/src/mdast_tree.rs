//! Markdown syntax trees as deep as their input nests, read and dropped
//! without recursion.
//!
//! `markdown-rs` parses thousands of nested quotes or lists without running
//! the stack out, but its tree is then as deep as the input: dropping it, or
//! `mdast::Node::to_string`, recurses once per level. `TextView` and
//! `RichEditor` read the tree recursively only to a bounded depth and keep
//! deeper content as its text ([`plain_text`]), and hold the tree in an
//! [`Mdast`], which drops it level by level.

use std::ops::{Deref, DerefMut};

use markdown::mdast::Node;

/// A parsed tree, dropped without recursion: a tree of thousands of levels
/// (a degenerate reply) ran the stack out when dropped as a `Node`.
pub(crate) struct Mdast(pub(crate) Node);

impl Deref for Mdast {
    type Target = Node;

    fn deref(&self) -> &Node {
        &self.0
    }
}

impl DerefMut for Mdast {
    fn deref_mut(&mut self) -> &mut Node {
        &mut self.0
    }
}

impl Drop for Mdast {
    fn drop(&mut self) {
        let Some(children) = self.0.children_mut() else {
            return;
        };
        // A node whose children have children of their own has them taken
        // before it is dropped; the others (a paragraph of text, a leaf)
        // are dropped as they are, two levels at most. So no drop recurses
        // deeper than that, and most nodes are not moved.
        let mut stack = std::mem::take(children);
        while let Some(mut node) = stack.pop() {
            if let Some(children) = node.children_mut()
                && children.iter().any(has_children)
            {
                stack.append(children);
            }
        }
    }
}

fn has_children(node: &Node) -> bool {
    node.children().is_some_and(|children| !children.is_empty())
}

/// The text of `nodes`, as `to_string` gives it (literals' values in order,
/// parents' children, nothing for voids), walked with a stack of its own.
pub(crate) fn plain_text(nodes: &[Node]) -> String {
    let mut out = String::new();
    let mut stack = vec![nodes.iter()];
    while let Some(top) = stack.last_mut() {
        let Some(node) = top.next() else {
            stack.pop();
            continue;
        };
        match node {
            Node::MdxjsEsm(x) => out.push_str(&x.value),
            Node::Toml(x) => out.push_str(&x.value),
            Node::Yaml(x) => out.push_str(&x.value),
            Node::InlineCode(x) => out.push_str(&x.value),
            Node::InlineMath(x) => out.push_str(&x.value),
            Node::MdxTextExpression(x) => out.push_str(&x.value),
            Node::Html(x) => out.push_str(&x.value),
            Node::Text(x) => out.push_str(&x.value),
            Node::Code(x) => out.push_str(&x.value),
            Node::Math(x) => out.push_str(&x.value),
            Node::MdxFlowExpression(x) => out.push_str(&x.value),
            _ => {
                if let Some(children) = node.children() {
                    stack.push(children.iter());
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same text as `to_string` for every kind of node it reads.
    #[test]
    fn matches_to_string() {
        let source = "# Head *em* **st** ~~del~~ `code` $m$\n\n> quote [link](u) ![img](i)\n\n- a\n  - b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n```rs\nfn x() {}\n```\n\n$$\nmath\n$$\n\n<div>html</div>\n\n[^1]: note\n";
        let mut options = markdown::ParseOptions::gfm();
        options.constructs.math_flow = true;
        options.constructs.math_text = true;
        let root = markdown::to_mdast(source, &options).unwrap();
        let children = root.children().unwrap();
        let expected: String = children.iter().map(Node::to_string).collect();
        assert_eq!(plain_text(children), expected);
        assert!(expected.contains("Head") && expected.contains("math"));
    }

    /// A tree far deeper than any input is read to (nested lists in
    /// quotes, as a degenerate reply parses) is dropped, and its text
    /// gathered, on a thread of a common stack size. Built by hand: parsing
    /// input this deep takes `markdown-rs` seconds.
    #[test]
    fn deep_trees_drop_without_recursion() {
        use markdown::mdast::{Blockquote, List, ListItem, Text};
        std::thread::Builder::new()
            .stack_size(2 * 1024 * 1024)
            .spawn(|| {
                let mut node = Node::Text(Text {
                    value: "deep".into(),
                    position: None,
                });
                for level in 0..100_000 {
                    let children = vec![node];
                    node = match level % 3 {
                        0 => Node::ListItem(ListItem {
                            children,
                            position: None,
                            spread: false,
                            checked: None,
                        }),
                        1 => Node::List(List {
                            children,
                            position: None,
                            ordered: false,
                            start: None,
                            spread: false,
                        }),
                        _ => Node::Blockquote(Blockquote {
                            children,
                            position: None,
                        }),
                    };
                }
                let tree = Mdast(node);
                assert_eq!(plain_text(std::slice::from_ref(&tree)), "deep");
                drop(tree);
            })
            .unwrap()
            .join()
            .unwrap();
    }
}

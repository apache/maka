//! Content expressions (`"paragraph+"`, `"heading (paragraph | list){2,}"`,
//! ...) compiled as ProseMirror's `content.ts` compiles them: parsed, turned
//! into an NFA, then into a DFA whose states are [`ContentMatch`]es. A
//! schema keeps the states of all its expressions in one table.

use std::{collections::HashMap, fmt};

use super::{Fragment, NodeType, Schema, schema::NodeTypeData};

/// One DFA state: whether content may end here, and the type → state edges.
pub(crate) struct MatchState {
    pub(crate) valid_end: bool,
    pub(crate) next: Vec<(usize, usize)>,
}

/// A state of a content expression's automaton: where matching some content
/// against a node type's expression got to. Cheap to clone.
#[derive(Clone)]
pub struct ContentMatch {
    pub(crate) schema: Schema,
    pub(crate) state: usize,
}

impl PartialEq for ContentMatch {
    fn eq(&self, other: &Self) -> bool {
        self.state == other.state && self.schema == other.schema
    }
}

impl Eq for ContentMatch {}

impl fmt::Debug for ContentMatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let names: Vec<&str> = self
            .data()
            .next
            .iter()
            .map(|&(t, _)| self.schema.0.nodes[t].name.as_str())
            .collect();
        write!(
            f,
            "ContentMatch({}{})",
            names.join(" | "),
            if self.valid_end() { " ." } else { "" }
        )
    }
}

impl ContentMatch {
    fn data(&self) -> &MatchState {
        &self.schema.0.matches[self.state]
    }

    fn at(&self, state: usize) -> ContentMatch {
        ContentMatch {
            schema: self.schema.clone(),
            state,
        }
    }

    fn ty(&self, index: usize) -> NodeType {
        NodeType {
            schema: self.schema.clone(),
            index,
        }
    }

    /// Whether content may end here.
    pub fn valid_end(&self) -> bool {
        self.data().valid_end
    }

    /// The state after a node of type `ty`, if one may come next.
    pub fn match_type(&self, ty: &NodeType) -> Option<ContentMatch> {
        if ty.schema != self.schema {
            return None;
        }
        self.data()
            .next
            .iter()
            .find(|&&(t, _)| t == ty.index)
            .map(|&(_, s)| self.at(s))
    }

    /// The state after the children `start..end` of `fragment`, if they
    /// match.
    pub fn match_fragment(
        &self,
        fragment: &Fragment,
        start: usize,
        end: usize,
    ) -> Option<ContentMatch> {
        let mut cur = self.clone();
        for i in start..end.min(fragment.child_count()) {
            cur = cur.match_type(fragment.child(i).ty())?;
        }
        Some(cur)
    }

    /// Whether what may come next is inline.
    pub fn inline_content(&self) -> bool {
        self.data()
            .next
            .first()
            .is_some_and(|&(t, _)| !self.schema.0.nodes[t].is_block)
    }

    /// The first type that may come next and can be generated (not text,
    /// no required attributes).
    pub fn default_type(&self) -> Option<NodeType> {
        self.data().next.iter().find_map(|&(t, _)| {
            let d = &self.schema.0.nodes[t];
            (!(d.is_text || d.has_required_attrs)).then(|| self.ty(t))
        })
    }

    /// Whether this state and `other` share a type that may come next.
    pub fn compatible(&self, other: &ContentMatch) -> bool {
        self.schema == other.schema
            && self
                .data()
                .next
                .iter()
                .any(|&(a, _)| other.data().next.iter().any(|&(b, _)| a == b))
    }

    /// The number of edges out of this state.
    pub fn edge_count(&self) -> usize {
        self.data().next.len()
    }

    /// The `i`th edge: a type and the state after it.
    pub fn edge(&self, i: usize) -> (NodeType, ContentMatch) {
        let (t, s) = self.data().next[i];
        (self.ty(t), self.at(s))
    }

    /// The nodes to insert before the children of `after` from `start` on
    /// so that they match (and, with `to_end`, end the content validly);
    /// none when no generatable nodes do it.
    pub fn fill_before(&self, after: &Fragment, to_end: bool, start: usize) -> Option<Fragment> {
        let mut seen = vec![self.state];
        self.search_fill(after, to_end, start, &mut seen, &mut Vec::new())
    }

    fn search_fill(
        &self,
        after: &Fragment,
        to_end: bool,
        start: usize,
        seen: &mut Vec<usize>,
        types: &mut Vec<usize>,
    ) -> Option<Fragment> {
        if let Some(finished) = self.match_fragment(after, start, after.child_count())
            && (!to_end || finished.valid_end())
        {
            let nodes: Option<Vec<_>> = types
                .iter()
                .map(|&t| self.ty(t).create_and_fill(None, Fragment::empty(), vec![]))
                .collect();
            if let Some(nodes) = nodes {
                return Some(Fragment::from(nodes));
            }
        }
        for &(t, next) in &self.data().next {
            let d = &self.schema.0.nodes[t];
            if !(d.is_text || d.has_required_attrs) && !seen.contains(&next) {
                seen.push(next);
                types.push(t);
                let found = self.at(next).search_fill(after, to_end, start, seen, types);
                types.pop();
                if found.is_some() {
                    return found;
                }
            }
        }
        None
    }

    /// The wrapper types (outermost first) a node of type `target` needs to
    /// be placed here; empty when it fits as it is, none when no wrapping
    /// does it.
    pub fn find_wrapping(&self, target: &NodeType) -> Option<Vec<NodeType>> {
        struct Active {
            state: usize,
            ty: Option<usize>,
            via: Option<usize>,
        }
        let nodes = &self.schema.0.nodes;
        let mut seen = vec![false; nodes.len()];
        let mut active = vec![Active {
            state: self.state,
            ty: None,
            via: None,
        }];
        let mut i = 0;
        while i < active.len() {
            let current = &active[i];
            let m = self.at(current.state);
            if m.match_type(target).is_some() {
                let mut result = Vec::new();
                let mut obj = i;
                while let Some(t) = active[obj].ty {
                    result.push(self.ty(t));
                    obj = active[obj].via.unwrap_or(0);
                }
                result.reverse();
                return Some(result);
            }
            let current_has_type = current.ty.is_some();
            for &(t, next) in &m.data().next {
                let d = &nodes[t];
                let valid_end = self.schema.0.matches[next].valid_end;
                if d.content != 0
                    && !d.has_required_attrs
                    && !seen[t]
                    && (!current_has_type || valid_end)
                {
                    active.push(Active {
                        state: d.content,
                        ty: Some(t),
                        via: Some(i),
                    });
                    seen[t] = true;
                }
            }
            i += 1;
        }
        None
    }
}

#[derive(Debug)]
enum Expr {
    Choice(Vec<Expr>),
    Seq(Vec<Expr>),
    Plus(Box<Expr>),
    Star(Box<Expr>),
    Opt(Box<Expr>),
    Range(Box<Expr>, usize, Option<usize>),
    Name(usize),
}

struct Stream<'a> {
    tokens: Vec<String>,
    pos: usize,
    inline: Option<bool>,
    types: &'a [NodeTypeData],
    names: &'a HashMap<String, usize>,
}

fn tokenize(s: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut chars = s.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
        } else if c.is_alphanumeric() || c == '_' {
            let mut word = String::new();
            while let Some(&c) = chars.peek() {
                if c.is_alphanumeric() || c == '_' {
                    word.push(c);
                    chars.next();
                } else {
                    break;
                }
            }
            tokens.push(word);
        } else {
            tokens.push(c.to_string());
            chars.next();
        }
    }
    tokens
}

fn is_word(token: &str) -> bool {
    token.chars().all(|c| c.is_alphanumeric() || c == '_')
}

impl Stream<'_> {
    fn next(&self) -> Option<&str> {
        self.tokens.get(self.pos).map(String::as_str)
    }

    fn eat(&mut self, tok: &str) -> bool {
        if self.next() == Some(tok) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn parse_expr(&mut self) -> Result<Expr, String> {
        let mut exprs = vec![self.parse_seq()?];
        while self.eat("|") {
            exprs.push(self.parse_seq()?);
        }
        Ok(if exprs.len() == 1 {
            exprs.pop().unwrap()
        } else {
            Expr::Choice(exprs)
        })
    }

    fn parse_seq(&mut self) -> Result<Expr, String> {
        let mut exprs = Vec::new();
        loop {
            exprs.push(self.parse_subscript()?);
            match self.next() {
                Some(t) if t != ")" && t != "|" => {}
                _ => break,
            }
        }
        Ok(if exprs.len() == 1 {
            exprs.pop().unwrap()
        } else {
            Expr::Seq(exprs)
        })
    }

    fn parse_subscript(&mut self) -> Result<Expr, String> {
        let mut expr = self.parse_atom()?;
        loop {
            if self.eat("+") {
                expr = Expr::Plus(Box::new(expr));
            } else if self.eat("*") {
                expr = Expr::Star(Box::new(expr));
            } else if self.eat("?") {
                expr = Expr::Opt(Box::new(expr));
            } else if self.eat("{") {
                expr = self.parse_range(expr)?;
            } else {
                return Ok(expr);
            }
        }
    }

    fn parse_num(&mut self) -> Result<usize, String> {
        let tok = self.next().unwrap_or("");
        let n = tok
            .parse::<usize>()
            .map_err(|_| format!("Expected number, got '{tok}'"))?;
        self.pos += 1;
        Ok(n)
    }

    fn parse_range(&mut self, expr: Expr) -> Result<Expr, String> {
        let min = self.parse_num()?;
        let mut max = Some(min);
        if self.eat(",") {
            max = if self.next() != Some("}") {
                Some(self.parse_num()?)
            } else {
                None
            };
        }
        if !self.eat("}") {
            return Err("Unclosed braced range".into());
        }
        if max.is_some_and(|m| m < min) {
            return Err(format!("Range maximum below its minimum ({min}, {max:?})"));
        }
        Ok(Expr::Range(Box::new(expr), min, max))
    }

    fn resolve_name(&self, name: &str) -> Result<Vec<usize>, String> {
        if let Some(&i) = self.names.get(name) {
            return Ok(vec![i]);
        }
        let found: Vec<usize> = self
            .types
            .iter()
            .enumerate()
            .filter(|(_, t)| t.groups.iter().any(|g| g == name))
            .map(|(i, _)| i)
            .collect();
        if found.is_empty() {
            return Err(format!("No node type or group '{name}' found"));
        }
        Ok(found)
    }

    fn parse_atom(&mut self) -> Result<Expr, String> {
        if self.eat("(") {
            let expr = self.parse_expr()?;
            if !self.eat(")") {
                return Err("Missing closing paren".into());
            }
            return Ok(expr);
        }
        let Some(tok) = self.next().filter(|t| is_word(t)).map(str::to_owned) else {
            return Err(format!("Unexpected token '{}'", self.next().unwrap_or("")));
        };
        let mut exprs = Vec::new();
        for ty in self.resolve_name(&tok)? {
            let inline = !self.types[ty].is_block;
            match self.inline {
                None => self.inline = Some(inline),
                Some(i) if i != inline => return Err("Mixing inline and block content".into()),
                _ => {}
            }
            exprs.push(Expr::Name(ty));
        }
        self.pos += 1;
        Ok(if exprs.len() == 1 {
            exprs.pop().unwrap()
        } else {
            Expr::Choice(exprs)
        })
    }
}

#[derive(Clone, Copy)]
struct Edge {
    term: Option<usize>,
    to: Option<usize>,
}

/// An edge by its state and index, whose target is connected later.
type EdgeRef = (usize, usize);

struct Nfa {
    states: Vec<Vec<Edge>>,
}

impl Nfa {
    fn node(&mut self) -> usize {
        self.states.push(Vec::new());
        self.states.len() - 1
    }

    fn edge(&mut self, from: usize, to: Option<usize>, term: Option<usize>) -> EdgeRef {
        self.states[from].push(Edge { term, to });
        (from, self.states[from].len() - 1)
    }

    fn connect(&mut self, edges: &[EdgeRef], to: usize) {
        for &(s, e) in edges {
            self.states[s][e].to = Some(to);
        }
    }

    fn compile(&mut self, expr: &Expr, from: usize) -> Vec<EdgeRef> {
        match expr {
            Expr::Choice(exprs) => exprs.iter().flat_map(|e| self.compile(e, from)).collect(),
            Expr::Seq(exprs) => {
                let mut from = from;
                for (i, e) in exprs.iter().enumerate() {
                    let next = self.compile(e, from);
                    if i == exprs.len() - 1 {
                        return next;
                    }
                    from = self.node();
                    self.connect(&next, from);
                }
                Vec::new()
            }
            Expr::Star(e) => {
                let lp = self.node();
                self.edge(from, Some(lp), None);
                let inner = self.compile(e, lp);
                self.connect(&inner, lp);
                vec![self.edge(lp, None, None)]
            }
            Expr::Plus(e) => {
                let lp = self.node();
                let first = self.compile(e, from);
                self.connect(&first, lp);
                let inner = self.compile(e, lp);
                self.connect(&inner, lp);
                vec![self.edge(lp, None, None)]
            }
            Expr::Opt(e) => {
                let mut out = vec![self.edge(from, None, None)];
                out.extend(self.compile(e, from));
                out
            }
            Expr::Range(e, min, max) => {
                let mut cur = from;
                for _ in 0..*min {
                    let next = self.node();
                    let edges = self.compile(e, cur);
                    self.connect(&edges, next);
                    cur = next;
                }
                match max {
                    None => {
                        let edges = self.compile(e, cur);
                        self.connect(&edges, cur);
                    }
                    Some(max) => {
                        for _ in *min..*max {
                            let next = self.node();
                            self.edge(cur, Some(next), None);
                            let edges = self.compile(e, cur);
                            self.connect(&edges, next);
                            cur = next;
                        }
                    }
                }
                vec![self.edge(cur, None, None)]
            }
            Expr::Name(t) => vec![self.edge(from, None, Some(*t))],
        }
    }

    /// The states reachable from `node` over null edges, sorted.
    fn null_from(&self, node: usize) -> Vec<usize> {
        let mut result = Vec::new();
        self.scan(node, &mut result);
        result.sort_unstable();
        result
    }

    fn scan(&self, node: usize, result: &mut Vec<usize>) {
        let edges = &self.states[node];
        if edges.len() == 1
            && edges[0].term.is_none()
            && let Some(to) = edges[0].to
        {
            return self.scan(to, result);
        }
        result.push(node);
        for e in edges {
            if e.term.is_none()
                && let Some(to) = e.to
                && !result.contains(&to)
            {
                self.scan(to, result);
            }
        }
    }
}

fn explore(
    nfa: &Nfa,
    states: Vec<usize>,
    labeled: &mut HashMap<Vec<usize>, usize>,
    out_states: &mut Vec<MatchState>,
) -> usize {
    let mut out: Vec<(usize, Vec<usize>)> = Vec::new();
    for &node in &states {
        for e in &nfa.states[node] {
            let (Some(term), Some(to)) = (e.term, e.to) else {
                continue;
            };
            for n in nfa.null_from(to) {
                let p = match out.iter().position(|(t, _)| *t == term) {
                    Some(p) => p,
                    None => {
                        out.push((term, Vec::new()));
                        out.len() - 1
                    }
                };
                if !out[p].1.contains(&n) {
                    out[p].1.push(n);
                }
            }
        }
    }
    let accept = nfa.states.len() - 1;
    let index = out_states.len();
    out_states.push(MatchState {
        valid_end: states.contains(&accept),
        next: Vec::new(),
    });
    labeled.insert(states, index);
    for (term, mut set) in out {
        set.sort_unstable();
        let next = match labeled.get(&set) {
            Some(&s) => s,
            None => explore(nfa, set, labeled, out_states),
        };
        out_states[index].next.push((term, next));
    }
    index
}

/// Compiles `expr` into `matches`, returning its start state (0, the shared
/// empty match, for an empty expression).
pub(crate) fn compile(
    expr: &str,
    types: &[NodeTypeData],
    names: &HashMap<String, usize>,
    matches: &mut Vec<MatchState>,
) -> Result<usize, String> {
    let mut stream = Stream {
        tokens: tokenize(expr),
        pos: 0,
        inline: None,
        types,
        names,
    };
    if stream.tokens.is_empty() {
        return Ok(0);
    }
    let parsed = stream.parse_expr()?;
    if let Some(tok) = stream.next() {
        return Err(format!("Unexpected trailing text '{tok}'"));
    }
    let mut nfa = Nfa {
        states: vec![Vec::new()],
    };
    let edges = nfa.compile(&parsed, 0);
    let accept = nfa.node();
    nfa.connect(&edges, accept);

    let first = matches.len();
    let start = explore(&nfa, nfa.null_from(0), &mut HashMap::new(), matches);

    // Dead ends: states that cannot end and lead on only through nodes that
    // cannot be generated, which no fill could ever complete.
    for state in &matches[first..] {
        if !state.valid_end
            && !state
                .next
                .iter()
                .any(|&(t, _)| !(types[t].is_text || types[t].has_required_attrs))
        {
            let nodes: Vec<&str> = state
                .next
                .iter()
                .map(|&(t, _)| types[t].name.as_str())
                .collect();
            return Err(format!(
                "Only non-generatable nodes ({}) in a required position",
                nodes.join(", ")
            ));
        }
    }
    Ok(start)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::rich_editor::model::{SchemaSpec, test_schema::*};

    fn expr_schema(content: &str) -> Result<Schema, crate::rich_editor::model::SchemaError> {
        SchemaSpec::from_json(&json!({
            "nodes": [
                ["doc", {"content": content}],
                ["paragraph", {"content": "text*", "group": "block"}],
                ["heading", {"content": "text*", "group": "block"}],
                ["hr", {"group": "block"}],
                ["image", {"inline": true, "group": "inline"}],
                ["text", {"group": "inline"}]
            ]
        }))
    }

    fn matches(content: &str, types: &str) -> bool {
        let s = expr_schema(content).unwrap();
        let nodes: Vec<Node> = types
            .split_whitespace()
            .map(|n| {
                if n == "text" {
                    t(&s, "x")
                } else {
                    s.node(n, None, Fragment::empty(), vec![]).unwrap()
                }
            })
            .collect();
        // Avoid joining adjacent texts: matching is per child.
        let frag = Fragment::from(nodes);
        s.top_node_type()
            .content_match()
            .match_fragment(&frag, 0, frag.child_count())
            .is_some_and(|m| m.valid_end())
    }

    use crate::rich_editor::model::Node;

    #[test]
    fn expressions() {
        assert!(matches("", ""));
        assert!(!matches("", "paragraph"));
        assert!(matches("paragraph", "paragraph"));
        assert!(!matches("paragraph", ""));
        assert!(matches("paragraph*", ""));
        assert!(matches("paragraph*", "paragraph paragraph paragraph"));
        assert!(!matches("paragraph+", ""));
        assert!(matches("paragraph+", "paragraph paragraph"));
        assert!(matches("paragraph?", "") && matches("paragraph?", "paragraph"));
        assert!(!matches("paragraph?", "paragraph paragraph"));
        assert!(matches("heading paragraph", "heading paragraph"));
        assert!(!matches("heading paragraph", "paragraph heading"));
        assert!(matches(
            "(heading | paragraph)+",
            "paragraph heading paragraph"
        ));
        assert!(matches("block+", "hr heading"));
        assert!(matches("heading block*", "heading hr paragraph"));
        assert!(!matches("heading block*", "hr"));
        assert!(matches("paragraph{2}", "paragraph paragraph"));
        assert!(!matches("paragraph{2}", "paragraph"));
        assert!(!matches("paragraph{2}", "paragraph paragraph paragraph"));
        assert!(matches("paragraph{1,3}", "paragraph paragraph paragraph"));
        assert!(!matches(
            "paragraph{1,3}",
            "paragraph paragraph paragraph paragraph"
        ));
        assert!(matches(
            "paragraph{2,}",
            "paragraph paragraph paragraph paragraph"
        ));
        assert!(!matches("paragraph{2,}", "paragraph"));
        assert!(matches(
            "(paragraph hr)* heading",
            "paragraph hr paragraph hr heading"
        ));
        assert!(matches("inline*", "text image text"));
    }

    #[test]
    fn expression_errors() {
        for bad in [
            "paragraph | image",
            "(paragraph",
            "paragraph{x}",
            "nothing",
            "paragraph )",
            "paragraph{3,1}",
        ] {
            assert!(expr_schema(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn fill_before_and_wrapping() {
        let s = schema();
        let doc_m = s.top_node_type().content_match();
        assert_eq!(
            doc_m
                .fill_before(&Fragment::empty(), true, 0)
                .unwrap()
                .to_string(),
            "<paragraph>"
        );
        // A list item needs a paragraph before a list.
        let li = s.node_type("list_item").unwrap().content_match();
        let list = n(
            &s,
            "bullet_list",
            vec![n(&s, "list_item", vec![p(&s, vec![])])],
        );
        let filled = li.fill_before(&Fragment::from(list), true, 0).unwrap();
        assert_eq!(filled.to_string(), "<paragraph>");
        // Nothing generatable fits text into a doc.
        assert!(
            doc_m
                .fill_before(&Fragment::from(t(&s, "x")), false, 0)
                .is_none()
        );

        let wrap = doc_m.find_wrapping(&s.text_type()).unwrap();
        assert_eq!(
            wrap.iter().map(|t| t.name()).collect::<Vec<_>>(),
            ["paragraph"]
        );
        let wrap = doc_m
            .find_wrapping(&s.node_type("list_item").unwrap())
            .unwrap();
        assert_eq!(
            wrap.iter().map(|t| t.name()).collect::<Vec<_>>(),
            ["bullet_list"]
        );
        assert_eq!(
            doc_m
                .find_wrapping(&s.node_type("paragraph").unwrap())
                .unwrap()
                .len(),
            0
        );
        let para = s.node_type("paragraph").unwrap().content_match();
        assert!(
            para.find_wrapping(&s.node_type("paragraph").unwrap())
                .is_none()
        );
        assert_eq!(doc_m.default_type().unwrap().name(), "paragraph");
    }
}

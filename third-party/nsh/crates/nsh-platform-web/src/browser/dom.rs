//! Dense host nodes and typed operations for compiled JSX. Values stay
//! browser values; props cross through the shared Rust decoders.
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use nsh_core::{EventKind, NodeId, Op, Tag, element::PropError, js::host::HostInput};

use super::{
    bindings::Bindings,
    compat, protocol,
    values::{Value, invoke},
};

struct Node {
    text: Option<String>,
    tag: Option<Tag>,
    parent: Option<NodeId>,
    children: Vec<Value>,
}
pub(super) struct Dom {
    bindings: Rc<Bindings>,
    nodes: RefCell<Vec<Option<Node>>>,
    next: Cell<u32>,
    warnings: RefCell<protocol::Warnings>,
}
impl Dom {
    pub(super) fn new(bindings: Rc<Bindings>) -> Self {
        Self {
            bindings,
            nodes: RefCell::new(vec![
                None,
                Some(Node {
                    text: None,
                    tag: Some(Tag::View),
                    parent: None,
                    children: Vec::new(),
                }),
            ]),
            next: Cell::new(2),
            warnings: RefCell::default(),
        }
    }
    fn id(value: &Value) -> Result<NodeId, PropError> {
        value
            .node()
            .ok_or_else(|| PropError("nsh: not a node".into()))
    }
    fn new_node(&self, tag: Option<Tag>, text: Option<String>) -> Result<Value, PropError> {
        let id = self.next.get();
        let next = id
            .checked_add(2)
            .ok_or_else(|| PropError("node IDs exhausted".into()))?;
        self.next.set(next);
        {
            let mut nodes = self.nodes.borrow_mut();
            nodes.resize_with(id as usize + 1, || None);
            nodes[id as usize] = Some(Node {
                text: text.clone(),
                tag,
                parent: None,
                children: Vec::new(),
            });
        }
        let op = match text {
            Some(text) => Op::CreateText { id, text },
            None => Op::Create {
                id,
                tag: tag.unwrap_or(Tag::View),
            },
        };
        self.bindings.ops.borrow_mut().push(op);
        Value::checked(invoke(39, id, u32::from(tag.is_none()), 0, 0.0))
    }
    fn insert(
        &self,
        parent: NodeId,
        child: Value,
        before: Option<NodeId>,
    ) -> Result<(), PropError> {
        let id = Self::id(&child)?;
        if id == 1 {
            return Err(PropError("cannot insert the root".into()));
        }
        let old = {
            let mut nodes = self.nodes.borrow_mut();
            let mut ancestor = Some(parent);
            while let Some(next) = ancestor {
                if next == id {
                    return Err(PropError("cannot insert a node into its descendant".into()));
                }
                ancestor = nodes
                    .get(next as usize)
                    .and_then(Option::as_ref)
                    .ok_or_else(|| PropError("released parent node".into()))?
                    .parent;
            }
            if let Some(before) = before {
                if before == id {
                    return Ok(());
                }
                if nodes
                    .get(before as usize)
                    .and_then(Option::as_ref)
                    .and_then(|n| n.parent)
                    != Some(parent)
                {
                    return Err(PropError("insertion anchor has another parent".into()));
                }
            }
            let previous = nodes
                .get(id as usize)
                .and_then(Option::as_ref)
                .ok_or_else(|| PropError("released child node".into()))?
                .parent;
            if previous == Some(parent) {
                let children = &nodes[parent as usize].as_ref().unwrap().children;
                if let Some(index) = children.iter().position(|v| v.node() == Some(id))
                    && children.get(index + 1).and_then(Value::node) == before
                {
                    return Ok(());
                }
            }
            let old = previous.and_then(|p| {
                let children = &mut nodes[p as usize].as_mut()?.children;
                let index = children.iter().position(|v| v.node() == Some(id))?;
                Some(children.remove(index))
            });
            let children = &mut nodes[parent as usize].as_mut().unwrap().children;
            let index = before
                .and_then(|b| children.iter().position(|v| v.node() == Some(b)))
                .unwrap_or(children.len());
            children.insert(index, child);
            nodes[id as usize].as_mut().unwrap().parent = Some(parent);
            old
        };
        drop(old);
        self.bindings.ops.borrow_mut().push(Op::Insert {
            parent,
            child: id,
            before,
        });
        Ok(())
    }
    fn set_text(&self, id: NodeId, text: String) -> Result<(), PropError> {
        let changed = {
            let mut nodes = self.nodes.borrow_mut();
            let node = nodes
                .get_mut(id as usize)
                .and_then(Option::as_mut)
                .ok_or_else(|| PropError("released text node".into()))?;
            if node.text.as_deref() == Some(&text) {
                false
            } else {
                node.text = Some(text.clone());
                true
            }
        };
        if changed {
            self.bindings
                .ops
                .borrow_mut()
                .push(Op::SetText { id, text });
        }
        Ok(())
    }
    fn flatten(
        &self,
        value: Value,
        previous: &[Value],
        out: &mut Vec<Value>,
        depth: usize,
    ) -> Result<(), PropError> {
        if depth > 64 || out.len() > 1_000_000 {
            return Err(PropError("JSX children exceed the traversal limit".into()));
        }
        if value.node().is_some() {
            out.push(value);
            return Ok(());
        }
        match value.kind() {
            0..=2 => {}
            5 => {
                for index in 0..value.length()?.unwrap_or(0) {
                    self.flatten(value.index(index)?, previous, out, depth + 1)?;
                }
            }
            6 => {
                let value = value.call(&Value(0), &Value::array([])?)?;
                self.flatten(value, previous, out, depth + 1)?;
            }
            _ => {
                let text = Value::checked(invoke(43, value.0, 0, 0, 0.0))?
                    .as_string()
                    .unwrap_or_default();
                let reuse = previous.get(out.len()).filter(|value| {
                    value.node().is_some_and(|id| {
                        self.nodes
                            .borrow()
                            .get(id as usize)
                            .and_then(Option::as_ref)
                            .is_some_and(|n| n.tag.is_none())
                    })
                });
                let node = if let Some(old) = reuse {
                    let id = Self::id(old)?;
                    self.set_text(id, text)?;
                    old.clone()
                } else {
                    self.new_node(None, Some(text))?
                };
                out.push(node);
            }
        }
        Ok(())
    }
    pub(super) fn trace_edges(&self, edges: &mut Vec<(u32, u32, u32, u32)>) {
        for (id, node) in self.nodes.borrow().iter().enumerate().skip(2) {
            if let Some(node) = node {
                for child in &node.children {
                    edges.push((2, id as u32, 0, child.0));
                }
            }
        }
    }
    pub(super) fn call(&self, op: u32, args: &Value) -> Result<Value, PropError> {
        match op {
            315 => {
                let id = Self::id(&args.index(0)?)?;
                let call = args.index(2)?.as_number().unwrap_or(0.0) as u32;
                self.bindings.ops.borrow_mut().push(Op::Command {
                    id,
                    command: nsh_core::Command::Measure { call },
                });
                Ok(Value(0))
            }
            313 => {
                let ancestor = args.index(0)?.as_number().unwrap_or(0.0) as u32;
                let mut child = args.index(1)?.as_number().unwrap_or(0.0) as u32;
                let nodes = self.nodes.borrow();
                loop {
                    if child == ancestor {
                        return Ok(Value(3));
                    }
                    let Some(parent) = nodes
                        .get(child as usize)
                        .and_then(Option::as_ref)
                        .and_then(|n| n.parent)
                    else {
                        return Ok(Value(2));
                    };
                    child = parent;
                }
            }
            314 => {
                let id = args
                    .index(0)?
                    .as_number()
                    .ok_or_else(|| PropError("invalid node ID".into()))?
                    as u32;
                let name = args
                    .index(1)?
                    .as_string()
                    .ok_or_else(|| PropError("invalid command".into()))?;
                if let Some(command) =
                    protocol::decode_command(&name, compat::Value::new(args.index(2)?))?
                {
                    self.bindings
                        .ops
                        .borrow_mut()
                        .push(Op::Command { id, command });
                }
                Ok(Value(0))
            }
            300 => {
                let name = args
                    .index(0)?
                    .as_string()
                    .ok_or_else(|| PropError("expected an element name".into()))?;
                let tag = Tag::from_name(&name).unwrap_or(Tag::View);
                self.new_node(Some(tag), None)
            }
            301 => {
                let text = args
                    .index(0)?
                    .as_string()
                    .ok_or_else(|| PropError("expected text".into()))?;
                self.new_node(None, Some(text))
            }
            302 => {
                let parent = Self::id(&args.index(0)?)?;
                let child = args.index(1)?;
                let before = args.index(2)?.node();
                self.insert(parent, child, before)?;
                Ok(Value(0))
            }
            303 => {
                let id = Self::id(&args.index(0)?)?;
                let name = args
                    .index(1)?
                    .as_string()
                    .ok_or_else(|| PropError("expected a prop name".into()))?;
                let value = args.index(2)?;
                let tag = self
                    .nodes
                    .borrow()
                    .get(id as usize)
                    .and_then(Option::as_ref)
                    .ok_or_else(|| PropError("released node".into()))?
                    .tag;
                let mut warnings = protocol::Warnings::deferred();
                let decoded = protocol::decode_prop(
                    id,
                    tag,
                    &name,
                    compat::Value::new(value),
                    &mut warnings,
                )?;
                self.warnings.borrow_mut().merge(warnings);
                if let Some(op) = decoded {
                    self.bindings.ops.borrow_mut().push(op);
                }
                Ok(Value(0))
            }
            304 => {
                let id = Self::id(&args.index(0)?)?;
                let text = args
                    .index(1)?
                    .as_string()
                    .ok_or_else(|| PropError("expected text".into()))?;
                self.set_text(id, text)?;
                Ok(Value(0))
            }
            305 | 309 => {
                let id = Self::id(&args.index(0)?)?;
                let name = args
                    .index(1)?
                    .as_string()
                    .ok_or_else(|| PropError("expected event name".into()))?;
                let event = if op == 309 {
                    EventKind::from_prop(&name)
                } else {
                    EventKind::from_handler(&name)
                }
                .ok_or_else(|| PropError(format!("unknown event name {name}")))?;
                self.bindings.ops.borrow_mut().push(Op::Listen {
                    id,
                    event,
                    enabled: args.index(2)?.truthy(),
                });
                Ok(Value(0))
            }
            308 => {
                let parent = Self::id(&args.index(0)?)?;
                let value = args.index(1)?;
                let old = args.index(2)?;
                let before = args.index(3)?.node();
                let previous = (0..old.length()?.unwrap_or(0))
                    .map(|index| old.index(index))
                    .collect::<Result<Vec<_>, _>>()?;
                let mut next = Vec::new();
                self.flatten(value, &previous, &mut next, 0)?;
                let next_ids = next
                    .iter()
                    .map(Self::id)
                    .collect::<Result<std::collections::HashSet<_>, _>>()?;
                for child in &previous {
                    if !next_ids.contains(&Self::id(child)?) {
                        self.call(306, &Value::array([args.index(0)?, child.clone()])?)?;
                    }
                }
                let mut anchor = before;
                for child in next.iter().rev() {
                    let id = Self::id(child)?;
                    self.insert(parent, child.clone(), anchor)?;
                    anchor = Some(id);
                }
                Value::array(next)
            }
            306 => {
                let parent = Self::id(&args.index(0)?)?;
                let child = Self::id(&args.index(1)?)?;
                let old = {
                    let mut nodes = self.nodes.borrow_mut();
                    let node = nodes
                        .get(child as usize)
                        .and_then(Option::as_ref)
                        .ok_or_else(|| PropError("released node".into()))?;
                    if node.parent != Some(parent) {
                        return Ok(Value(0));
                    }
                    let children = &mut nodes[parent as usize].as_mut().unwrap().children;
                    let index = children
                        .iter()
                        .position(|v| v.node() == Some(child))
                        .unwrap();
                    let old = children.remove(index);
                    nodes[child as usize].as_mut().unwrap().parent = None;
                    old
                };
                self.bindings
                    .ops
                    .borrow_mut()
                    .push(Op::Remove { parent, child });
                drop(old);
                Ok(Value(0))
            }
            307 => {
                let id = args.index(0)?.as_number().unwrap_or(0.0) as u32;
                if id <= 1 {
                    return Ok(Value(0));
                }
                let node = self
                    .nodes
                    .borrow_mut()
                    .get_mut(id as usize)
                    .and_then(Option::take);
                if let Some(node) = node {
                    for child in &node.children {
                        if let Some(id) = child.node()
                            && let Some(Some(child)) = self.nodes.borrow_mut().get_mut(id as usize)
                        {
                            child.parent = None;
                        }
                    }
                    self.bindings.ops.borrow_mut().push(Op::Release { id });
                    drop(node);
                }
                Ok(Value(0))
            }
            _ => Err(PropError("unknown DOM operation".into())),
        }
    }
}

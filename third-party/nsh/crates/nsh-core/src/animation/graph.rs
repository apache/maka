use std::cell::Cell;

use super::{
    driver::{Running, ease},
    ops::{
        AnimationId, AnimationOp, Composite, Driver, Easing, Extrapolate, MathOp, NodeId, Operand,
        Output,
    },
};

/// Animations of composite steps get ids from here up (JS's are small).
const LEAF_IDS: AnimationId = 0x8000_0000;

/// How long a snapping `diffClamp` takes to reach its bound (seconds), as
/// Flutter's floating app bar.
const SNAP_SECONDS: f64 = 0.2;

/// The evaluated value of a node.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum AnimationValue {
    /// A number.
    Number(f32),
    /// A color, `0xRRGGBBAA`.
    Color(u32),
}

impl AnimationValue {
    /// The number, or 0 for colors.
    pub fn number(self) -> f32 {
        match self {
            AnimationValue::Number(n) => n,
            AnimationValue::Color(_) => 0.0,
        }
    }
}

/// A finished (or interrupted) animation, to report back to JS; also the
/// answer to an [`AnimationOp::Read`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Finished {
    /// The animation (or the read request).
    pub animation: AnimationId,
    /// False if it was stopped or replaced before reaching its end.
    pub finished: bool,
    /// The node's value, for a read.
    pub value: Option<f32>,
}

impl Finished {
    /// The end of `animation`.
    pub fn new(animation: AnimationId, finished: bool) -> Self {
        Finished {
            animation,
            finished,
            value: None,
        }
    }
}

#[derive(Debug)]
enum Node {
    Value {
        value: f32,
        /// Added when evaluated (`setOffset`).
        offset: f32,
        velocity: f32,
        running: Option<Running>,
    },
    Interpolate {
        input: NodeId,
        input_range: Vec<f32>,
        output: Output,
        extrapolate: (Extrapolate, Extrapolate),
        easing: Easing,
    },
    DiffClamp {
        input: NodeId,
        min: f32,
        max: f32,
        /// The input and output at the last evaluation.
        state: Cell<Option<(f32, f32)>>,
        /// Settles at the nearer bound when its scroll view rests.
        snap: bool,
        /// Its settling, while it runs.
        snapping: Cell<Option<Snap>>,
    },
    Math {
        op: MathOp,
        a: Operand,
        b: Operand,
    },
}

/// A `diffClamp` moving to a bound after its scroll view came to rest.
#[derive(Debug, Clone, Copy)]
struct Snap {
    from: f32,
    to: f32,
    /// The scroll value that came to rest, and where: scrolling it again
    /// ends the settling.
    source: NodeId,
    at: f32,
    /// Its input at the last evaluation: a snapping `diffClamp` it reads
    /// settles too and moves it meanwhile.
    input: f32,
    /// The first frame's time.
    start: Option<f64>,
    /// It arrived: the next evaluation takes in where its input went.
    done: bool,
}

/// Nodes deeper than this are treated as cycles (JS bug) and evaluate to 0.
const MAX_DEPTH: u32 = 64;

/// All animation nodes of one surface.
#[derive(Debug, Default)]
pub struct Graph {
    /// Indexed by node id (dense, assigned by JS).
    nodes: Vec<Option<Node>>,
    /// Value nodes with a running animation.
    animating: Vec<NodeId>,
    /// Running composite animations.
    programs: Vec<Program>,
    /// Ends of composite steps (and when they ended), for their programs.
    leaf_ends: Vec<(Finished, f64)>,
    next_leaf: AnimationId,
    /// Values a composite step started in this frame.
    started: Vec<NodeId>,
    /// Values of each composite when it last started, for resets.
    baselines: Vec<(u32, Vec<(NodeId, f32)>)>,
    /// `diffClamp` nodes settling at a bound.
    snaps: Vec<NodeId>,
}

/// A running composite animation.
#[derive(Debug)]
struct Program {
    id: AnimationId,
    key: u32,
    root: Step,
    /// When it started (its first frame).
    at: Option<f64>,
}

/// The state of one part of a composite animation.
#[derive(Debug)]
enum Step {
    Run {
        node: NodeId,
        driver: Driver,
        /// The animation once started.
        leaf: Option<AnimationId>,
    },
    Sequence {
        steps: Vec<Step>,
        index: usize,
        /// When the current step starts.
        at: Option<f64>,
    },
    Parallel {
        steps: Vec<Step>,
        ends: Vec<Option<(bool, f64)>>,
        stop_together: bool,
        at: Option<f64>,
    },
    Delay {
        ms: f32,
        until: Option<f64>,
    },
    Loop {
        template: Composite,
        current: Box<Step>,
        runs: u32,
        iterations: Option<u32>,
        reset: bool,
        /// Values at the start, restored before each run with `reset`.
        initial: Option<Vec<(NodeId, f32)>>,
        /// When the current run starts.
        at: Option<f64>,
    },
}

/// How a step ended: completed (or stopped) and when.
type End = (bool, f64);

impl Step {
    fn new(spec: &Composite) -> Step {
        match spec {
            Composite::Run { node, driver } => Step::Run {
                node: *node,
                driver: *driver,
                leaf: None,
            },
            Composite::Sequence(children) => Step::Sequence {
                steps: children.iter().map(Step::new).collect(),
                index: 0,
                at: None,
            },
            Composite::Parallel {
                children,
                stop_together,
            } => Step::Parallel {
                steps: children.iter().map(Step::new).collect(),
                ends: vec![None; children.len()],
                stop_together: *stop_together,
                at: None,
            },
            Composite::Delay(ms) => Step::Delay {
                ms: *ms,
                until: None,
            },
            Composite::Loop {
                child,
                iterations,
                reset,
            } => Step::Loop {
                template: (**child).clone(),
                current: Box::new(Step::new(child)),
                runs: 0,
                iterations: *iterations,
                reset: *reset,
                initial: None,
                at: None,
            },
        }
    }

    /// Runs as far as possible at `now`; a step that has not started yet
    /// starts at `at` (the exact end of the step before it, possibly a
    /// little in the past). `Some` once over.
    fn advance(
        &mut self,
        g: &mut Graph,
        now: f64,
        at: f64,
        finished: &mut Vec<Finished>,
    ) -> Option<End> {
        match self {
            Step::Run { node, driver, leaf } => match *leaf {
                None => {
                    let id = g.next_leaf.max(LEAF_IDS);
                    g.next_leaf = id.wrapping_add(1).max(LEAF_IDS);
                    if !g.start(*node, id, *driver, Some(at), finished) {
                        // The value is gone (released): the composite
                        // cannot go on (a loop would spin forever).
                        return Some((false, at));
                    }
                    g.started.push(*node);
                    *leaf = Some(id);
                    None
                }
                Some(id) => {
                    let i = g.leaf_ends.iter().position(|(f, _)| f.animation == id)?;
                    let (f, end) = g.leaf_ends.swap_remove(i);
                    Some((f.finished, end))
                }
            },
            Step::Sequence {
                steps,
                index,
                at: start,
            } => {
                let mut at = *start.get_or_insert(at);
                loop {
                    let Some(step) = steps.get_mut(*index) else {
                        return Some((true, at));
                    };
                    match step.advance(g, now, at, finished)? {
                        (true, end) => {
                            *index += 1;
                            at = end;
                            *start = Some(end);
                        }
                        (false, end) => return Some((false, end)),
                    }
                }
            }
            Step::Parallel {
                steps,
                ends,
                stop_together,
                at: start,
            } => {
                let at = *start.get_or_insert(at);
                let mut interrupted = false;
                for (step, end) in steps.iter_mut().zip(ends.iter_mut()) {
                    if end.is_none() {
                        *end = step.advance(g, now, at, finished);
                        interrupted |= matches!(*end, Some((false, _)));
                    }
                }
                if interrupted && *stop_together {
                    for (step, end) in steps.iter_mut().zip(ends.iter()) {
                        if end.is_none() {
                            step.stop(g, finished);
                        }
                    }
                    return Some((false, now));
                }
                let mut last = at;
                for end in ends.iter() {
                    let (_, t) = (*end)?;
                    last = last.max(t);
                }
                Some((ends.iter().all(|e| matches!(e, Some((true, _)))), last))
            }
            Step::Delay { ms, until } => {
                let until = *until.get_or_insert(at + *ms as f64 / 1000.0);
                (now >= until).then_some((true, until))
            }
            Step::Loop {
                template,
                current,
                runs,
                iterations,
                reset,
                initial,
                at: start,
            } => {
                if *reset && initial.is_none() {
                    let mut nodes = Vec::new();
                    template.nodes(&mut nodes);
                    *initial = Some(
                        nodes
                            .into_iter()
                            .filter_map(|n| Some((n, g.value(n)?)))
                            .collect(),
                    );
                }
                let mut at = *start.get_or_insert(at);
                // Runs that take no time (zero durations) must not spin.
                for _ in 0..64 {
                    match current.advance(g, now, at, finished)? {
                        (false, end) => return Some((false, end)),
                        (true, end) => {
                            *runs += 1;
                            if iterations.is_some_and(|n| *runs >= n) {
                                return Some((true, end));
                            }
                            if let Some(values) = initial {
                                for &(node, value) in values.iter() {
                                    g.set(node, value, finished);
                                }
                            }
                            **current = Step::new(template);
                            at = end;
                            *start = Some(end);
                        }
                    }
                }
                None
            }
        }
    }

    /// Stops what runs (values stay where they are).
    fn stop(&mut self, g: &mut Graph, finished: &mut Vec<Finished>) {
        match self {
            Step::Run {
                node,
                leaf: Some(id),
                ..
            } => {
                if g.running_id(*node) == Some(*id) {
                    g.stop(*node, finished);
                }
            }
            Step::Run { .. } | Step::Delay { .. } => {}
            Step::Sequence { steps, index, .. } => {
                if let Some(step) = steps.get_mut(*index) {
                    step.stop(g, finished);
                }
            }
            Step::Parallel { steps, ends, .. } => {
                for (step, end) in steps.iter_mut().zip(ends.iter()) {
                    if end.is_none() {
                        step.stop(g, finished);
                    }
                }
            }
            Step::Loop { current, .. } => current.stop(g, finished),
        }
    }
}

impl Graph {
    /// Applies an op. Interrupted animations are pushed to `finished`.
    pub fn apply(&mut self, op: AnimationOp, finished: &mut Vec<Finished>) {
        self.apply_op(op, finished);
        self.route_leaf_ends(finished);
    }

    /// Ends of composite steps go to their programs, not to JS.
    fn route_leaf_ends(&mut self, finished: &mut Vec<Finished>) {
        if finished.iter().any(|f| f.animation >= LEAF_IDS) {
            // Interrupted: when does not matter (the program stops).
            self.leaf_ends.extend(
                finished
                    .iter()
                    .filter(|f| f.animation >= LEAF_IDS)
                    .map(|&f| (f, 0.0)),
            );
            finished.retain(|f| f.animation < LEAF_IDS);
        }
    }

    fn apply_op(&mut self, op: AnimationOp, finished: &mut Vec<Finished>) {
        match op {
            AnimationOp::CreateValue { node, value } => self.insert(
                node,
                Node::Value {
                    value,
                    offset: 0.0,
                    velocity: 0.0,
                    running: None,
                },
            ),
            AnimationOp::CreateInterpolate {
                node,
                input,
                input_range,
                output,
                extrapolate_left,
                extrapolate_right,
                easing,
            } => self.insert(
                node,
                Node::Interpolate {
                    input,
                    input_range,
                    output,
                    extrapolate: (extrapolate_left, extrapolate_right),
                    easing,
                },
            ),
            AnimationOp::CreateDiffClamp {
                node,
                input,
                min,
                max,
                snap,
            } => self.insert(
                node,
                Node::DiffClamp {
                    input,
                    min,
                    max: max.max(min),
                    state: Cell::new(None),
                    snap,
                    snapping: Cell::new(None),
                },
            ),
            AnimationOp::CreateMath { node, op, a, b } => {
                self.insert(node, Node::Math { op, a, b })
            }
            AnimationOp::Set { node, value } => self.set(node, value, finished),
            AnimationOp::Adjust {
                node,
                factor,
                offset,
            } => {
                if let Some(value) = self.value(node) {
                    self.set(node, value * factor + offset, finished);
                }
            }
            AnimationOp::SetOutput { node, output } => {
                if let Some(Some(Node::Interpolate {
                    input_range,
                    output: current,
                    ..
                })) = self.nodes.get_mut(node as usize)
                    && output_len(&output) == input_range.len()
                {
                    *current = output;
                }
            }
            AnimationOp::Start {
                node,
                animation,
                driver,
            } => {
                self.start(node, animation, driver, None, finished);
            }
            AnimationOp::StartComposite {
                animation,
                key,
                spec,
            } => {
                let mut nodes = Vec::new();
                spec.nodes(&mut nodes);
                let values = nodes
                    .into_iter()
                    .filter_map(|n| Some((n, self.value(n)?)))
                    .collect();
                match self.baselines.iter_mut().find(|(k, _)| *k == key) {
                    Some(b) => b.1 = values,
                    None => self.baselines.push((key, values)),
                }
                self.programs.push(Program {
                    id: animation,
                    key,
                    root: Step::new(&spec),
                    at: None,
                });
            }
            AnimationOp::ResetComposite { key } => {
                while let Some(i) = self.programs.iter().position(|p| p.key == key) {
                    let mut program = self.programs.remove(i);
                    program.root.stop(self, finished);
                    finished.push(Finished {
                        animation: program.id,
                        finished: false,
                        value: None,
                    });
                }
                if let Some(i) = self.baselines.iter().position(|(k, _)| *k == key) {
                    let (_, values) = self.baselines.swap_remove(i);
                    for &(node, value) in &values {
                        self.set(node, value, finished);
                    }
                    self.baselines.push((key, values));
                }
            }
            AnimationOp::ReleaseComposite { key } => self.baselines.retain(|(k, _)| *k != key),
            AnimationOp::Stop { node } => self.stop(node, finished),
            AnimationOp::StopAnimation { animation } => {
                if let Some(i) = self.programs.iter().position(|p| p.id == animation) {
                    let mut program = self.programs.remove(i);
                    program.root.stop(self, finished);
                    finished.push(Finished::new(animation, false));
                }
            }
            AnimationOp::Release { node } => {
                self.stop(node, finished);
                if let Some(slot) = self.nodes.get_mut(node as usize) {
                    *slot = None;
                }
            }
            AnimationOp::SetOffset { node, offset: new } => {
                if let Some(Some(Node::Value { offset, .. })) = self.nodes.get_mut(node as usize) {
                    *offset = new;
                }
            }
            AnimationOp::FlattenOffset { node } => {
                if let Some(Some(Node::Value { value, offset, .. })) =
                    self.nodes.get_mut(node as usize)
                {
                    *value += std::mem::take(offset);
                }
            }
            AnimationOp::ExtractOffset { node } => {
                if let Some(Some(Node::Value { value, offset, .. })) =
                    self.nodes.get_mut(node as usize)
                {
                    *offset += std::mem::take(value);
                }
            }
            AnimationOp::Read { node, request } => finished.push(Finished {
                animation: request,
                finished: true,
                value: Some(self.eval(node).number()),
            }),
        }
    }

    /// Starts `driver` on value `node` (at `start`, or on the next tick),
    /// replacing its animation. False if there is no such value.
    fn start(
        &mut self,
        node: NodeId,
        animation: AnimationId,
        driver: Driver,
        start: Option<f64>,
        finished: &mut Vec<Finished>,
    ) -> bool {
        let Some(Some(Node::Value {
            value,
            velocity,
            running,
            ..
        })) = self.nodes.get_mut(node as usize)
        else {
            return false;
        };
        let mut new = Running::new(animation, driver, *value, *velocity);
        if let Some(start) = start {
            new = new.starting_at(start);
        }
        if let Some(old) = running.replace(new) {
            finished.push(Finished {
                animation: old.id,
                finished: false,
                value: None,
            });
        }
        if !self.animating.contains(&node) {
            self.animating.push(node);
        }
        true
    }

    /// The animation running on value `node`.
    fn running_id(&self, node: NodeId) -> Option<AnimationId> {
        match self.nodes.get(node as usize)? {
            Some(Node::Value {
                running: Some(r), ..
            }) => Some(r.id),
            _ => None,
        }
    }

    fn insert(&mut self, id: NodeId, node: Node) {
        let idx = id as usize;
        if idx >= self.nodes.len() {
            self.nodes
                .resize_with((idx + 1).next_power_of_two(), || None);
        }
        self.nodes[idx] = Some(node);
    }

    /// Sets a value directly (gestures, scroll offsets, JS `set`), stopping
    /// its animation.
    pub fn set(&mut self, node: NodeId, new: f32, finished: &mut Vec<Finished>) {
        self.stop(node, finished);
        self.route_leaf_ends(finished);
        if let Some(Some(Node::Value {
            value, velocity, ..
        })) = self.nodes.get_mut(node as usize)
        {
            *value = new;
            *velocity = 0.0;
        }
    }

    fn stop(&mut self, node: NodeId, finished: &mut Vec<Finished>) {
        if let Some(Some(Node::Value {
            running, velocity, ..
        })) = self.nodes.get_mut(node as usize)
            && let Some(old) = running.take()
        {
            *velocity = 0.0;
            finished.push(Finished {
                animation: old.id,
                finished: false,
                value: None,
            });
        }
        self.animating.retain(|&n| n != node);
    }

    /// The current value of a value node.
    pub fn value(&self, node: NodeId) -> Option<f32> {
        match self.nodes.get(node as usize)? {
            Some(Node::Value { value, .. }) => Some(*value),
            _ => None,
        }
    }

    /// True while any animation runs (the platform keeps its frame clock on).
    pub fn is_animating(&self) -> bool {
        !self.animating.is_empty() || !self.programs.is_empty() || !self.snaps.is_empty()
    }

    /// The scroll view whose scroll value is `source` came to rest (its
    /// drag and momentum ended): every snapping `diffClamp` that follows it
    /// and rests between its bounds settles at the nearer one, at `max`
    /// only once its input reached `max` (a page scrolled less than a
    /// bar's height shows the whole bar). True if one starts settling.
    pub fn settle(&mut self, source: NodeId) -> bool {
        let mut started = false;
        let at = self.eval(source).number();
        // Register moving nodes first, independent of their ids. Bound
        // dependents then hold their output while those inputs settle.
        for hold_bounds in [false, true] {
            if hold_bounds && !started {
                break;
            }
            for i in 0..self.nodes.len() {
                let Some(Node::DiffClamp {
                    input,
                    min,
                    max,
                    snap: true,
                    ..
                }) = &self.nodes[i]
                else {
                    continue;
                };
                let (input, min, max) = (*input, *min, *max);
                if !self.depends(input, source, 0) {
                    continue;
                }
                // Brings its output up to the input.
                let out = self.eval(i as NodeId).number();
                let x = self.eval(input).number();
                let bounded = out <= min || out >= max;
                if bounded != hold_bounds {
                    continue;
                }
                if hold_bounds && !self.snaps.iter().any(|&node| self.depends(input, node, 0)) {
                    continue;
                }
                let to = if hold_bounds {
                    out
                } else if out - min >= (max - min) / 2.0 && x >= max {
                    max
                } else {
                    min
                };
                if let Some(Node::DiffClamp { snapping, .. }) = &self.nodes[i] {
                    snapping.set(Some(Snap {
                        from: out,
                        to,
                        source,
                        at,
                        input: x,
                        start: None,
                        done: false,
                    }));
                }
                if !self.snaps.contains(&(i as NodeId)) {
                    self.snaps.push(i as NodeId);
                }
                started = true;
            }
        }
        started
    }

    /// Whether `node` reads `source`, directly or through other nodes.
    fn depends(&self, node: NodeId, source: NodeId, depth: u32) -> bool {
        if node == source {
            return true;
        }
        if depth > MAX_DEPTH {
            return false;
        }
        match self.nodes.get(node as usize) {
            Some(Some(Node::Interpolate { input, .. } | Node::DiffClamp { input, .. })) => {
                self.depends(*input, source, depth + 1)
            }
            Some(Some(Node::Math { a, b, .. })) => [a, b].into_iter().any(|o| match *o {
                Operand::Node(n) => self.depends(n, source, depth + 1),
                Operand::Const(_) => false,
            }),
            _ => false,
        }
    }

    /// Moves the settling `diffClamp` nodes to `now`. True if one moved.
    fn run_snaps(&mut self, now: f64) -> bool {
        let mut changed = false;
        let nodes = &self.nodes;
        self.snaps.retain(|&node| {
            let Some(Some(Node::DiffClamp {
                state, snapping, ..
            })) = nodes.get(node as usize)
            else {
                return false;
            };
            // Gone: its scroll view scrolled again.
            let Some(mut snap) = snapping.get() else {
                return false;
            };
            let start = *snap.start.get_or_insert(now);
            let p = ((now - start) / SNAP_SECONDS).clamp(0.0, 1.0) as f32;
            let out = snap.from + (snap.to - snap.from) * ease(Easing::EaseOut, p);
            state.set(Some((snap.input, out)));
            changed = true;
            snap.done = p >= 1.0;
            snapping.set(Some(snap));
            !snap.done
        });
        changed
    }

    /// Advances all animations to `now` (seconds, monotonic). Completed
    /// animations are pushed to `finished`. Returns true if a value changed.
    pub fn tick(&mut self, now: f64, finished: &mut Vec<Finished>) -> bool {
        let mut changed = false;
        let mut i = 0;
        while i < self.animating.len() {
            let node = self.animating[i];
            let (moved, done) = self.step_node(node, now, finished);
            changed |= moved;
            if done {
                self.animating.swap_remove(i);
            } else {
                i += 1;
            }
        }
        if !self.programs.is_empty() {
            changed |= self.run_programs(now, finished);
        }
        if !self.snaps.is_empty() {
            changed |= self.run_snaps(now);
        }
        changed
    }

    /// Steps the animation of `node` to `now`: `(value changed, ended)`.
    /// Ends of composite steps go to `leaf_ends`, with their exact time.
    fn step_node(&mut self, node: NodeId, now: f64, finished: &mut Vec<Finished>) -> (bool, bool) {
        let Some(Some(Node::Value {
            value,
            velocity,
            running: running @ Some(_),
            ..
        })) = self.nodes.get_mut(node as usize)
        else {
            return (false, true);
        };
        let r = running.as_mut().expect("checked");
        let (v, vel, done) = r.step(now);
        let changed = v != *value;
        *value = v;
        *velocity = vel;
        if done {
            let end = Finished {
                animation: r.id,
                finished: true,
                value: None,
            };
            if r.id >= LEAF_IDS {
                self.leaf_ends.push((end, r.end_time(now)));
            } else {
                finished.push(end);
            }
            *running = None;
        }
        (changed, done)
    }

    /// Advances the composite animations; steps they start this frame are
    /// stepped to `now` at once. Returns true if a value changed.
    fn run_programs(&mut self, now: f64, finished: &mut Vec<Finished>) -> bool {
        let mut changed = false;
        for _ in 0..16 {
            self.route_leaf_ends(finished);
            let mut programs = std::mem::take(&mut self.programs);
            programs.retain_mut(|p| {
                let at = *p.at.get_or_insert(now);
                match p.root.advance(self, now, at, finished) {
                    Some((done, _)) => {
                        finished.push(Finished {
                            animation: p.id,
                            finished: done,
                            value: None,
                        });
                        false
                    }
                    None => true,
                }
            });
            programs.append(&mut self.programs);
            self.programs = programs;
            let started = std::mem::take(&mut self.started);
            if started.is_empty() {
                break;
            }
            for node in started {
                let (moved, done) = self.step_node(node, now, finished);
                changed |= moved;
                if done {
                    self.animating.retain(|&n| n != node);
                }
            }
        }
        self.route_leaf_ends(finished);
        if self.programs.is_empty() {
            // Ends of steps no program waits for.
            self.leaf_ends.clear();
        }
        changed
    }

    /// Evaluates any node.
    pub fn eval(&self, node: NodeId) -> AnimationValue {
        self.eval_depth(node, 0)
    }

    fn eval_depth(&self, node: NodeId, depth: u32) -> AnimationValue {
        if depth > MAX_DEPTH {
            return AnimationValue::Number(0.0);
        }
        match self.nodes.get(node as usize) {
            Some(Some(Node::Value { value, offset, .. })) => {
                AnimationValue::Number(*value + *offset)
            }
            Some(Some(Node::Interpolate {
                input,
                input_range,
                output,
                extrapolate,
                easing,
            })) => interpolate(
                self.eval_depth(*input, depth + 1).number(),
                input_range,
                output,
                *extrapolate,
                *easing,
            ),
            Some(Some(Node::DiffClamp {
                input,
                min,
                max,
                state,
                snapping,
                ..
            })) => {
                let x = self.eval_depth(*input, depth + 1).number();
                if let Some(mut snap) = snapping.get() {
                    if self.eval_depth(snap.source, depth + 1).number() != snap.at {
                        // Scrolled again: it follows the input from where
                        // the settling left it.
                        snapping.set(None);
                    } else {
                        // Its input moved with a snapping `diffClamp` it
                        // reads, which settles too: it settles on.
                        if let Some((_, out)) = state.get() {
                            state.set(Some((x, out)));
                        }
                        snap.input = x;
                        snapping.set((!snap.done).then_some(snap));
                    }
                }
                let out = match state.get() {
                    None => x.clamp(*min, *max),
                    Some((last, out)) => (out + x - last).clamp(*min, *max),
                };
                state.set(Some((x, out)));
                AnimationValue::Number(out)
            }
            Some(Some(Node::Math { op, a, b })) => {
                let operand = |o: &Operand| match *o {
                    Operand::Node(n) => self.eval_depth(n, depth + 1).number(),
                    Operand::Const(c) => c,
                };
                let (a, b) = (operand(a), operand(b));
                AnimationValue::Number(match op {
                    MathOp::Mod if b != 0.0 => ((a % b) + b) % b,
                    MathOp::Mod => 0.0,
                    MathOp::Add => a + b,
                    MathOp::Sub => a - b,
                    MathOp::Mul => a * b,
                    MathOp::Div if b != 0.0 => a / b,
                    MathOp::Div => 0.0,
                })
            }
            _ => AnimationValue::Number(0.0),
        }
    }
}

/// How many outputs an interpolation has.
fn output_len(output: &Output) -> usize {
    match output {
        Output::Numbers(v) => v.len(),
        Output::Colors(v) => v.len(),
    }
}

fn interpolate(
    x: f32,
    input: &[f32],
    output: &Output,
    (left, right): (Extrapolate, Extrapolate),
    easing: Easing,
) -> AnimationValue {
    let n = input.len().min(output_len(output));
    if n == 0 {
        return AnimationValue::Number(x);
    }
    let (first, last) = (input[0], input[n - 1]);
    let extrapolate = if x < first { left } else { right };
    if n == 1 || (x < first || x > last) && extrapolate != Extrapolate::Extend {
        if extrapolate == Extrapolate::Identity && n > 1 {
            return AnimationValue::Number(x);
        }
        let i = if n == 1 || x < first { 0 } else { n - 1 };
        return match output {
            Output::Numbers(v) => AnimationValue::Number(v[i]),
            Output::Colors(v) => AnimationValue::Color(v[i]),
        };
    }
    // Segment containing x (or the edge segment when extending).
    let seg = input[..n]
        .windows(2)
        .position(|w| x <= w[1])
        .unwrap_or(n - 2);
    let (a, b) = (input[seg], input[seg + 1]);
    let t = if b == a { 0.0 } else { (x - a) / (b - a) };
    // The curve applies within the range (extended segments stay linear).
    let t = if easing != Easing::Linear && (0.0..=1.0).contains(&t) {
        ease(easing, t)
    } else {
        t
    };
    match output {
        Output::Numbers(v) => AnimationValue::Number(v[seg] + (v[seg + 1] - v[seg]) * t),
        Output::Colors(v) => {
            AnimationValue::Color(lerp_color(v[seg], v[seg + 1], t.clamp(0.0, 1.0)))
        }
    }
}

fn lerp_color(a: u32, b: u32, t: f32) -> u32 {
    let mut out = 0u32;
    for shift in [24, 16, 8, 0] {
        let ca = ((a >> shift) & 0xff) as f32;
        let cb = ((b >> shift) & 0xff) as f32;
        out |= ((ca + (cb - ca) * t).round() as u32 & 0xff) << shift;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::animation::ops::{Driver, Easing};

    const CLAMP: (Extrapolate, Extrapolate) = (Extrapolate::Clamp, Extrapolate::Clamp);

    #[test]
    fn interpolation_and_extrapolation() {
        let out = Output::Numbers(vec![0.0, 10.0, 0.0]);
        let r = [0.0, 1.0, 2.0];
        assert_eq!(
            interpolate(0.5, &r, &out, CLAMP, Easing::Linear),
            AnimationValue::Number(5.0)
        );
        assert_eq!(
            interpolate(1.5, &r, &out, CLAMP, Easing::Linear),
            AnimationValue::Number(5.0)
        );
        assert_eq!(
            interpolate(3.0, &r, &out, CLAMP, Easing::Linear),
            AnimationValue::Number(0.0)
        );
        assert_eq!(
            interpolate(
                3.0,
                &r,
                &out,
                (Extrapolate::Extend, Extrapolate::Extend),
                Easing::Linear
            ),
            AnimationValue::Number(-10.0)
        );
        assert_eq!(
            interpolate(
                -1.0,
                &r,
                &out,
                (Extrapolate::Identity, Extrapolate::Identity),
                Easing::Linear
            ),
            AnimationValue::Number(-1.0)
        );
        let colors = Output::Colors(vec![0x0000_00ff, 0xff00_00ff]);
        assert_eq!(
            interpolate(0.5, &[0.0, 1.0], &colors, CLAMP, Easing::Linear),
            AnimationValue::Color(0x8000_00ff)
        );
    }

    #[test]
    fn an_interpolation_takes_other_outputs() {
        let mut g = Graph::default();
        let mut finished = Vec::new();
        g.apply(
            AnimationOp::CreateValue {
                node: 1,
                value: 1.0,
            },
            &mut finished,
        );
        g.apply(
            AnimationOp::CreateInterpolate {
                node: 2,
                input: 1,
                input_range: vec![0.0, 1.0],
                output: Output::Colors(vec![0x0000_00ff, 0xff00_00ff]),
                extrapolate_left: Extrapolate::Clamp,
                extrapolate_right: Extrapolate::Clamp,
                easing: Easing::Linear,
            },
            &mut finished,
        );
        g.apply(
            AnimationOp::SetOutput {
                node: 2,
                output: Output::Colors(vec![0x0000_00ff, 0x00ff_00ff]),
            },
            &mut finished,
        );
        assert_eq!(g.eval(2), AnimationValue::Color(0x00ff_00ff));
        // Another number of outputs than of inputs is refused.
        g.apply(
            AnimationOp::SetOutput {
                node: 2,
                output: Output::Colors(vec![0xffff_ffff]),
            },
            &mut finished,
        );
        assert_eq!(g.eval(2), AnimationValue::Color(0x00ff_00ff));
    }

    #[test]
    fn derived_nodes_follow_animated_values() {
        let mut g = Graph::default();
        let mut finished = Vec::new();
        g.apply(
            AnimationOp::CreateValue {
                node: 1,
                value: 0.0,
            },
            &mut finished,
        );
        g.apply(
            AnimationOp::CreateInterpolate {
                node: 2,
                input: 1,
                input_range: vec![0.0, 100.0],
                output: Output::Numbers(vec![1.0, 0.0]),
                extrapolate_left: Extrapolate::Clamp,
                extrapolate_right: Extrapolate::Clamp,
                easing: Easing::Linear,
            },
            &mut finished,
        );
        g.apply(
            AnimationOp::CreateMath {
                node: 3,
                op: MathOp::Mul,
                a: Operand::Node(1),
                b: Operand::Const(-1.0),
            },
            &mut finished,
        );
        g.apply(
            AnimationOp::Start {
                node: 1,
                animation: 7,
                driver: Driver::Timing {
                    to: 100.0,
                    duration_ms: 100.0,
                    easing: Easing::Linear,
                    delay_ms: 0.0,
                },
            },
            &mut finished,
        );
        assert!(g.is_animating());
        g.tick(0.0, &mut finished);
        g.tick(0.05, &mut finished);
        assert!((g.eval(2).number() - 0.5).abs() < 1e-4);
        assert!((g.eval(3).number() + 50.0).abs() < 1e-3);
        g.tick(0.2, &mut finished);
        assert_eq!(
            finished,
            vec![Finished {
                animation: 7,
                finished: true,
                value: None,
            }]
        );
        assert!(!g.is_animating());
        assert_eq!(g.value(1), Some(100.0));
    }

    #[test]
    fn interrupting_reports_unfinished_and_keeps_velocity() {
        let mut g = Graph::default();
        let mut finished = Vec::new();
        g.apply(
            AnimationOp::CreateValue {
                node: 1,
                value: 0.0,
            },
            &mut finished,
        );
        let spring = |to| Driver::Spring {
            to,
            stiffness: 100.0,
            damping: 10.0,
            mass: 1.0,
            velocity: None,
        };
        g.apply(
            AnimationOp::Start {
                node: 1,
                animation: 1,
                driver: spring(100.0),
            },
            &mut finished,
        );
        g.tick(0.0, &mut finished);
        g.tick(0.1, &mut finished);
        g.apply(
            AnimationOp::Start {
                node: 1,
                animation: 2,
                driver: spring(0.0),
            },
            &mut finished,
        );
        assert_eq!(
            finished,
            vec![Finished {
                animation: 1,
                finished: false,
                value: None,
            }]
        );
        // A gesture takes over: stops the running animation.
        g.set(1, 42.0, &mut finished);
        assert_eq!(
            finished.last(),
            Some(&Finished {
                animation: 2,
                finished: false,
                value: None,
            })
        );
        assert_eq!(g.value(1), Some(42.0));
        assert!(!g.is_animating());
    }

    fn timing(to: f32, ms: f32) -> Driver {
        Driver::Timing {
            to,
            duration_ms: ms,
            easing: Easing::Linear,
            delay_ms: 0.0,
        }
    }

    fn values(g: &mut Graph, f: &mut Vec<Finished>, nodes: &[NodeId]) {
        for &node in nodes {
            g.apply(AnimationOp::CreateValue { node, value: 0.0 }, f);
        }
    }

    #[test]
    fn affine_updates_use_the_live_base_and_composite_resets_restore_it() {
        let mut g = Graph::default();
        let mut f = Vec::new();
        values(&mut g, &mut f, &[1, 2]);
        g.set(1, 10.0, &mut f);
        g.apply(
            AnimationOp::Start {
                node: 1,
                animation: 7,
                driver: timing(30.0, 100.0),
            },
            &mut f,
        );
        g.tick(0.0, &mut f);
        g.tick(0.05, &mut f);
        assert_eq!(g.value(1), Some(20.0));
        let adjust = AnimationOp::Adjust {
            node: 1,
            factor: 2.0,
            offset: 1.0,
        };
        g.apply(adjust, &mut f);
        assert_eq!(g.value(1), Some(41.0));
        assert_eq!(f, vec![Finished::new(7, false)]);
        assert!(!g.is_animating());
        g.apply(
            AnimationOp::Adjust {
                node: 1,
                factor: 0.5,
                offset: -0.5,
            },
            &mut f,
        );
        assert_eq!(g.value(1), Some(20.0));
        g.apply(
            AnimationOp::SetOffset {
                node: 1,
                offset: 3.0,
            },
            &mut f,
        );
        g.apply(
            AnimationOp::Adjust {
                node: 1,
                factor: 2.0,
                offset: 1.0,
            },
            &mut f,
        );
        assert_eq!((g.value(1), g.eval(1).number()), (Some(41.0), 44.0));

        for (node, key) in [(1, 11), (2, 12)] {
            let start = AnimationOp::StartComposite {
                animation: key,
                key,
                spec: Composite::Run {
                    node,
                    driver: timing(100.0, 100.0),
                },
            };
            g.apply(start, &mut f);
        }
        g.set(1, 99.0, &mut f);
        g.apply(AnimationOp::ResetComposite { key: 11 }, &mut f);
        assert_eq!(g.value(1), Some(41.0));
    }

    /// Ticks at 60 Hz from `from` to `to` seconds.
    fn run(g: &mut Graph, f: &mut Vec<Finished>, from: f64, to: f64) {
        let mut t = from;
        while t <= to + 1e-9 {
            g.tick(t, f);
            t += 1.0 / 60.0;
        }
    }

    #[test]
    fn sequences_run_step_after_step_without_gaps() {
        let mut g = Graph::default();
        let mut f = Vec::new();
        values(&mut g, &mut f, &[1, 2]);
        g.apply(
            AnimationOp::StartComposite {
                animation: 5,
                key: 1,
                spec: Composite::Sequence(vec![
                    Composite::Run {
                        node: 1,
                        driver: timing(100.0, 100.0),
                    },
                    Composite::Delay(50.0),
                    Composite::Run {
                        node: 2,
                        driver: timing(10.0, 100.0),
                    },
                ]),
            },
            &mut f,
        );
        assert!(g.is_animating());
        run(&mut g, &mut f, 0.0, 0.12);
        assert_eq!(g.value(1), Some(100.0));
        assert_eq!(g.value(2), Some(0.0));
        // 100 ms run + 50 ms delay: the second run is halfway at 200 ms.
        g.tick(0.2, &mut f);
        let v = g.value(2).unwrap();
        assert!((4.0..6.0).contains(&v), "{v}");
        run(&mut g, &mut f, 0.2, 0.4);
        assert_eq!(g.value(2), Some(10.0));
        assert_eq!(
            f,
            vec![Finished {
                animation: 5,
                finished: true,
                value: None,
            }]
        );
        assert!(!g.is_animating());
    }

    #[test]
    fn parallel_groups_stop_together_when_interrupted() {
        let mut g = Graph::default();
        let mut f = Vec::new();
        values(&mut g, &mut f, &[1, 2]);
        g.apply(
            AnimationOp::StartComposite {
                animation: 9,
                key: 1,
                spec: Composite::Parallel {
                    children: vec![
                        Composite::Run {
                            node: 1,
                            driver: timing(100.0, 1000.0),
                        },
                        Composite::Run {
                            node: 2,
                            driver: timing(100.0, 1000.0),
                        },
                    ],
                    stop_together: true,
                },
            },
            &mut f,
        );
        run(&mut g, &mut f, 0.0, 0.1);
        // A gesture takes node 1: the group ends, node 2 stops too.
        g.set(1, 0.0, &mut f);
        assert!(f.is_empty(), "step ends are not reported to JS: {f:?}");
        g.tick(0.12, &mut f);
        assert_eq!(
            f,
            vec![Finished {
                animation: 9,
                finished: false,
                value: None,
            }]
        );
        let stopped = g.value(2).unwrap();
        g.tick(0.5, &mut f);
        assert_eq!(g.value(2), Some(stopped));
        assert!(!g.is_animating());
    }

    #[test]
    fn loops_reset_and_count() {
        let mut g = Graph::default();
        let mut f = Vec::new();
        values(&mut g, &mut f, &[1]);
        g.apply(
            AnimationOp::StartComposite {
                animation: 3,
                key: 1,
                spec: Composite::Loop {
                    child: Box::new(Composite::Run {
                        node: 1,
                        driver: timing(10.0, 100.0),
                    }),
                    iterations: Some(3),
                    reset: true,
                },
            },
            &mut f,
        );
        g.tick(0.0, &mut f);
        g.tick(0.15, &mut f);
        // The second run started over from 0.
        let v = g.value(1).unwrap();
        assert!(v < 10.0, "{v}");
        run(&mut g, &mut f, 0.15, 0.5);
        assert_eq!(g.value(1), Some(10.0));
        assert_eq!(
            f,
            vec![Finished {
                animation: 3,
                finished: true,
                value: None,
            }]
        );

        // Forever, until stopped.
        f.clear();
        g.apply(
            AnimationOp::StartComposite {
                animation: 4,
                key: 2,
                spec: Composite::Loop {
                    child: Box::new(Composite::Run {
                        node: 1,
                        driver: timing(20.0, 100.0),
                    }),
                    iterations: None,
                    reset: true,
                },
            },
            &mut f,
        );
        run(&mut g, &mut f, 1.0, 3.0);
        assert!(f.is_empty());
        g.apply(AnimationOp::StopAnimation { animation: 4 }, &mut f);
        assert_eq!(
            f,
            vec![Finished {
                animation: 4,
                finished: false,
                value: None,
            }]
        );
        assert!(!g.is_animating());
        // Back to where the forever loop started (10).
        g.set(1, 7.0, &mut f);
        g.apply(AnimationOp::ResetComposite { key: 2 }, &mut f);
        assert_eq!(g.value(1), Some(10.0));
    }

    #[test]
    fn diff_clamp_and_modulo() {
        let mut g = Graph::default();
        let mut f = Vec::new();
        values(&mut g, &mut f, &[1]);
        g.apply(
            AnimationOp::CreateDiffClamp {
                node: 2,
                input: 1,
                min: 0.0,
                max: 50.0,
                snap: false,
            },
            &mut f,
        );
        g.apply(
            AnimationOp::CreateMath {
                node: 3,
                op: MathOp::Mod,
                a: Operand::Node(1),
                b: Operand::Const(360.0),
            },
            &mut f,
        );
        let mut at = |g: &mut Graph, v: f32| {
            g.set(1, v, &mut f);
            g.eval(2).number()
        };
        assert_eq!(at(&mut g, 0.0), 0.0);
        assert_eq!(at(&mut g, 30.0), 30.0);
        assert_eq!(at(&mut g, 200.0), 50.0);
        // Scrolling back by 20 shows 20 of it again.
        assert_eq!(at(&mut g, 180.0), 30.0);
        assert_eq!(at(&mut g, 0.0), 0.0);
        g.set(1, -30.0, &mut f);
        assert_eq!(g.eval(3).number(), 330.0);
    }

    /// A snapping `diffClamp` of value 1 in `0..=50` (node 2).
    fn snapping(g: &mut Graph, f: &mut Vec<Finished>) {
        values(g, f, &[1]);
        g.apply(
            AnimationOp::CreateDiffClamp {
                node: 2,
                input: 1,
                min: 0.0,
                max: 50.0,
                snap: true,
            },
            f,
        );
    }

    /// Scrolls value 1 to each of `offsets`, as frames of a scroll.
    fn scroll(g: &mut Graph, f: &mut Vec<Finished>, offsets: &[f32]) {
        for &o in offsets {
            g.set(1, o, f);
            g.eval(2);
        }
    }

    #[test]
    fn a_snapping_diff_clamp_settles_at_the_nearer_bound() {
        let mut g = Graph::default();
        let mut f = Vec::new();
        snapping(&mut g, &mut f);
        // Down 200, back up 10: 40 of 50 hidden, nearer to hidden.
        scroll(&mut g, &mut f, &[0.0, 200.0, 190.0]);
        assert_eq!(g.eval(2).number(), 40.0);
        assert!(g.settle(1));
        assert!(g.is_animating());
        g.tick(1.0, &mut f);
        assert_eq!(g.eval(2).number(), 40.0);
        g.tick(1.1, &mut f);
        let mid = g.eval(2).number();
        assert!(mid > 40.0 && mid < 50.0, "{mid}");
        g.tick(1.2, &mut f);
        assert_eq!(g.eval(2).number(), 50.0);
        assert!(!g.is_animating());
        // Back up 30 from there: 20 hidden, nearer to shown.
        scroll(&mut g, &mut f, &[160.0]);
        assert_eq!(g.eval(2).number(), 20.0);
        assert!(g.settle(1));
        run(&mut g, &mut f, 2.0, 2.3);
        assert_eq!(g.eval(2).number(), 0.0);
        // It follows the scrolling from where it settled.
        scroll(&mut g, &mut f, &[170.0]);
        assert_eq!(g.eval(2).number(), 10.0);
    }

    #[test]
    fn a_snapping_diff_clamp_hides_only_once_its_input_reached_max() {
        let mut g = Graph::default();
        let mut f = Vec::new();
        snapping(&mut g, &mut f);
        // A page scrolled 40 of a 50 bar: hiding it would leave a gap.
        scroll(&mut g, &mut f, &[0.0, 40.0]);
        assert!(g.settle(1));
        run(&mut g, &mut f, 1.0, 1.3);
        assert_eq!(g.eval(2).number(), 0.0);
    }

    #[test]
    fn scrolling_again_ends_the_settling_where_it_is() {
        let mut g = Graph::default();
        let mut f = Vec::new();
        snapping(&mut g, &mut f);
        scroll(&mut g, &mut f, &[0.0, 200.0, 190.0]);
        g.settle(1);
        g.tick(1.0, &mut f);
        g.tick(1.1, &mut f);
        let at = g.eval(2).number();
        // The finger moves the page down 5 before it ended.
        scroll(&mut g, &mut f, &[195.0]);
        assert_eq!(g.eval(2).number(), (at + 5.0).min(50.0));
        g.tick(1.15, &mut f);
        assert!(!g.is_animating());
        assert_eq!(g.eval(2).number(), (at + 5.0).min(50.0));
    }

    #[test]
    fn a_snapping_diff_clamp_of_a_snapping_one_settles_too() {
        let mut g = Graph::default();
        let mut f = Vec::new();
        snapping(&mut g, &mut f);
        // One of the first, in `0..=100`.
        g.apply(
            AnimationOp::CreateDiffClamp {
                node: 3,
                input: 2,
                min: 0.0,
                max: 100.0,
                snap: true,
            },
            &mut f,
        );
        let at = |g: &Graph| (g.eval(2).number(), g.eval(3).number());
        for o in [0.0, 200.0, 190.0] {
            g.set(1, o, &mut f);
            g.eval(3);
        }
        assert_eq!(at(&g), (40.0, 40.0));
        // The first hides, past half; the second, short of half, shows.
        assert!(g.settle(1));
        g.tick(1.0, &mut f);
        assert_eq!(at(&g), (40.0, 40.0));
        g.tick(1.1, &mut f);
        let (first, second) = at(&g);
        assert!(first > 40.0 && first < 50.0, "{first}");
        assert!(second > 0.0 && second < 40.0, "{second}");
        g.tick(1.2, &mut f);
        assert_eq!(at(&g), (50.0, 0.0));
        assert!(!g.is_animating());
        // Both follow the scrolling from there.
        g.set(1, 180.0, &mut f);
        assert_eq!(at(&g), (40.0, 0.0));
        g.set(1, 185.0, &mut f);
        assert_eq!(at(&g), (45.0, 5.0));

        // The second stays at its lower bound while the first hides.
        g.set(1, 180.0, &mut f);
        assert_eq!(at(&g), (40.0, 0.0));
        assert!(g.settle(1));
        for now in [2.0, 2.1, 2.3] {
            g.tick(now, &mut f);
            assert_eq!(g.eval(3).number(), 0.0);
        }
        assert_eq!(at(&g), (50.0, 0.0));
        assert!(!g.is_animating());
        g.set(1, 170.0, &mut f);
        assert_eq!(at(&g), (40.0, 0.0));
        g.set(1, 175.0, &mut f);
        assert_eq!(at(&g), (45.0, 5.0));
    }

    #[test]
    fn a_bound_diff_clamp_holds_while_its_input_settles_regardless_of_node_order() {
        for (first, second) in [(2, 3), (3, 2)] {
            let mut g = Graph::default();
            let mut f = Vec::new();
            values(&mut g, &mut f, &[1]);
            for (node, input, max) in [(first, 1, 50.0), (second, first, 10.0)] {
                g.apply(
                    AnimationOp::CreateDiffClamp {
                        node,
                        input,
                        min: 0.0,
                        max,
                        snap: true,
                    },
                    &mut f,
                );
            }
            for y in [0.0, 40.0] {
                g.set(1, y, &mut f);
                g.eval(second);
            }
            assert_eq!(g.eval(second).number(), 10.0);
            assert!(g.settle(1));
            for now in [1.0, 1.1, 1.3] {
                g.tick(now, &mut f);
                assert_eq!(g.eval(second).number(), 10.0);
            }
            assert_eq!(g.eval(first).number(), 0.0);
            assert!(!g.is_animating());
            assert!(!g.settle(1));
            g.set(1, 35.0, &mut f);
            assert_eq!(g.eval(second).number(), 10.0);
            g.set(1, 45.0, &mut f);
            assert_eq!(g.eval(second).number(), 10.0);
            g.set(1, 40.0, &mut f);
            assert_eq!(g.eval(second).number(), 5.0);
        }
    }

    #[test]
    fn only_snapping_diff_clamps_of_the_scroll_value_settle() {
        let mut g = Graph::default();
        let mut f = Vec::new();
        snapping(&mut g, &mut f);
        values(&mut g, &mut f, &[3]);
        // A plain one of the same value, a snapping one through a product.
        g.apply(
            AnimationOp::CreateDiffClamp {
                node: 4,
                input: 1,
                min: 0.0,
                max: 50.0,
                snap: false,
            },
            &mut f,
        );
        g.apply(
            AnimationOp::CreateMath {
                node: 5,
                op: MathOp::Mul,
                a: Operand::Node(1),
                b: Operand::Const(2.0),
            },
            &mut f,
        );
        g.apply(
            AnimationOp::CreateDiffClamp {
                node: 6,
                input: 5,
                min: 0.0,
                max: 50.0,
                snap: true,
            },
            &mut f,
        );
        for o in [0.0, 200.0, 190.0] {
            g.set(1, o, &mut f);
            for n in [2, 4, 6] {
                g.eval(n);
            }
        }
        // Another value's end settles nothing.
        assert!(!g.settle(3));
        assert!(g.settle(1));
        run(&mut g, &mut f, 1.0, 1.3);
        assert_eq!(g.eval(2).number(), 50.0);
        assert_eq!(g.eval(4).number(), 40.0);
        // Through the product too: 30 of 50 hidden (twice the 10 scrolled
        // back), nearer to hidden.
        assert_eq!(g.eval(6).number(), 50.0);
        // At a bound, nothing moves.
        assert!(!g.settle(1));
    }

    #[test]
    fn interpolation_sides_and_easing() {
        let out = Output::Numbers(vec![0.0, 100.0]);
        let r = [0.0, 1.0];
        let both = |l, r_| (l, r_);
        assert_eq!(
            interpolate(
                -1.0,
                &r,
                &out,
                both(Extrapolate::Clamp, Extrapolate::Extend),
                Easing::Linear
            ),
            AnimationValue::Number(0.0)
        );
        assert_eq!(
            interpolate(
                2.0,
                &r,
                &out,
                both(Extrapolate::Clamp, Extrapolate::Extend),
                Easing::Linear
            ),
            AnimationValue::Number(200.0)
        );
        let eased = interpolate(
            0.5,
            &r,
            &out,
            both(Extrapolate::Clamp, Extrapolate::Clamp),
            Easing::Curve(
                crate::animation::ops::Curve::Quad,
                crate::animation::ops::EaseMode::In,
            ),
        );
        assert_eq!(eased, AnimationValue::Number(25.0));
    }

    #[test]
    fn cycles_do_not_overflow() {
        let mut g = Graph::default();
        let mut f = Vec::new();
        g.apply(
            AnimationOp::CreateMath {
                node: 1,
                op: MathOp::Add,
                a: Operand::Node(1),
                b: Operand::Const(1.0),
            },
            &mut f,
        );
        let _ = g.eval(1);
    }

    #[test]
    fn offsets_and_reads() {
        let mut g = Graph::default();
        let mut f = Vec::new();
        values(&mut g, &mut f, &[1]);
        g.set(1, 10.0, &mut f);
        g.apply(
            AnimationOp::SetOffset {
                node: 1,
                offset: 5.0,
            },
            &mut f,
        );
        assert_eq!(g.eval(1).number(), 15.0);
        assert_eq!(g.value(1), Some(10.0));
        // A drag starting from 0, on top of where the value was.
        g.apply(AnimationOp::ExtractOffset { node: 1 }, &mut f);
        assert_eq!((g.value(1), g.eval(1).number()), (Some(0.0), 15.0));
        g.set(1, 3.0, &mut f);
        g.apply(AnimationOp::FlattenOffset { node: 1 }, &mut f);
        assert_eq!((g.value(1), g.eval(1).number()), (Some(18.0), 18.0));
        g.apply(
            AnimationOp::CreateMath {
                node: 2,
                op: MathOp::Mul,
                a: Operand::Node(1),
                b: Operand::Const(2.0),
            },
            &mut f,
        );
        g.apply(
            AnimationOp::Read {
                node: 2,
                request: 40,
            },
            &mut f,
        );
        assert_eq!(
            f,
            [Finished {
                animation: 40,
                finished: true,
                value: Some(36.0),
            }]
        );
    }

    #[test]
    fn loops_end_when_their_values_are_released() {
        let mut g = Graph::default();
        let mut f = Vec::new();
        values(&mut g, &mut f, &[1, 2]);
        for (animation, key, node, spec) in [
            // A loop that is animating its value when it goes.
            (
                3,
                1,
                1,
                Composite::Run {
                    node: 1,
                    driver: timing(10.0, 100.0),
                },
            ),
            // One waiting in a delay when it goes.
            (
                5,
                2,
                2,
                Composite::Sequence(vec![
                    Composite::Delay(100.0),
                    Composite::Run {
                        node: 2,
                        driver: timing(10.0, 100.0),
                    },
                ]),
            ),
        ] {
            g.apply(
                AnimationOp::StartComposite {
                    animation,
                    key,
                    spec: Composite::Loop {
                        child: Box::new(spec),
                        iterations: None,
                        reset: true,
                    },
                },
                &mut f,
            );
            run(&mut g, &mut f, 0.0, 0.5);
            assert!(f.is_empty() && g.is_animating());
            g.apply(AnimationOp::ReleaseComposite { key }, &mut f);
            g.apply(AnimationOp::Release { node }, &mut f);
            run(&mut g, &mut f, 0.5, 1.0);
            assert_eq!(f, [Finished::new(animation, false)]);
            assert!(!g.is_animating());
            f.clear();
        }
    }
}

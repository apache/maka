use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use nsh_core::{
    NodeId,
    geometry::{Bounds, Point, Points, Size},
};

use super::{
    Agent, DragOptions, Key, LANDING, Native, RemoteScene, StepOutcome, TestStep,
    refuse_custom_drag,
};

struct Input {
    events: Arc<Mutex<Vec<&'static str>>>,
    fail_up: Arc<AtomicBool>,
}
impl Native for Input {
    fn bounds(&self, _: NodeId) -> Option<Bounds<Points>> {
        None
    }
    fn viewport(&self) -> Size<Points> {
        Size::new(Points(100.0), Points(100.0))
    }
    fn press(&self, _: Point<Points>) {}
    fn long_press(&self, _: Point<Points>, _: Duration) {}
    fn scroll(&self, _: Point<Points>, _: Point<Points>) {}
    fn drag(&self, _: Point<Points>, _: Point<Points>, options: DragOptions) -> Result<(), String> {
        refuse_custom_drag("drag", options)?;
        self.events.lock().unwrap().push("drag");
        Ok(())
    }
    fn drag_and_hold(
        &self,
        _: Point<Points>,
        _: Point<Points>,
        options: DragOptions,
    ) -> Result<(), String> {
        refuse_custom_drag("dragAndHold", options)?;
        self.events.lock().unwrap().push("hold");
        Ok(())
    }
    fn drop_at(&self, _: Point<Points>) -> Result<(), String> {
        if self.fail_up.load(Ordering::Relaxed) {
            return Err("Up failed".into());
        }
        self.events.lock().unwrap().push("up");
        Ok(())
    }
    fn type_text(&self, _: &str) {}
    fn key(&self, _: Key) {}
    fn input_text(&self, _: NodeId) -> Option<String> {
        None
    }
    fn back(&self) -> Result<(), String> {
        Ok(())
    }
    fn answer_dialog(&self, _: Option<&str>) -> Result<(), String> {
        Ok(())
    }
    fn animating(&self) -> bool {
        false
    }
    fn screenshot(&self) -> Result<Vec<u8>, String> {
        Ok(Vec::new())
    }
    fn resize(&self, _: Points, _: Points) -> Result<(), String> {
        Ok(())
    }
    fn set_dark(&self, _: bool) -> Result<(), String> {
        Ok(())
    }
    fn quit(&self) {
        self.events.lock().unwrap().push("quit");
    }
}

fn input() -> Input {
    Input {
        events: Arc::default(),
        fail_up: Arc::default(),
    }
}
fn position() -> Point<Points> {
    Point::new(Points(20.0), Points(30.0))
}
fn agent(input: Input) -> Agent {
    let size = input.viewport();
    let agent = Agent::new(
        Arc::new(RemoteScene::new(|_| panic!("no scene query expected"))),
        Box::new(input),
    );
    *agent.viewport.lock().unwrap() = Some(size);
    *agent.held.lock().unwrap() = Some(position());
    agent
}

#[test]
fn default_timing_agents_reject_custom_holds_before_input_and_keep_default_calls() {
    let input = input();
    let at = position();
    let long = DragOptions::default().hold(Duration::from_millis(600));
    assert!(input.drag(at, at, long).is_err());
    assert!(input.drag_and_hold(at, at, long).is_err());
    assert!(input.events.lock().unwrap().is_empty());
    input.drag(at, at, DragOptions::default()).unwrap();
    input
        .drag_and_hold(at, at, DragOptions::default().hold(LANDING))
        .unwrap();
    assert_eq!(*input.events.lock().unwrap(), ["drag", "hold"]);
}

#[test]
fn failed_up_keeps_the_owner_and_blocks_new_down_until_a_retry_succeeds() {
    let input = input();
    let events = input.events.clone();
    let fail = input.fail_up.clone();
    fail.store(true, Ordering::Relaxed);
    let agent = agent(input);
    assert_eq!(agent.drop_held(), Err("Up failed".into()));
    assert_eq!(*agent.held.lock().unwrap(), Some(position()));
    assert_eq!(
        agent.drag("id:any", 10.0, 0.0, DragOptions::default()),
        Err("Up failed".into())
    );
    assert_eq!(
        agent.drag_and_hold("id:any", 10.0, 0.0, DragOptions::default()),
        Err("Up failed".into())
    );
    assert!(events.lock().unwrap().is_empty());
    fail.store(false, Ordering::Relaxed);
    assert_eq!(agent.release_held(), Ok(true));
    assert_eq!(agent.release_held(), Ok(false));
    assert_eq!(*events.lock().unwrap(), ["up"]);
}

#[test]
fn closing_releases_the_held_finger_before_quitting() {
    let input = input();
    let events = input.events.clone();
    let agent = agent(input);
    assert_eq!(
        agent.take(TestStep::Quit),
        StepOutcome::Done {
            value: serde_json::Value::Null
        }
    );
    assert_eq!(*agent.held.lock().unwrap(), None);
    assert_eq!(*events.lock().unwrap(), ["up", "quit"]);
}

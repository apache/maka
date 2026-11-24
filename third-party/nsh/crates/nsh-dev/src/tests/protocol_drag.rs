use super::TestStep;

#[test]
fn drag_hold_round_trips_fractional_times_and_omits_the_default() {
    for name in ["drag", "drag_and_hold"] {
        let legacy = format!(r#"{{"step":"{name}","selector":"id:row","x":12.25,"y":-0.1}}"#);
        let step: TestStep = serde_json::from_str(&legacy).unwrap();
        let encoded = serde_json::to_value(&step).unwrap();
        assert!(encoded.get("hold_ms").is_none());
        assert_eq!(serde_json::from_value::<TestStep>(encoded).unwrap(), step);

        let requested = format!(
            r#"{{"step":"{name}","selector":"id:row","x":12.25,"y":-0.1,"hold_ms":600.5}}"#
        );
        let step: TestStep = serde_json::from_str(&requested).unwrap();
        match &step {
            TestStep::Drag { hold_ms, .. } | TestStep::DragAndHold { hold_ms, .. } => {
                assert_eq!(*hold_ms, Some(600.5));
            }
            _ => panic!("expected a drag step"),
        }
        assert_eq!(
            serde_json::from_value::<TestStep>(serde_json::to_value(&step).unwrap()).unwrap(),
            step
        );
    }
}

//! Explicit real-window measurements for Linux decoration. Frame-clock
//! intervals measure update cadence, not GPU execution or presentation timestamps.

use super::*;

#[test]
#[ignore = "opens a window and measures the active GTK renderer"]
fn continuous_corner_frame_cost() {
    crate::gtk_test::run(run).expect("benchmark requires a display");
}

fn run() {
    use std::{cell::Cell, rc::Rc, time::Instant};

    use crate::view::NshView;

    let ticks_per_second: f64 = String::from_utf8(
        std::process::Command::new("getconf")
            .arg("CLK_TCK")
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .parse()
    .unwrap();
    let cpu_seconds = || {
        let stat = std::fs::read_to_string("/proc/self/stat").unwrap();
        stat.rsplit_once(") ")
            .unwrap()
            .1
            .split_whitespace()
            .skip(11)
            .take(2)
            .map(|v| v.parse::<u64>().unwrap())
            .sum::<u64>() as f64
            / ticks_per_second
    };
    for scene in ["background", "clip-border", "shadow"] {
        for continuous in [false, true] {
            let fixed = gtk::Fixed::new();
            let mut cards = Vec::new();
            for ix in 0..100 {
                let card = NshView::new(ix + 1, nsh_core::ViewKind::View);
                {
                    let mut state = card.state_mut();
                    state.frame = crate::gtk_test::frame(0.0, 0.0, 110.0, 70.0);
                    state.style.background_color = Color(0x3366_ccff);
                    state.style.border_radius = Points(20.0);
                    state.style.continuous_corners = continuous;
                    if scene == "clip-border" {
                        state.style.overflow_hidden = true;
                        state.style.borders.widths = nsh_core::geometry::Edges::all(Points(2.0));
                        state.style.borders.colors = [Color(0xffcc_00ff); 4];
                    }
                    if scene == "shadow" {
                        let mut effects = nsh_core::Effects::default();
                        effects.box_shadows.push(nsh_core::BoxShadow {
                            offset_y: Points(2.0),
                            blur: Points(8.0),
                            color: Color(0x0000_0066),
                            ..Default::default()
                        });
                        state.style.effects = Some(std::sync::Arc::new(effects));
                    }
                }
                if scene == "clip-border" {
                    let child = NshView::new(ix + 101, nsh_core::ViewKind::View);
                    child.state_mut().frame = crate::gtk_test::frame(-10.0, 0.0, 80.0, 35.0);
                    child.state_mut().style.background_color = Color(0xcc33_66ff);
                    child.set_parent(&card);
                }
                card.set_size_request(110, 70);
                fixed.put(&card, f64::from(ix % 10 * 118), f64::from(ix / 10 * 78));
                cards.push(card);
            }
            let window = gtk::Window::new();
            window.set_default_size(1200, 800);
            window.set_child(Some(&fixed));
            window.present();
            assert!(crate::gtk_test::wait_until(|| fixed.width() > 0));
            let samples = Rc::new(RefCell::new(Vec::new()));
            let previous = Rc::new(Cell::new(Instant::now()));
            let frame = Rc::new(Cell::new(0_u32));
            let started = Instant::now();
            let cpu_started = cpu_seconds();
            let tick = fixed.add_tick_callback({
                let samples = samples.clone();
                let frame = frame.clone();
                move |fixed, _| {
                    let now = Instant::now();
                    let elapsed = now.duration_since(previous.replace(now)).as_secs_f64() * 1000.0;
                    let ix = frame.get();
                    frame.set(ix + 1);
                    if ix >= 30 {
                        samples.borrow_mut().push(elapsed);
                    }
                    for (ix, card) in cards.iter().enumerate() {
                        fixed.move_(
                            card,
                            (ix % 10 * 118) as f64,
                            (ix / 10 * 78) as f64 - f64::from(frame.get() % 60),
                        );
                        card.redraw();
                    }
                    gtk::glib::ControlFlow::Continue
                }
            });
            for _ in 0..4 {
                if crate::gtk_test::wait_until(|| samples.borrow().len() >= 180) {
                    break;
                }
            }
            tick.remove();
            let mut times = samples.borrow().clone();
            assert!(times.len() >= 180, "not enough frame-clock samples");
            times.sort_by(f64::total_cmp);
            let mean = times.iter().sum::<f64>() / times.len() as f64;
            let cpu = (cpu_seconds() - cpu_started) / started.elapsed().as_secs_f64() * 100.0;
            let late = times.iter().filter(|&&ms| ms > 25.0).count();
            println!(
                "scene={scene} continuous={continuous} renderer={} scale={} frames={} mean={mean:.2}ms p50={:.2}ms p95={:.2}ms p99={:.2}ms fps={:.1} cpu={cpu:.1}% intervals_over_25ms={late}",
                window.renderer().unwrap().type_().name(),
                window.scale_factor(),
                times.len(),
                times[times.len() / 2],
                times[times.len() * 95 / 100],
                times[times.len() * 99 / 100],
                1000.0 / mean
            );
            window.destroy();
        }
    }
}

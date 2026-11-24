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

use super::{
    annotate::{self, Ink, Mark, Marks, Shape, Size, Tool},
    area::{self, Edges, Pixel},
    *,
};
use nsh_platform_windows::{
    ComponentContext, Components, NativeComponent,
    windows::Win32::Graphics::{
        Direct2D::{Common::*, *},
        Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM,
    },
};
use serde_json::json;
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::OnceLock,
};

pub(crate) fn register(components: &Components) {
    components.register("maka.screenshot", Rc::new(|ctx| Box::new(Stage::new(ctx))));
}

enum Drag {
    Select(Pixel),
    Move(Pixel, area::Area),
    Resize(Edges, area::Area),
    Mark(Pixel, Mark),
}

struct Frame {
    picture: Arc<Picture>,
    origin: POINT,
    scale: f64,
    boxes: Arc<OnceLock<Vec<area::Area>>>,
    bitmap: RefCell<Option<ID2D1Bitmap1>>,
}

impl Frame {
    fn target(&self, at: Pixel) -> Option<area::Area> {
        self.boxes
            .get()?
            .iter()
            .find(|area| area.contains(at))
            .copied()
    }
}

struct Stage {
    ctx: ComponentContext,
    frame: Option<Frame>,
    selection: Option<area::Area>,
    hover: Option<area::Area>,
    drag: Option<Drag>,
    tool: Option<Tool>,
    ink: Ink,
    marks: Marks,
    overlay: Option<AnnotationLayer>,
    text_at: Option<Pixel>,
    folder: Option<std::path::PathBuf>,
}

struct AnnotationLayer {
    committed: Picture,
    preview: surface::Surface,
    bitmap: RefCell<Option<ID2D1Bitmap1>>,
    dirty: Cell<bool>,
}

impl From<area::Area> for Area {
    fn from(rect: area::Area) -> Self {
        Self {
            left: rect.x as i32,
            top: rect.y as i32,
            right: (rect.right() + 1) as i32,
            bottom: (rect.bottom() + 1) as i32,
        }
    }
}

impl Stage {
    fn new(ctx: ComponentContext) -> Self {
        Self {
            ctx,
            frame: None,
            selection: None,
            hover: None,
            drag: None,
            tool: None,
            ink: Ink {
                size: Size::Medium,
                color: [255, 64, 64],
                scale: 1.,
            },
            marks: Marks::default(),
            overlay: None,
            text_at: None,
            folder: None,
        }
    }

    fn open(&mut self, value: &JsonValue) -> Result<(), String> {
        let desktop = FROZEN
            .lock()
            .unwrap()
            .clone()
            .ok_or("The screenshot is no longer available")?;
        if value["id"].as_str() != Some(&desktop.id.to_string()) {
            return Err("The screenshot was replaced".into());
        }
        let number = |key: &str| {
            value["bounds"][key]
                .as_f64()
                .map(|value| value.round() as i64)
                .ok_or("Missing display bounds")
        };
        let scale = value["scale"]
            .as_f64()
            .filter(|scale| scale.is_finite() && *scale > 0.)
            .ok_or("Missing display scale")?;
        let rect = area::Area {
            x: number("x")? - i64::from(desktop.left),
            y: number("y")? - i64::from(desktop.top),
            width: number("width")?,
            height: number("height")?,
        };
        let whole = area::Area {
            x: 0,
            y: 0,
            width: desktop.picture.width.into(),
            height: desktop.picture.height.into(),
        };
        if rect.width <= 0 || rect.height <= 0 || rect.intersection(whole) != Some(rect) {
            return Err("Screenshot display bounds have changed".into());
        }
        let picture = Arc::new(desktop.picture.crop(rect.into()));
        let boxes = Arc::new(OnceLock::new());
        if value["pictureBoxes"].as_bool() == Some(true) {
            let result = Arc::clone(&boxes);
            let image = Arc::clone(&picture);
            std::thread::Builder::new()
                .name("screenshot-boxes".into())
                .spawn(move || {
                    let pixels = shapes::Pixels {
                        data: &image.pixels,
                        width: image.width as usize,
                        height: image.height as usize,
                        stride: image.width as usize * 4,
                    };
                    let mut found = shapes::rectangles(&pixels, (16. * scale).round() as i64);
                    found.retain(|area| pixels.visible_border(*area));
                    found.sort_by_key(|area| area.size());
                    result.get_or_init(|| found);
                })
                .map_err(|error| error.to_string())?;
        }
        self.ink.scale = scale;
        self.frame = Some(Frame {
            picture,
            origin: POINT {
                x: desktop.left + rect.x as i32,
                y: desktop.top + rect.y as i32,
            },
            scale,
            boxes,
            bitmap: RefCell::default(),
        });
        self.ctx.emit("ready", json!({"elements":true}));
        self.ctx.redraw();
        Ok(())
    }

    fn selected(&self) {
        self.ctx.emit("selection",self.selection.zip(self.frame.as_ref()).map_or(JsonValue::Null,|(area,frame)|json!({"x":area.x as f64/frame.scale,"y":area.y as f64/frame.scale,"width":area.width as f64/frame.scale,"height":area.height as f64/frame.scale})));
    }

    fn composed(&self) -> Result<Picture, String> {
        let region = self.selection.ok_or("Select a region first")?;
        if let Some(layer) = &self.overlay {
            return Ok(layer.preview.picture(layer.preview.bounds()));
        }
        Ok(self
            .frame
            .as_ref()
            .ok_or("No frozen picture")?
            .picture
            .crop(region.into()))
    }

    fn refresh_marks(&mut self) -> Result<(), String> {
        self.overlay = None;
        if self.marks.made().is_empty() && !matches!(self.drag, Some(Drag::Mark(..))) {
            return Ok(());
        }
        let region = self.selection.ok_or("Select a region first")?;
        let mut committed = self.composed()?;
        let mut preview = surface::Surface::new(&committed)?;
        let bounds = preview.bounds();
        if !self.marks.made().is_empty() {
            for mark in self.marks.made() {
                preview.paint_mark(mark, region, bounds);
            }
            committed = preview.picture(bounds);
        }
        self.overlay = Some(AnnotationLayer {
            committed,
            preview,
            bitmap: RefCell::default(),
            dirty: Cell::new(true),
        });
        Ok(())
    }

    fn action(&mut self, name: &str, args: &JsonValue) -> Result<(), String> {
        let Some(frame) = &self.frame else {
            return Ok(());
        };
        let whole = area::Area {
            x: 0,
            y: 0,
            width: frame.picture.width.into(),
            height: frame.picture.height.into(),
        };
        if matches!(name, "begin" | "move" | "end" | "hover") {
            let coordinate = |key: &str, max: i64| -> Result<i64, String> {
                let points = args[key].as_f64().ok_or("Missing pointer coordinate")?;
                Ok(((points * frame.scale).round() as i64).clamp(0, max))
            };
            let at = (
                coordinate("x", whole.right())?,
                coordinate("y", whole.bottom())?,
            );
            match name {
                "hover" if self.selection.is_none() && self.drag.is_none() => {
                    let next = frame.target(at);
                    if self.hover == next {
                        return Ok(());
                    }
                    self.hover = next;
                }
                "begin" => {
                    let mut gesture = Drag::Select(at);
                    if let Some(area) = self.selection {
                        if let Some(tool) = self.tool {
                            if !area.contains(at) {
                                return Ok(());
                            }
                            if tool == Tool::Text {
                                self.text_at = Some(at);
                                self.ctx.emit("text",json!({"x":at.0 as f64/frame.scale,"y":at.1 as f64/frame.scale}));
                                return Ok(());
                            }
                            if tool == Tool::Number {
                                self.marks.add(Mark {
                                    shape: Shape::Number {
                                        at,
                                        number: self.marks.next_number(),
                                    },
                                    ink: self.ink,
                                });
                                self.refresh_marks()?;
                                self.ctx.redraw();
                                return Ok(());
                            }
                            gesture = Drag::Mark(
                                at,
                                Mark::dragged(tool, at, self.ink).ok_or("Unknown drawing tool")?,
                            );
                        } else if self.marks.made().is_empty() {
                            let edges = area.edges_at(at, (6. * frame.scale) as i64);
                            if edges.any() {
                                gesture = Drag::Resize(edges, area);
                            } else if area.contains(at) {
                                gesture = Drag::Move(at, area);
                            }
                        } else {
                            return Ok(());
                        }
                    }
                    self.drag = Some(gesture);
                    if matches!(self.drag, Some(Drag::Mark(..))) && self.overlay.is_none() {
                        self.refresh_marks()?;
                    }
                    self.ctx.emit("selection", JsonValue::Null);
                }
                "move" | "end" => {
                    let Some(gesture) = &mut self.drag else {
                        return Ok(());
                    };
                    match gesture {
                        Drag::Select(start) => {
                            self.selection = if name == "end"
                                && start.0.abs_diff(at.0) <= 2
                                && start.1.abs_diff(at.1) <= 2
                            {
                                self.hover = frame.target(at);
                                self.hover
                            } else {
                                Some(area::Area::spanning(*start, at))
                            };
                        }
                        Drag::Move(start, area) => {
                            self.selection =
                                Some(area.moved((at.0 - start.0, at.1 - start.1), whole))
                        }
                        Drag::Resize(edges, area) => {
                            self.selection = Some(area.resized(*edges, at))
                        }
                        Drag::Mark(start, mark) => {
                            mark.extend(*start, at);
                            if name == "move" {
                                let layer =
                                    self.overlay.as_mut().ok_or("Missing annotation layer")?;
                                layer.preview.load(&layer.committed);
                                if mark.drawn() {
                                    layer.preview.paint_mark(
                                        mark,
                                        self.selection.ok_or("Select a region first")?,
                                        layer.preview.bounds(),
                                    );
                                }
                                layer.dirty.set(true);
                            }
                        }
                    }
                    if name == "end" {
                        if let Some(Drag::Mark(_, mark)) = self.drag.take() {
                            if mark.drawn() {
                                self.marks.add(mark);
                            }
                            self.refresh_marks()?;
                        }
                        self.selected();
                    }
                }
                _ => return Ok(()),
            }
        } else {
            match name {
                "interrupt" => {
                    self.drag = None;
                    self.refresh_marks()?;
                    self.selected();
                }
                "ink" => {
                    if let Some(color) = args["color"].as_str().and_then(annotate::color) {
                        self.ink.color = color;
                    }
                    if let Some(size) = args["size"].as_str().and_then(Size::named) {
                        self.ink.size = size;
                    }
                }
                "tool" => {
                    self.text_at = None;
                    self.tool = args["tool"].as_str().and_then(Tool::named);
                }
                "discardText" => self.text_at = None,
                "text" => {
                    if let Some(at) = self.text_at.take() {
                        if let Some(text) = args["value"]
                            .as_str()
                            .filter(|text| !text.trim().is_empty())
                        {
                            self.marks.add(Mark {
                                shape: Shape::Text {
                                    at,
                                    text: text.to_owned(),
                                },
                                ink: self.ink,
                            });
                            self.refresh_marks()?;
                        }
                    }
                }
                "undo" | "redo" => {
                    if name == "undo" {
                        self.marks.undo()
                    } else {
                        self.marks.redo()
                    }
                    self.refresh_marks()?;
                }
                "copy" | "pin" | "save" => {
                    let Some(area) = self.selection else {
                        return Ok(());
                    };
                    let picture = self.composed()?;
                    match name {
                        "copy" => picture.copy(null_mut())?,
                        "pin" => pin::open(
                            picture,
                            POINT {
                                x: frame.origin.x + area.x as i32,
                                y: frame.origin.y + area.y as i32,
                            },
                            serde::Deserialize::deserialize(args)
                                .map_err(|err: serde_json::Error| err.to_string())?,
                            self.folder.clone(),
                        )?,
                        _ => {
                            let folder = self.folder.clone();
                            let ctx = self.ctx.clone();
                            nsh_platform_windows::with_running_view(move |view| {
                                let owner = view.hwnd().0 as isize;
                                let worker = ctx.clone();
                                let task = std::thread::Builder::new()
                                    .name("screenshot-save".into())
                                    .spawn(move || {
                                        let result = save_picture(
                                            owner as HWND,
                                            &picture,
                                            folder.as_deref(),
                                        );
                                        match result {
                                            Ok(true) => worker.emit("done", JsonValue::Null),
                                            Ok(false) => {
                                                worker.emit("saveCancelled", JsonValue::Null)
                                            }
                                            Err(error) => worker.emit(
                                                "failed",
                                                json!({"message":error,"permission":false}),
                                            ),
                                        }
                                    });
                                if let Err(error) = task {
                                    ctx.emit(
                                        "failed",
                                        json!({"message":error.to_string(),"permission":false}),
                                    );
                                }
                            });
                            return Ok(());
                        }
                    }
                    self.ctx.emit("done", JsonValue::Null);
                }
                "cancel" => self.ctx.emit("cancel", JsonValue::Null),
                _ => return Ok(()),
            }
        }
        self.ctx.redraw();
        Ok(())
    }
}

fn display(
    dc: &ID2D1DeviceContext,
    size: (i32, i32),
    pixels: &[u8],
    dirty: bool,
    cache: &RefCell<Option<ID2D1Bitmap1>>,
    rect: D2D_RECT_F,
) {
    let mut slot = cache.borrow_mut();
    // SAFETY: both pixel sources contain four bytes per pixel for the entire bitmap.
    unsafe {
        if dirty
            && let Some(bitmap) = slot.as_ref()
            && bitmap
                .CopyFromMemory(None, pixels.as_ptr().cast(), size.0 as u32 * 4)
                .is_err()
        {
            *slot = None;
        }
        if slot.is_none() {
            let props = D2D1_BITMAP_PROPERTIES1 {
                pixelFormat: D2D1_PIXEL_FORMAT {
                    format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    alphaMode: D2D1_ALPHA_MODE_IGNORE,
                },
                dpiX: 96.,
                dpiY: 96.,
                ..Default::default()
            };
            *slot = dc
                .CreateBitmap(
                    D2D_SIZE_U {
                        width: size.0 as u32,
                        height: size.1 as u32,
                    },
                    Some(pixels.as_ptr().cast()),
                    size.0 as u32 * 4,
                    &props,
                )
                .ok();
        }
        if let Some(bitmap) = slot.as_ref() {
            dc.DrawBitmap(
                bitmap,
                Some(&rect),
                1.,
                D2D1_INTERPOLATION_MODE_NEAREST_NEIGHBOR,
                None,
                None,
            );
        }
    }
}

impl NativeComponent for Stage {
    fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) {
        let value = value.unwrap_or(&JsonValue::Null);
        match name {
            "viewport" if value.is_object() && self.frame.is_none() => {
                if let Err(error) = self.open(value) {
                    self.ctx
                        .emit("failed", json!({"message":error,"permission":false}));
                }
            }
            "folder" => self.folder = value.as_str().map(Into::into),
            _ => {}
        }
    }
    fn command(&mut self, name: &str, args: &JsonValue) {
        if let Err(error) = self.action(name, args) {
            self.ctx
                .emit("failed", json!({"message":error,"permission":false}));
        }
    }
    fn draw(&self, dc: &ID2D1DeviceContext, size: (f32, f32)) {
        let Some(frame) = &self.frame else { return };
        let screen = D2D_RECT_F {
            left: 0.,
            top: 0.,
            right: size.0,
            bottom: size.1,
        };
        display(
            dc,
            (frame.picture.width, frame.picture.height),
            &frame.picture.pixels,
            false,
            &frame.bitmap,
            screen,
        );
        let region = self.selection.or(self.hover).map(|area| D2D_RECT_F {
            left: (area.x as f64 / frame.scale) as f32,
            top: (area.y as f64 / frame.scale) as f32,
            right: ((area.right() + 1) as f64 / frame.scale) as f32,
            bottom: ((area.bottom() + 1) as f64 / frame.scale) as f32,
        });
        // SAFETY: rectangles are in the current drawing context and the brush lives through each fill.
        unsafe {
            if let Ok(shade) = dc.CreateSolidColorBrush(
                &D2D1_COLOR_F {
                    a: 0.38,
                    ..Default::default()
                },
                None,
            ) {
                if let Some(rect) = region {
                    for band in [
                        D2D_RECT_F {
                            bottom: rect.top,
                            ..screen
                        },
                        D2D_RECT_F {
                            top: rect.bottom,
                            ..screen
                        },
                        D2D_RECT_F {
                            left: 0.,
                            right: rect.left,
                            ..rect
                        },
                        D2D_RECT_F {
                            left: rect.right,
                            right: screen.right,
                            ..rect
                        },
                    ] {
                        dc.FillRectangle(&band, &shade);
                    }
                } else {
                    dc.FillRectangle(&screen, &shade);
                }
            }
        }
        if let Some(rect) = region {
            if let Some(layer) = &self.overlay {
                display(
                    dc,
                    (layer.preview.width, layer.preview.height),
                    layer.preview.pixels(),
                    layer.dirty.replace(false),
                    &layer.bitmap,
                    rect,
                );
            }
            unsafe {
                if let Ok(brush) = dc.CreateSolidColorBrush(
                    &D2D1_COLOR_F {
                        r: 0.1,
                        g: 0.7,
                        b: 1.,
                        a: 1.,
                    },
                    None,
                ) {
                    dc.DrawRectangle(&rect, &brush, 2., None);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nsh_platform_windows::{AppOptions, quit_app, run_app_with_config};

    #[test]
    fn native_stage_exports_an_annotated_region_at_150_percent_on_a_left_display() {
        const OUTPUT: &str = "MAKA_SCREENSHOT_TEST_FOLDER";
        if let Some(folder) = std::env::var_os(OUTPUT) {
            run_stage(&std::path::PathBuf::from(folder));
            return;
        }
        let folder = std::env::temp_dir().join(format!("maka-stage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&folder).unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                std::thread::current().name().unwrap(),
                "--nocapture",
            ])
            .env(OUTPUT, &folder)
            .status()
            .unwrap();
        assert!(status.success());
        verify_export(&folder);
    }

    fn run_stage(folder: &Path) {
        let id = uuid::Uuid::new_v4();
        *FROZEN.lock().unwrap() = Some(Arc::new(Desktop {
            id,
            picture: Picture {
                width: 240,
                height: 180,
                pixels: vec![255; 240 * 180 * 4],
            },
            left: -240,
            top: 0,
        }));
        let source = r#"import {mount, nativeComponent, host} from 'nsh';
            const Canvas = nativeComponent('maka.screenshot', {props:['viewport','folder'],events:['ready','selection','done','failed']});
            let stage, blankEvents = 0;
            mount(() => Canvas({style:{width:160,height:120}, ref: node => stage=node,
                folder:FOLDER, viewport:{id:ID,bounds:{x:-240,y:0,width:240,height:180},scale:1.5},
                onReady:()=>{stage.command('begin',{x:4,y:4});stage.command('end',{x:4,y:4});},
                onSelection:rect=>{if(blankEvents >= 2) return;
                    if(rect !== null) {host.post('test.finish',{message:'Blank click produced a selection'});return;}
                    if(++blankEvents !== 2) return;
                    stage.command('begin',{x:Math.fround(23/1.5),y:10});stage.command('end',{x:50,y:40});
                    stage.command('tool',{tool:'rectangle'});stage.command('ink',{color:'#ff0000',size:'small'});
                    stage.command('begin',{x:17,y:12});stage.command('move',{x:45,y:38});stage.command('interrupt');
                    stage.command('begin',{x:16,y:16});stage.command('move',{x:36,y:30});stage.command('end',{x:40,y:32});stage.command('save');},
                onDone:()=>host.post('test.finish'), onFailed:error=>host.post('test.finish',error)}));"#
            .replace("FOLDER", &json!(folder).to_string()).replace("ID,", &format!("{},",json!(id)));
        let mut policy = nsh_engine::Policy {
            declared: Some(nsh_engine::Capabilities::all()),
            ..nsh_engine::Policy::development()
        };
        policy
            .declared
            .as_mut()
            .unwrap()
            .host
            .push("test.finish".into());
        let config = nsh_engine::EngineConfig::new(
            nsh_engine::Bundle::source(source.into()).with_policy(policy),
        );
        config.host.handle("test.finish", move |call| {
            if let Some(message) = call.data()["message"].as_str() {
                eprintln!("{message}");
                std::process::exit(1);
            }
            quit_app();
        });
        let (completed, wait) = std::sync::mpsc::channel::<()>();
        let watchdog = std::thread::spawn(move || {
            if wait
                .recv_timeout(std::time::Duration::from_secs(15))
                .is_err()
            {
                std::process::exit(1);
            }
        });
        let components = Components::default();
        register(&components);
        let result = run_app_with_config(
            config,
            AppOptions {
                components,
                size: (160, 120),
                skip_taskbar: true,
                title: "Maka screenshot stage test".into(),
                ..Default::default()
            },
            |_| {},
        );
        let _ = completed.send(());
        watchdog.join().unwrap();
        assert_eq!(result, std::process::ExitCode::SUCCESS);
    }

    fn verify_export(folder: &Path) {
        let path = std::fs::read_dir(folder)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let mut reader =
            png::Decoder::new(std::io::BufReader::new(std::fs::File::open(&path).unwrap()))
                .read_info()
                .unwrap();
        let mut bytes = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut bytes).unwrap();
        assert_eq!((info.width, info.height), (53, 46));
        let pixel = |x: usize, y: usize| &bytes[(y * 53 + x) * 3..(y * 53 + x) * 3 + 3];
        assert_eq!(pixel(8, 9), [255, 0, 0]);
        assert_eq!(pixel(8, 15), [255, 255, 255]);
        drop(reader);
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(folder).unwrap();
    }
}

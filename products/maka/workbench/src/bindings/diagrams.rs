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

use base64::{Engine as _, engine::general_purpose::STANDARD};
use std::sync::{Arc, LazyLock};

static FONTS: LazyLock<Arc<usvg::fontdb::Database>> = LazyLock::new(|| {
    let mut fonts = usvg::fontdb::Database::new();
    fonts.load_system_fonts();
    Arc::new(fonts)
});

pub(super) fn image(svg: &str) -> Result<String, String> {
    let outlined = outline_with_fonts(svg, FONTS.clone())?;
    Ok(format!(
        "data:image/svg+xml;base64,{}",
        STANDARD.encode(outlined)
    ))
}

fn outline_with_fonts(svg: &str, fonts: Arc<usvg::fontdb::Database>) -> Result<String, String> {
    if fonts.is_empty() {
        return Err("No local fonts are available for diagram labels".into());
    }
    let options = usvg::Options {
        font_family: fonts
            .family_name(&usvg::fontdb::Family::SansSerif)
            .to_owned(),
        font_size: 16.0,
        fontdb: fonts,
        // Diagram sources must never cause filesystem or network image reads.
        image_href_resolver: usvg::ImageHrefResolver {
            resolve_data: Box::new(|_, _, _| None),
            resolve_string: Box::new(|_, _| None),
        },
        ..usvg::Options::default()
    };
    let tree = usvg::Tree::from_str(svg, &options).map_err(|error| error.to_string())?;
    Ok(tree.to_string(&usvg::WriteOptions::default()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fonts() -> Arc<usvg::fontdb::Database> {
        let mut fonts = usvg::fontdb::Database::new();
        fonts.load_font_data(include_bytes!("../../tests/fonts/IBMPlexSans-Regular.ttf").to_vec());
        fonts.set_sans_serif_family("IBM Plex Sans");
        Arc::new(fonts)
    }

    #[test]
    fn labels_become_visible_paths_without_loading_external_images() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("external.png");
        image::save_buffer(&path, &[255, 0, 255, 255], 1, 1, image::ColorType::Rgba8).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let href = path
            .to_str()
            .unwrap()
            .replace('&', "&amp;")
            .replace('"', "&quot;");
        let svg = format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="160" height="40"><text x="5" y="25" font-family="sans-serif" font-size="20" fill="#ff0000">Maka</text><image href="{href}" width="40" height="40"/><image href="data:image/png;base64,{}" width="40" height="40"/></svg>"##,
            STANDARD.encode(bytes)
        );
        let outlined = outline_with_fonts(&svg, fonts()).unwrap();
        assert!(!outlined.contains("<text"));
        assert!(!outlined.contains("<image"));
        assert!(outlined.contains("<path"));
        let raster = nsh_core::svg::rasterize(outlined.as_bytes(), 320).unwrap();
        assert!(
            raster
                .pixels
                .as_chunks::<4>()
                .0
                .iter()
                .any(|pixel| pixel[0] > 0 && pixel[1] == 0 && pixel[2] == 0 && pixel[3] > 0),
            "labels must paint real pixels through NSH's unmodified image path"
        );
    }

    #[nsh_core::element::class]
    struct DiagramHost {
        pending: Option<std::sync::mpsc::Sender<PendingImage>>,
    }

    struct PendingImage {
        svg: String,
        reply: tokio::sync::oneshot::Sender<String>,
    }

    #[nsh_core::element::class]
    impl DiagramHost {
        #[getter]
        pub fn system_locale(&self) -> String {
            "en".into()
        }

        pub async fn diagram_image(
            this: nsh_core::element::Instance<Self>,
            svg: String,
        ) -> Result<String, String> {
            let pending = this.with(|host| host.pending.clone());
            drop(this);
            if let Some(pending) = pending {
                let (reply, result) = tokio::sync::oneshot::channel();
                pending
                    .send(PendingImage { svg, reply })
                    .map_err(|error| error.to_string())?;
                return result.await.map_err(|error| error.to_string());
            }
            let outlined = outline_with_fonts(&svg, fonts())?;
            Ok(format!(
                "data:image/svg+xml;base64,{}",
                STANDARD.encode(outlined)
            ))
        }
    }

    fn diagram_app_with_environment(
        mut environment: nsh_core::platform::Environment,
        pending: Option<std::sync::mpsc::Sender<PendingImage>>,
    ) -> nsh_testing::Headless {
        environment.native_focus_scopes = true;
        use nsh_core::{Size, element::Instance, prelude::px};
        let mut registry = crate::bindings::ui_registry();
        registry.value("host", move || {
            Instance::new(DiagramHost {
                pending: pending.clone(),
            })
        });
        let sets = vec![nsh_base::registry(), registry];
        let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
            entry: std::path::Path::new("tests/fixtures/mermaid-view.tsx")
                .canonicalize()
                .unwrap(),
            minify: false,
            split: false,
            ui_sets: sets
                .iter()
                .flat_map(nsh_core::element::Registry::sets)
                .map(Into::into)
                .collect(),
            asset_root_from: Some(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."),
            ),
            ..Default::default()
        })
        .unwrap();
        struct MermaidLoader;
        impl nsh_engine::ChunkLoader for MermaidLoader {
            fn load(&self, id: &str) -> nsh_engine::ChunkLoad {
                let id = id.to_owned();
                Box::pin(async move {
                    if id == crate::MERMAID_CHUNK_ID {
                        Ok(nsh_engine::ChunkSource::new(crate::mermaid_chunk_source()))
                    } else {
                        Err(format!("unexpected test chunk: {id}"))
                    }
                })
            }
        }
        nsh_testing::Headless::start(nsh_engine::EngineConfig {
            viewport: Size::new(px(720.0), px(900.0)),
            environment,
            ui_sets: sets,
            chunk_loader: Some(std::sync::Arc::new(MermaidLoader)),
            ..nsh_engine::EngineConfig::new(nsh_engine::Bundle::source(bundle.code))
        })
        .unwrap()
    }

    fn diagram_app(
        terminal: bool,
        pending: Option<std::sync::mpsc::Sender<PendingImage>>,
    ) -> nsh_testing::Headless {
        use nsh_core::platform::{Environment, Idiom, Os};
        diagram_app_with_environment(
            Environment {
                os: Os::MacOs,
                idiom: if terminal {
                    Idiom::Terminal
                } else {
                    Idiom::Desktop
                },
                ..Environment::default()
            },
            pending,
        )
    }

    #[test]
    fn diagram_source_and_parse_error_recovery() {
        let mut app = diagram_app(false, None);
        app.wait_for("label:Mermaid diagram").unwrap();
        app.press("role:button[Show diagram source]").unwrap();
        app.wait_for("text:/flowchart LR/").unwrap();
        app.press("role:button[Hide diagram source]").unwrap();
        app.press("id:break").unwrap();
        app.wait_for("text:/Diagram unavailable:/").unwrap();
        app.wait_for("text:/unfinished/").unwrap();
        app.press("id:repair").unwrap();
        app.wait_for("label:Mermaid diagram").unwrap();
        assert!(!app.shows("Diagram unavailable"));
    }

    #[test]
    fn terminal_diagrams_keep_readable_source() {
        let mut app = diagram_app(true, None);
        app.wait_for("text:/flowchart LR/").unwrap();
        assert!(!app.shows("Mermaid diagram"));
        assert!(!app.shows("Show diagram source"));
    }

    #[test]
    fn missing_fonts_fail_explicitly() {
        let valid = r#"<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><text y="16">Maka</text></svg>"#;
        assert_eq!(
            outline_with_fonts(valid, Arc::new(usvg::fontdb::Database::new())).unwrap_err(),
            "No local fonts are available for diagram labels"
        );
    }

    #[test]
    fn large_svg_documents_are_outlined_without_a_local_size_cap() {
        // Cross the removed 4 MB input cap without adding rendering complexity.
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="80" height="24"><!--{}--><text y="16">Maka</text></svg>"#,
            "x".repeat(4_000_001)
        );
        let outlined = outline_with_fonts(&svg, fonts()).unwrap();
        assert!(outlined.contains("<path"));
        assert!(!outlined.contains("<text"));
    }

    #[test]
    fn superseded_conversion_never_reaches_the_image_view() {
        use std::sync::Mutex;
        let (send, pending) = std::sync::mpsc::channel();
        let mut app = diagram_app(false, Some(send));
        let images = Arc::new(Mutex::new(Vec::new()));
        let observed = images.clone();
        app.observe(move |_, batch| {
            for item in &batch.items {
                if let nsh_core::MountItem::Image {
                    source: Some(source),
                    ..
                } = item
                {
                    observed
                        .lock()
                        .unwrap()
                        .push(source.data.as_ref().unwrap().bytes().to_vec());
                }
            }
        });
        app.wait_for("Rendering diagram…").unwrap();
        let old = pending.recv_timeout(nsh_testing::WAIT).unwrap();
        app.press("id:update").unwrap();
        app.wait_for("Latest requested").unwrap();
        let old_image = outline_with_fonts(&old.svg, fonts()).unwrap();
        old.reply
            .send(format!(
                "data:image/svg+xml;base64,{}",
                STANDARD.encode(&old_image)
            ))
            .unwrap();
        let latest = pending.recv_timeout(nsh_testing::WAIT).unwrap();
        assert!(latest.svg.contains("LATEST"));
        // A real UI round trip applies batches while the latest conversion stays pending.
        app.press("role:button[Show diagram source]").unwrap();
        app.wait_for("text:/LATEST/").unwrap();
        assert!(
            images.lock().unwrap().is_empty(),
            "an obsolete image was published"
        );
        let latest_image = outline_with_fonts(&latest.svg, fonts()).unwrap();
        assert_ne!(latest_image, old_image);
        latest
            .reply
            .send(format!(
                "data:image/svg+xml;base64,{}",
                STANDARD.encode(&latest_image)
            ))
            .unwrap();
        app.wait_for("label:Mermaid diagram").unwrap();
        let images = images.lock().unwrap();
        assert!(!images.is_empty());
        assert!(
            images
                .iter()
                .all(|image| image.as_slice() == latest_image.as_bytes())
        );
    }

    #[test]
    fn diagram_opens_full_screen_zooms_in_and_out_and_closes() {
        use nsh_core::platform::{ColorScheme, Environment, Idiom, Os};
        let mut app = diagram_app_with_environment(
            Environment {
                os: Os::MacOs,
                idiom: Idiom::Desktop,
                color_scheme: ColorScheme::Dark,
                ..Environment::default()
            },
            None,
        );
        app.wait_for("label:Mermaid diagram").unwrap();
        // Clicking the diagram itself opens the full-screen viewer.
        app.press("role:button[Mermaid diagram]").unwrap();
        app.wait_for("role:button[Close full screen image]")
            .unwrap();
        app.wait_for("text:/· 100%/").unwrap();

        // Zoom in, then zoom back out via buttons and plain keyboard shortcuts.
        app.press("role:button[Zoom image in]").unwrap();
        app.wait_for("text:/· 125%/").unwrap();
        app.press("role:button[Zoom image out]").unwrap();
        app.wait_for("text:/· 100%/").unwrap();
        app.press_key("minus").unwrap();
        app.wait_for("text:/· 80%/").unwrap();
        app.press("role:button[Show image at actual size]").unwrap();
        app.wait_for("text:/· 100%/").unwrap();

        // A taking trackpad listener owns the gesture: the outer native
        // binding must not apply the same scale again at PinchEnd.
        app.trackpad_pinch("label:Image viewport", 1.44).unwrap();
        app.wait_for("text:/· 144%/").unwrap();
        app.trackpad_pinch("label:Image viewport", 1.0 / 1.44)
            .unwrap();
        app.wait_for("text:/· 100%/").unwrap();

        app.hold_keys("ctrl", true).unwrap();
        app.wheel(
            "label:Image viewport",
            nsh_core::geometry::point(nsh_core::prelude::px(0.0), nsh_core::prelude::px(-10.0)),
        )
        .unwrap();
        app.wait_for("text:/· 108%/").unwrap();
        app.wheel(
            "label:Image viewport",
            nsh_core::geometry::point(nsh_core::prelude::px(0.0), nsh_core::prelude::px(10.0)),
        )
        .unwrap();
        app.wait_for("text:/· 100%/").unwrap();
        app.hold_keys("ctrl", false).unwrap();

        app.press("label:Image viewport").unwrap();
        app.press("label:Image viewport").unwrap();
        app.wait_for("text:/· 200%/").unwrap();
        app.press("role:button[Show image at actual size]").unwrap();
        app.wait_for("text:/· 100%/").unwrap();

        // Escape closes the full-screen viewer.
        app.press_key("escape").unwrap();
        assert!(
            !app.screen()
                .matches("role:button[Close full screen image]")
                .unwrap()
        );

        // The header expand button also opens the viewer, and the close button dismisses it.
        app.press("role:button[Open diagram full screen]").unwrap();
        app.wait_for("role:button[Close full screen image]")
            .unwrap();
        app.press("role:button[Close full screen image]").unwrap();
        assert!(
            !app.screen()
                .matches("role:button[Close full screen image]")
                .unwrap()
        );
    }

    #[test]
    fn windows_viewer_close_button_stays_clear_of_caption_controls() {
        use nsh_core::{
            geometry::Edges,
            platform::{ColorScheme, Environment, Idiom, Os},
            prelude::px,
        };
        let caption_right = 138.0_f32;
        let mut app = diagram_app_with_environment(
            Environment {
                os: Os::Windows,
                idiom: Idiom::Desktop,
                color_scheme: ColorScheme::Light,
                title_bar: Edges {
                    top: px(48.0),
                    right: px(caption_right),
                    bottom: px(0.0),
                    left: px(0.0),
                },
                ..Environment::default()
            },
            None,
        );
        app.wait_for("label:Mermaid diagram").unwrap();
        app.press("role:button[Open diagram full screen]").unwrap();
        app.wait_for("role:button[Close full screen image]")
            .unwrap();

        let close_id = app
            .screen()
            .id("role:button[Close full screen image]")
            .unwrap();
        let close_bounds = app
            .screen()
            .layout_nodes()
            .into_iter()
            .find(|node| node.id == close_id)
            .expect("close button layout bounds")
            .bounds;
        let close_right = close_bounds.origin.x.0 + close_bounds.size.width.0;
        assert!(
            close_right <= 720.0 - caption_right,
            "viewer close button right edge ({close_right}) overlaps Windows caption controls starting at {}",
            720.0 - caption_right
        );
    }

    #[test]
    fn light_mode_viewer_renders_dark_palette_diagram() {
        use nsh_core::platform::{ColorScheme, Environment, Idiom, Os};
        let (send, pending) = std::sync::mpsc::channel();
        let mut app = diagram_app_with_environment(
            Environment {
                os: Os::MacOs,
                idiom: Idiom::Desktop,
                color_scheme: ColorScheme::Light,
                ..Environment::default()
            },
            Some(send),
        );
        // Inline render uses the light palette.
        let inline = pending.recv_timeout(nsh_testing::WAIT).unwrap();
        assert!(
            !inline.svg.contains("var(--pele-"),
            "inline SVG colors must be resolved for an image document"
        );
        let inline_outlined = outline_with_fonts(&inline.svg, fonts()).unwrap();
        inline
            .reply
            .send(format!(
                "data:image/svg+xml;base64,{}",
                STANDARD.encode(&inline_outlined)
            ))
            .unwrap();
        app.wait_for("label:Mermaid diagram").unwrap();

        // Opening the dark full-screen viewer requests a dark-palette diagram.
        app.press("role:button[Open diagram full screen]").unwrap();
        let dark = pending.recv_timeout(nsh_testing::WAIT).unwrap();
        assert_ne!(
            dark.svg, inline.svg,
            "the viewer must request a new palette instead of reusing the inline SVG"
        );
        assert!(
            !dark.svg.contains("var(--pele-"),
            "viewer SVG colors must be resolved for an image document"
        );
        let dark_outlined = outline_with_fonts(&dark.svg, fonts()).unwrap();
        dark.reply
            .send(format!(
                "data:image/svg+xml;base64,{}",
                STANDARD.encode(&dark_outlined)
            ))
            .unwrap();
        app.wait_for("role:button[Close full screen image]")
            .unwrap();
    }
}

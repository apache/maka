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
        fonts.load_font_data(include_bytes!("../../../../../third-party/nsh/third-party/gpui-wgpu/test-assets/IBMPlexSans-Regular.ttf").to_vec());
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

    fn diagram_app(
        renderer: nsh_core::platform::Renderer,
        pending: Option<std::sync::mpsc::Sender<PendingImage>>,
    ) -> nsh_testing::Headless {
        use nsh_core::{
            Size,
            element::Instance,
            platform::{Environment, Os},
            prelude::px,
        };
        let mut registry = nsh_core::element::Registry::ui_set("maka/host");
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
            ui_sets: sets.iter().map(Into::into).collect(),
        })
        .unwrap();
        nsh_testing::Headless::start(nsh_engine::EngineConfig {
            viewport: Size::new(px(720.0), px(900.0)),
            environment: Environment {
                os: Os::MacOs,
                renderer,
                ..Environment::default()
            },
            ui_sets: sets,
            ..nsh_engine::EngineConfig::new(nsh_engine::Bundle::source(bundle.code))
        })
        .unwrap()
    }

    #[test]
    fn diagram_source_and_parse_error_recovery() {
        let mut app = diagram_app(nsh_core::platform::Renderer::Native, None);
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
        let mut app = diagram_app(nsh_core::platform::Renderer::Terminal, None);
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
        let mut app = diagram_app(nsh_core::platform::Renderer::Native, Some(send));
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
}

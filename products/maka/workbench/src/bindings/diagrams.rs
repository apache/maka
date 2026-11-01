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

const MAX_SVG_BYTES: usize = 4_000_000;
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
    if svg.len() > MAX_SVG_BYTES {
        return Err("Diagram SVG exceeds the size limit".into());
    }
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
    let outlined = tree.to_string(&usvg::WriteOptions::default());
    if outlined.len() > 16 * 1024 * 1024 {
        return Err("Outlined diagram exceeds the image size limit".into());
    }
    Ok(outlined)
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
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="160" height="40"><text x="5" y="25" font-family="sans-serif" font-size="20" fill="#ff0000">Maka</text><image href="file:///must-not-read.png" width="40" height="40"/></svg>"##;
        let outlined = outline_with_fonts(svg, fonts()).unwrap();
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
                .any(|pixel| pixel[0] > 0 && pixel[3] > 0),
            "labels must paint real pixels through NSH's unmodified image path"
        );
    }

    #[test]
    fn pele_runs_in_quickjs_and_labels_paint_through_nsh() {
        let entry = std::path::Path::new("tests/fixtures/mermaid.ts")
            .canonicalize()
            .unwrap();
        let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
            entry,
            minify: false,
            split: false,
            ui_sets: vec![nsh_base::registry().into()],
        })
        .unwrap();
        let host = nsh_js::Host::new().unwrap();
        host.eval_source(&bundle.code).unwrap();
        let mut ops = Vec::new();
        host.take_ops(&mut ops);
        let value = ops
            .into_iter()
            .find_map(|op| match op {
                nsh_core::Op::CreateText { text, .. } => Some(text.to_string()),
                _ => None,
            })
            .expect("Pele must produce a diagram in the real UI JavaScript VM");
        let result: serde_json::Value = serde_json::from_str(&value).unwrap();
        let svg = result["svg"].as_str().unwrap();
        assert!(svg.contains("用户 User"));
        assert!(!svg.contains("var("));
        let outlined = outline_with_fonts(svg, fonts()).unwrap();
        let raster = nsh_core::svg::rasterize(outlined.as_bytes(), 720).unwrap();
        assert!(
            raster
                .pixels
                .as_chunks::<4>()
                .0
                .iter()
                .any(|p| p[0] < 80 && p[3] > 0)
        );
        if let Some(directory) = std::env::var_os("MAKA_MERMAID_EVIDENCE") {
            // A local visual check uses the same font discovery as the client.
            let outlined = outline_with_fonts(svg, FONTS.clone()).unwrap();
            let raster = nsh_core::svg::rasterize(outlined.as_bytes(), 1440).unwrap();
            let directory = std::path::PathBuf::from(directory);
            std::fs::create_dir_all(&directory).unwrap();
            image::save_buffer(
                directory.join("mermaid.png"),
                &raster.pixels,
                raster.width,
                raster.height,
                image::ColorType::Rgba8,
            )
            .unwrap();
        }
    }

    #[nsh_core::element::class]
    struct DiagramHost;

    #[nsh_core::element::class]
    impl DiagramHost {
        #[getter]
        pub fn system_locale(&self) -> String {
            "en".into()
        }

        pub fn diagram_image(&self, svg: String) -> Result<String, String> {
            let outlined = outline_with_fonts(&svg, fonts())?;
            Ok(format!(
                "data:image/svg+xml;base64,{}",
                STANDARD.encode(outlined)
            ))
        }
    }

    fn diagram_app(renderer: nsh_core::platform::Renderer) -> nsh_testing::Headless {
        use nsh_core::{
            Size,
            element::Instance,
            platform::{Environment, Os},
            prelude::px,
        };
        let mut registry = nsh_core::element::Registry::ui_set("maka/host");
        registry.value("host", || Instance::new(DiagramHost));
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
    fn markdown_diagram_preview_source_and_parse_error_recovery() {
        let mut app = diagram_app(nsh_core::platform::Renderer::Native);
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
        let mut app = diagram_app(nsh_core::platform::Renderer::Terminal);
        app.wait_for("text:/flowchart LR/").unwrap();
        assert!(!app.shows("Mermaid diagram"));
        assert!(!app.shows("Show diagram source"));
    }

    #[test]
    fn invalid_and_oversized_diagrams_fail_explicitly() {
        assert!(outline_with_fonts("<svg", fonts()).is_err());
        assert!(outline_with_fonts(&"x".repeat(MAX_SVG_BYTES + 1), fonts()).is_err());
        assert!(outline_with_fonts("<svg/>", Arc::new(usvg::fontdb::Database::new())).is_err());
    }
}

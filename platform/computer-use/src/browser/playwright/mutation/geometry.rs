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

//! Project each renderer's local coordinates through its actual frame owners.

use super::*;

const FRAME: &str = include_str!("geometry.js");

struct Projection<'a> {
    force: bool,
    alignment: &'a Value,
    resources: &'a Resources,
    cancellation: &'a CancellationToken,
    used: &'a [frames::Frame],
}

fn pair(value: &Value) -> Result<[f64; 2], ToolError> {
    let point: [f64; 2] = serde_json::from_value(value.clone()).map_err(failed)?;
    if point.iter().all(|value| value.is_finite()) {
        Ok(point)
    } else {
        Err(failed("frame geometry is not finite"))
    }
}

fn project_quad(quad: &Value, point: [f64; 2], size: [f64; 2]) -> Result<[f64; 2], ToolError> {
    let quad: [f64; 8] = serde_json::from_value(quad.clone()).map_err(failed)?;
    if !quad
        .iter()
        .chain(point.iter())
        .chain(size.iter())
        .all(|value| value.is_finite())
        || size.iter().any(|value| *value <= 0.0)
    {
        return Err(failed("iframe content geometry is unavailable"));
    }
    let [x, y] = [point[0] / size[0], point[1] / size[1]];
    Ok([
        quad[0] + x * (quad[2] - quad[0]) + y * (quad[6] - quad[0]),
        quad[1] + x * (quad[3] - quad[1]) + y * (quad[7] - quad[1]),
    ])
}

fn project_frame_quad(
    quad: &Value,
    child_point: [f64; 2],
    geometry: &Value,
) -> Result<[f64; 2], ToolError> {
    // An iframe's CDP quad describes its border box; its child viewport starts
    // inside the border and padding, in that box's untransformed coordinates.
    let inset = pair(&geometry["inset"])?;
    project_quad(
        quad,
        [child_point[0] + inset[0], child_point[1] + inset[1]],
        pair(&geometry["size"])?,
    )
}

fn document_hit_point(viewport_point: [f64; 2], metrics: &Value) -> Result<[f64; 2], ToolError> {
    // Content quads and dispatched input use the CSS visual viewport. The DOM
    // hit query consumes document coordinates, including the visual origin.
    let viewport = &metrics["cssVisualViewport"];
    let origin = pair(&json!([viewport["pageX"], viewport["pageY"]]))?;
    Ok([viewport_point[0] + origin[0], viewport_point[1] + origin[1]])
}

fn protocol_coordinate(value: f64) -> Result<i32, ToolError> {
    let value = value.round();
    if !value.is_finite() || value < f64::from(i32::MIN) || value > f64::from(i32::MAX) {
        return Err(failed(
            "pointer position is outside the CDP integer coordinate range",
        ));
    }
    // DOM.getNodeForLocation requires an integer, unlike floating-point input
    // coordinates. The checked range makes this conversion exact.
    Ok(value as i32)
}

impl Tab {
    async fn locator_frame_owner(
        &self,
        child: &frames::Frame,
        parent: &frames::Frame,
        point: [f64; 2],
        projection: &Projection<'_>,
    ) -> Result<(Value, u64), ToolError> {
        let Projection {
            alignment,
            resources,
            cancellation,
            ..
        } = *projection;
        check_cancelled(cancellation, true)?;
        resources.register(parent);
        let owner = self
            .frame_request(
                parent.session.as_deref(),
                "DOM.getFrameOwner",
                json!({"frameId":child.id}),
            )
            .await?;
        let backend = owner["backendNodeId"]
            .as_u64()
            .ok_or_else(|| failed("frame owner identity is unavailable"))?;
        let resolved = self
            .frame_request(
                parent.session.as_deref(),
                "DOM.resolveNode",
                json!({"backendNodeId":backend,"objectGroup":resources.group}),
            )
            .await?;
        let object = resolved["object"]["objectId"]
            .as_str()
            .ok_or_else(|| failed("frame owner is detached"))?;
        check_cancelled(cancellation, true)?;
        if !self.frame_scopes_current(projection.used).await? {
            return Err(failed("frame changed before frame scroll"));
        }
        let result = self
            .frame_request(
                parent.session.as_deref(),
                "Runtime.callFunctionOn",
                json!({"objectId":object,"functionDeclaration":FRAME,
                    "arguments":[{"value":{"point":point,"requireVisible":child.session==parent.session&&!alignment.is_null(),"alignment":alignment}}],
                    "returnByValue":true}),
            )
            .await?;
        Ok((cdp_value(result)?["value"].clone(), backend))
    }

    async fn locator_project(
        &self,
        selected: &Selected,
        mut point: [f64; 2],
        projection: &Projection<'_>,
    ) -> Result<[f64; 2], ToolError> {
        let Projection { cancellation, .. } = *projection;
        let mut index = selected.used.len() - 1;
        while index > 0 {
            check_cancelled(cancellation, true)?;
            let child = &selected.used[index];
            let parent = &selected.used[index - 1];
            let child_point = point;
            let (geometry, backend) = self
                .locator_frame_owner(child, parent, point, projection)
                .await?;
            point = pair(&geometry["point"])?;
            index -= 1;
            if child.session == parent.session {
                continue;
            }
            // A parent-session content quad already includes its same-renderer
            // ancestor frames. Validate/scroll those owners, then use one fresh
            // quad rather than adding those offsets for a second time.
            while index > 0 && selected.used[index - 1].session == parent.session {
                let (outer, _) = self
                    .locator_frame_owner(
                        &selected.used[index],
                        &selected.used[index - 1],
                        point,
                        projection,
                    )
                    .await?;
                point = pair(&outer["point"])?;
                index -= 1;
            }
            let quads = self
                .frame_request(
                    parent.session.as_deref(),
                    "DOM.getContentQuads",
                    json!({"backendNodeId":backend}),
                )
                .await?;
            point = project_frame_quad(&quads["quads"][0], child_point, &geometry)?;
            if !projection.force {
                let metrics = self
                    .frame_observation(
                        parent.session.as_deref(),
                        "Page.getLayoutMetrics",
                        json!({}),
                    )
                    .await?;
                let document_point = document_hit_point(point, &metrics)?;
                let hit = self.frame_observation(parent.session.as_deref(),"DOM.getNodeForLocation",json!({
                    "x":protocol_coordinate(document_point[0])?,"y":protocol_coordinate(document_point[1])?,"includeUserAgentShadowDOM":true,
                })).await?;
                if hit["backendNodeId"].as_u64() != Some(backend)
                    && hit["frameId"].as_str() != Some(child.id.as_str())
                {
                    return Err(failed("Frame is obscured at the interaction point"));
                }
            }
        }
        Ok(point)
    }

    pub(super) async fn dom_cua_project(
        &self,
        selected: &Selected,
        point: [f64; 2],
        resources: &Resources,
        cancellation: &CancellationToken,
    ) -> Result<[f64; 2], ToolError> {
        self.locator_project(
            selected,
            point,
            &Projection {
                force: true,
                alignment: &Value::Null,
                resources,
                cancellation,
                used: &selected.used,
            },
        )
        .await
    }

    pub(super) async fn locator_pointer(
        &self,
        selected: &Selected,
        force: bool,
        resources: &Resources,
        cancellation: &CancellationToken,
    ) -> Result<[f64; 2], ToolError> {
        let mut failure = None;
        for alignment in [
            json!({"block":"center","inline":"nearest"}),
            json!({"block":"end","inline":"end"}),
            json!({"block":"start","inline":"start"}),
        ] {
            check_cancelled(cancellation, failure.is_some())?;
            let prepared = self
                .locator_element_script(
                    selected,
                    json!({"kind":"pointer","force":force,"scrollAlignment":alignment}),
                    resources,
                    Some(cancellation),
                )
                .await?;
            let point = [
                prepared["point"]["x"]
                    .as_f64()
                    .ok_or_else(|| failed("pointer x is unavailable"))?,
                prepared["point"]["y"]
                    .as_f64()
                    .ok_or_else(|| failed("pointer y is unavailable"))?,
            ];
            match self
                .locator_project(
                    selected,
                    point,
                    &Projection {
                        force,
                        alignment: &alignment,
                        resources,
                        cancellation,
                        used: &selected.used,
                    },
                )
                .await
            {
                Ok(point) => return Ok(point),
                Err(error @ ToolError::Failed(_)) => failure = Some(error),
                Err(error) => return Err(error),
            }
        }
        Err(failure.expect("three frame alignment attempts failed"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_frame_projection_uses_both_quad_axes() {
        let quad = json!([100.0, 200.0, 100.0, 600.0, -100.0, 600.0, -100.0, 200.0]);
        assert_eq!(
            project_quad(&quad, [50.0, 25.0], [200.0, 100.0]).unwrap(),
            [50.0, 300.0]
        );
        assert!(project_quad(&quad, [0.0, 0.0], [0.0, 100.0]).is_err());
    }

    #[test]
    fn captured_iframe_border_quad_maps_to_its_content_origin() {
        let point = project_frame_quad(
            &json!([312.0, 270.5, 616.0, 270.5, 616.0, 424.5, 312.0, 424.5]),
            [50.96875, 10.5],
            &json!({"size":[304.0,154.0],"inset":[2.0,2.0]}),
        )
        .unwrap();
        assert_eq!(point, [364.96875, 283.0]);
        assert_eq!(
            document_hit_point(
                point,
                &json!({"cssVisualViewport":{"pageX":0.0,"pageY":66.0}}),
            )
            .unwrap(),
            [364.96875, 349.0]
        );
    }

    #[test]
    fn guard_document_origin_uses_css_visual_metrics_and_requires_them() {
        let viewport = [10.0, 20.0];
        let metrics = json!({
            "cssLayoutViewport":{"pageX":100.0,"pageY":200.0},
            "cssVisualViewport":{"pageX":120.0,"pageY":250.0},
        });
        assert_eq!(
            document_hit_point(viewport, &metrics).unwrap(),
            [130.0, 270.0]
        );
        assert!(document_hit_point(viewport, &json!({})).is_err());
    }
}

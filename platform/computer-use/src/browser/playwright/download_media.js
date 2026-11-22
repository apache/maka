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

function downloadMedia(request) {
	const elements = this.querySelectorAll(request.parsedSelector, document);
	if (elements.length === 0) return { status: "missing" };
	let element = elements[0];
	if (elements.length > 1) {
		const visible = elements.filter(
			(candidate) => this.elementState(candidate, "visible").matches,
		);
		if (visible.length !== 1)
			return { status: "strict", count: elements.length };
		element = visible[0];
	}
	if (!element.isConnected)
		return { status: "notReady", message: "Element is not connected" };
	element.scrollIntoView({ block: "center", inline: "nearest" });
	const mediaSelector = "img, video, source, a[href]";
	const media =
		element.closest?.(mediaSelector) ??
		element.querySelector?.(mediaSelector) ??
		element;
	let url;
	for (const key of ["currentSrc", "src", "href"]) {
		const value = media[key];
		if (typeof value === "string") {
			url = value;
			break;
		}
	}
	if (!url)
		return {
			status: "notReady",
			message: "Matched element does not expose a downloadable URL",
		};
	const trigger = document.createElement("a");
	trigger.href = url;
	trigger.download = url.split("/").pop()?.split("?")[0] || "download";
	trigger.rel = "noopener";
	trigger.style.display = "none";
	document.body.appendChild(trigger);
	trigger.click();
	trigger.remove();
	return { status: "value", value: true };
}

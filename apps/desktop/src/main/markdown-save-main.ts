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

export interface MarkdownSaveDialog {
  showSaveDialog(options: {
    title: string;
    defaultPath: string;
    filters: Array<{ name: string; extensions: string[] }>;
  }): Promise<{ canceled: boolean; filePath?: string }>;
}

export async function saveMarkdownViaDialog(
  dialog: MarkdownSaveDialog,
  input: { markdown?: unknown; defaultName?: unknown } | undefined,
  dialogTitle: string,
): Promise<
  | { ok: true; path: string }
  | { ok: false; reason: "canceled" | "write_failed" | "invalid_input" }
> {
  const markdown = typeof input?.markdown === "string" ? input.markdown : null;
  const defaultName =
    typeof input?.defaultName === "string" ? input.defaultName : null;
  if (!markdown || markdown.length > 1_000_000) {
    return { ok: false, reason: "invalid_input" };
  }
  if (!defaultName || defaultName.length > 200) {
    return { ok: false, reason: "invalid_input" };
  }
  const safeName = defaultName.replace(/[\\/]/g, "_");
  const result = await dialog.showSaveDialog({
    title: dialogTitle,
    defaultPath: safeName,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (result.canceled || !result.filePath) {
    return { ok: false, reason: "canceled" };
  }
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(result.filePath, markdown, "utf8");
    return { ok: true, path: result.filePath };
  } catch {
    return { ok: false, reason: "write_failed" };
  }
}

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

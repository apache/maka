import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Button } from "./button";

describe("Button", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("does not warn when an external style is present before hydration", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const container = document.createElement("div");
    const serverHtml = renderToString(<Button size="sm">Select file</Button>);

    container.innerHTML = serverHtml.replace(
      "<button ",
      '<button style="text-shadow: rgb(255, 255, 255) 0px 0px 1px;" ',
    );
    document.body.appendChild(container);

    let root: Root | undefined;

    await act(async () => {
      root = hydrateRoot(container, <Button size="sm">Select file</Button>);
    });

    const errorMessages = consoleError.mock.calls
      .map((call) => call.map(String).join(" "))
      .join("\n");

    expect(errorMessages).not.toContain("A tree hydrated");
    expect(errorMessages).not.toContain("hydration-mismatch");

    await act(async () => {
      root?.unmount();
    });
  });
});

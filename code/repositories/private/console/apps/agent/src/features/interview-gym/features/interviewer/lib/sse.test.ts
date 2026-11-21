import { describe, expect, it } from "vitest";
import { parseSSE } from "./sse";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const data of parseSSE(stream)) out.push(data);
  return out;
}

describe("parseSSE", () => {
  it("解析 data: 行并跳过 [DONE]", async () => {
    const datas = await collect(streamOf(['data: {"a":1}\n\n', "data: [DONE]\n\n"]));
    expect(datas).toEqual(['{"a":1}']);
  });

  it("跨 chunk 的半行能拼接", async () => {
    const datas = await collect(streamOf(["data: hel", "lo\nda", "ta: world\n"]));
    expect(datas).toEqual(["hello", "world"]);
  });

  it("容忍 CRLF", async () => {
    const datas = await collect(streamOf(["data: a\r\ndata: b\r\n"]));
    expect(datas).toEqual(["a", "b"]);
  });
});

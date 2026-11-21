// 最小 SSE 解析：只关心 data: 行；跨 chunk 的半行用 buffer 拼接
export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data && data !== "[DONE]") yield data;
        }
        idx = buffer.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

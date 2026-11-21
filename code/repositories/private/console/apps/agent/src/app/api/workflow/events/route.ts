import { subscribe, history, type WorkflowEvent } from "@/server/workflow/events";

// SSE 事件流：订阅进程内事件总线（可 ?afterSeq= 重放历史）
export async function GET(req: Request) {
  const afterSeq = Number(new URL(req.url).searchParams.get("afterSeq") ?? 0);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: WorkflowEvent) => {
        controller.enqueue(encoder.encode(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      };
      for (const e of history(afterSeq)) send(e);
      const unsub = subscribe(send);
      // 客户端断开时清理
      req.signal.addEventListener("abort", () => {
        unsub();
        try {
          controller.close();
        } catch {
          // 已关闭
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

import { getTodoDeps } from "@/server/todo/connection";
import { handleChatStream } from "@/server/todo/chat";
import { serializeError } from "@/server/todo/http";

export const maxDuration = 300;

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ code: "VALIDATION_ERROR", message: "请求体不能为空" }, { status: 400 });
  }
  try {
    return handleChatStream(getTodoDeps(), body, req.signal);
  } catch (err) {
    const { statusCode, body: envelope } = serializeError(err);
    return Response.json(envelope, { status: statusCode });
  }
}

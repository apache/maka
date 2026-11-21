import { getTodoDeps } from "@/server/todo/connection";
import { handleConfirm } from "@/server/todo/chat";

type Ctx = { params: Promise<{ messageId: string }> };

export async function POST(req: Request, { params }: Ctx) {
  const messageId = Number((await params).messageId);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  return handleConfirm(getTodoDeps(), messageId, body);
}

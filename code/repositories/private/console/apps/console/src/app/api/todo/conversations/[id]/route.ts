import { getTodoDb } from "@/server/todo/connection";
import { deleteConversation, getConversation } from "@/server/todo/db/repo-conversations";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(_req: Request, { params }: Ctx) {
  const id = Number((await params).id);
  if (!getConversation(getTodoDb(), id)) {
    return Response.json({ code: "NOT_FOUND", message: `会话 ${id} 不存在` }, { status: 404 });
  }
  if (!deleteConversation(getTodoDb(), id)) {
    return Response.json({ code: "NOT_FOUND", message: `会话 ${id} 不存在` }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}

import { getTodoDb } from "@/server/todo/connection";
import { getConversation, listMessages } from "@/server/todo/db/repo-conversations";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const id = Number((await params).id);
  const db = getTodoDb();
  if (!getConversation(db, id)) {
    return Response.json({ code: "NOT_FOUND", message: `会话 ${id} 不存在` }, { status: 404 });
  }
  return Response.json(listMessages(db, id));
}

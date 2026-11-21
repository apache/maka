import { getTodoDb } from "@/server/todo/connection";
import { listConversations } from "@/server/todo/db/repo-conversations";

export async function GET() {
  return Response.json(listConversations(getTodoDb()));
}

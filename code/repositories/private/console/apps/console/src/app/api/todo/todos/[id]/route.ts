import { UpdateTodoInputSchema } from "@ggbdpq/console-shared/todo";
import { getTodoDb } from "@/server/todo/connection";
import { getTodoById, softDeleteTodo, updateTodo } from "@/server/todo/db/repo-todos";
import { parseBody, serializeError } from "@/server/todo/http";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const id = Number((await params).id);
  const todo = getTodoById(getTodoDb(), id);
  if (!todo) return Response.json({ code: "NOT_FOUND", message: `todo ${id} 不存在` }, { status: 404 });
  return Response.json(todo);
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const id = Number((await params).id);
    const patch = parseBody(UpdateTodoInputSchema, await req.json());
    const todo = updateTodo(getTodoDb(), id, patch);
    if (!todo) return Response.json({ code: "NOT_FOUND", message: `todo ${id} 不存在` }, { status: 404 });
    return Response.json(todo);
  } catch (err) {
    const { statusCode, body } = serializeError(err);
    return Response.json(body, { status: statusCode });
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const id = Number((await params).id);
  if (!softDeleteTodo(getTodoDb(), id)) {
    return Response.json({ code: "NOT_FOUND", message: `todo ${id} 不存在` }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}

import { CreateTodoInputSchema } from "@ggbdpq/console-shared/todo";
import { getTodoDb } from "@/server/todo/connection";
import { createTodo, listTodos } from "@/server/todo/db/repo-todos";
import { parseBody, serializeError } from "@/server/todo/http";

export async function GET() {
  // Q11 定案：不分页全量，软删永远过滤
  return Response.json(listTodos(getTodoDb()));
}

export async function POST(req: Request) {
  try {
    const input = parseBody(CreateTodoInputSchema, await req.json());
    const todo = createTodo(getTodoDb(), input);
    return Response.json(todo, { status: 201 });
  } catch (err) {
    const { statusCode, body } = serializeError(err);
    return Response.json(body, { status: statusCode });
  }
}

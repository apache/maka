import { NextResponse } from "next/server";
import { z } from "zod";
import { getAccount, applyError } from "@/server/assets/store";
import { parseErrorLog } from "@ggbdpq/console-shared";
import { readJson, jsonError } from "@/server/assets/api-utils";

const errorImportSchema = z.object({
  text: z.string().min(1),
  accountIds: z.array(z.number().int()).optional(), // 批量模式：勾选账号套用
});

// 报错日志导入：模式①行内带邮箱自动归属；模式②无邮箱时套用到勾选账号。
export async function POST(req: Request) {
  const body = errorImportSchema.safeParse(await readJson(req));
  if (!body.success) return jsonError("需要 text 字段");
  const lines = parseErrorLog(body.data.text);

  const results = {
    applied: 0,
    unmatched: [] as string[],
    unrecognized: 0,
    lines: lines.length,
  };
  const withEmail = lines.filter((l) => l.email && l.classification);
  const withoutEmail = lines.filter((l) => !l.email && l.classification);

  for (const line of withEmail) {
    const ok = applyError(line.email!, line.classification!.status, line.classification!.reason);
    if (ok) results.applied++;
    else results.unmatched.push(line.email!);
  }

  if (withoutEmail.length && body.data.accountIds?.length) {
    const cls = withoutEmail[0]!.classification!;
    for (const id of body.data.accountIds) {
      const acc = getAccount(id);
      if (!acc) continue;
      if (applyError(acc.email, cls.status, cls.reason)) results.applied++;
    }
  }
  results.unrecognized = lines.filter((l) => !l.classification).length;
  return NextResponse.json(results);
}

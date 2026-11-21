import { NextResponse } from "next/server";
import { getAccount, applyQuotaSnapshot, applyQuotaRefreshError } from "@/server/assets/store";
import { findCliProxyProxyUrl, QuotaRefreshError, refreshQuotaFromOpenAI } from "@/server/assets/quota";
import { jsonError, param } from "@/server/assets/api-utils";

// 单账号真实额度刷新：与原 Hono 实现同构，失败时记录健康度而非抛 500。
export async function refreshOneAccountQuota(id: number) {
  const acc = getAccount(id);
  if (!acc) return { id, error: "账号不存在", account: null };
  try {
    const snapshot = await refreshQuotaFromOpenAI({
      accessToken: acc.access_token,
      accountId: acc.account_id,
      proxyUrl:
        process.env.CARD_ADMIN_OPENAI_PROXY_URL ||
        process.env.OPENAI_PROXY_URL ||
        findCliProxyProxyUrl(),
    });
    return { id, account: applyQuotaSnapshot(id, snapshot), snapshot };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const upstreamStatus = error instanceof QuotaRefreshError ? error.status : undefined;
    return { id, account: applyQuotaRefreshError(id, message, upstreamStatus), error: message };
  }
}

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = Number(await param(ctx, "id"));
  const result = await refreshOneAccountQuota(id);
  if (!result.account && result.error === "账号不存在") return jsonError(result.error, 404);
  return NextResponse.json(result);
}

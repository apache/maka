// live 模式：连真实网关（或 附录/代码骨架 的 demoServer）。
//   ?live=http://127.0.0.1:8320&token=demo
import { useStore } from "./store";
import type { Provider, RouteGroup } from "./contracts";

export function startLive(base: string, token: string): () => void {
  const store = useStore.getState();
  useStore.setState({ mode: "live", gatewayAddr: new URL(base).host, connection: "connecting" });
  fetch(`${base}/admin/state`, { headers: { authorization: `Bearer ${token}` } })
    .then((r) => {
      if (!r.ok) throw new Error(`admin/state ${r.status}`);
      return r.json();
    })
    .then((state) => {
      const providers: Provider[] = state.providers.map((p: any) => ({
        id: p.id, kind: p.kind, label: p.label, models: [], capabilities: p.capabilities, enabled: true,
      }));
      const groups: RouteGroup[] = state.groups.map((g: any) => ({ id: g.id, name: g.name, strategy: g.strategy, enabled: g.enabled, members: g.members.map((m: any) => ({ providerId: m.providerId, model: m.model })) }));
      useStore.setState({ providers, groups });
    })
    .catch((error) => {
      console.error(error);
      useStore.setState({ connection: "closed" });
    });
  // EventSource 不能带 header：admin token 走 query（仅 127.0.0.1，见 02-接口契约 §3.4）
  const es = new EventSource(`${base}/admin/events?token=${encodeURIComponent(token)}`);
  es.onopen = () => useStore.setState({ connection: "open" });
  es.onerror = () => useStore.setState({ connection: "closed" });
  es.addEventListener("route", (m) => store.apply(JSON.parse((m as MessageEvent).data)));
  return () => es.close();
}

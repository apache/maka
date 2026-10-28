import { computed, mount, signal, View } from "nsh";
import { Input } from "nsh/base";
import { Dialog } from "nsh/base";
import { Canvas } from "nsh";
import { windowSize } from "nsh";
import { List } from "nsh";
import { initialActivity, sections, services, type Activity, type Filter, type Section } from "./data";
import { Action, Label, Metric, palette as p, Progress, Sparkline } from "./ui";
import { EffectsInspector, RunbookInspector } from "./inspectors";

function Workbench() {
  const section = signal<Section>("services");
  const query = signal("");
  const filter = signal<Filter>("all");
  const selected = signal(2);
  const inspectorTab = signal<"details" | "effects" | "guide">("details");
  const queued = signal<number[]>([]);
  const activity = signal<Activity[]>(initialActivity);
  const deployOpen = signal(false);
  const releaseNote = signal("Routine rollout · 安全发布");
  const notice = signal("Connected · 5 regions");
  const inspector = () => windowSize().width >= 1120;
  const short = () => windowSize().height < 544;
  const trend = () => windowSize().width >= 880;
  const regionName = (region: string) => ({ "us-east-1": "US / Virginia", "us-west-2": "US / Oregon", "eu-west-1": "IE / Dublin", "eu-central-1": "DE / Frankfurt", "ap-northeast-1": "JP / Tokyo", "ap-southeast-1": "SG / Singapore" }[region] ?? region);
  const incidents = computed(() => services.filter((service) => service.health === "degraded" && !queued().includes(service.id)));
  const rows = computed(() => {
    const term = query().trim().toLowerCase();
    return services.filter((service) => {
      const inSection = section() === "services" || (section() === "incidents" ? incidents().includes(service) : service.id <= 8 || queued().includes(service.id));
      const inFilter = filter() === "all" || service.health === filter();
      return inSection && inFilter && (!term || `${service.name} ${service.group} ${service.region} ${service.owner}`.toLowerCase().includes(term));
    });
  });
  const current = computed(() => rows().find((service) => service.id === selected()) ?? rows()[0] ?? services.find((service) => service.id === selected()) ?? services[0]);
  const title = () => section() === "services" ? "Service fleet" : section() === "incidents" ? "Active incidents" : "Release history";
  const changeSection = (next: Section) => {
    section.set(next);
    query.set("");
    filter.set("all");
    notice.set(next === "services" ? "Service fleet · all environments" : next === "incidents" ? "Showing services that need attention" : "Recent releases and queued deployments");
  };
  const confirmDeployment = () => {
    const service = current();
    queued.update((ids) => ids.includes(service.id) ? ids : [...ids, service.id]);
    activity.update((items) => [{ time: "NOW", title: "Deployment queued", detail: releaseNote() || `${service.name} → v2.19.0`, tone: "mint" as const }, ...items].slice(0, 3));
    notice.set(`Deployment queued · ${service.name} → v2.19.0`);
    deployOpen.set(false);
  };

  return (
    <View style={{ flex: 1, paddingHorizontal: 16, paddingVertical: 16, gap: 16, backgroundColor: p.page, overflow: "hidden" }}>
      <View style={{ height: 32, flexDirection: "row", alignItems: "flex-start", gap: 16 }}>
        <View style={{ flex: 1, height: 32 }}>
          <View style={{ height: 16, flexDirection: "row", gap: 16 }}>
            <Label strong color={p.mint}>Native Shell</Label>
            <Label strong color={p.ink}>Operations workbench</Label>
          </View>
          <Label color={p.faint}>Production / global workspace</Label>
        </View>
        <Label color={p.mint}>● Connected</Label>
        <Action label="Deploy update" accessibilityLabel="+ Deploy update" testID="deploy-update" primary onPress={() => deployOpen.set(true)} />
      </View>

      <View style={{ flex: 1, minHeight: 0, flexDirection: "row", gap: 16 }}>
        <View style={{ width: windowSize().width >= 880 ? 136 : 120, paddingHorizontal: 8, paddingVertical: 16, overflow: "hidden", backgroundColor: p.sidebar }}>
          <View style={{ height: 32, paddingHorizontal: 8 }}><Label color={p.faint}>Workspace</Label></View>
          <Each of={sections}>
            {(item) => (
              <View style={{ height: 32 }}>
                <View
                  testID={`nav-${item().id}`}
                  role="button"
                  accessibilityLabel={`Open ${item().label}`}
                  onPress={() => changeSection(item().id)}
                  style={{ height: 16, paddingHorizontal: 8, flexDirection: "row", gap: 8, backgroundColor: section() === item().id ? p.selected : "transparent" }}
                >
                  <View style={{ flex: 1 }}><Label strong color={section() === item().id ? p.mint : p.muted}>{item().label}</Label></View>
                  <Label color={item().id === "incidents" ? p.amber : p.faint}>{item().id === "services" ? "72" : item().id === "incidents" ? `${incidents().length}` : `${8 + queued().filter((id) => id > 8).length}`}</Label>
                </View>
              </View>
            )}
          </Each>
          <If when={!short()}>
            <View style={{ height: 32, justifyContent: "flex-end", paddingHorizontal: 8 }}><Label color={p.faint}>Regions</Label></View>
            <Each of={["Virginia", "Frankfurt", "Tokyo · 東京"]}>
              {(region) => <View style={{ height: 16, paddingHorizontal: 8 }}><Label>{region()}</Label></View>}
            </Each>
          </If>
          <View style={{ flex: 1 }} />
          <View style={{ height: 48, paddingHorizontal: 8 }}>
            <Label color={p.mint}>AL  JM  王</Label>
            <Label color={p.ink}>{windowSize().width >= 880 ? "Platform team" : "Platform"}</Label>
            <Label color={p.faint}>Local demo</Label>
          </View>
        </View>

        <View style={{ flex: 1, minWidth: 0, minHeight: 0, gap: 16 }}>
          <View style={{ height: short() ? 32 : 48, flexDirection: "row", gap: 8 }}>
            <Metric title="Online" value={`${72 - incidents().length}/72`} detail="5 regions healthy" color={p.mint} dense={short()} />
            <If when={!short()}><Metric title="P95 latency" value="142ms" detail="18ms below last hour" color={p.blue} /></If>
            <If when={!short()}><Metric title="Requests" value="82.4k" detail="12.8% above last hour" color={p.blue} /></If>
            <Metric title="Incidents" value={`${incidents().length}`} detail="Services to review" color={p.amber} dense={short()} />
          </View>

          <View testID="service-table" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
            <View style={{ height: 16, paddingHorizontal: 8, flexDirection: "row", justifyContent: "space-between" }}>
              <Label strong color={p.ink}>{title()}</Label>
              <Label color={p.faint}>{`${rows().length} services`}</Label>
            </View>
            <View style={{ height: 16, paddingHorizontal: 8, flexDirection: "row", gap: 8 }}>
              <View style={{ width: 48 }}><Label color={p.faint}>Search</Label></View>
              <Input
                testID="service-search"
                accessibilityLabel="Search services"
                autoFocus
                value={query()}
                placeholder="Name, region, owner..."
                onChange={({ value }) => query.set(value)}
                style={{ flex: 1, minWidth: 0, height: 16, paddingHorizontal: 8, backgroundColor: p.raised, color: p.ink, placeholderColor: p.faint, fontSize: 14, lineHeight: 16 }}
              />
              <Each of={["all", "healthy", "degraded"] as const}>
                {(choice) => <Action testID={`filter-${choice()}`} label={choice() === "all" ? "All" : choice() === "healthy" ? "Healthy" : "Degraded"} active={filter() === choice()} onPress={() => filter.set(choice())} />}
              </Each>
            </View>
            <View style={{ height: 16, paddingHorizontal: 8, flexDirection: "row", gap: 8, backgroundColor: p.panel }}>
              <View style={{ width: 8 }} />
              <View style={{ flex: 1 }}><Label color={p.faint}>Service / group</Label></View>
              <View style={{ width: 80 }}><Label color={p.faint}>Status</Label></View>
              <View style={{ width: 112 }}><Label color={p.faint}>Region</Label></View>
              <View style={{ width: 56 }}><Label color={p.faint} align="right">P95</Label></View>
              <If when={trend()}><View style={{ width: 48 }}><Label color={p.faint} align="right">Trend</Label></View></If>
            </View>
            <List
              each={rows()}
              estimatedItemSize={32}
              style={{ flex: 1, minHeight: 0 }}
              empty={<View style={{ padding: 16 }}><Label color={p.ink}>No matching services</Label><Label>Try another name or clear the search.</Label></View>}
            >
              {(service) => (
                <View
                  testID={`service-${service().id}`}
                  role="button"
                  accessibilityLabel={`Inspect ${service().name}`}
                  onPress={() => { selected.set(service().id); notice.set(`Inspecting ${service().name} · ${service().location}`); }}
                  style={{ height: 32, paddingHorizontal: 8, flexDirection: "row", gap: 8, backgroundColor: current().id === service().id ? p.selected : service().id % 2 ? p.page : p.sidebar }}
                >
                  <View style={{ width: 8 }}><Label color={p.mint}>{current().id === service().id ? "›" : " "}</Label></View>
                  <View style={{ flex: 1, minWidth: 0, height: 32 }}>
                    <Label strong color={current().id === service().id ? p.mint : p.ink}>{service().name}</Label>
                    <Label color={p.faint}>{service().group}</Label>
                  </View>
                  <View style={{ width: 80 }}><Label color={queued().includes(service().id) ? p.blue : service().health === "healthy" ? p.mint : p.amber}>{queued().includes(service().id) ? "↗ Queued" : service().health === "healthy" ? "● Healthy" : "! Degraded"}</Label></View>
                  <View style={{ width: 112 }}><Label>{regionName(service().region)}</Label></View>
                  <View style={{ width: 56 }}><Label align="right" color={service().health === "degraded" ? p.amber : p.ink}>{`${service().latency}ms`}</Label></View>
                  <If when={trend()}><Sparkline seed={service().id} color={service().health === "degraded" ? p.amber : p.mint} warning={service().health === "degraded"} /></If>
                </View>
              )}
            </List>
            <View style={{ height: 16, paddingHorizontal: 8, flexDirection: "row", justifyContent: "space-between", backgroundColor: p.panel }}>
              <Label color={p.faint}>{`${rows().length} of 72 services`}</Label>
              <Label color={p.faint}>Select a row to inspect</Label>
            </View>
          </View>

          <If when={!short()}>
            <View style={{ height: 64 }}>
              <View style={{ height: 16, flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 8 }}>
                <Label strong color={p.ink}>Traffic overview</Label>
                <Label color={p.faint}>Last hour / requests</Label>
              </View>
              <Canvas
                testID="traffic-chart"
                style={{ flex: 1, minHeight: 0 }}
                draw={(ctx, { width, height }) => {
                  const n = 48;
                  const values = Array.from({ length: n }, (_, index) => 0.4 + Math.sin(index * 0.23) * 0.15 + Math.sin(index * 1.1) * 0.04 + (section() === "incidents" && index > 32 ? 0.17 : 0));
                  const x = (index: number) => 8 + index * (width - 16) / (n - 1);
                  const y = (value: number) => height - 2 - value * (height - 4);
                  ctx.strokeStyle = p.line; ctx.lineWidth = 1;
                  for (let index = 1; index < 3; index++) { ctx.beginPath(); ctx.moveTo(0, index * height / 3); ctx.lineTo(width, index * height / 3); ctx.stroke(); }
                  const area = ctx.createLinearGradient(0, 0, 0, height);
                  area.addColorStop(0, "#8bd6bd33"); area.addColorStop(1, "#8bd6bd04");
                  ctx.beginPath(); ctx.moveTo(x(0), height);
                  values.forEach((value, index) => ctx.lineTo(x(index), y(value)));
                  ctx.lineTo(x(n - 1), height); ctx.closePath(); ctx.fillStyle = area; ctx.fill();
                  ctx.beginPath(); values.forEach((value, index) => index ? ctx.lineTo(x(index), y(value)) : ctx.moveTo(x(index), y(value)));
                  ctx.strokeStyle = p.mint; ctx.lineWidth = 3; ctx.lineJoin = "round"; ctx.stroke();
                  ctx.setLineDash([8, 8]); ctx.beginPath(); ctx.moveTo(0, y(0.78)); ctx.lineTo(width, y(0.78)); ctx.strokeStyle = p.blue; ctx.lineWidth = 1; ctx.stroke();
                }}
              />
              <View style={{ height: 16, paddingHorizontal: 8, flexDirection: "row", justifyContent: "space-between" }}><Label color={p.faint}>13:30</Label><Label color={p.faint}>13:45</Label><Label color={p.faint}>14:00</Label><Label color={p.faint}>14:15</Label><Label color={p.faint}>14:30</Label></View>
            </View>
          </If>
        </View>

        <If when={inspector()}>
          <View style={{ width: 240, minHeight: 0, paddingHorizontal: 8, paddingVertical: 16, overflow: "hidden", backgroundColor: p.sidebar }}>
            <View style={{ height: 16, flexDirection: "row", gap: 8 }}>
              <Action label="Details" testID="inspector-details" active={inspectorTab() === "details"} onPress={() => inspectorTab.set("details")} />
              <Action label="Effects" testID="inspector-effects" active={inspectorTab() === "effects"} onPress={() => inspectorTab.set("effects")} />
              <Action label="Guide" testID="inspector-guide" active={inspectorTab() === "guide"} onPress={() => inspectorTab.set("guide")} />
            </View>
            <If when={inspectorTab() === "details"}>
              <View style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
                <Label strong color={p.ink}>{current().name}</Label>
                <Label color={queued().includes(current().id) ? p.blue : current().health === "degraded" ? p.amber : p.mint}>{queued().includes(current().id) ? "↗ Deployment queued" : current().health === "degraded" ? "! Elevated latency" : "● All checks passing"}</Label>
                <View style={{ height: 16 }} />
                <View style={{ height: 16, flexDirection: "row", justifyContent: "space-between" }}><Label>Region</Label><Label color={p.ink}>{regionName(current().region)}</Label></View>
                <View style={{ height: 16, flexDirection: "row", justifyContent: "space-between" }}><Label>Replicas</Label><Label color={p.ink}>{`${current().replicas} / ${current().replicas} ready`}</Label></View>
                <View style={{ height: 16, flexDirection: "row", justifyContent: "space-between" }}><Label>Version</Label><Label color={p.blue}>{queued().includes(current().id) ? "v2.19.0 queued" : current().version}</Label></View>
                <View style={{ height: 16, flexDirection: "row", justifyContent: "space-between" }}><Label>Updated</Label><Label color={p.ink}>{queued().includes(current().id) ? "just now" : current().updated}</Label></View>
                <View style={{ height: 16 }} />
                <Label color={p.faint}>On-call owner</Label>
                <Label color={p.ink}>{current().owner}</Label>
                <View style={{ height: 16 }} />
                <Progress label="CPU" value={current().cpu} color={current().cpu > 75 ? p.amber : p.mint} />
                <Progress label="Memory" value={current().memory} color={p.blue} />
                <View style={{ height: 16 }} />
                <Action label="Deploy this service" testID="deploy-selected" onPress={() => deployOpen.set(true)} />
                <If when={windowSize().height >= 640}>
                  <View style={{ height: 16 }} />
                  <Label strong color={p.ink}>Activity timeline</Label>
                  <View style={{ height: 16 }} />
                  <Each of={activity()}>
                    {(event) => (
                      <View style={{ height: 48 }}>
                        <View style={{ height: 16, flexDirection: "row", gap: 8 }}><Label color={p[event().tone]}>{event().time}</Label><View style={{ flex: 1 }}><Label color={p.ink}>{event().title}</Label></View></View>
                        <Label color={p.faint}>{event().detail}</Label>
                      </View>
                    )}
                  </Each>
                </If>
                <View style={{ flex: 1 }} />
                <Label color={p.faint}>Production / 5 regions</Label>
              </View>
            </If>
            <If when={inspectorTab() === "effects"}><EffectsInspector /></If>
            <If when={inspectorTab() === "guide"}><RunbookInspector name={current().name} region={current().region} /></If>
          </View>
        </If>
      </View>

      <View style={{ height: 16, flexDirection: "row", gap: 16 }}>
        <View style={{ flex: 1, minWidth: 0 }}><Label color={p.muted}>{notice()}</Label></View>
        <Label color={p.faint}>{`Selected: ${current().name}`}</Label>
        <If when={inspector()}><Label color={p.faint}>Tab focus · Ctrl+Q quit</Label></If>
      </View>

      <Dialog open={deployOpen()} animation="fade" onOpenChange={({ open }) => deployOpen.set(open)} style={{ flex: 1 }}>
        <View style={{ flex: 1, padding: 16, alignItems: "center", justifyContent: "center", backgroundColor: "#02060dcc" }}>
          <View style={{ width: 448, maxWidth: "100%", padding: 16, gap: 16, backgroundColor: p.panel }}>
            <Label strong color={p.mint}>Deploy service</Label>
            <Label color={p.ink}>{`${current().name} → v2.19.0`}</Label>
            <View><Label color={p.blue}>Preflight checks passed</Label><Label>{`${current().region} · ${current().replicas} replicas`}</Label><Label>Rolling update / one replica at a time</Label></View>
            <View><Label color={p.faint}>Release note</Label><Input testID="release-note" accessibilityLabel="Release note" value={releaseNote()} onChange={({ value }) => releaseNote.set(value)} style={{ height: 16, paddingHorizontal: 8, fontSize: 14, lineHeight: 16, color: p.ink, backgroundColor: p.raised }} /></View>
            <View style={{ height: 16, flexDirection: "row", justifyContent: "flex-end", gap: 16 }}>
              <Action label="Cancel" testID="cancel-deploy" accessibilityLabel="Cancel deployment" onPress={() => deployOpen.set(false)} />
              <Action label="Queue deployment" testID="confirm-deploy" accessibilityLabel="Confirm deployment" primary onPress={confirmDeployment} />
            </View>
          </View>
        </View>
      </Dialog>
    </View>
  );
}

mount(Workbench);

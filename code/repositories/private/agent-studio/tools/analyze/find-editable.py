import json

agents = json.load(open('E:/cc/temp/rea-agent/app/agents.json'))
wf = json.load(open('E:/cc/temp/rea-agent/app/workflow-data.json'))
versions = {str(v.get('microAppVersionId')): v for v in wf.get('versions', [])}

for mode, label in [(0, '低代码'), (2, '工具型')]:
    rows = [r for r in agents if r['runMode'] == mode]
    print(f'\n{label} (runMode={mode}): {len(rows)} 条')
    for r in rows:
        vid = str(r['microAppVersionId'])
        v = versions.get(vid)
        if not v or not v.get('data'):
            continue
        try:
            g = json.loads(v['data'])
        except Exception:
            continue
        nodes = g.get('nodes', [])
        status = v.get('status')
        editable = status not in (3, 4)
        types = sorted({n.get('type') for n in nodes if n.get('type')})
        if editable and len(nodes) > 2:
            print(f"  可编辑 id={r['microAppId']} verId={vid} status={status} nodes={len(nodes)}")
            print(f"    name={r['microAppName']}")
            print(f"    types={types}")

import json
a = json.load(open('E:/cc/temp/rea-agent/app/agents.json'))
super6 = [r for r in a if r['runMode'] == 6]
standard5 = [r for r in a if r['runMode'] == 5]
print(f'Super6: {len(super6)}, Standard5: {len(standard5)}')
if super6:
    print(f"Super: {super6[0]['microAppName']} id={super6[0]['microAppId']} verId={super6[0]['microAppVersionId']}")
if standard5:
    print(f"Standard: {standard5[0]['microAppName']} id={standard5[0]['microAppId']} verId={standard5[0]['microAppVersionId']}")

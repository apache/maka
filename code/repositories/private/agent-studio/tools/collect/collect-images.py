"""保存已观察的图片和已采集页面模块明确引用的图片。"""
import hashlib
import json
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import urlsplit, quote, urlunsplit

ROOT = Path(__file__).resolve().parent
BASE = 'https://ai-copilot.cos.clife.cn/web-agent-paas/'
resource_path=ROOT/'evidence/combined-resources.json'
resources = json.loads((resource_path if resource_path.exists() else ROOT/'evidence/page-resources.json').read_text(encoding='utf-8'))
urls = {row['url'] for row in resources['images'] if row['url'].startswith('https://')}
for p in (ROOT / 'captured/assets/js').glob('*.js'):
    urls.update(re.findall(r'https://ai-copilot\.cos\.clife\.cn/web-agent-paas/assets/images/[^`\"\s]+\.(?:png|svg|jpg|webp)', p.read_text(encoding='utf-8')))
sample_path=ROOT/'evidence/agent-samples.json'
if sample_path.exists():
    urls.update(row['picUrl'] for row in json.loads(sample_path.read_text(encoding='utf-8'))['records'] if row.get('picUrl'))
navigation_path=ROOT/'evidence/navigation-resources.json'
if navigation_path.exists():
    stack=json.loads(navigation_path.read_text(encoding='utf-8'))['menuData']
    while stack:
        item=stack.pop()
        stack.extend(item.get('children',[]))
        if item.get('icon','') and item['icon'].startswith('https://'):
            urls.add(item['icon'])
for name in ['sidebar-data', 'component-data', 'mode-support-data', 'component-details']:
    path = ROOT / 'evidence' / (name + '.json')
    if not path.exists():
        continue
    def visit(value):
        if isinstance(value, str) and re.fullmatch(r'https://[^\s]+\.(?:png|jpe?g|svg|webp)(?:\?[^\s]*)?', value, re.I):
            urls.add(value)
        elif isinstance(value, dict):
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)
    visit(json.loads(path.read_text(encoding='utf-8')))
urls.add('https://meiye.cos.clife.cn/material/T000000/209e1407eeb1485fa761eaf7aacff8ac.png')


def save(url):
    if url.startswith(BASE):
        relative = url.removeprefix(BASE)
    elif urlsplit(url).hostname in {'itest.clife.net', 'meiye.cos.clife.cn', 'ai-copilot.cos.clife.cn', 'agent-paas-test-1323116912.cos.ap-guangzhou.myqcloud.com', 'ai-copilot-1323116912.cos.ap-guangzhou.myqcloud.com'}:
        relative = 'assets/images/' + hashlib.sha256(url.encode()).hexdigest()[:16] + Path(urlsplit(url).path).suffix
    else:
        return {'url': url, 'skipped': '非已观察的图片域名'}
    path = ROOT / 'captured' / relative
    if path.exists():
        return {'url':url,'path':relative,'bytes':path.stat().st_size}
    try:
        parts=urlsplit(url)
        encoded=urlunsplit((parts.scheme,parts.netloc,quote(parts.path,safe='/%'),parts.query,parts.fragment))
        with urlopen(Request(encoded,headers={'User-Agent':'REA-learning/1.0'}),timeout=25) as response:
            body=response.read()
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_bytes(body)
        return {'url':url,'path':relative,'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest()}
    except Exception as error:
        return {'url':url,'error':str(error)}

with ThreadPoolExecutor(max_workers=4) as pool:
    results = list(pool.map(save, sorted(urls)))
(ROOT/'evidence/image-manifest.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'saved':len([r for r in results if 'path' in r]),'errors':[r for r in results if 'error' in r],'skipped':[r for r in results if 'skipped' in r]},ensure_ascii=False,indent=2))

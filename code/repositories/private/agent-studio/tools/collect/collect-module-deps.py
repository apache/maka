"""仅下载已采集画布代码实际声明的延迟模块与字体。"""
import importlib.util
import json
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urljoin

ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('asset_collector',ROOT/'collect-assets.py')
collector=importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)
asset_root=ROOT/'captured'
urls=set()
for p in (asset_root/'assets/js').glob('*.js'):
    if p.name.startswith('index.'):
        continue
    text=p.read_text(encoding='utf-8')
    for relative in re.findall(r'assets/(?:js|css)/[^"\s]+\.(?:js|css)',text):
        if not (asset_root/relative).exists():
            urls.add(collector.BASE+relative)
for p in (asset_root/'assets/css').glob('*.css'):
    for relative in re.findall(r'url\(["\']?([^\)"\']+)["\']?\)',p.read_text(encoding='utf-8')):
        if relative.startswith('data:'):
            continue
        url=urljoin(collector.BASE+'assets/css/'+p.name,relative)
        if url.startswith(collector.BASE) and not (asset_root/url.removeprefix(collector.BASE)).exists():
            urls.add(url)
with ThreadPoolExecutor(max_workers=4) as pool:
    records=list(pool.map(collector.download,sorted(urls)))
(ROOT/'evidence/module-dependency-manifest.json').write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'downloaded':len([r for r in records if 'path' in r]),'errors':[r for r in records if 'error' in r]},ensure_ascii=False,indent=2))

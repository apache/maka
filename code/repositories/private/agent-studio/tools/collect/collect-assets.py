"""保存浏览器实际观察到的前端文件；凭据和接口响应不在采集范围内。"""
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen
import re

ROOT = Path(__file__).resolve().parent
BASE = 'https://ai-copilot.cos.clife.cn/web-agent-paas/'
OUT = ROOT / 'captured'
RESOURCE_LIST = ROOT / 'evidence' / ('combined-resources.json' if (ROOT / 'evidence/combined-resources.json').exists() else 'page-resources.json')


def download(url):
    parsed = urlsplit(url)
    if not url.startswith(BASE) or parsed.query:
        return {'url': url, 'skipped': '不属于观察到的静态发布目录'}
    relative = parsed.path.removeprefix('/web-agent-paas/')
    path = OUT / relative
    if '..' in Path(relative).parts:
        raise ValueError('路径越界')
    try:
        with urlopen(Request(url, headers={'User-Agent': 'REA-learning/1.0'}), timeout=30) as response:
            body = response.read()
            content_type = response.headers.get('Content-Type', '')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        result = {'url': url, 'path': relative, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest(), 'content_type': content_type}
        if path.suffix == '.js':
            text = body.decode('utf-8')
            maps = re.findall(r'[#@]\s*sourceMappingURL=([^\s*]+)', text)
            result['source_map_directives'] = maps
        return result
    except Exception as error:
        return {'url': url, 'error': str(error)}


def main():
    observed = json.loads(RESOURCE_LIST.read_text(encoding='utf-8'))
    urls = {item['url'] for key in ('scripts', 'resources', 'images') for item in observed[key]}
    urls.update(observed['styles'])
    with ThreadPoolExecutor(max_workers=4) as pool:
        records = list(pool.map(download, sorted(urls)))
    manifest = {'source_url': observed['url'], 'assets': records}
    (ROOT / 'evidence' / 'asset-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    saved = [item for item in records if 'path' in item]
    print(json.dumps({'downloaded': len(saved), 'bytes': sum(item['bytes'] for item in saved), 'errors': [item for item in records if 'error' in item], 'source_maps': [item for item in saved if item.get('source_map_directives')]}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()

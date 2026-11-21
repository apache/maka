"""采集已声明的导航入口及依赖闭包，保留原资源并生成入口可读副本。"""
import importlib.util
import json
import re
import subprocess
import time
from collections import deque
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path
from urllib.parse import urljoin, urlsplit

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / 'captured'
INDEX = ASSETS / 'assets/js/index.B_LPe2F7.js'
BASE = 'https://ai-copilot.cos.clife.cn/web-agent-paas/assets/js/'
# 只从 Agent 业务路由注册区提取精确 import，不展开其它顶层模块。
_INDEX_TEXT = INDEX.read_text(encoding='utf-8')
_AGENT_START = _INDEX_TEXT.index('Jf={')
_AGENT_END = _INDEX_TEXT.index('Yf={}', _AGENT_START)
AGENT_ROUTES = _INDEX_TEXT[_AGENT_START:_AGENT_END]
_ENTRY_IMPORTS = re.findall(r'\bimport\(\s*["\'`]([^"\'`$]+)["\'`]\s*\)', AGENT_ROUTES)
if not _ENTRY_IMPORTS or any(not re.fullmatch(r'\./[^/]+\.js', relative) for relative in _ENTRY_IMPORTS):
    raise ValueError('Agent 注册区入口为空或出现未支持的确切 import')
ENTRIES = list(dict.fromkeys(relative[2:] for relative in _ENTRY_IMPORTS))

spec = importlib.util.spec_from_file_location('navigation_asset_collector', ROOT / 'collect-assets.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)
ORIGINAL_URLOPEN = collector.urlopen

# 不执行 bundle；只识别明确写出的 import 和资源路径，不枚举服务器文件名。
STATIC_IMPORT = re.compile(
    r'\b(?:import|export)\s*(?:[^;"\'`]*?\bfrom\s*)?["\']([^"\'\r\n]+)["\']'
)
DYNAMIC_IMPORT = re.compile(r'\bimport\s*\(\s*["\'`]([^"\'`\r\n$]+)["\'`]\s*\)')
DELAYED_ASSET = re.compile(r'["\'`]((?:\./|\.\./|/web-agent-paas/)?assets/(?:js|css)/[^"\'`\s$]+\.(?:js|css))["\'`]')
CSS_URL = re.compile(r'url\(\s*["\']?([^\s)"\']+)["\']?\s*\)', re.I)
CSS_IMPORT = re.compile(r'@import\s*["\']([^"\']+)["\']', re.I)


class TimedResponse:
    """让 download 的整次响应读取共享 URL 截止时间，避免分块重复获得 20 秒。"""

    def __init__(self, response, deadline):
        self.response = response
        self.deadline = deadline
        self.headers = response.headers

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.response.close()

    def read(self):
        chunks = []
        while True:
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('单 URL 20 秒或总采集时限已到')
            sock = getattr(getattr(getattr(self.response, 'fp', None), 'raw', None), '_sock', None)
            if sock is not None:
                sock.settimeout(remaining)
            chunk = self.response.read1(65536)
            if not chunk:
                return b''.join(chunks)
            chunks.append(chunk)


def main():
    started = time.monotonic()
    # 为格式化与落盘预留 20 秒；网络阶段最多 280 秒。
    network_deadline = started + 280
    total_deadline = started + 300

    def bounded_urlopen(request, timeout=20):
        deadline = min(time.monotonic() + 20, network_deadline)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('总采集时限已到')
        return TimedResponse(ORIGINAL_URLOPEN(request, timeout=remaining), deadline)

    collector.urlopen = bounded_urlopen
    records = {}
    parents = {}
    edges = []
    excluded = []
    queue = deque()
    index_text = INDEX.read_text(encoding='utf-8')

    def local_path(url):
        return ASSETS / urlsplit(url).path.removeprefix('/web-agent-paas/')

    def add(url, source, kind):
        if not url.startswith(collector.BASE) or urlsplit(url).query or urlsplit(url).fragment:
            excluded.append({'url': url, 'source': source, 'reason': '发布目录外或带查询/片段的地址'})
            return
        if '..' in Path(urlsplit(url).path).parts:
            excluded.append({'url': url, 'source': source, 'reason': '路径越界'})
            return
        edges.append({'source': source, 'url': url, 'kind': kind})
        parents.setdefault(url, set()).add(source)
        if url not in records:
            records[url] = {'url': url, 'status': 'pending'}
            queue.append(url)

    for name in ENTRIES:
        if not re.search(r'["\'](?:assets/js/|\./)' + re.escape(name) + r'["\']', index_text):
            records[BASE + name] = {'url': BASE + name, 'error': '主 index 没有确切入口声明'}
            continue
        add(BASE + name, str(INDEX.relative_to(ROOT)), 'entry')
        # 仅展开当前目标路由传给 mapDeps 的索引，不遍历全站动态注册表。
        routes = list(re.finditer(r'import\(\s*["\'`]\./' + re.escape(name) + r'["\'`]\s*\)', AGENT_ROUTES))
        for route in routes:
            tail = AGENT_ROUTES[route.end():]
            next_import = re.search(r'\bimport\(', tail)
            route_tail = tail[:next_import.start()] if next_import else tail
            dependency_call = re.search(r'__vite__mapDeps\(\[([\d,\s]+)\]\)', route_tail)
            if dependency_call:
                registry = re.search(r'\.f=\[(.*?)\]', index_text)
                if registry is None:
                    raise ValueError('目标路由声明了 mapDeps，但无法解析其确切数组')
                declared = json.loads('[' + registry.group(1) + ']')
                for number in dependency_call.group(1).split(','):
                    if number.strip():
                        add(urljoin(collector.BASE, declared[int(number)]), BASE + name, 'target-route-mapDeps')

    def expand(url):
        path = local_path(url)
        if path.name == INDEX.name or path.name.startswith('vendor-'):
            records[url]['expansion'] = '主 index 全站 registry / vendor 按要求不扫描'
            return
        if path.suffix not in ('.js', '.css'):
            return
        text = path.read_text(encoding='utf-8')
        if path.suffix == '.css':
            for relative in CSS_URL.findall(text) + CSS_IMPORT.findall(text):
                if not relative.startswith(('data:', '#')):
                    add(urljoin(url, relative), url, 'css-resource')
            return
        for pattern, kind in ((STATIC_IMPORT, 'static-import'), (DYNAMIC_IMPORT, 'dynamic-import')):
            for relative in pattern.findall(text):
                if relative.startswith(('.', '/', 'https://')) and urlsplit(relative).path.endswith(('.js', '.css')):
                    add(urljoin(url, relative), url, kind)
        for relative in DELAYED_ASSET.findall(text):
            add(urljoin(collector.BASE, relative), url, 'delayed-asset')

    with ThreadPoolExecutor(max_workers=4) as pool:
        pending = {}
        while queue or pending:
            while queue and len(pending) < 4:
                url = queue.popleft()
                path = local_path(url)
                if path.is_file():
                    records[url] = {'url': url, 'path': str(path.relative_to(ASSETS)).replace('\\', '/'), 'status': 'existing', 'bytes': path.stat().st_size}
                    try:
                        expand(url)
                    except Exception as error:
                        records[url]['expansion_error'] = str(error)
                elif time.monotonic() >= network_deadline:
                    records[url] = {'url': url, 'error': '总采集时限已到，未发起下载'}
                else:
                    pending[pool.submit(collector.download, url)] = url
            if not pending:
                continue
            done, _ = wait(pending, return_when=FIRST_COMPLETED)
            for future in done:
                url = pending.pop(future)
                try:
                    result = future.result()
                    result['status'] = 'downloaded' if 'path' in result else 'failed'
                    records[url] = result
                    if 'path' in result:
                        expand(url)
                except Exception as error:
                    records[url] = {'url': url, 'error': str(error)}

    formatter = r'''
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {format} from 'prettier';
const names=JSON.parse(await new Promise(resolve=>{let value='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>value+=part);process.stdin.on('end',()=>resolve(value));}));
await mkdir('readable',{recursive:true});
const results=[];
for(const name of names){
 try{
  const text=await readFile(join('captured/assets/js',name),'utf8');
  const output=await format(text,{parser:'babel'});
  await writeFile(join('readable',name),output);
  results.push({file:name,lines:output.split('\n').length});
 }catch(error){results.push({file:name,error:String(error)});}
}
console.log(JSON.stringify(results));
'''
    formatting = []
    try:
        result = subprocess.run(
            ['node', '--input-type=module', '-e', formatter], cwd=ROOT,
            input=json.dumps(ENTRIES), capture_output=True, text=True, encoding='utf-8',
            timeout=max(0.1, total_deadline - time.monotonic() - 1),
        )
        formatting = json.loads(result.stdout) if result.returncode == 0 else [{'error': result.stderr[:1000]}]
    except Exception as error:
        formatting = [{'error': str(error)}]
    assets = [dict(record, declared_by=sorted(parents.get(url, ()))) for url, record in sorted(records.items())]
    errors = [item for item in assets if 'error' in item or 'expansion_error' in item or 'skipped' in item]
    missing = [item['url'] for item in assets if not local_path(item['url']).is_file()]
    summary = {
        'downloaded': sum(item.get('status') == 'downloaded' for item in assets),
        'existing': sum(item.get('status') == 'existing' for item in assets),
        'downloaded_bytes': sum(item.get('bytes', 0) for item in assets if item.get('status') == 'downloaded'),
        'discovered': len(assets), 'missing': missing, 'errors': errors,
        'formatted_entries': sum('lines' in item for item in formatting),
        'format_errors': [item for item in formatting if 'error' in item],
        'elapsed_seconds': round(time.monotonic() - started, 2),
    }
    manifest = {
        'base': BASE, 'entries': ENTRIES, 'limits': {'workers': 4, 'url_seconds': 20, 'total_seconds': 300},
        'summary': summary, 'assets': assets, 'edges': edges, 'excluded': excluded,
        'formatting': formatting, 'analysis_scope': '仅 Jf={ 至 Yf={} 的 Agent 业务导航依赖闭包；其它顶层模块、主 index 全站 registry 和 vendor 不展开',
    }
    (ROOT / 'evidence').mkdir(exist_ok=True)
    (ROOT / 'evidence/navigation-asset-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()

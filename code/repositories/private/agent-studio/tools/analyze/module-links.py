import json
import re
from pathlib import Path

root = Path(__file__).resolve().parent
links = []
for p in sorted((root / 'captured/assets/js').glob('*.js')):
    text = p.read_text(encoding='utf-8')
    imports = re.findall(r'import([^;]*?)from["\']([^"\']+)["\']', text)
    links.append({'file': p.name, 'imports': [{'bindings': b, 'file': f} for b, f in imports]})
    critical = [f'{b} from {f}' for b, f in imports if any(s in f for s in ['index.', 'src-'])]
    if critical:
        print(p.name, '\n  ' + '\n  '.join(critical))
    if p.name.startswith(('vendor-react', 'vendor-antd', 'rolldown-runtime')):
        print(p.name, 'FIRST', text[:600], 'LAST', text[-1300:])
(root / 'evidence/module-links.json').write_text(json.dumps(links, ensure_ascii=False, indent=2), encoding='utf-8')
index = (root / 'captured/assets/js/index.B_LPe2F7.js').read_text(encoding='utf-8')
for name in ['Zd', 'Xd', 'Bf', 'ks', 'nl', 'To', 'Su', 'hd', 'us', 'Io', 'jf']:
    match = re.search(r'(?:function '+name+r'\b|\b'+name+r'=)', index)
    if match:
        print(name, index[max(0, match.start()-70):match.start()+1700])

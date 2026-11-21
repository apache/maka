import json
import re
from collections import Counter
from pathlib import Path

root = Path(__file__).resolve().parent
v = json.loads((root / 'evidence/rea-analysis.json').read_text(encoding='utf-8'))
graph = v['normalized_result']['graph']
print('REA graph:', dict(Counter(n['kind'] for n in graph['nodes'])))
print('Normalized keys:', list(v['normalized_result']))
text = (root / 'captured/assets/js/src-_hjT3BN9.js').read_text(encoding='utf-8')
print('Business facade size:', len(text))
print('API paths:')
print('\n'.join(sorted(set(re.findall(r'[`\"](/[^`\"\s]+)[`\"]', text)))))
print('Facade exports:', text[-4000:])
index = (root / 'captured/assets/js/index.B_LPe2F7.js').read_text(encoding='utf-8')
print('Bootstrap exports:', index[-5000:])
for term in ['findMicroAppPage', 'publishMicroApp', 'copyMicroApp']:
    pos = text.find(term)
    if pos >= 0:
        print(term, text[max(0, pos - 400):pos + 600])

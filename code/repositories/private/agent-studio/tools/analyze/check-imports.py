import re
from pathlib import Path
root=Path(__file__).resolve().parent.parent.parent/'app/assets/js'
missing=[]
for file in root.glob('*.js'):
    for target in re.findall(r'from["\']([^"\']+)',file.read_text(encoding='utf-8')):
        if target.startswith('.') and not (file.parent/target).is_file():
            missing.append((file.name,target))
print('missing static imports:',missing)
assert not missing

from pathlib import Path
import hashlib
import json

root = Path(__file__).resolve().parent
modified = Path('/private/tmp/magpie-quality-20261017-2533')
rollback = Path('/private/tmp/magpie-quality-20261017-2533-replay')
for name, values in json.loads((root / 'source-hashes.json').read_text()).items():
    assert hashlib.sha256((modified / name).read_bytes()).hexdigest() == values['modified_sha256'], name
    if values['baseline_sha256'] is None:
        assert not (rollback / name).exists(), name
    else:
        assert hashlib.sha256((rollback / name).read_bytes()).hexdigest() == values['baseline_sha256'], name
print('PASS: rollback copy exactly matches baseline hashes; modified source remains changed')

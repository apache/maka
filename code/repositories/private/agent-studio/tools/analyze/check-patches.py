"""校验 restore.mjs 对发布代码的改动真实落在生成产物里。

这些改动不经过离线接口层，只能在生成文件上断言；一旦上游资源变化导致
patch 边界失配，restore.mjs 会直接抛错，这里再确认改动结果符合预期。
"""
import re
from pathlib import Path

root = Path(__file__).resolve().parent.parent.parent / 'app'
js = root / 'assets/js'
failures = []


def check(name, condition, detail=''):
    if not condition:
        failures.append(f'{name}{": " + detail if detail else ""}')


low_code = (js / 'low-code-chat-D6fop61f.js').read_text(encoding='utf-8')
# 抽屉关闭会卸载表单，防抖回调读到空引用并把 {} 写回节点。
debounced = re.findall(r'onFieldsChange:Zn\([A-Za-z_$][\w$]*,\d+\)', low_code)
check('节点表单仍有防抖提交', not debounced, f'{len(debounced)} 处')
synchronous = re.findall(r'onFieldsChange:[A-Za-z_$][\w$]*(?=[,}])', low_code)
check('节点表单同步提交数量异常', len(synchronous) >= 11, f'{len(synchronous)} 处')

qa = (js / 'qa-daatabase-CouSE0St.js').read_text(encoding='utf-8')
check('问答状态列缺少本地标注', 'localOnly' in qa and '本地保存（未向量化）' in qa)

request = (js / 'request-Cb6e7tFu.js').read_text(encoding='utf-8')
check('原请求适配器未接离线层', 'offlineRequest' in request)

index = (js / 'index.B_LPe2F7.js').read_text(encoding='utf-8')
for name, token in [('mountRecovered 缺失', 'mountRecovered'), ('df 入口未接离线层', 'df=async'),
                    ('Axios 风格入口未接离线层', 'Y.request=options=>offlineRequest')]:
    check(name, token in index)

client = (js / 'client-BfElcTb7.js').read_text(encoding='utf-8')
check('账号 SDK 未接离线层', 'offlineRequest' in client)

assets = 'https://ai-copilot.cos.clife.cn/web-agent-paas/'
remote = [path.name for path in js.glob('*.js') if assets in path.read_text(encoding='utf-8')]
check('仍引用原 CDN 资源', not remote, ', '.join(remote[:5]))

print('restore patches:', 'ok' if not failures else failures)
assert not failures, failures

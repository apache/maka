import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  generalizedErrorMessage,
  generalizedErrorMessageChinese,
  redactSecrets,
} from '../redaction.js';

describe('redactSecrets', () => {
  test('masks bearer tokens and provider key prefixes', () => {
    const text = redactSecrets(
      'Authorization: Bearer sk-live-secret-token-value Proxy-Authorization: Basic opaque-proxy-value and ghp_abcdefghijklmnopqrstuvwxyz',
    );

    assert.equal(text.includes('sk-live-secret-token-value'), false);
    assert.equal(text.includes('opaque-proxy-value'), false);
    assert.equal(text.includes('ghp_abcdefghijklmnopqrstuvwxyz'), false);
    assert.match(text, /Authorization: Bearer \[redacted\]/);
    assert.match(text, /Proxy-Authorization: Basic \[redacted\]/);
  });

  test('masks only sensitive URL query values', () => {
    const text = redactSecrets(
      'https://api.example.test/models?model=x&api_key=secret-value&timeout=30',
    );

    assert.match(text, /https:\/\/api\.example\.test\/models\?model=x/);
    assert.match(text, /api_key=\[redacted\]/);
    assert.match(text, /timeout=30/);
    assert.equal(text.includes('secret-value'), false);
  });

  test('masks quoted sensitive object keys in serialized JSON', () => {
    const text = redactSecrets(
      JSON.stringify({
        authorization: 'Bearer opaque-session-value',
        apiKey: 'plain-provider-key',
        password: 'correct-horse-battery-staple',
        nested: {
          accessToken: 'nested-token-value',
        },
        keep: 'visible',
      }),
    );

    assert.match(text, /"authorization":"\[redacted\]"/);
    assert.match(text, /"apiKey":"\[redacted\]"/);
    assert.match(text, /"password":"\[redacted\]"/);
    assert.match(text, /"accessToken":"\[redacted\]"/);
    assert.match(text, /"keep":"visible"/);
    assert.equal(text.includes('opaque-session-value'), false);
    assert.equal(text.includes('plain-provider-key'), false);
    assert.equal(text.includes('correct-horse-battery-staple'), false);
    assert.equal(text.includes('nested-token-value'), false);
  });

  test('masks common compound credential keys', () => {
    const text = redactSecrets(
      JSON.stringify({
        client_secret: 'client-value',
        refreshToken: 'refresh-value',
        private_key: 'private-value',
        session_token: 'session-value',
        service_account_key: 'service-account-value',
        ssh_key: 'ssh-key-value',
        ssh_private_key: 'ssh-value',
        credentials: 'credential-value',
        cache_key: 'cached-result',
        idempotencyKey: 'request-deduplication',
        issue_key: 'ISSUE-1359',
        keyboard: 'ordinary-keyboard',
        objectKey: 'approval-target',
        public_key: 'published-material',
        tokenCount: 42,
      }),
    );

    assert.doesNotMatch(
      text,
      /client-value|refresh-value|private-value|session-value|service-account-value|ssh-key-value|ssh-value|credential-value/,
    );
    assert.deepEqual(JSON.parse(text), {
      client_secret: '[redacted]',
      refreshToken: '[redacted]',
      private_key: '[redacted]',
      session_token: '[redacted]',
      service_account_key: '[redacted]',
      ssh_key: '[redacted]',
      ssh_private_key: '[redacted]',
      credentials: '[redacted]',
      cache_key: 'cached-result',
      idempotencyKey: 'request-deduplication',
      issue_key: 'ISSUE-1359',
      keyboard: 'ordinary-keyboard',
      objectKey: 'approval-target',
      public_key: 'published-material',
      tokenCount: 42,
    });
  });

  test('masks compound credential assignments without changing authorization schemes', () => {
    const text = redactSecrets(
      'ssh_private_key=ssh-value sessionToken=session-value service-account-key=service-value Authorization: Basic basic-value Proxy-Authorization: Bearer proxy-value issue_key=ISSUE-1359 objectKey=target',
    );

    assert.equal(
      text,
      'ssh_private_key=[redacted] sessionToken=[redacted] service-account-key=[redacted] Authorization: Basic [redacted] Proxy-Authorization: Bearer [redacted] issue_key=ISSUE-1359 objectKey=target',
    );
  });

  test('does not cross enclosing quotes between adjacent header assignments', () => {
    assert.equal(
      redactSecrets(
        'curl -H "awsSecretAccessKey=aws-secret" -H "secretAccessKey=standard-secret" -H "accessKey=ordinary-access-key"',
      ),
      'curl -H "awsSecretAccessKey=[redacted]" -H "secretAccessKey=[redacted]" -H "accessKey=ordinary-access-key"',
    );
    assert.equal(
      redactSecrets('curl -H "password=secret value" -H "accessKey=ordinary-access-key"'),
      'curl -H "password=[redacted]" -H "accessKey=ordinary-access-key"',
    );
  });

  test('masks quoted fragments appended to unquoted assignment values', () => {
    assert.equal(
      redactSecrets('password=abc" secret tail" && echo visible'),
      'password=[redacted] && echo visible',
    );
  });

  test('uses expansion-local quote context for assignments', () => {
    assert.equal(
      redactSecrets(
        'echo "$(password=abc" secret tail"; echo inner-visible)" && echo outer-visible',
      ),
      'echo "$(password=[redacted]; echo inner-visible)" && echo outer-visible',
    );
  });

  test('treats prose apostrophes as ambiguous text instead of outer shell quotes', () => {
    assert.equal(
      redactSecrets("can't connect: password=abc' secret tail' && status=visible"),
      "can't connect: password=[redacted] && status=visible",
    );
    assert.equal(
      redactSecrets("James' error: password=secret status=visible"),
      "James' error: password=[redacted] status=visible",
    );
    assert.equal(
      redactSecrets("curl -H 'password=secret value' -H 'status=visible'"),
      "curl -H 'password=[redacted]' -H 'status=visible'",
    );
    assert.equal(redactSecrets("'password=secret status=visible"), "'password=[redacted]");
  });

  test('keeps the longer complete strict-shell interpretation for quote concatenation', () => {
    assert.equal(
      redactSecrets("note=abc' password=abc secret tail' status=visible"),
      "note=abc' password=[redacted]' status=visible",
    );
    assert.equal(
      redactSecrets("can't run note=abc' password=secret tail' status=visible"),
      "can't run note=abc' password=[redacted]' status=visible",
    );
  });

  test('closes a complete quoted field before interpreting the next assignment', () => {
    assert.equal(
      redactSecrets("note='complete field' password=secret status=visible"),
      "note='complete field' password=[redacted] status=visible",
    );
  });

  test('bounds lexical ambiguity across repeated apostrophes and expansions', () => {
    const prefix = "word's $(echo visible) ".repeat(512);
    const ordinary = redactSecrets(`${prefix}password=secret status=visible`);
    const unterminated = redactSecrets(`${prefix}'password=secret tail-visible`);

    assert.equal(ordinary, `${prefix}password=[redacted] status=visible`);
    assert.equal(unterminated, `${prefix}'password=[redacted]`);
  });

  test('redacts a large assignment batch through one ordered context pass', () => {
    const assignments = Array.from({ length: 2_000 }, (_, index) => `password=value-${index}`);
    const text = redactSecrets(assignments.join(' '));

    assert.equal(text, assignments.map(() => 'password=[redacted]').join(' '));
  });

  test('masks complete shell tokens in generic secret assignments', () => {
    assert.equal(
      redactSecrets(
        `password='correct horse battery staple' && api_token="secret with \\"quoted\\" text" ; printf 'keep this command'`,
      ),
      `password='[redacted]' && api_token="[redacted]" ; printf 'keep this command'`,
    );
    assert.equal(
      redactSecrets(
        'client_secret=correct\\ horse\\ battery && password="continued \\\nsecret value" || echo still-visible',
      ),
      'client_secret=[redacted] && password="[redacted]" || echo still-visible',
    );
  });

  test('masks Bash append and indexed sensitive assignments', () => {
    assert.equal(
      redactSecrets(
        'API_TOKEN+=correct-horse-battery-staple API_TOKEN[0]=indexed-secret && echo visible',
      ),
      'API_TOKEN+=[redacted] API_TOKEN[0]=[redacted] && echo visible',
    );
    assert.equal(
      redactSecrets(
        `API_TOKEN["team] prod"]='quoted secret' && API_\\
TOKEN[0]\\
+=continued\\
-secret; printf visible`,
      ),
      `API_TOKEN["team] prod"]='[redacted]' && API_\\
TOKEN[0]\\
+=[redacted]; printf visible`,
    );
  });

  test('does not treat arbitrary arrays or similar keys as sensitive assignments', () => {
    const text =
      'items[0]=ordinary API_TOKENS[0]=plural TOKEN_COUNT[0]+=1 cache_key[API_TOKEN]=visible';
    assert.equal(redactSecrets(text), text);
  });

  test('redacts command strings inside serialized JSON without crossing JSON syntax', () => {
    const text = redactSecrets(
      JSON.stringify({
        command: 'deploy --label visible password="json secret" --region ap-southeast-1',
        adjacent: 'still visible',
        argv: ['--name', 'ordinary'],
      }),
    );

    assert.deepEqual(JSON.parse(text), {
      command: 'deploy --label visible password="[redacted]" --region ap-southeast-1',
      adjacent: 'still visible',
      argv: ['--name', 'ordinary'],
    });
  });

  test('fails closed for incomplete quoted and escaped secret words', () => {
    assert.equal(
      redactSecrets("password='unterminated secret && echo also-secret"),
      'password=[redacted]',
    );
    assert.equal(
      redactSecrets('api_token="unterminated secret || echo also-secret'),
      'api_token=[redacted]',
    );
    assert.equal(redactSecrets('client_secret=trailing-secret\\'), 'client_secret=[redacted]');
    assert.equal(
      redactSecrets("aws configure set aws_secret_access_key 'unterminated aws secret"),
      'aws configure set aws_secret_access_key [redacted]',
    );
    assert.equal(
      redactSecrets('tool --secret-access-key "unterminated flag secret'),
      'tool --secret-access-key [redacted]',
    );
  });

  test('fails closed when AWS config keys require shell evaluation', () => {
    const ansi = redactSecrets(
      String.raw`aws configure set $'aws_secret_access_\x6bey' ansi-secret && echo visible`,
    );
    const substitution = redactSecrets(
      'aws configure set aws_secret_access_$(printf key) substitution-secret && echo visible',
    );
    const nestedValue = redactSecrets(
      'password=$(printf %s $(load-secret))literal-secret && echo visible',
    );
    const dynamicProfile = redactSecrets(
      'aws configure set profile.$(team).aws_secret_access_key profile-secret',
    );
    const splitKey = redactSecrets(
      'aws configure set aws_$(printf secret)_access_key split-secret',
    );

    assert.equal(
      ansi,
      String.raw`aws configure set $'aws_secret_access_\x6bey' [redacted] && echo visible`,
    );
    assert.equal(
      substitution,
      'aws configure set aws_secret_access_$(printf key) [redacted] && echo visible',
    );
    assert.equal(nestedValue, 'password=[redacted] && echo visible');
    assert.equal(
      dynamicProfile,
      'aws configure set profile.$(team).aws_secret_access_key [redacted]',
    );
    assert.equal(splitKey, 'aws configure set aws_$(printf secret)_access_key [redacted]');
  });

  test('keeps arithmetic and subshell grouping inside the redacted word span', () => {
    assert.equal(
      redactSecrets('password=$((1 + 2))literal-secret && echo visible'),
      'password=[redacted] && echo visible',
    );
    assert.equal(
      redactSecrets('password=$( (printf secret) )literal-secret && echo visible'),
      'password=[redacted] && echo visible',
    );
  });

  test('fails closed only for uncertain words that can resolve to the sensitive AWS flag', () => {
    assert.equal(
      redactSecrets("$'--secret-access-key' flag-secret && echo visible"),
      "$'--secret-access-key' [redacted] && echo visible",
    );
    assert.equal(
      redactSecrets('--secret-access-$(printf key) flag-secret && echo visible'),
      '--secret-access-$(printf key) [redacted] && echo visible',
    );
    assert.equal(
      redactSecrets('--output-$(printf format) visible-value && echo visible'),
      '--output-$(printf format) visible-value && echo visible',
    );
  });

  test('consumes complete ANSI-C escape payloads before matching sensitive flags', () => {
    for (const flag of [
      String.raw`$'--secret-access-\x6bey'`,
      String.raw`$'--secret-access-\u006bey'`,
      String.raw`$'--secret-access-\U0000006bey'`,
      String.raw`$'--secret-access-\153ey'`,
    ]) {
      assert.equal(
        redactSecrets(`${flag} flag-secret && echo visible`),
        `${flag} [redacted] && echo visible`,
      );
    }
    const nonSecret = String.raw`$'--secret-access-\x66ile' visible-value && echo visible`;
    assert.equal(redactSecrets(nonSecret), nonSecret);
  });

  test('uses original UTF-16 spans when redacting non-ASCII shell words', () => {
    assert.equal(
      redactSecrets('echo 前缀 password="秘密🔑 值" 后缀=可见'),
      'echo 前缀 password="[redacted]" 后缀=可见',
    );
  });

  test('masks standard secret access key names without owning arbitrary access keys', () => {
    const json = redactSecrets(
      JSON.stringify({
        awsSecretAccessKey: 'aws-secret',
        secretAccessKey: 'standard-secret',
        AWS_SECRET_ACCESS_KEY: 'environment-secret',
        accessKey: 'ordinary-access-key',
      }),
    );

    assert.deepEqual(JSON.parse(json), {
      awsSecretAccessKey: '[redacted]',
      secretAccessKey: '[redacted]',
      AWS_SECRET_ACCESS_KEY: '[redacted]',
      accessKey: 'ordinary-access-key',
    });
    assert.equal(
      redactSecrets(
        'awsSecretAccessKey=aws-secret secretAccessKey:standard-secret AWS_SECRET_ACCESS_KEY="environment-secret" accessKey=ordinary-access-key',
      ),
      'awsSecretAccessKey=[redacted] secretAccessKey:[redacted] AWS_SECRET_ACCESS_KEY="[redacted]" accessKey=ordinary-access-key',
    );
  });

  test('masks space-separated AWS CLI secret access key values', () => {
    assert.equal(
      redactSecrets(
        "aws configure set aws_secret_access_key aws-config-secret && aws s3 cp . s3://bucket --secret-access-key 'aws-flag-secret'",
      ),
      "aws configure set aws_secret_access_key [redacted] && aws s3 cp . s3://bucket --secret-access-key '[redacted]'",
    );
    assert.equal(
      redactSecrets('aws configure set aws_secret_access_key "quoted-secret"'),
      'aws configure set aws_secret_access_key "[redacted]"',
    );
    assert.equal(
      redactSecrets(
        'aws configure set profile.team-prod-admin.aws_secret_access_key "profile secret value" && aws configure set region us-west-2',
      ),
      'aws configure set profile.team-prod-admin.aws_secret_access_key "[redacted]" && aws configure set region us-west-2',
    );
    assert.equal(
      redactSecrets(
        "aws configure set 'profile.team.aws_secret_access_key' 'quoted \\\nsecret value' && echo visible",
      ),
      "aws configure set 'profile.team.aws_secret_access_key' '[redacted]' && echo visible",
    );
    assert.equal(
      redactSecrets(
        "aws configure set 'profile.team prod.aws_secret_access_key' 'quoted secret value'",
      ),
      "aws configure set 'profile.team prod.aws_secret_access_key' '[redacted]'",
    );
    assert.equal(
      redactSecrets(
        `aws configure set profile.'team prod'.aws_secret_access_key "segmented secret "value`,
      ),
      `aws configure set profile.'team prod'.aws_secret_access_key [redacted]`,
    );
    assert.equal(
      redactSecrets(
        "aws configure set $'aws_secret_access_key' 'ansi secret'; aws configure set aws_secret_access_$'key' suffix-secret",
      ),
      "aws configure set $'aws_secret_access_key' '[redacted]'; aws configure set aws_secret_access_$'key' [redacted]",
    );
  });

  test('masks AWS secrets across POSIX line continuations', () => {
    assert.equal(
      redactSecrets(
        'aws configure set aws_secret_access_key \\\nconfig-secret\nAWS_SECRET_ACCESS_KEY=\\\nenvironment-secret',
      ),
      'aws configure set aws_secret_access_key \\\n[redacted]\nAWS_SECRET_ACCESS_KEY=\\\n[redacted]',
    );
    assert.equal(
      redactSecrets('aws s3 cp . s3://bucket --secret-access-key flag-\\\nsecret'),
      'aws s3 cp . s3://bucket --secret-access-key [redacted]',
    );
    assert.equal(
      redactSecrets('AWS_SECRET_ACCESS_KEY\\\n=environment-secret'),
      'AWS_SECRET_ACCESS_KEY\\\n=[redacted]',
    );
    assert.equal(
      redactSecrets(
        'aws configure set aws_secret_access_\\\nkey config-secret && tool --secret-access-\\\r\nkey flag-secret && AWS_SECRET_ACCESS_\\\nKEY=environment-secret',
      ),
      'aws configure set aws_secret_access_\\\nkey [redacted] && tool --secret-access-\\\r\nkey [redacted] && AWS_SECRET_ACCESS_\\\nKEY=[redacted]',
    );
  });

  test('does not mask similar non-secret AWS CLI tokens', () => {
    const text =
      'aws configure set region us-east-1; aws configure set \'profile.team prod.region\' us-west-2; aws configure set profile.team.prod.aws_secret_access_key ordinary-value; aws configure set "aws_secret_access_ke\\y" escaped-value; aws configure set my_aws_secret_access_\\\nkey visible; tool --secret-access-key-\\\r\nfile credentials.txt; AWS_SECRET_ACCESS_KEY_\\\nFILE=visible';

    assert.equal(redactSecrets(text), text);
    assert.equal(
      redactSecrets(
        'aws configure set $(printf region) us-west-2; aws configure set profile.$(team).region us-west-2',
      ),
      'aws configure set $(printf region) us-west-2; aws configure set profile.$(team).region us-west-2',
    );
  });

  test('masks escaped and non-string sensitive JSON values structurally', () => {
    const text = redactSecrets(
      JSON.stringify({
        password: 'abc"def\\ghi',
        token: 12345,
        secret: { raw: 'object value should not leak' },
        keep: 'visible',
      }),
    );

    assert.match(text, /"password":"\[redacted\]"/);
    assert.match(text, /"token":"\[redacted\]"/);
    assert.match(text, /"secret":"\[redacted\]"/);
    assert.match(text, /"keep":"visible"/);
    assert.equal(text.includes('abc'), false);
    assert.equal(text.includes('def'), false);
    assert.equal(text.includes('object value should not leak'), false);
  });
});

describe('generalizedErrorMessage', () => {
  test('returns generic classes instead of raw redacted provider errors', () => {
    assert.equal(
      generalizedErrorMessage(new Error('401 Authorization: Bearer sk-live-secret-token-value')),
      'Authentication failed',
    );
    assert.equal(
      generalizedErrorMessage(new Error('fetch failed ECONNREFUSED token=secret')),
      'Network error',
    );
  });

  test('classifies status and rate-limit messages before redacted secret content', () => {
    const auth = generalizedErrorMessage(
      new Error('403 {"error":"bad key","api_key":"sk-live-secret-token-value"}'),
    );
    const rateLimit = generalizedErrorMessage(
      new Error('429 Authorization: Bearer sk-live-secret-token-value'),
    );

    assert.equal(auth, 'Authentication failed');
    assert.equal(rateLimit, 'Rate limit exceeded');
    assert.equal(auth.includes('sk-live-secret-token-value'), false);
    assert.equal(rateLimit.includes('sk-live-secret-token-value'), false);
  });
});

describe('generalizedErrorMessageChinese (PR110b)', () => {
  // Locks the Chinese-only contract for surfaces that must never
  // leak an English category to renderer copy. Each category
  // returns the Chinese phrase and the raw English category MUST NOT
  // appear in the result.

  test('timeout → 请求超时', () => {
    const msg = generalizedErrorMessageChinese(new Error('Request timeout after 30s'));
    assert.equal(msg, '请求超时');
  });

  test('429 / rate → 触发模型速率限制', () => {
    for (const raw of [
      'HTTP 429 Too Many Requests',
      'OpenAI rate limit reached for model gpt-4',
      'rate exceeded',
    ]) {
      const msg = generalizedErrorMessageChinese(new Error(raw));
      assert.equal(msg, '触发模型速率限制', `raw=${raw}`);
    }
  });

  test('401 / 403 / auth → 鉴权失败', () => {
    for (const raw of ['401 Unauthorized', 'HTTP 403 forbidden', 'Authentication failed']) {
      const msg = generalizedErrorMessageChinese(new Error(raw));
      assert.equal(msg, '鉴权失败', `raw=${raw}`);
    }
  });

  test('5xx → 模型服务返回错误', () => {
    for (const raw of [
      'HTTP 500 Internal Server Error',
      'Provider returned 503',
      'Bad gateway 502',
    ]) {
      const msg = generalizedErrorMessageChinese(new Error(raw));
      assert.equal(msg, '模型服务返回错误', `raw=${raw}`);
      assert.notEqual(msg, '模型服务暂不可用');
    }
  });

  test('network / fetch / econn / enotfound → 网络错误', () => {
    for (const raw of [
      'fetch failed',
      'ECONNREFUSED',
      'ENOTFOUND api.example.test',
      'network unreachable',
    ]) {
      const msg = generalizedErrorMessageChinese(new Error(raw));
      assert.equal(msg, '网络错误', `raw=${raw}`);
    }
  });

  test('completely unknown error uses Chinese fallback (default = 操作失败)', () => {
    // @kenji PR110b: unknown failure must NOT escape to English; the
    // default fallback is itself Chinese.
    assert.equal(generalizedErrorMessageChinese(new Error('something weird happened')), '操作失败');
    assert.equal(generalizedErrorMessageChinese('non-Error string input'), '操作失败');
  });

  test('caller-supplied Chinese fallback is used for unknown errors', () => {
    const msg = generalizedErrorMessageChinese(
      new Error('something weird happened'),
      '会话已创建但发送失败，请重试。',
    );
    assert.equal(msg, '会话已创建但发送失败，请重试。');
  });

  test('output is always Chinese — no English category leaks through', () => {
    const rawErrors = [
      new Error('Request timed out'),
      new Error('rate limit'),
      new Error('Authentication failed'),
      new Error('Provider returned 500'),
      new Error('fetch failed'),
      new Error('NO_REAL_CONNECTION:missing_api_key: 缺少 API key'),
      new Error('completely unknown'),
    ];
    const englishCategories = [
      'Request timed out',
      'Rate limit exceeded',
      'Authentication failed',
      'Provider returned an error',
      'Network error',
      'Operation failed',
    ];
    for (const error of rawErrors) {
      const msg = generalizedErrorMessageChinese(error, '操作失败');
      // Must contain at least one Chinese character.
      assert.match(msg, /[一-鿿]/, `result "${msg}" should contain Chinese`);
      // Must not contain ANY English category from the original helper.
      for (const eng of englishCategories) {
        assert.equal(msg.includes(eng), false, `result "${msg}" leaked English category "${eng}"`);
      }
    }
  });

  test('redacts secrets before classifying (token does not appear in output)', () => {
    const msg = generalizedErrorMessageChinese(
      new Error('401 Authorization: Bearer sk-live-secret-token-value'),
    );
    assert.equal(msg, '鉴权失败');
    assert.equal(msg.includes('sk-live-secret-token-value'), false);
  });
});

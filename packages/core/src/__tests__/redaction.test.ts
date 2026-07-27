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

  test('applies bounded text patterns to top-level JSON number primitives', () => {
    assert.equal(redactSecrets('1234567890123456789012345678901234567890'), '[redacted]');
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

  test('redacts original string leaves without crossing serialized JSON boundaries', () => {
    const text = redactSecrets(
      JSON.stringify({
        assignment: 'review note\npassword=dummy-value\nrun visible',
        request: 'Authorization: Bearer opaque-value\nnext visible',
      }),
    );

    assert.deepEqual(JSON.parse(text), {
      assignment: 'review note\npassword=[redacted]\nrun visible',
      request: 'Authorization: Bearer [redacted]\nnext visible',
    });
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

  test('does not consume a trailing command after a quoted review comment', () => {
    assert.equal(
      redactSecrets('# " review note\npassword=dummy-value\npython deploy.py --target production'),
      '# " review note\npassword=[redacted]\npython deploy.py --target production',
    );
  });

  test('preserves own __proto__ data properties while redacting serialized JSON', () => {
    const redacted = JSON.parse(
      redactSecrets(
        '{"__proto__":{"password":"prototype-secret","keep":"visible"},"apiKey":"api-secret"}',
      ),
    );

    assert.equal(Object.hasOwn(redacted, '__proto__'), true);
    assert.deepEqual(redacted, {
      ['__proto__']: {
        password: '[redacted]',
        keep: 'visible',
      },
      apiKey: '[redacted]',
    });
  });

  test('handles a large batch of malformed sensitive assignment indexes in bounded time', {
    timeout: 15_000,
  }, () => {
    const malformed = 'token['.repeat(50_000);

    assert.equal(redactSecrets(malformed), malformed);
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
      'aws configure set region us-east-1; aws configure set my_aws_secret_access_\\\nkey visible; tool --secret-access-key-\\\r\nfile credentials.txt; AWS_SECRET_ACCESS_KEY_\\\nFILE=visible';

    assert.equal(redactSecrets(text), text);
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

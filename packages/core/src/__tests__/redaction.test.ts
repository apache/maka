/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { formatWithOptions } from 'node:util';
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
    const inspected = redactSecrets(
      formatWithOptions(
        { colors: false },
        {
          authorization: 'Bearer inspected-secret-value',
          'Proxy-Authorization': 'Basic inspected-proxy-secret',
          proxyAuthorization: 'Token inspected-camel-secret',
        },
      ),
    );

    assert.equal(text.includes('sk-live-secret-token-value'), false);
    assert.equal(text.includes('opaque-proxy-value'), false);
    assert.equal(text.includes('ghp_abcdefghijklmnopqrstuvwxyz'), false);
    assert.match(text, /Authorization: Bearer \[redacted\]/);
    assert.match(text, /Proxy-Authorization: Basic \[redacted\]/);
    assert.equal(inspected.includes('inspected-secret-value'), false);
    assert.equal(inspected.includes('inspected-proxy-secret'), false);
    assert.equal(inspected.includes('inspected-camel-secret'), false);
    assert.match(inspected, /authorization: 'Bearer \[redacted\]'/);
    assert.match(inspected, /'Proxy-Authorization': 'Basic \[redacted\]'/);
    assert.match(inspected, /proxyAuthorization: 'Token \[redacted\]'/);
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
  test('classifies provider failures without exposing secret-bearing input', () => {
    for (const [raw, expected] of [
      ['401 Authorization: Bearer sk-live-secret-token-value', 'Authentication failed'],
      ['403 {"error":"bad key","api_key":"sk-live-secret-token-value"}', 'Authentication failed'],
      ['429 Authorization: Bearer sk-live-secret-token-value', 'Rate limit exceeded'],
      ['fetch failed ECONNREFUSED token=secret', 'Network error'],
    ]) {
      const message = generalizedErrorMessage(new Error(raw));
      assert.equal(message, expected);
      assert.doesNotMatch(message, /sk-live-secret-token-value|token=secret/);
    }
  });

  test('does not mistake runtime authority errors for authentication failures', () => {
    assert.equal(
      generalizedErrorMessage(
        new Error('Conversation copy contains durable runtime authority facts'),
        'Conversation copy failed',
      ),
      'Conversation copy failed',
    );
  });

  test('recognizes provider authentication error spellings', () => {
    for (const message of [
      'AuthenticationError',
      'OAuth2 token expired',
      'User is not authorized',
      'Please authenticate',
      'authToken is missing',
    ]) {
      assert.equal(generalizedErrorMessage(new Error(message)), 'Authentication failed');
    }
  });
});

describe('generalizedErrorMessageChinese', () => {
  test('maps provider failures to Chinese categories without leaking secrets', () => {
    for (const [raw, expected] of [
      ['Request timeout after 30s', '请求超时'],
      ['HTTP 429 Too Many Requests', '触发模型速率限制'],
      ['OpenAI rate limit reached for model gpt-4', '触发模型速率限制'],
      ['rate exceeded', '触发模型速率限制'],
      ['401 Unauthorized', '鉴权失败'],
      ['HTTP 403 forbidden', '鉴权失败'],
      ['Authentication failed', '鉴权失败'],
      ['HTTP 500 Internal Server Error', '模型服务返回错误'],
      ['Provider returned 503', '模型服务返回错误'],
      ['Bad gateway 502', '模型服务返回错误'],
      ['fetch failed', '网络错误'],
      ['ECONNREFUSED', '网络错误'],
      ['ENOTFOUND api.example.test', '网络错误'],
      ['network unreachable', '网络错误'],
      ['something weird happened', '操作失败'],
      ['401 Authorization: Bearer sk-live-secret-token-value', '鉴权失败'],
    ]) {
      const message = generalizedErrorMessageChinese(new Error(raw));
      assert.equal(message, expected);
      assert.match(message, /[一-鿿]/);
      assert.doesNotMatch(message, /sk-live-secret-token-value/);
    }
    assert.equal(generalizedErrorMessageChinese('non-Error string input'), '操作失败');
  });

  test('uses a caller-supplied Chinese fallback for unknown errors', () => {
    assert.equal(
      generalizedErrorMessageChinese(
        new Error('something weird happened'),
        '会话已创建但发送失败，请重试。',
      ),
      '会话已创建但发送失败，请重试。',
    );
  });

  test('does not mistake runtime authority errors for authentication failures', () => {
    assert.equal(
      generalizedErrorMessageChinese(
        new Error('Conversation copy contains durable runtime authority facts'),
        '无法基于该上下文创建新会话。',
      ),
      '无法基于该上下文创建新会话。',
    );
  });
});

import { strict as assert } from 'node:assert';
import { afterEach, describe, test } from 'node:test';
import type { AppSettings, SearchResult, SessionEvent, SessionSummary, StoredMessage } from '@maka/core';
import { createDefaultSettings } from '@maka/core/settings';
import { OpenGatewayService } from '../open-gateway.js';
import { SessionLifecycleError } from '../session-lifecycle.js';

const activeServices: OpenGatewayService[] = [];

afterEach(async () => {
  await Promise.all(activeServices.splice(0).map((service) => service.stop()));
});

describe('OpenGatewayService', () => {
  test('stays stopped when disabled or missing token', async () => {
    const service = makeService();
    activeServices.push(service);
    const disabled = createGatewaySettings({ enabled: false, token: 'dev-token' });

    assert.equal((await service.sync(disabled.openGateway)).running, false);

    const missingToken = createGatewaySettings({ enabled: true, token: '' });
    const status = await service.sync(missingToken.openGateway);

    assert.equal(status.running, false);
    assert.equal(status.lastError, 'missing_token');
    assert.equal(status.tokenConfigured, false);
  });

  test('does not expose raw internal errors over the local HTTP API', async () => {
    const service = makeService({
      getSettings: async () => {
        throw new Error('settings read failed at /Users/alice/.maka/settings.json token=sk-live-secret');
      },
    });
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.equal(status.running, true);
    assert.ok(status.baseUrl);

    const response = await fetchJson(`${status.baseUrl}/v1/state`, 'dev-token');
    assert.equal(response.status, 500);
    assert.equal(response.body.error, 'internal_error');
    assert.equal(response.body.message, '开放网关暂时不可用，请稍后重试。');
    assert.match(response.body.requestId, /^gw_/);
    assert.doesNotMatch(JSON.stringify(response.body), /settings read failed|sk-live-secret|\/Users\/alice/);
  });

  test('reports gateway start failures with a closed status reason', async () => {
    const first = makeService();
    const second = makeService();
    activeServices.push(first, second);
    const firstStatus = await first.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.equal(firstStatus.running, true);

    const secondStatus = await second.sync(createGatewaySettings({
      enabled: true,
      host: firstStatus.host,
      port: firstStatus.port,
      token: 'dev-token',
    }).openGateway);

    assert.equal(secondStatus.running, false);
    assert.equal(secondStatus.lastError, 'start_failed');
    assert.doesNotMatch(JSON.stringify(secondStatus), /EADDRINUSE|listen|address already in use/i);
  });

  test('serializes overlapping sync calls so the latest settings state wins', async () => {
    const service = makeService();
    activeServices.push(service);

    const enable = createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway;
    const disable = createGatewaySettings({ enabled: false, port: 0, token: 'dev-token' }).openGateway;
    await Promise.all([
      service.sync(enable),
      service.sync(disable),
    ]);

    const status = service.getStatus();
    assert.equal(status.enabled, false);
    assert.equal(status.running, false);
    assert.equal(status.baseUrl, null);
    assert.equal(status.tokenConfigured, true);
  });

  test('serves health without auth and protects v1 endpoints with bearer token', async () => {
    const service = makeService();
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.equal(status.running, true);
    assert.ok(status.baseUrl);

    const health = await fetchJson(`${status.baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.gateway.running, true);
    assert.match(health.headers.get('x-maka-request-id') ?? '', /^gw_[0-9a-f-]{8}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{12}$/);
    assert.equal(health.headers.get('access-control-expose-headers'), 'X-Maka-Request-Id');

    const unauthorized = await fetchJson(`${status.baseUrl}/v1/capabilities`);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.body.error, 'unauthorized');
    assert.equal(unauthorized.body.requestId, unauthorized.headers.get('x-maka-request-id'));

    const authorized = await fetchJson(`${status.baseUrl}/v1/capabilities`, 'dev-token');
    assert.equal(authorized.status, 200);
    assert.match(authorized.headers.get('x-maka-request-id') ?? '', /^gw_[0-9a-f-]{8}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{12}$/);
    assert.equal(authorized.body.requestId, undefined);
    assert.deepEqual(authorized.body.capabilities, [
      'events.state',
      'gateway.openapi',
      'gateway.state',
      'incidents.list',
      'incidents.state',
      'requests.recent',
      'sessions.detail_state',
      'sessions.list',
      'sessions.state',
      'sessions.messages.read',
      'sessions.messages.page',
      'sessions.messages.state',
      'sessions.messages.send',
      'sessions.events.stream',
      'sessions.events.replay',
      'sessions.events.replay_miss',
      'sessions.events.state',
      'sessions.events.recent',
      'sessions.incidents.read',
      'search.thread',
    ]);
    assert.deepEqual(authorized.body.gateway, {
      requestIdHeader: 'X-Maka-Request-Id',
      state: {
        endpoint: '/v1/state',
        includesPayloads: false,
        includesPreviews: false,
      },
    });
    assert.deepEqual(authorized.body.sessions, {
      state: {
        endpoint: '/v1/sessions/state',
        includesPreviews: false,
        includesRecentIncidentCounts: true,
      },
      detailState: {
        endpoint: '/v1/sessions/{sessionId}/state',
        includesText: false,
        includesPreviews: false,
        includesPayloads: false,
      },
    });
    assert.deepEqual(authorized.body.sessionMessages, {
      pagination: {
        limitQuery: 'limit',
        beforeQuery: 'before',
        maxLimit: 200,
      },
      state: {
        endpoint: '/v1/sessions/{sessionId}/messages/state',
        includesText: false,
      },
    });
    assert.deepEqual(authorized.body.sessionEvents, {
      stream: true,
      cursor: {
        header: 'Last-Event-ID',
        query: 'after',
        maxLength: 256,
      },
      replay: {
        limit: 100,
        missEvent: 'gateway_replay_miss',
        missAdvancesCursor: false,
        partialReplayOnMiss: false,
      },
      state: {
        endpoint: '/v1/sessions/{sessionId}/events/state',
        includesPayloads: false,
      },
      recent: {
        endpoint: '/v1/sessions/{sessionId}/events/recent',
        limit: 50,
        includesPayloads: false,
      },
      globalState: {
        endpoint: '/v1/events/state',
        includesPayloads: false,
      },
    });
    assert.deepEqual(authorized.body.incidents, {
      endpoint: '/v1/incidents',
      stateEndpoint: '/v1/incidents/state',
      perSessionEndpoint: '/v1/sessions/{sessionId}/incidents',
      limit: 50,
      includesPayloads: false,
    });
    assert.deepEqual(authorized.body.requests, {
      recent: {
        endpoint: '/v1/requests/recent',
        limit: 50,
        includesHeaders: false,
        includesQuery: false,
        includesPayloads: false,
      },
    });
  });

  test('serves a token-protected OpenAPI gateway description', async () => {
    const service = makeService();
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);

    const unauthorized = await fetchJson(`${status.baseUrl}/v1/openapi.json`);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.body.error, 'unauthorized');

    const authorized = await fetchJson(`${status.baseUrl}/v1/openapi.json`, 'dev-token');
    assert.equal(authorized.status, 200);
    assert.equal(authorized.body.openapi, '3.1.0');
    assert.equal(authorized.body.info.title, 'Maka Open Gateway');
    assert.deepEqual(authorized.body.security, [{ bearerAuth: [] }]);
    assert.equal(authorized.body.components.securitySchemes.bearerAuth.scheme, 'bearer');
    assert.ok(authorized.body.paths['/v1/state'].get);
    assert.ok(authorized.body.paths['/v1/events/state'].get);
    assert.ok(authorized.body.paths['/v1/requests/recent'].get);
    assert.ok(authorized.body.paths['/v1/sessions/{sessionId}/state'].get);
    assert.ok(authorized.body.paths['/v1/sessions/{sessionId}/events/recent'].get);
    assert.ok(authorized.body.paths['/v1/sessions/{sessionId}/events'].get);
    assert.ok(authorized.body.paths['/v1/sessions/{sessionId}/messages'].post);
    assert.doesNotMatch(JSON.stringify(authorized.body), /dev-token|hello gateway|sk-live/);
  });

  test('exposes recent request metadata without query, headers, or payloads', async () => {
    const service = makeService({
      searchThread: async () => [],
    });
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);

    const search = await fetchJson(`${status.baseUrl}/v1/search/thread?q=secret-query-token`, 'dev-token');
    assert.equal(search.status, 200);
    const missing = await fetchJson(`${status.baseUrl}/v1/missing?apiKey=sk-live-secret`, 'dev-token');
    assert.equal(missing.status, 404);

    const recent = await fetchJson(`${status.baseUrl}/v1/requests/recent`, 'dev-token');
    assert.equal(recent.status, 200);
    assert.equal(recent.body.ok, true);
    assert.equal(recent.body.limit, 50);
    assert.equal(recent.body.includesHeaders, false);
    assert.equal(recent.body.includesQuery, false);
    assert.equal(recent.body.includesPayloads, false);

    const searchRequest = recent.body.requests.find((request: any) => request.path === '/v1/search/thread');
    assert.equal(searchRequest.statusCode, 200);
    assert.equal(searchRequest.method, 'GET');
    assert.equal(typeof searchRequest.requestId, 'string');
    assert.equal(typeof searchRequest.durationMs, 'number');

    const missingRequest = recent.body.requests.find((request: any) => request.path === '/v1/missing');
    assert.equal(missingRequest.statusCode, 404);
    assert.equal(missingRequest.requestId, missing.headers.get('x-maka-request-id'));
    assert.doesNotMatch(JSON.stringify(recent.body), /secret-query-token|sk-live-secret|dev-token|authorization/i);
  });

  test('exposes a token-protected overview state for external dashboards', async () => {
    const sessions = [
      session({ id: 's1', status: 'running', hasUnread: true, lastMessageAt: 20 }),
      session({ id: 's2', status: 'blocked', isArchived: true, lastMessageAt: 10 }),
    ];
    const service = makeService({
      listSessions: async () => sessions,
    });
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);

    service.publishSessionEvent('s2', errorEvent({
      id: 'event-error-overview',
      turnId: 'turn-s2',
      message: 'overview failure with Authorization: Bearer sk-live-secret-token-value',
    }));
    await fetchJson(`${status.baseUrl}/v1/capabilities`, 'dev-token');
    await fetchJson(`${status.baseUrl}/v1/not-found?query=secret-query`, 'dev-token');

    const response = await fetchJson(`${status.baseUrl}/v1/state`, 'dev-token');
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.state.generatedAt, 1_700_000_000_000);
    assert.equal(response.body.state.includesPayloads, false);
    assert.equal(response.body.state.includesPreviews, false);
    assert.equal(response.body.state.gateway.running, true);
    assert.ok(response.body.state.capabilities.includes('gateway.state'));
    assert.equal(response.body.state.sessions.sessionCount, 2);
    assert.equal(response.body.state.sessions.archivedCount, 1);
    assert.equal(response.body.state.sessions.unreadCount, 1);
    assert.equal(response.body.state.sessions.incidentSessionCount, 1);
    assert.equal(response.body.state.incidents.incidentCount, 1);
    assert.equal(response.body.state.incidents.newestIncident.sessionId, 's2');
    assert.equal(response.body.state.requests.requestCount, 2);
    assert.equal(response.body.state.requests.errorCount, 1);
    assert.equal(response.body.state.requests.includesHeaders, false);
    assert.equal(response.body.state.requests.includesQuery, false);
    assert.equal(response.body.state.requests.includesPayloads, false);
    assert.deepEqual(response.body.state.requests.byStatusCode, { 200: 1, 404: 1 });
    assert.equal(response.body.state.requests.newestRequest.path, '/v1/not-found');
    assert.doesNotMatch(JSON.stringify(response.body), /sk-live-secret-token-value/);
    assert.doesNotMatch(JSON.stringify(response.body), /secret-query|dev-token|sk-live-secret/i);
    assert.doesNotMatch(JSON.stringify(response.body), /Alpha|Beta|lastMessagePreview/);

    const unauthorized = await fetchJson(`${status.baseUrl}/v1/state`);
    assert.equal(unauthorized.status, 401);
  });

  test('exposes local sessions, messages, and thread search read APIs', async () => {
    const sessions = [session({ id: 's1', name: 'Alpha' })];
    const messages = [userMessage('hello gateway')];
    let searchedFor = '';
    const service = makeService({
      listSessions: async () => sessions,
      readMessages: async (sessionId) => (sessionId === 's1' ? messages : []),
      searchThread: async (query) => {
        searchedFor = query;
        return [searchResult({ sessionId: 's1', snippet: 'hello gateway' })];
      },
    });
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);

    const sessionResponse = await fetchJson(`${status.baseUrl}/v1/sessions`, 'dev-token');
    assert.equal(sessionResponse.status, 200);
    assert.equal(sessionResponse.body.sessions[0].id, 's1');

    const messageResponse = await fetchJson(`${status.baseUrl}/v1/sessions/s1/messages`, 'dev-token');
    assert.equal(messageResponse.status, 200);
    assert.equal(messageResponse.body.messages[0].text, 'hello gateway');

    const searchResponse = await fetchJson(`${status.baseUrl}/v1/search/thread?q=gateway`, 'dev-token');
    assert.equal(searchResponse.status, 200);
    assert.equal(searchedFor, 'gateway');
    assert.equal(searchResponse.body.result[0].target.sessionId, 's1');
  });

  test('exposes session state without title or preview payloads', async () => {
    const sessions = [
      session({ id: 's1', status: 'running', hasUnread: true, isFlagged: true, lastMessageAt: 20 }),
      session({ id: 's2', status: 'blocked', isArchived: true, lastMessageAt: 10 }),
      session({ id: 's3', status: 'running', lastMessageAt: undefined }),
    ];
    const service = makeService({
      listSessions: async () => sessions,
    });
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);
    service.publishSessionEvent('s1', errorEvent({ id: 'event-error-s1', turnId: 'turn-s1', message: 'failed' }));
    service.publishSessionEvent('s1', abortEvent({ id: 'event-abort-s1', turnId: 'turn-s1', reason: 'user_stop' }));

    const response = await fetchJson(`${status.baseUrl}/v1/sessions/state`, 'dev-token');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.state, {
      sessionCount: 3,
      archivedCount: 1,
      unreadCount: 1,
      flaggedCount: 1,
      recentIncidentCount: 2,
      incidentSessionCount: 1,
      includesPreviews: false,
      byStatus: {
        running: 2,
        blocked: 1,
      },
      newestSession: {
        id: 's1',
        status: 'running',
        lastMessageAt: 20,
        recentIncidentCount: 2,
        lastIncidentAt: 1_700_000_000_001,
      },
      oldestSession: {
        id: 's3',
        status: 'running',
      },
    });
    assert.equal(JSON.stringify(response.body).includes('Alpha'), false);
    assert.equal(JSON.stringify(response.body).includes('lastMessagePreview'), false);
  });

  test('exposes single-session state without title, text, or event payloads', async () => {
    const sessions = [
      session({ id: 's1', name: 'Alpha Secret', status: 'blocked', hasUnread: true, isFlagged: true, lastMessageAt: 20 }),
    ];
    const messages = [
      userMessage('secret message token=abc', 'm1'),
      userMessage('another secret message token=def', 'm2'),
    ];
    const service = makeService({
      listSessions: async () => sessions,
      readMessages: async (sessionId) => (sessionId === 's1' ? messages : []),
    });
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);
    service.publishSessionEvent('s1', textDeltaEvent({
      id: 'event-1',
      turnId: 'turn-1',
      text: 'stream payload must not leak',
    }));
    service.publishSessionEvent('s1', errorEvent({
      id: 'event-error-s1',
      turnId: 'turn-1',
      message: 'Provider failed with Authorization: Bearer sk-live-secret-token-value',
    }));

    const response = await fetchJson(`${status.baseUrl}/v1/sessions/s1/state`, 'dev-token');
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.deepEqual(response.body.state.session, {
      id: 's1',
      status: 'blocked',
      lastMessageAt: 20,
      recentIncidentCount: 1,
      lastIncidentAt: 1_700_000_000_000,
      isArchived: false,
      hasUnread: true,
      isFlagged: true,
    });
    assert.equal(response.body.state.includesText, false);
    assert.equal(response.body.state.includesPreviews, false);
    assert.equal(response.body.state.includesPayloads, false);
    assert.equal(response.body.state.messages.messageCount, 2);
    assert.equal(response.body.state.events.bufferedEvents, 2);
    assert.equal(response.body.state.events.includesPayloads, false);
    assert.equal(response.body.state.incidents.recentIncidentCount, 1);
    assert.doesNotMatch(JSON.stringify(response.body), /Alpha Secret|secret message|stream payload|sk-live-secret-token-value/);

    const missing = await fetchJson(`${status.baseUrl}/v1/sessions/missing/state`, 'dev-token');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'session_not_found');
  });

  test('paginates session messages with a before cursor without changing default reads', async () => {
    const messages = [
      userMessage('one', 'm1'),
      userMessage('two', 'm2'),
      userMessage('three', 'm3'),
      userMessage('four', 'm4'),
    ];
    const service = makeService({
      readMessages: async () => messages,
    });
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);

    const defaultResponse = await fetchJson(`${status.baseUrl}/v1/sessions/s1/messages`, 'dev-token');
    assert.equal(defaultResponse.status, 200);
    assert.deepEqual(defaultResponse.body.messages.map((message: StoredMessage) => message.id), ['m1', 'm2', 'm3', 'm4']);
    assert.equal(defaultResponse.body.pagination, undefined);

    const pageResponse = await fetchJson(`${status.baseUrl}/v1/sessions/s1/messages?limit=2&before=m4`, 'dev-token');
    assert.equal(pageResponse.status, 200);
    assert.deepEqual(pageResponse.body.messages.map((message: StoredMessage) => message.id), ['m2', 'm3']);
    assert.deepEqual(pageResponse.body.pagination, {
      limit: 2,
      before: 'm4',
      nextBefore: 'm2',
      hasMoreBefore: true,
    });

    const invalidResponse = await fetchJson(`${status.baseUrl}/v1/sessions/s1/messages?limit=2&before=missing`, 'dev-token');
    assert.equal(invalidResponse.status, 400);
    assert.equal(invalidResponse.body.error, 'invalid_before_cursor');
  });

  test('exposes message state without message text payloads', async () => {
    const messages = [
      userMessage('secret one token=abc', 'm1'),
      userMessage('secret two token=def', 'm2'),
    ];
    const service = makeService({
      readMessages: async () => messages,
    });
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);

    const response = await fetchJson(`${status.baseUrl}/v1/sessions/s1/messages/state`, 'dev-token');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.state, {
      messageCount: 2,
      includesText: false,
      oldestMessage: {
        id: 'm1',
        type: 'user',
        turnId: 't1',
        ts: 1_700_000_000_000,
      },
      newestMessage: {
        id: 'm2',
        type: 'user',
        turnId: 't1',
        ts: 1_700_000_000_000,
      },
    });
    assert.equal(JSON.stringify(response.body).includes('secret'), false);
    assert.equal(JSON.stringify(response.body).includes('token='), false);
  });

  test('accepts token-protected session sends and returns the turn id', async () => {
    let sent: { sessionId: string; text: string } | null = null;
    const service = makeService({
      sendMessage: async (sessionId, input) => {
        sent = { sessionId, text: input.text };
        return { turnId: 'turn-gateway' };
      },
    });
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);

    const unauthorized = await fetchJson(`${status.baseUrl}/v1/sessions/s1/messages`, {
      method: 'POST',
      body: { text: 'hello from gateway' },
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(sent, null);

    const response = await fetchJson(`${status.baseUrl}/v1/sessions/s1/messages`, {
      token: 'dev-token',
      method: 'POST',
      body: { text: 'hello from gateway' },
    });

    assert.equal(response.status, 202);
    assert.equal(response.body.turnId, 'turn-gateway');
    assert.deepEqual(sent, { sessionId: 's1', text: 'hello from gateway' });
  });

  test('streams token-protected live session events as SSE', async () => {
    const statusChanges: number[] = [];
    const service = makeService({
      onStatusChanged: (status) => {
        statusChanges.push(status.activeEventStreams);
      },
    });
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);
    assert.equal(status.activeEventStreams, 0);

    const unauthorized = await fetch(`${status.baseUrl}/v1/sessions/s1/events`);
    assert.equal(unauthorized.status, 401);
    assert.equal((await unauthorized.json()).error, 'unauthorized');

    const controller = new AbortController();
    const response = await fetch(`${status.baseUrl}/v1/sessions/s1/events`, {
      headers: { Authorization: 'Bearer dev-token' },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
    assert.equal(service.getStatus().activeEventStreams, 1);
    assert.ok(statusChanges.includes(1), 'opening an SSE stream should publish activeEventStreams=1');

    const health = await fetchJson(`${status.baseUrl}/health`);
    assert.equal(health.body.gateway.activeEventStreams, 1);

    const reader = response.body!.getReader();
    service.publishSessionEvent('s1', textDeltaEvent({ id: 'event-1', turnId: 'turn-1', text: 'hello gateway stream' }));
    const chunk = await readUntil(reader, 'event: text_delta');
    controller.abort();
    await waitFor(() => service.getStatus().activeEventStreams === 0);

    assert.match(chunk, /id: event-1/);
    assert.match(chunk, /event: text_delta/);
    assert.match(chunk, /data: \{"type":"text_delta"/);
    assert.match(chunk, /hello gateway stream/);
    assert.ok(statusChanges.includes(0), 'closing an SSE stream should publish activeEventStreams=0');
  });

  test('delivers one child-session event sequence to two observing clients', async () => {
    const service = makeService();
    activeServices.push(service);
    const status = await service.sync(
      createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway,
    );
    assert.ok(status.baseUrl);

    const first = await openEventStream(status.baseUrl, 'child-session');
    const second = await openEventStream(status.baseUrl, 'child-session');
    const firstReader = first.response.body!.getReader();
    const secondReader = second.response.body!.getReader();
    service.publishSessionEvent(
      'child-session',
      textDeltaEvent({ id: 'child-event-1', turnId: 'child-turn', text: 'first' }),
    );
    service.publishSessionEvent(
      'child-session',
      textDeltaEvent({ id: 'child-event-2', turnId: 'child-turn', text: 'second' }),
    );

    const [firstStream, secondStream] = await Promise.all([
      readUntil(firstReader, 'id: child-event-2'),
      readUntil(secondReader, 'id: child-event-2'),
    ]);
    for (const stream of [firstStream, secondStream]) {
      assert.ok(stream.indexOf('id: child-event-1') < stream.indexOf('id: child-event-2'));
    }

    first.controller.abort();
    second.controller.abort();
    await waitFor(() => service.getStatus().activeEventStreams === 0);
  });

  test('rejects excess SSE streams before establishing event-stream headers', async () => {
    const service = makeService();
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);

    // Keep each unread response body reachable until cleanup. Undici closes an SSE
    // connection when its response is garbage-collected, which would make the stream
    // count depend on GC timing instead of the gateway limit under test.
    const streams: Array<{ controller: AbortController; response: Response }> = [];
    try {
      for (let index = 0; index < 3; index += 1) {
        const opened = await openEventStream(status.baseUrl, 'same-session');
        streams.push(opened);
        assert.equal(opened.response.status, 200);
      }
      assert.equal(service.getStatus().activeEventStreams, 3);

      const perSessionRejected = await fetchJson(`${status.baseUrl}/v1/sessions/same-session/events`, 'dev-token');
      assert.equal(perSessionRejected.status, 429);
      assert.equal(perSessionRejected.body.error, 'too_many_event_streams');
      assert.doesNotMatch(perSessionRejected.headers.get('content-type') ?? '', /^text\/event-stream/);
      assert.equal(service.getStatus().activeEventStreams, 3);

      for (let index = 0; index < 7; index += 1) {
        const opened = await openEventStream(status.baseUrl, `other-${index}`);
        streams.push(opened);
        assert.equal(opened.response.status, 200);
      }
      assert.equal(service.getStatus().activeEventStreams, 10);

      const globalRejected = await fetchJson(`${status.baseUrl}/v1/sessions/global-overflow/events`, 'dev-token');
      assert.equal(globalRejected.status, 429);
      assert.equal(globalRejected.body.error, 'too_many_event_streams');
      assert.doesNotMatch(globalRejected.headers.get('content-type') ?? '', /^text\/event-stream/);
      assert.equal(service.getStatus().activeEventStreams, 10);
    } finally {
      for (const stream of streams) stream.controller.abort();
      await waitFor(() => service.getStatus().activeEventStreams === 0);
    }
  });

  test('stop closes active SSE clients and clears stream counts', async () => {
    const service = makeService();
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);

    const first = await openEventStream(status.baseUrl, 's1');
    const second = await openEventStream(status.baseUrl, 's2');
    assert.equal(service.getStatus().activeEventStreams, 2);

    await service.stop();
    await Promise.all([
      readUntilClosed(first.response.body!.getReader()),
      readUntilClosed(second.response.body!.getReader()),
    ]);

    assert.equal(service.getStatus().activeEventStreams, 0);
  });

  test('replays recent SSE events after Last-Event-ID cursor', async () => {
    const service = makeService();
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);

    service.publishSessionEvent('s1', textDeltaEvent({ id: 'event-1', turnId: 'turn-1', text: 'already seen' }));
    service.publishSessionEvent('s1', textDeltaEvent({ id: 'event-2', turnId: 'turn-1', text: 'replay me' }));

    const controller = new AbortController();
    const response = await fetch(`${status.baseUrl}/v1/sessions/s1/events`, {
      headers: {
        Authorization: 'Bearer dev-token',
        'Last-Event-ID': 'event-1',
      },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);

    const reader = response.body!.getReader();
    const chunk = await readUntil(reader, 'replay me');
    controller.abort();

    assert.doesNotMatch(chunk, /already seen/);
    assert.match(chunk, /id: event-2/);
    assert.match(chunk, /event: text_delta/);
    assert.match(chunk, /replay me/);
  });

  test('surfaces replay cursor misses as structured SSE events', async () => {
    const service = makeService();
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);

    service.publishSessionEvent('s1', textDeltaEvent({ id: 'event-2', turnId: 'turn-1', text: 'newer event' }));

    const controller = new AbortController();
    const response = await fetch(`${status.baseUrl}/v1/sessions/s1/events`, {
      headers: {
        Authorization: 'Bearer dev-token',
        'Last-Event-ID': 'event-missing',
      },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);

    const reader = response.body!.getReader();
    const chunk = await readUntil(reader, 'gateway_replay_miss');
    controller.abort();

    assert.match(chunk, /event: gateway_replay_miss/);
    assert.match(chunk, /"type":"gateway_replay_miss"/);
    assert.match(chunk, /"reason":"cursor_not_found"/);
    assert.match(chunk, /"requestedEventId":"event-missing"/);
    assert.match(chunk, /"replayLimit":100/);
    assert.doesNotMatch(chunk, /id:/, 'replay-miss diagnostics must not advance Last-Event-ID');
    assert.doesNotMatch(chunk, /newer event/, 'cursor miss requires client resync instead of partial replay');
  });

  test('exposes replay state summaries without event payloads', async () => {
    const service = makeService();
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);

    service.publishSessionEvent('s1', textDeltaEvent({
      id: 'event-1',
      turnId: 'turn-1',
      text: 'first payload must not leak',
    }));
    service.publishSessionEvent('s1', textDeltaEvent({
      id: 'Authorization: Bearer sk-live-secret-token-value',
      turnId: 'turn-2',
      text: 'second payload must not leak either',
    }));

    const response = await fetchJson(`${status.baseUrl}/v1/sessions/s1/events/state`, 'dev-token');
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.deepEqual(response.body.state, {
      replayLimit: 100,
      bufferedEvents: 2,
      activeStreams: 0,
      hasReplayBuffer: true,
      includesPayloads: false,
      oldestEvent: {
        id: 'event-1',
        type: 'text_delta',
        turnId: 'turn-1',
        ts: 1_700_000_000_000,
      },
      newestEvent: {
        id: 'Authorization: Bearer [redacted]',
        type: 'text_delta',
        turnId: 'turn-2',
        ts: 1_700_000_000_000,
      },
    });
    assert.doesNotMatch(JSON.stringify(response.body), /payload must not leak/);
    assert.doesNotMatch(JSON.stringify(response.body), /sk-live-secret-token-value/);
  });

  test('exposes bounded recent event summaries without event payloads', async () => {
    const service = makeService();
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);

    service.publishSessionEvent('s1', textDeltaEvent({
      id: 'event-1',
      turnId: 'turn-1',
      text: 'recent payload must not leak',
    }));
    service.publishSessionEvent('s1', errorEvent({
      id: 'Authorization: Bearer sk-live-secret-token-value',
      turnId: 'turn-2',
      message: 'recent failure payload must not leak',
      reason: 'provider_error',
    }));

    const response = await fetchJson(`${status.baseUrl}/v1/sessions/s1/events/recent`, 'dev-token');
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.includesPayloads, false);
    assert.equal(response.body.limit, 50);
    assert.deepEqual(response.body.events, [
      {
        id: 'event-1',
        type: 'text_delta',
        turnId: 'turn-1',
        ts: 1_700_000_000_000,
      },
      {
        id: 'Authorization: Bearer [redacted]',
        type: 'error',
        turnId: 'turn-2',
        ts: 1_700_000_000_000,
      },
    ]);
    assert.doesNotMatch(JSON.stringify(response.body), /payload must not leak/);
    assert.doesNotMatch(JSON.stringify(response.body), /sk-live-secret-token-value/);

    const unauthorized = await fetchJson(`${status.baseUrl}/v1/sessions/s1/events/recent`);
    assert.equal(unauthorized.status, 401);
  });

  test('exposes global event state across sessions without event payloads', async () => {
    const service = makeService();
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);

    service.publishSessionEvent('s1', textDeltaEvent({
      id: 'event-s1',
      turnId: 'turn-1',
      text: 'global payload must not leak',
    }));
    service.publishSessionEvent('s2', errorEvent({
      id: 'Authorization: Bearer sk-live-secret-token-value',
      turnId: 'turn-2',
      message: 'global failure payload must not leak',
      reason: 'provider_error',
    }));

    const response = await fetchJson(`${status.baseUrl}/v1/events/state`, 'dev-token');
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.deepEqual(response.body.state, {
      replayLimitPerSession: 100,
      bufferedEvents: 2,
      bufferedSessionCount: 2,
      activeStreams: 0,
      includesPayloads: false,
      oldestEvent: {
        sessionId: 's1',
        id: 'event-s1',
        type: 'text_delta',
        turnId: 'turn-1',
        ts: 1_700_000_000_000,
      },
      newestEvent: {
        sessionId: 's2',
        id: 'Authorization: Bearer [redacted]',
        type: 'error',
        turnId: 'turn-2',
        ts: 1_700_000_000_000,
      },
    });
    assert.doesNotMatch(JSON.stringify(response.body), /payload must not leak/);
    assert.doesNotMatch(JSON.stringify(response.body), /sk-live-secret-token-value/);
  });

  test('exposes bounded redacted recent run incidents without event payload replay', async () => {
    const service = makeService();
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);

    service.publishSessionEvent('s1', textDeltaEvent({ id: 'event-ok', turnId: 'turn-1', text: 'normal stream' }));
    service.publishSessionEvent('s1', errorEvent({
      id: 'event-error',
      turnId: 'turn-1',
      message: 'Provider failed with Authorization: Bearer sk-live-secret-token-value',
      reason: 'provider_error',
      code: 'upstream_500',
    }));
    service.publishSessionEvent('s1', abortEvent({ id: 'event-abort', turnId: 'turn-2', reason: 'timeout' }));

    const response = await fetchJson(`${status.baseUrl}/v1/sessions/s1/incidents`, 'dev-token');
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.incidents.length, 2);
    assert.deepEqual(response.body.incidents.map((item: any) => item.type), ['error', 'abort']);
    assert.equal(response.body.incidents[0].id, 'incident:event-error');
    assert.equal(response.body.incidents[0].eventId, 'event-error');
    assert.equal(response.body.incidents[0].turnId, 'turn-1');
    assert.match(response.body.incidents[0].message, /\[redacted\]/);
    assert.doesNotMatch(JSON.stringify(response.body.incidents), /sk-live-secret-token-value/);
    assert.equal(response.body.incidents[1].reason, 'timeout');

    const unauthorized = await fetchJson(`${status.baseUrl}/v1/sessions/s1/incidents`);
    assert.equal(unauthorized.status, 401);
  });

  test('exposes an aggregate recent incident index across sessions', async () => {
    const service = makeService();
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);

    service.publishSessionEvent('s1', errorEvent({
      id: 'event-error-s1',
      turnId: 'turn-s1',
      message: 's1 failed with api_key=sk-live-secret-token-value',
    }));
    service.publishSessionEvent('s2', abortEvent({ id: 'event-abort-s2', turnId: 'turn-s2', reason: 'user_stop' }));

    const response = await fetchJson(`${status.baseUrl}/v1/incidents`, 'dev-token');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.incidents.map((item: any) => item.sessionId), ['s1', 's2']);
    assert.deepEqual(response.body.incidents.map((item: any) => item.eventId), ['event-error-s1', 'event-abort-s2']);
    assert.match(response.body.incidents[0].message, /\[redacted\]/);
    assert.doesNotMatch(JSON.stringify(response.body), /sk-live-secret-token-value/);

    const stateResponse = await fetchJson(`${status.baseUrl}/v1/incidents/state`, 'dev-token');
    assert.equal(stateResponse.status, 200);
    assert.equal(stateResponse.body.state.incidentCount, 2);
    assert.equal(stateResponse.body.state.incidentSessionCount, 2);
    assert.equal(stateResponse.body.state.limit, 50);
    assert.equal(stateResponse.body.state.includesPayloads, false);
    assert.equal(stateResponse.body.state.oldestIncident.sessionId, 's1');
    assert.equal(stateResponse.body.state.newestIncident.sessionId, 's2');
    assert.doesNotMatch(JSON.stringify(stateResponse.body), /sk-live-secret-token-value/);

    const unauthorized = await fetchJson(`${status.baseUrl}/v1/incidents`);
    assert.equal(unauthorized.status, 401);
    const unauthorizedState = await fetchJson(`${status.baseUrl}/v1/incidents/state`);
    assert.equal(unauthorizedState.status, 401);
  });

  test('caps gateway incidents to the most recent entries', async () => {
    const service = makeService();
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);

    for (let index = 0; index < 25; index += 1) {
      service.publishSessionEvent('s1', errorEvent({
        id: `event-error-${index}`,
        turnId: `turn-${index}`,
        message: `failure ${index}`,
      }));
    }

    const response = await fetchJson(`${status.baseUrl}/v1/sessions/s1/incidents`, 'dev-token');
    assert.equal(response.status, 200);
    assert.equal(response.body.incidents.length, 20);
    assert.equal(response.body.incidents[0].eventId, 'event-error-5');
    assert.equal(response.body.incidents[19].eventId, 'event-error-24');
  });

  test('closes existing SSE clients when the gateway token rotates', async () => {
    let settings = createGatewaySettings({ enabled: true, port: 0, token: 'old-token' });
    const service = makeService({
      getSettings: async () => settings,
    });
    activeServices.push(service);
    const status = await service.sync(settings.openGateway);
    assert.ok(status.baseUrl);

    const response = await fetch(`${status.baseUrl}/v1/sessions/s1/events`, {
      headers: { Authorization: 'Bearer old-token' },
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();

    settings = createGatewaySettings({
      enabled: true,
      host: status.host,
      port: status.port,
      token: 'new-token',
    });
    await service.sync(settings.openGateway);

    const closed = await readUntilClosed(reader);
    assert.match(closed, /session s1 connected/);

    const oldToken = await fetchJson(`${status.baseUrl}/v1/capabilities`, 'old-token');
    assert.equal(oldToken.status, 401);
    const newToken = await fetchJson(`${status.baseUrl}/v1/capabilities`, 'new-token');
    assert.equal(newToken.status, 200);
  });

  test('rejects invalid gateway send bodies before calling runtime send', async () => {
    let calls = 0;
    const service = makeService({
      sendMessage: async () => {
        calls += 1;
        return { turnId: 'turn-never' };
      },
    });
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);

    const empty = await fetchJson(`${status.baseUrl}/v1/sessions/s1/messages`, {
      token: 'dev-token',
      method: 'POST',
      body: { text: '   ' },
    });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, 'empty_text');

    const oversize = await fetchJson(`${status.baseUrl}/v1/sessions/s1/messages`, {
      token: 'dev-token',
      method: 'POST',
      body: { text: 'x'.repeat(8_001) },
    });
    assert.equal(oversize.status, 400);
    assert.equal(oversize.body.error, 'text_too_large');
    assert.equal(calls, 0);
  });

  test('maps archived and removed send bindings to stable lifecycle responses', async () => {
    const service = makeService({
      sendMessage: async (sessionId) => {
        throw new SessionLifecycleError(sessionId === 'archived' ? 'archived' : 'removed');
      },
    });
    activeServices.push(service);
    const status = await service.sync(createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' }).openGateway);
    assert.ok(status.baseUrl);

    const archived = await fetchJson(`${status.baseUrl}/v1/sessions/archived/messages`, {
      token: 'dev-token',
      method: 'POST',
      body: { text: 'hello' },
    });
    assert.equal(archived.status, 409);
    assert.equal(archived.body.ok, false);
    assert.equal(archived.body.error, 'session_archived');

    const removed = await fetchJson(`${status.baseUrl}/v1/sessions/removed/messages`, {
      token: 'dev-token',
      method: 'POST',
      body: { text: 'hello' },
    });
    assert.equal(removed.status, 404);
    assert.equal(removed.body.ok, false);
    assert.equal(removed.body.error, 'session_not_found');
  });
});

function makeService(overrides: Partial<ConstructorParameters<typeof OpenGatewayService>[0]> = {}): OpenGatewayService {
  let settings = createGatewaySettings({ enabled: true, port: 0, token: 'dev-token' });
  return new OpenGatewayService({
    getSettings: async () => settings,
    listSessions: async () => [],
    readMessages: async () => [],
    sendMessage: async () => ({ turnId: 'turn-1' }),
    searchThread: async () => [],
    now: () => 1_700_000_000_000,
    ...overrides,
    ...(overrides.getSettings
      ? {}
      : {
          getSettings: async () => settings,
        }),
  });
}

function createGatewaySettings(patch: Partial<AppSettings['openGateway']>): AppSettings {
  const settings = createDefaultSettings();
  settings.openGateway = {
    ...settings.openGateway,
    ...patch,
  };
  return settings;
}

async function fetchJson(
  url: string,
  input?: string | { token?: string; method?: string; body?: unknown },
): Promise<{ status: number; headers: Headers; body: any }> {
  const token = typeof input === 'string' ? input : input?.token;
  const response = await fetch(url, {
    method: typeof input === 'string' ? undefined : input?.method,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: typeof input === 'string' || input?.body === undefined ? undefined : JSON.stringify(input.body),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json(),
  };
}

async function openEventStream(
  baseUrl: string,
  sessionId: string,
): Promise<{ controller: AbortController; response: Response }> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/v1/sessions/${sessionId}/events`, {
    headers: { Authorization: 'Bearer dev-token' },
    signal: controller.signal,
  });
  return { controller, response };
}

function session(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    name: overrides.id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'anthropic',
    connectionLocked: false,
    model: 'claude-sonnet-4-5-20250929',
    permissionMode: 'ask',
    lastMessageAt: 1_700_000_000_000,
    ...overrides,
  };
}

function userMessage(text: string, id = 'm1'): StoredMessage {
  return { type: 'user', id, turnId: 't1', ts: 1_700_000_000_000, text };
}

function textDeltaEvent(input: { id: string; turnId: string; text: string }): SessionEvent {
  return {
    type: 'text_delta',
    id: input.id,
    turnId: input.turnId,
    messageId: 'assistant-1',
    ts: 1_700_000_000_000,
    text: input.text,
  };
}

function errorEvent(input: {
  id: string;
  turnId: string;
  message: string;
  recoverable?: boolean;
  code?: string;
  reason?: string;
}): SessionEvent {
  return {
    type: 'error',
    id: input.id,
    turnId: input.turnId,
    ts: 1_700_000_000_000,
    recoverable: input.recoverable ?? false,
    message: input.message,
    ...(input.code ? { code: input.code } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

function abortEvent(input: {
  id: string;
  turnId: string;
  reason: 'user_stop' | 'redirect' | 'timeout' | 'crash';
}): SessionEvent {
  return {
    type: 'abort',
    id: input.id,
    turnId: input.turnId,
    ts: 1_700_000_000_001,
    reason: input.reason,
  };
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + 2_000;
  while (!text.includes(needle)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${needle}. Received: ${text}`);
    const read = await reader.read();
    if (read.done) break;
    text += decoder.decode(read.value, { stream: true });
  }
  return text;
}

async function readUntilClosed(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + 2_000;
  while (true) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for SSE close. Received: ${text}`);
    const read = await reader.read();
    if (read.done) return text;
    text += decoder.decode(read.value, { stream: true });
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for predicate');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function searchResult(overrides: { sessionId: string; snippet?: string }): SearchResult {
  return {
    source: 'thread',
    title: 'Alpha',
    snippet: overrides.snippet ?? 'gateway',
    target: { kind: 'thread', sessionId: overrides.sessionId, turnId: 't1' },
  };
}

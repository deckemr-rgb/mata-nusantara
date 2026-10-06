import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchWithReconnect,
  fetchCctvCatalog,
} from '../../server/providers/cctv/connect.js';
import {
  CCTV_SOURCE_ATTEMPT_TIMEOUT_MS,
  CCTV_SOURCE_FETCH_ATTEMPTS,
  CCTV_SOURCE_FETCH_TIMEOUT_MS,
} from '../../server/providers/cctv/constants.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fetch stub failing the first `failures` calls the way a dead connection does. */
function flaky(failures) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push(init);
    if (calls.length <= failures) {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('Connect Timeout Error'), {
          code: 'UND_ERR_CONNECT_TIMEOUT',
        }),
      });
    }
    return { ok: true, status: 200 };
  };
  return { impl, calls };
}

/* --------------------------------------------------------------------------
 * The catalog deadline covers the body, the media deadline does not
 *
 * This is the difference that matters between the two callers, and getting it
 * backwards is silent: a catalog whose deadline stopped at the headers would
 * hang getCctvSources on a stalled portal -- the exact failure the timeout was
 * introduced to prevent -- while a live video whose deadline kept running
 * would be cut off mid-stream.
 * ----------------------------------------------------------------------- */

test('a catalog deadline stays armed while the body is still arriving', async () => {
  let observed = null;
  await fetchCctvCatalog(
    'https://example.com/cameras.json',
    {},
    {
      timeoutMs: 40,
      attemptTimeoutMs: 40,
      attempts: 1,
      fetchImpl: async (url, { signal }) => {
        observed = signal;
        return { ok: true, status: 200 };
      },
    },
  );
  assert.equal(observed.aborted, false, 'not aborted while still inside the budget');
  await sleep(90);
  assert.equal(
    observed.aborted,
    true,
    'a body that never finishes is cut off by the deadline, not left pending',
  );
});

test('a released deadline lets a live body outlive the budget', async () => {
  let observed = null;
  await fetchWithReconnect(
    'https://example.com/stream.m3u8',
    {},
    {
      timeoutMs: 40,
      attemptTimeoutMs: 40,
      attempts: 1,
      releaseOnHeaders: true,
      fetchImpl: async (url, { signal }) => {
        observed = signal;
        return { ok: true, status: 200 };
      },
    },
  );
  await sleep(90);
  assert.equal(observed.aborted, false, 'the stream keeps flowing past the opening budget');
});

/* --------------------------------------------------------------------------
 * Reconnecting
 * ----------------------------------------------------------------------- */

test('a catalog reopens a connection that never answered', async () => {
  const { impl, calls } = flaky(1);
  const resp = await fetchCctvCatalog(
    'https://example.com/cameras.json',
    { headers: { Accept: 'application/json' } },
    { fetchImpl: impl, attemptTimeoutMs: 30, timeoutMs: 500 },
  );
  assert.equal(resp.ok, true);
  assert.equal(calls.length, 2, 'the dead connection was reopened');
  assert.deepEqual(calls[1].headers, { Accept: 'application/json' },
    'the second attempt carries the same request as the first');
});

test('reconnecting never lengthens the worst case the caller was promised', async () => {
  // The whole design rests on this: retrying spends the existing budget
  // better, it does not ask for a bigger one. If this slips, every catalog
  // refresh can take twice as long as CCTV_SOURCE_FETCH_TIMEOUT_MS says.
  const startedAt = Date.now();
  await assert.rejects(
    fetchCctvCatalog(
      'https://example.com/cameras.json',
      {},
      {
        timeoutMs: 200,
        attemptTimeoutMs: 60,
        fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
      },
    ),
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 700, `stayed within the 200ms total budget, took ${elapsed}ms`);
});

/* --------------------------------------------------------------------------
 * What is refused a second attempt
 * ----------------------------------------------------------------------- */

test('a POST is not replayed unless its caller says it is a query', async () => {
  const { impl, calls } = flaky(Infinity);
  await assert.rejects(
    fetchCctvCatalog(
      'https://example.com/ajax',
      { method: 'POST', body: 'id=7' },
      { fetchImpl: impl, attemptTimeoutMs: 20, timeoutMs: 400 },
    ),
  );
  assert.equal(calls.length, 1, 'a repeated POST could be a second act, so it is not repeated');
});

test('a POST declared replayable is reopened like any query', async () => {
  // How the Bandung ajax endpoints opt in: they are listings, and POST is
  // only the shape that portal's API takes.
  const { impl, calls } = flaky(1);
  const resp = await fetchCctvCatalog(
    'https://example.com/ajax',
    { method: 'POST', body: 'id=7' },
    { fetchImpl: impl, attemptTimeoutMs: 20, timeoutMs: 400, replayable: true },
  );
  assert.equal(resp.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body, 'id=7', 'the replay sends the same body, not an empty one');
});

test('a body that cannot be sent twice is never sent twice, even if declared replayable', async () => {
  // A stream is consumed by the first attempt. Replaying it would send an
  // empty body and the server would answer a different question.
  const { impl, calls } = flaky(Infinity);
  const body = new ReadableStream({ start: (c) => c.close() });
  await assert.rejects(
    fetchCctvCatalog(
      'https://example.com/ajax',
      { method: 'POST', body },
      { fetchImpl: impl, attemptTimeoutMs: 20, timeoutMs: 400, replayable: true },
    ),
  );
  assert.equal(calls.length, 1, 'a consumed body disqualifies the replay');
});

test('a caller who walked away is not reconnected for', async () => {
  const caller = new AbortController();
  caller.abort();
  const { impl, calls } = flaky(Infinity);
  await assert.rejects(
    fetchCctvCatalog(
      'https://example.com/cameras.json',
      {},
      { fetchImpl: impl, attemptTimeoutMs: 20, timeoutMs: 400, signal: caller.signal },
    ),
  );
  assert.equal(calls.length, 1);
});

test('an HTTP error is an answer, not a dead connection', async () => {
  // 503 is the server speaking. Reopening would just ask again and lean on a
  // portal that has already said it is busy.
  let calls = 0;
  const resp = await fetchCctvCatalog(
    'https://example.com/cameras.json',
    {},
    {
      attemptTimeoutMs: 20,
      timeoutMs: 400,
      fetchImpl: async () => {
        calls += 1;
        return { ok: false, status: 503 };
      },
    },
  );
  assert.equal(resp.status, 503, 'the caller decides what to do with it');
  assert.equal(calls, 1, 'no reconnection for a server that answered');
});

/* --------------------------------------------------------------------------
 * Misuse is refused rather than silently ignored
 * ----------------------------------------------------------------------- */

test('a signal passed inside init is refused, because each attempt needs its own', async () => {
  // Silently dropping it would leave the caller believing it could cancel.
  await assert.rejects(
    fetchWithReconnect(
      'https://example.com/x',
      { signal: new AbortController().signal },
      { timeoutMs: 100, attemptTimeoutMs: 50 },
    ),
    (error) => error instanceof TypeError && /owns the request signal/.test(error.message),
  );
});

test('the shipped catalog budgets fit the deadline the loaders promise', async () => {
  const impatient = (CCTV_SOURCE_FETCH_ATTEMPTS - 1) * CCTV_SOURCE_ATTEMPT_TIMEOUT_MS;
  const patient = CCTV_SOURCE_FETCH_TIMEOUT_MS - impatient;
  assert.ok(
    patient >= CCTV_SOURCE_ATTEMPT_TIMEOUT_MS,
    `the final attempt is left ${patient}ms, which must not be under the ${CCTV_SOURCE_ATTEMPT_TIMEOUT_MS}ms the others get`,
  );
  assert.ok(CCTV_SOURCE_ATTEMPT_TIMEOUT_MS > 3200, 'must clear the 3s SYN retransmission rung');
  assert.ok(CCTV_SOURCE_ATTEMPT_TIMEOUT_MS < 7000, 'must not sit through the 7s rung');
  assert.equal(CCTV_SOURCE_FETCH_ATTEMPTS, 2,
    'one reconnection; more would lean on a municipal server that is already busy');
});

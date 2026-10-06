import {
  CCTV_SOURCE_ATTEMPT_TIMEOUT_MS,
  CCTV_SOURCE_FETCH_ATTEMPTS,
  CCTV_SOURCE_FETCH_TIMEOUT_MS,
} from './constants.js';

/**
 * Reopening a connection that never answered.
 *
 * WHY THIS EXISTS
 * ---------------
 * Several of the camera portals drop inbound SYN packets when they are busy.
 * A dropped SYN is reported to nobody: the kernel simply retransmits on a
 * fixed ladder, so the connection completes after 1s, then 3s, then 7s, then
 * 15s. Measured against cctvjss.jogjakota.go.id, connect latency was 24-90ms
 * in the median case and landed on exactly those rungs otherwise -- the same
 * host, seconds apart, with no failure in between.
 *
 * That shape is what makes one long wait the wrong answer. Sitting on a
 * connection that already missed the first rung buys a 3s, 7s or 15s reply,
 * while a fresh connection opened in its place usually lands in well under a
 * tenth of a second. So an early attempt is given a short budget and then
 * abandoned in favour of a new one.
 *
 * WHAT IS AND IS NOT RETRIED
 * --------------------------
 * Only a failure that produced no response headers. An HTTP error is a real
 * answer from the server and belongs to the caller; a caller who walked away
 * has nobody left to answer; and a request that cannot be replayed byte for
 * byte is never sent twice.
 */

/** Methods that may be repeated without the server observing a difference. */
const REPLAYABLE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Can this body be sent a second time?
 *
 * A stream is consumed by the first attempt, so replaying it would send an
 * empty body and quietly corrupt the request. Only bodies that are still fully
 * in hand qualify.
 *
 * @param {*} body
 * @returns {boolean}
 */
function isReplayableBody(body) {
  return (
    body === undefined ||
    body === null ||
    typeof body === 'string' ||
    body instanceof URLSearchParams
  );
}

/**
 * Fetch, reopening a connection that never answered.
 *
 * The request's AbortSignal belongs to this function -- each attempt needs its
 * own, so a signal passed inside `init` is refused rather than silently
 * ignored. A caller with its own cancellation passes it as `options.signal`.
 *
 * @param {string} url
 * @param {RequestInit} [init] Fetch options, minus `signal`.
 * @param {object} options
 * @param {number} options.timeoutMs Budget for the whole sequence.
 * @param {number} options.attemptTimeoutMs Budget for every attempt but the last.
 * @param {number} [options.attempts] Connections opened before giving up.
 * @param {Function} [options.fetchImpl] Injected for tests.
 * @param {?AbortSignal} [options.signal] The caller's own cancellation.
 * @param {boolean} [options.releaseOnHeaders] See below.
 * @param {?boolean} [options.replayable] Override the method/body judgement.
 * @returns {Promise<Response>}
 */
export async function fetchWithReconnect(
  url,
  init = {},
  {
    timeoutMs,
    attemptTimeoutMs,
    attempts = 2,
    fetchImpl = fetch,
    signal: caller = null,
    /*
     * Whether the deadline stops at the response headers.
     *
     * A live video body is supposed to run for minutes, so the media proxy
     * releases it: the budget bounds opening the stream, not watching it.
     * A catalog download is the opposite -- its whole point is to finish, and
     * a stalled body read there would leave getCctvSources pending forever.
     * Those callers keep the deadline armed across the body.
     */
    releaseOnHeaders = true,
    replayable = null,
  } = {},
) {
  if (init?.signal) {
    throw new TypeError(
      'fetchWithReconnect owns the request signal; pass yours as options.signal',
    );
  }

  const method = String(init?.method || 'GET').toUpperCase();
  const mayReplay =
    replayable === null
      ? REPLAYABLE_METHODS.has(method) && isReplayableBody(init?.body)
      : Boolean(replayable) && isReplayableBody(init?.body);

  const deadline = Date.now() + timeoutMs;
  const maxAttempts = mayReplay ? Math.max(1, Math.floor(attempts) || 1) : 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remaining = deadline - Date.now();
    // The total deadline is the promise made to the caller; an attempt that
    // cannot start inside it is not started.
    if (remaining <= 0) break;
    // Earlier attempts are cut short so there is room left to open another
    // connection; the last one may use whatever remains.
    const budget =
      attempt === maxAttempts
        ? remaining
        : Math.min(attemptTimeoutMs, remaining);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), budget);
    // The caller going away cancels the upstream request, not just the
    // response to it -- and unlike an expired attempt, it is never retried,
    // because there is nobody left to answer.
    let abandoned = Boolean(caller?.aborted);
    const onCallerAbort = () => {
      abandoned = true;
      controller.abort();
    };
    if (abandoned) controller.abort();
    else caller?.addEventListener?.('abort', onCallerAbort);

    /** Drop this attempt's deadline and listener. */
    const release = () => {
      clearTimeout(timeoutId);
      caller?.removeEventListener?.('abort', onCallerAbort);
    };

    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      if (releaseOnHeaders) release();
      // Otherwise the deadline and the caller's listener both stay armed over
      // the body read -- that is the point of not releasing. The timer is
      // unreferenced so a finished process is never held open by a timer with
      // nothing left to cancel; a body read still in progress keeps the loop
      // alive on its own, so the abort fires when it is actually needed. The
      // listener is deliberately not removed, and no caller that keeps the
      // deadline passes a signal today, so it outlives nothing.
      else timeoutId?.unref?.();
      return response;
    } catch (error) {
      release();
      lastError = error;
      if (abandoned) throw error;
      // Otherwise fall through and reopen. No distinction is drawn between a
      // silent connection and a refused or reset one: both failed before any
      // header arrived, and both are worth a fresh connection.
    }
  }

  throw (
    lastError ||
    Object.assign(new Error('Fetch deadline elapsed before any attempt'), {
      name: 'TimeoutError',
    })
  );
}

/**
 * Download a provider catalog, reopening a connection that never answered.
 *
 * Unlike the media proxy, the deadline here stays armed across the body. A
 * catalog is meant to finish, and CCTV_SOURCE_FETCH_TIMEOUT_MS exists so that
 * one stalled portal cannot leave getCctvSources -- and therefore every CCTV
 * route -- pending. Two attempts still add up to the same fifteen seconds a
 * single attempt was given before.
 *
 * @param {string} url
 * @param {RequestInit} [init] Fetch options, minus `signal`.
 * @param {object} [options] Overrides, chiefly for tests.
 * @returns {Promise<Response>}
 */
export async function fetchCctvCatalog(url, init = {}, options = {}) {
  return fetchWithReconnect(url, init, {
    timeoutMs: CCTV_SOURCE_FETCH_TIMEOUT_MS,
    attemptTimeoutMs: CCTV_SOURCE_ATTEMPT_TIMEOUT_MS,
    attempts: CCTV_SOURCE_FETCH_ATTEMPTS,
    releaseOnHeaders: false,
    ...options,
  });
}

const INSTALLED_POLICY = Symbol.for('keepflip.ebayFetchRetryPolicy');

export const EBAY_MAX_INFRASTRUCTURE_RETRIES = 2;
const EBAY_RETRY_BASE_DELAY_MS = 250;
const EBAY_RETRY_MAX_DELAY_MS = 2_000;
const EBAY_TOKEN_CACHE_SAFETY_WINDOW_MS = 60_000;
const ebayApplicationTokenCache = new Map();

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requestUrl(input) {
  if (typeof input === 'string' || input instanceof URL) return String(input);
  return typeof input?.url === 'string' ? input.url : '';
}

function requestMethod(input, init) {
  return String(init?.method || input?.method || 'GET').toUpperCase();
}

export function isOfficialEbayApiRequest(input) {
  try {
    const url = new URL(requestUrl(input));
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'api.ebay.com' ||
        url.hostname === 'api.sandbox.ebay.com')
    );
  } catch {
    return false;
  }
}

export function isEbayApplicationTokenRequest(input, init) {
  if (requestMethod(input, init) !== 'POST') return false;

  try {
    const url = new URL(requestUrl(input));
    return (
      (url.hostname === 'api.ebay.com' ||
        url.hostname === 'api.sandbox.ebay.com') &&
      url.pathname === '/identity/v1/oauth2/token'
    );
  } catch {
    return false;
  }
}

export function isRetryableEbayInfrastructureStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function retryAfterMilliseconds(response) {
  const value = response?.headers?.get?.('retry-after')?.trim();
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }

  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function retryDelayMilliseconds(response, attempt) {
  const requestedDelay = retryAfterMilliseconds(response);
  if (requestedDelay != null) {
    // Do not turn a synchronous KeepFlip request into aggressive polling when
    // eBay explicitly asks clients to wait longer than this execution can afford.
    return requestedDelay <= EBAY_RETRY_MAX_DELAY_MS ? requestedDelay : null;
  }

  return Math.min(
    EBAY_RETRY_MAX_DELAY_MS,
    EBAY_RETRY_BASE_DELAY_MS * 2 ** attempt,
  );
}

async function discardResponse(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // The response is intentionally discarded before a bounded retry.
  }
}

function headerValue(headers, name) {
  if (!headers) return '';
  const normalized = new Headers(headers);
  return normalized.get(name) || '';
}

function applicationTokenCacheKey(input, init) {
  return [
    requestUrl(input),
    headerValue(init?.headers || input?.headers, 'authorization'),
    String(init?.body || ''),
  ].join('|');
}

function responseFromCachedToken(cached) {
  return new Response(cached.body, {
    status: cached.status,
    statusText: cached.statusText,
    headers: cached.headers,
  });
}

async function maybeCacheApplicationToken(cacheKey, response) {
  if (!response.ok) return;

  let payload;
  let body;
  try {
    const clone = response.clone();
    body = await clone.text();
    payload = JSON.parse(body);
  } catch {
    return;
  }

  const expiresIn = Number(payload?.expires_in);
  if (!payload?.access_token || !Number.isFinite(expiresIn) || expiresIn <= 60) {
    return;
  }

  ebayApplicationTokenCache.set(cacheKey, {
    body,
    expiresAt:
      Date.now() + Math.max(0, expiresIn * 1_000 - EBAY_TOKEN_CACHE_SAFETY_WINDOW_MS),
    headers: [...response.headers.entries()],
    status: response.status,
    statusText: response.statusText,
  });
}

export async function ebayFetchWithRetry(
  fetchImpl,
  input,
  init,
  { sleep = wait } = {},
) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('A fetch implementation is required.');
  }

  for (
    let attempt = 0;
    attempt <= EBAY_MAX_INFRASTRUCTURE_RETRIES;
    attempt += 1
  ) {
    let response;

    try {
      response = await fetchImpl(input, init);
    } catch (error) {
      if (attempt >= EBAY_MAX_INFRASTRUCTURE_RETRIES) throw error;
      await sleep(
        Math.min(
          EBAY_RETRY_MAX_DELAY_MS,
          EBAY_RETRY_BASE_DELAY_MS * 2 ** attempt,
        ),
      );
      continue;
    }

    if (
      !isRetryableEbayInfrastructureStatus(response.status) ||
      attempt >= EBAY_MAX_INFRASTRUCTURE_RETRIES
    ) {
      return response;
    }

    const delay = retryDelayMilliseconds(response, attempt);
    if (delay == null) return response;

    await discardResponse(response);
    await sleep(delay);
  }

  throw new Error('eBay request failed after bounded retries.');
}

export async function ebayFetchWithApplicationTokenCache(fetchImpl, input, init) {
  const cacheKey = applicationTokenCacheKey(input, init);
  const cached = ebayApplicationTokenCache.get(cacheKey);

  if (cached?.expiresAt > Date.now()) {
    return responseFromCachedToken(cached);
  }
  if (cached) ebayApplicationTokenCache.delete(cacheKey);

  const response = await ebayFetchWithRetry(fetchImpl, input, init);
  await maybeCacheApplicationToken(cacheKey, response);
  return response;
}

export function installEbayFetchRetryPolicy() {
  if (globalThis[INSTALLED_POLICY]) return;

  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch is unavailable in this runtime.');
  }

  const originalFetch = fetchImpl.bind(globalThis);
  globalThis.fetch = (input, init) => {
    if (!isOfficialEbayApiRequest(input)) return originalFetch(input, init);
    return isEbayApplicationTokenRequest(input, init)
      ? ebayFetchWithApplicationTokenCache(originalFetch, input, init)
      : ebayFetchWithRetry(originalFetch, input, init);
  };

  Object.defineProperty(globalThis, INSTALLED_POLICY, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
}

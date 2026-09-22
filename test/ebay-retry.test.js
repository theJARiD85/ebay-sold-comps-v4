import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EBAY_MAX_INFRASTRUCTURE_RETRIES,
  ebayFetchWithRetry,
  isOfficialEbayApiRequest,
  isRetryableEbayInfrastructureStatus,
} from '../src/ebay-retry.js';

test('recognizes only official eBay API hosts', () => {
  assert.equal(isOfficialEbayApiRequest('https://api.ebay.com/buy/browse/v1/item_summary/search'), true);
  assert.equal(isOfficialEbayApiRequest('https://api.sandbox.ebay.com/identity/v1/oauth2/token'), true);
  assert.equal(isOfficialEbayApiRequest('https://www.ebay.com/itm/123'), false);
  assert.equal(isOfficialEbayApiRequest('https://serpapi.com/search.json'), false);
});

test('classifies only transient statuses as retryable', () => {
  assert.equal(isRetryableEbayInfrastructureStatus(408), true);
  assert.equal(isRetryableEbayInfrastructureStatus(429), true);
  assert.equal(isRetryableEbayInfrastructureStatus(500), true);
  assert.equal(isRetryableEbayInfrastructureStatus(503), true);
  assert.equal(isRetryableEbayInfrastructureStatus(400), false);
  assert.equal(isRetryableEbayInfrastructureStatus(401), false);
  assert.equal(isRetryableEbayInfrastructureStatus(403), false);
  assert.equal(isRetryableEbayInfrastructureStatus(404), false);
});

test('retries infrastructure responses no more than two times', async () => {
  let calls = 0;
  const sleeps = [];
  const fetchImpl = async () => {
    calls += 1;
    return new Response('{}', { status: 503 });
  };

  const response = await ebayFetchWithRetry(fetchImpl, 'https://api.ebay.com/test', undefined, {
    sleep: async (milliseconds) => sleeps.push(milliseconds),
  });

  assert.equal(EBAY_MAX_INFRASTRUCTURE_RETRIES, 2);
  assert.equal(response.status, 503);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [250, 500]);
});

test('returns ordinary client errors without retrying', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response('{}', { status: 400 });
  };

  const response = await ebayFetchWithRetry(fetchImpl, 'https://api.ebay.com/test', undefined, {
    sleep: async () => assert.fail('client errors must not sleep or retry'),
  });

  assert.equal(response.status, 400);
  assert.equal(calls, 1);
});

test('retries network failures no more than two times', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new TypeError('network unavailable');
  };

  await assert.rejects(
    ebayFetchWithRetry(fetchImpl, 'https://api.ebay.com/test', undefined, {
      sleep: async () => undefined,
    }),
    /network unavailable/,
  );

  assert.equal(calls, 3);
});

test('does not ignore an eBay Retry-After longer than the synchronous retry budget', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response('{}', {
      status: 429,
      headers: { 'retry-after': '10' },
    });
  };

  const response = await ebayFetchWithRetry(fetchImpl, 'https://api.ebay.com/test', undefined, {
    sleep: async () => assert.fail('long Retry-After must be returned to the caller'),
  });

  assert.equal(response.status, 429);
  assert.equal(calls, 1);
});

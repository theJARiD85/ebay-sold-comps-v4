import assert from 'node:assert/strict';
import test from 'node:test';

import main, {
  buildMarketAnalysis,
  filterComparableListings,
  makeValuation,
} from '../src/main.js';

function comp(totalPrice, overrides = {}) {
  return {
    title: `Sold item ${totalPrice}`,
    soldPrice: totalPrice,
    shipping: 0,
    totalPrice,
    currency: 'USD',
    condition: 'Used',
    soldDate: null,
    imageUrl: null,
    listingUrl: `https://example.test/${totalPrice}`,
    ...overrides,
  };
}

test('rejects requests without an authenticated Appwrite caller', async () => {
  let response;
  await main({
    req: { bodyJson: { action: 'start', query: 'Nintendo Switch' }, headers: {}, method: 'POST' },
    res: {
      json(body, statusCode = 200) {
        response = { body, statusCode };
        return response;
      },
    },
    log() {},
    error() {},
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.ok, false);
});

test('computes a median and p20/p80 range from confirmed sold totals', () => {
  const valuation = makeValuation([comp(80), comp(90), comp(100), comp(110), comp(120)]);

  assert.equal(valuation.status, 'ready');
  assert.equal(valuation.currency, 'USD');
  assert.equal(valuation.median, 100);
  assert.equal(valuation.p20, 88);
  assert.equal(valuation.p80, 112);
  assert.equal(valuation.usedCount, 5);
  assert.equal(valuation.source, 'ebay_sold');
});

test('removes duplicate listings and an extreme price outlier', () => {
  const sharedUrl = 'https://example.test/shared';
  const valuation = makeValuation([
    comp(90),
    comp(100),
    comp(100, { listingUrl: sharedUrl }),
    comp(100, { listingUrl: sharedUrl, title: 'Duplicate scrape' }),
    comp(110),
    comp(120),
    comp(9_000),
  ]);

  assert.equal(valuation.status, 'ready');
  assert.equal(valuation.median, 100);
  assert.equal(valuation.usedCount, 5);
  assert.equal(valuation.rejectedCount, 2);
});

test('uses one currency instead of mixing incomparable prices', () => {
  const valuation = makeValuation([
    comp(100),
    comp(110),
    comp(120),
    comp(75, { currency: 'EUR', listingUrl: 'https://example.test/eur' }),
  ]);

  assert.equal(valuation.currency, 'USD');
  assert.equal(valuation.usedCount, 3);
  assert.equal(valuation.rejectedCount, 1);
});

test('returns needs_comps without inventing a price', () => {
  const valuation = makeValuation([]);

  assert.equal(valuation.status, 'needs_comps');
  assert.equal(valuation.median, null);
  assert.equal(valuation.p20, null);
  assert.equal(valuation.p80, null);
});

test('keeps aggregate market signals out of confirmed-transaction valuation', () => {
  const valuation = makeValuation([
    comp(100, {
      provider: 'poshmark',
      evidenceClass: 'confirmed_transaction',
    }),
    comp(500, {
      provider: 'reverb',
      evidenceClass: 'platform_sold_aggregate',
      listingUrl: 'https://example.test/reverb-guide',
    }),
    comp(450, {
      provider: 'stockx',
      evidenceClass: 'platform_last_sale',
      listingUrl: 'https://example.test/stockx-last-sale',
    }),
  ]);

  assert.equal(valuation.status, 'limited_comps');
  assert.equal(valuation.suppliedCount, 3);
  assert.equal(valuation.usedCount, 1);
  assert.equal(valuation.rejectedCount, 2);
  assert.equal(valuation.median, 100);
  assert.equal(valuation.providerCount, 1);
});

test('keeps sold-price, active-competition, and margin inputs separate', () => {
  const analysis = buildMarketAnalysis({
    comps: [
      comp(100, {
        condition: 'Used',
        soldDate: '2026-08-21T00:00:00.000Z',
        soldDateConfidence: 'exact',
      }),
      comp(110, {
        condition: 'Used',
        listingUrl: 'https://example.test/110-recent',
        soldDate: '2026-08-10T00:00:00.000Z',
        soldDateConfidence: 'exact',
      }),
      comp(120, {
        condition: 'New',
        listingUrl: 'https://example.test/120-recent',
        soldDate: '2026-08-01T00:00:00.000Z',
        soldDateConfidence: 'exact',
      }),
    ],
    activeSnapshot: {
      total: 6,
      listings: [
        { hasImage: true, hasTitle: true, price: 130, shipping: 8 },
        { hasImage: true, hasTitle: true, price: 140, shipping: 10 },
        { hasImage: false, hasTitle: true, price: 150, shipping: 12 },
      ],
    },
    searchedAt: '2026-08-24T00:00:00.000Z',
  });

  assert.equal(analysis.version, 1);
  assert.equal(analysis.marketValue.status, 'ready');
  assert.equal(analysis.marketValue.period.days, 30);
  assert.equal(analysis.marketValue.floor, 100);
  assert.equal(analysis.marketValue.median, 110);
  assert.equal(analysis.marketValue.ceiling, 120);
  assert.equal(analysis.marketValue.conditionBands[0].condition, 'Pre-owned');
  assert.equal(analysis.marketVelocity.status, 'sample_only');
  assert.equal(analysis.marketVelocity.observedSoldToActiveRatio, 0.5);
  assert.equal(analysis.marketVelocity.daysOnMarket.status, 'unavailable');
  assert.equal(analysis.competitorSaturation.status, 'ready');
  assert.equal(analysis.competitorSaturation.activePriceMedian, 140);
  assert.equal(analysis.competitorSaturation.activeShippingMedian, 10);
  assert.equal(analysis.competitorSaturation.listingQuality.imageCoverage, 0.67);
  assert.equal(analysis.netMarginViability.status, 'needs_inputs');
  assert.equal(analysis.netMarginViability.netProfit, null);
  assert.ok(analysis.netMarginViability.missingInputs.includes('Acquisition cost (COGS)'));
  assert.equal(analysis.decisionInputs.status, 'limited');
  assert.ok(analysis.decisionInputs.missingInputs.includes('Package weight and dimensions'));
});
test('requires a demand review when active supply dwarfs the returned sold sample', () => {
  const analysis = buildMarketAnalysis({
    comps: [
      comp(100, {
        soldDate: '2026-08-21T00:00:00.000Z',
        soldDateConfidence: 'exact',
      }),
      comp(110, {
        listingUrl: 'https://example.test/high-supply-110',
        soldDate: '2026-08-10T00:00:00.000Z',
        soldDateConfidence: 'exact',
      }),
      comp(120, {
        listingUrl: 'https://example.test/high-supply-120',
        soldDate: '2026-08-01T00:00:00.000Z',
        soldDateConfidence: 'exact',
      }),
    ],
    activeSnapshot: {
      total: 100,
      listings: [
        { hasImage: true, hasTitle: true, price: 130, shipping: 8 },
        { hasImage: true, hasTitle: true, price: 140, shipping: 10 },
        { hasImage: true, hasTitle: true, price: 150, shipping: 12 },
      ],
    },
    searchedAt: '2026-08-24T00:00:00.000Z',
  });

  assert.equal(analysis.marketVelocity.observedSoldToActiveRatio, 0.03);
  assert.equal(analysis.decisionInputs.status, 'limited');
  assert.match(analysis.decisionInputs.summary, /active eBay supply/i);
  assert.ok(
    analysis.decisionInputs.missingInputs.some((input) =>
      /Confirm demand against the current active eBay supply/i.test(input),
    ),
  );
});

test('rejects obvious parts and accessory-only false matches', () => {
  const matches = filterComparableListings(
    [
      comp(100, { title: 'Nintendo Switch OLED console' }),
      comp(20, { title: 'Nintendo Switch empty box only', listingUrl: 'https://example.test/box' }),
      comp(15, { title: 'Nintendo Switch for parts', listingUrl: 'https://example.test/parts' }),
      comp(30, { title: 'Nintendo Switch case only', listingUrl: 'https://example.test/case' }),
    ],
    'Nintendo Switch OLED console',
  );

  assert.deepEqual(matches.map((item) => item.totalPrice), [100]);
});

test('keeps an accessory when that accessory is the identified item', () => {
  const matches = filterComparableListings(
    [comp(30, { title: 'Nintendo Switch case only' })],
    'Nintendo Switch case',
  );

  assert.equal(matches.length, 1);
});

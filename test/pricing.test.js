'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildQuote, QuoteError } = require('../src/pricing');

const property = {
  capacity: 2,
  cutOffTime: '22:00:00',
  cutOffDays: 0,
  defaultCleaningRate: '40.0000',
  shortStayCleaningRate: '40.0000',
  defaultNightRateCurrency: 'EUR',
  address: { timezone: 'Europe/Luxembourg' },
};

function day(date, extra = {}) {
  return { date, availability: 1, rate: 165, min_stay: 2, max_stay: 1125, stop_sell: false, closed_to_arrival: false, closed_to_departure: false, ...extra };
}

const now = new Date('2026-11-13T10:00:00Z');
const days = [
  day('2026-11-25', { rate: 180 }),
  day('2026-11-26', { rate: 190, min_stay: 1 }),
  day('2026-11-27', { rate: 182, stop_sell: true }),
  day('2026-11-28', { rate: 182 }),
  day('2026-11-29', { rate: 185, min_stay: 1 }),
  day('2026-11-30', { availability: 0 }),
];

test('quotes nightly rates plus cleaning fee', () => {
  const q = buildQuote({ property, days, arrival: '2026-11-25', departure: '2026-11-27', adults: 2, now });
  assert.strictEqual(q.nights, 2);
  assert.strictEqual(q.accommodation, 370);
  assert.strictEqual(q.cleaning, 40);
  assert.strictEqual(q.total, 410);
  assert.strictEqual(q.currency, 'EUR');
});

test('departure day may be unavailable (it is not a night)', () => {
  const q = buildQuote({ property, days, arrival: '2026-11-29', departure: '2026-11-30', adults: 1, now });
  assert.strictEqual(q.total, 225);
});

const rejects = (args, code) => assert.throws(
  () => buildQuote({ property, days, adults: 2, now, ...args }),
  (e) => e instanceof QuoteError && e.code === code,
);

test('enforces min stay of the arrival night', () => rejects({ arrival: '2026-11-25', departure: '2026-11-26' }, 'min_stay'));
test('rejects stop-sell nights', () => rejects({ arrival: '2026-11-26', departure: '2026-11-28' }, 'unavailable'));
test('rejects unavailable nights', () => rejects({ arrival: '2026-11-29', departure: '2026-12-01' }, 'unavailable'));
test('rejects too many guests', () => rejects({ arrival: '2026-11-25', departure: '2026-11-27', adults: 2, children: 1 }, 'too_many_guests'));
test('rejects past dates', () => rejects({ arrival: '2026-11-01', departure: '2026-11-03' }, 'past_dates'));
test('rejects reversed dates', () => rejects({ arrival: '2026-11-27', departure: '2026-11-25' }, 'invalid_dates'));
test('rejects closed to arrival', () => assert.throws(
  () => buildQuote({ property, days: [day('2026-11-25', { closed_to_arrival: true }), day('2026-11-26')], arrival: '2026-11-25', departure: '2026-11-27', adults: 1, now }),
  (e) => e.code === 'closed_to_arrival',
));

test('same-day booking blocked after cut-off time', () => {
  const late = new Date('2026-11-25T21:30:00Z'); // 22:30 in Luxembourg
  assert.throws(
    () => buildQuote({ property, days, arrival: '2026-11-25', departure: '2026-11-27', adults: 1, now: late }),
    (e) => e.code === 'cut_off',
  );
});

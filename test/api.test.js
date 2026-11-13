'use strict';

// End-to-end flow against the mock NowIstay client and a fake Stripe.

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/app');
const { MockNowIstayClient, addDays } = require('../src/nowistay');

function fakeStripe() {
  const sessions = new Map();
  const refunds = [];
  return {
    refunds: { create: async (args) => { refunds.push(args); return { id: 're_1' }; } },
    _refunds: refunds,
    _sessions: sessions,
    checkout: {
      sessions: {
        create: async (args) => {
          const id = `cs_test_${sessions.size + 1}`;
          const s = { id, url: `https://checkout.stripe.test/${id}`, status: 'open', payment_status: 'unpaid', ...args };
          sessions.set(id, s);
          return s;
        },
        retrieve: async (id) => sessions.get(id),
        expire: async (id) => { sessions.get(id).status = 'expired'; return sessions.get(id); },
      },
    },
    paymentIntents: { search: async () => ({ data: [{ id: 'pi_1' }] }) },
    webhooks: { constructEvent: (body) => JSON.parse(body.toString()) },
  };
}

const config = {
  publicUrl: 'https://luxcasa.lu',
  nowistay: { propertyId: 2553 },
  stripe: { webhookSecret: 'whsec_test' },
  booking: { holdMinutes: 30, freeCancellationDays: 7, maxMonthsAhead: 12 },
};

async function start() {
  const nowistay = new MockNowIstayClient({});
  const stripe = fakeStripe();
  const app = createApp({ config, nowistay, stripe });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body, headers = {}) => {
    const res = await fetch(base + path, body !== undefined
      ? { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }
      : { headers });
    return { status: res.status, json: await res.json().catch(() => null), res };
  };
  return { server, nowistay, stripe, call };
}

// Find a bookable 3-night window ~40 days out in the mock calendar.
async function findStay(nowistay) {
  const today = new Date().toISOString().slice(0, 10);
  for (let i = 40; i < 120; i++) {
    const arrival = addDays(today, i);
    const departure = addDays(arrival, 3);
    const { days } = await nowistay.getCalendar(2553, arrival, departure);
    if (days.slice(0, 3).every((d) => d.availability > 0)) return { arrival, departure };
  }
  throw new Error('no window');
}

test('book, pay, confirm, look up and cancel', async () => {
  const { server, nowistay, stripe, call } = await start();
  try {
    const stay = await findStay(nowistay);

    const cal = await call(`/api/calendar?month=${stay.arrival.slice(0, 7)}`);
    assert.strictEqual(cal.status, 200);
    assert.ok(cal.json.days.length >= 28);

    const quote = await call('/api/quote', { ...stay, adults: 2 });
    assert.strictEqual(quote.status, 200, JSON.stringify(quote.json));
    assert.strictEqual(quote.json.nights, 3);

    const checkout = await call('/api/checkout', { ...stay, adults: 2, firstName: 'Ana', lastName: 'Silva', email: 'Ana@Example.com' });
    assert.strictEqual(checkout.status, 200, JSON.stringify(checkout.json));
    const bookingId = checkout.json.bookingId;
    const session = stripe._sessions.get(checkout.json.sessionId);
    assert.strictEqual(session.line_items[0].price_data.unit_amount, Math.round(quote.json.total * 100));
    assert.strictEqual((await nowistay.getBooking(bookingId)).status, 'pending');

    // Dates are held: a second guest cannot book the same nights.
    const clash = await call('/api/quote', { ...stay, adults: 1 });
    assert.strictEqual(clash.status, 400);

    // Stripe webhook confirms the booking in NowIstay.
    const wh = await call('/api/stripe/webhook', JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: { id: session.id, payment_status: 'paid', payment_intent: 'pi_1', metadata: { nowistay_booking_id: String(bookingId) } } },
    }), { 'stripe-signature': 'x' });
    assert.strictEqual(wh.status, 200);
    assert.strictEqual((await nowistay.getBooking(bookingId)).status, 'confirmed');

    // Wrong email is refused.
    const bad = await call('/api/booking/lookup', { bookingId, email: 'someone@else.com' });
    assert.strictEqual(bad.status, 404);

    const look = await call('/api/booking/lookup', { bookingId, email: 'ana@example.com' });
    assert.strictEqual(look.status, 200);
    assert.strictEqual(look.json.status, 'confirmed');
    assert.strictEqual(look.json.canCancelOnline, true);

    const cancel = await call('/api/booking/cancel', { bookingId, email: 'ana@example.com' });
    assert.strictEqual(cancel.status, 200);
    assert.strictEqual(cancel.json.refunded, true);
    assert.strictEqual(stripe._refunds[0].payment_intent, 'pi_1');
    assert.strictEqual((await nowistay.getBooking(bookingId)).status, 'cancelled');
  } finally {
    server.close();
  }
});

test('abandoned checkout releases the dates', async () => {
  const { server, nowistay, call } = await start();
  try {
    const stay = await findStay(nowistay);
    const checkout = await call('/api/checkout', { ...stay, adults: 1, firstName: 'A', lastName: 'B', email: 'a@b.co' });
    assert.strictEqual(checkout.status, 200);
    const rel = await call('/api/checkout/release', { sessionId: checkout.json.sessionId });
    assert.strictEqual(rel.json.released, true);
    assert.strictEqual((await nowistay.getBooking(checkout.json.bookingId)).status, 'cancelled');
    const again = await call('/api/quote', { ...stay, adults: 1 });
    assert.strictEqual(again.status, 200);
  } finally {
    server.close();
  }
});

test('www redirects to the apex domain', async () => {
  const { server } = await start();
  try {
    const http = require('http');
    const status = await new Promise((resolve, reject) => {
      http.get({ port: server.address().port, path: '/manage', headers: { Host: 'www.luxcasa.lu' } }, (res) => {
        resolve([res.statusCode, res.headers.location]);
      }).on('error', reject);
    });
    assert.deepStrictEqual(status, [301, 'https://luxcasa.lu/manage']);
  } finally {
    server.close();
  }
});

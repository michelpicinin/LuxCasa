'use strict';

// RestNowIstayClient against a local fake of the NowIstay public API.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { RestNowIstayClient, NowIstayError } = require('../src/nowistay');

function fakeApi() {
  const calls = [];
  let tokens = 0;
  let expireNext = false;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, body });
      const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };

      if (url.pathname === '/public/oauth/token') {
        const form = new URLSearchParams(body);
        if (form.get('grant_type') !== 'client_credentials' || form.get('client_secret') !== 'sec') return send(401, { error: 'invalid_client' });
        tokens++;
        return send(200, { access_token: `tok${tokens}`, token_type: 'Bearer', expires_in: 3600, scope: 'calendar.read' });
      }
      if (expireNext) { expireNext = false; return send(401, { detail: 'expired' }); }
      if (!/^Bearer tok\d+$/.test(req.headers.authorization || '')) return send(401, {});

      if (req.method === 'GET' && url.pathname === '/public/v1/properties/2553') {
        return send(200, { id: 2553, capacity: 2, checkInTime: '15:00:00', defaultCleaningRate: '40.00', defaultNightRateCurrency: 'EUR', address: { timezone: 'Europe/Luxembourg' } });
      }
      if (req.method === 'GET' && url.pathname === '/public/v1/properties/2553/calendar') {
        return send(200, {
          propertyId: 2553, from: url.searchParams.get('from'), to: url.searchParams.get('to'), currency: 'EUR',
          days: [{ date: '2026-12-01', availability: 1, rate: 165, minStay: 2, maxStay: 30, stopSell: false, closedToArrival: true, closedToDeparture: false, restricted: false, restrictionReasons: [] }],
        });
      }
      if (req.method === 'POST' && url.pathname === '/public/v1/bookings') {
        const b = JSON.parse(body);
        if (b.arrival === '2026-12-24') return send(409, { detail: 'Dates already booked' });
        return send(201, { booking: { id: 777, status: b.status, propertyId: b.propertyId } });
      }
      if (req.method === 'GET' && url.pathname === '/public/v1/bookings/777') {
        return send(200, { id: 777, propertyId: 2553, status: 'pending', channel: 'direct', arrival: '2026-12-01', departure: '2026-12-04', adults: 2, children: 0,
          guest: { firstName: 'Ana', lastName: 'Silva', fullName: 'Ana Silva', email: 'ana@example.com' }, amounts: { amount: '535.00', currency: 'EUR' } });
      }
      if (req.method === 'PATCH' && url.pathname === '/public/v1/bookings/777') {
        return send(200, { id: 777, status: JSON.parse(body).status, guest: {}, amounts: {} });
      }
      send(404, { detail: 'not found' });
    });
  });
  return { server, calls, expire: () => { expireNext = true; }, tokenCount: () => tokens };
}

async function setup() {
  const api = fakeApi();
  await new Promise((r) => api.server.listen(0, r));
  const client = new RestNowIstayClient({ apiUrl: `http://127.0.0.1:${api.server.address().port}`, clientId: 'cid', clientSecret: 'sec' });
  return { api, client };
}

test('exchanges the credential and maps the calendar', async () => {
  const { api, client } = await setup();
  try {
    const cal = await client.getCalendar(2553, '2026-12-01', '2026-12-05');
    assert.deepStrictEqual(cal.days[0], {
      date: '2026-12-01', availability: 1, rate: 165, min_stay: 2, max_stay: 30,
      stop_sell: false, closed_to_arrival: true, closed_to_departure: false,
    });
    const calCall = api.calls.find((c) => c.path.endsWith('/calendar'));
    assert.deepStrictEqual(calCall.query, { from: '2026-12-01', to: '2026-12-05' });
    assert.strictEqual(calCall.auth, 'Bearer tok1');
    await client.getProperty(2553);
    assert.strictEqual(api.tokenCount(), 1, 'token is reused');
  } finally { api.server.close(); }
});

test('renews the token once on 401', async () => {
  const { api, client } = await setup();
  try {
    await client.getProperty(2553);
    api.expire();
    const p = await client.getProperty(2553);
    assert.strictEqual(p.capacity, 2);
    assert.strictEqual(api.tokenCount(), 2);
  } finally { api.server.close(); }
});

test('creates, reads and updates bookings', async () => {
  const { api, client } = await setup();
  try {
    const created = await client.createBooking({
      property_id: 2553, arrival: '2026-12-01', departure: '2026-12-04', status: 'pending',
      guest_first_name: 'Ana', guest_last_name: 'Silva', guest_email: 'ana@example.com', num_adults: 2, num_children: 0,
      amount: 535, currency: 'EUR', notes: 'x', guest_phone: undefined,
    });
    assert.strictEqual(created.id, 777);
    const sent = JSON.parse(api.calls.find((c) => c.method === 'POST' && c.path === '/public/v1/bookings').body);
    assert.strictEqual(sent.propertyId, 2553);
    assert.strictEqual(sent.guestEmail, 'ana@example.com');
    assert.strictEqual(sent.adults, 2);
    assert.ok(!('guestPhone' in sent), 'undefined fields are not sent');

    const b = await client.getBooking(777);
    assert.strictEqual(b.guestEmail, 'ana@example.com');
    assert.strictEqual(b.amount, 535);
    assert.strictEqual(b.channel, 'direct');

    const u = await client.updateBooking({ booking_id: 777, status: 'cancelled', cancellation_refund_mode: 'none' });
    assert.strictEqual(u.status, 'cancelled');
    const patch = JSON.parse(api.calls.find((c) => c.method === 'PATCH').body);
    assert.deepStrictEqual(patch, { status: 'cancelled', cancellationRefundMode: 'none' });
  } finally { api.server.close(); }
});

test('surfaces conflicts with their HTTP status', async () => {
  const { api, client } = await setup();
  try {
    await assert.rejects(
      client.createBooking({ property_id: 2553, arrival: '2026-12-24', departure: '2026-12-26', guest_email: 'a@b.co' }),
      (e) => e instanceof NowIstayError && e.status === 409,
    );
  } finally { api.server.close(); }
});

test('bad credentials fail clearly', async () => {
  const api = fakeApi();
  await new Promise((r) => api.server.listen(0, r));
  const client = new RestNowIstayClient({ apiUrl: `http://127.0.0.1:${api.server.address().port}`, clientId: 'cid', clientSecret: 'wrong' });
  try {
    await assert.rejects(client.getProperty(2553), (e) => e instanceof NowIstayError && e.status === 401);
  } finally { api.server.close(); }
});

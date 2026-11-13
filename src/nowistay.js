'use strict';

// NowIstay client.
//
// Uses the NowIstay public REST API (https://api.nowistay.com/public/docs)
// with a personal API credential that the host creates in the NowIstay app
// (My account > Developer > New credential). The credential is exchanged for a
// one-hour access token with the OAuth client_credentials grant; the client
// renews it automatically, so there is no token to copy or babysit.
//
// Required credential permissions: properties.read, calendar.read,
// bookings.read, bookings.write.
//
// The rest of the app works with the shapes returned here (calendar days in
// snake_case, bookings flattened), so the mock below can stand in for it.
//
// Set NOWISTAY_MOCK=true to run against an in-memory fake (local development
// and tests), so nothing touches the live calendar.

class NowIstayError extends Error {
  constructor(message, details, status) {
    super(message);
    this.name = 'NowIstayError';
    this.details = details;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Live REST client
// ---------------------------------------------------------------------------

class RestNowIstayClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.baseUrl = cfg.apiUrl.replace(/\/$/, '');
    this.token = null;
    this.tokenExpiresAt = 0;
    this.tokenPromise = null;
  }

  async accessToken(force = false) {
    if (!force && this.token && Date.now() < this.tokenExpiresAt - 60 * 1000) return this.token;
    if (!this.tokenPromise) {
      this.tokenPromise = (async () => {
        if (!this.cfg.clientId || !this.cfg.clientSecret) {
          throw new NowIstayError('NOWISTAY_CLIENT_ID and NOWISTAY_CLIENT_SECRET are not set');
        }
        const res = await fetch(`${this.baseUrl}/public/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: this.cfg.clientId,
            client_secret: this.cfg.clientSecret,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.access_token) {
          throw new NowIstayError(`NowIstay token request failed (HTTP ${res.status})`, json, res.status);
        }
        this.token = json.access_token;
        this.tokenExpiresAt = Date.now() + (Number(json.expires_in) || 3600) * 1000;
        return this.token;
      })().finally(() => { this.tokenPromise = null; });
    }
    return this.tokenPromise;
  }

  async request(method, path, { query, body } = {}, retried = false) {
    const url = new URL(this.baseUrl + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
    const token = await this.accessToken(retried);
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(stripUndefined(body)) : undefined,
    });
    if (res.status === 401 && !retried) return this.request(method, path, { query, body }, true);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = { text }; }
    if (!res.ok) throw new NowIstayError(`NowIstay ${method} ${path} failed (HTTP ${res.status})`, json, res.status);
    return json;
  }

  async getProperty(propertyId) {
    const p = await this.request('GET', `/public/v1/properties/${propertyId}`);
    return p.property || p;
  }

  async getCalendar(propertyId, startDate, endDate) {
    const res = await this.request('GET', `/public/v1/properties/${propertyId}/calendar`, {
      query: { from: startDate, to: endDate },
    });
    return {
      property_id: res.propertyId,
      currency: res.currency,
      days: (res.days || []).map((d) => ({
        date: d.date,
        availability: d.availability,
        rate: d.rate,
        min_stay: d.minStay,
        max_stay: d.maxStay,
        stop_sell: !!d.stopSell,
        closed_to_arrival: !!d.closedToArrival,
        closed_to_departure: !!d.closedToDeparture,
      })),
    };
  }

  async getBooking(bookingId) {
    const b = await this.request('GET', `/public/v1/bookings/${bookingId}`);
    return flattenBooking(b.booking || b);
  }

  async createBooking(args) {
    const res = await this.request('POST', '/public/v1/bookings', {
      body: {
        propertyId: args.property_id,
        arrival: args.arrival,
        departure: args.departure,
        status: args.status,
        guestFirstName: args.guest_first_name,
        guestLastName: args.guest_last_name,
        guestName: args.guest_name,
        guestEmail: args.guest_email,
        guestPhone: args.guest_phone,
        adults: args.num_adults,
        children: args.num_children,
        amount: args.amount,
        nightRate: args.night_rate,
        cleaningAmount: args.cleaning_amount,
        currency: args.currency,
        notes: args.notes,
        silent: args.silent,
      },
    });
    const booking = (res && res.booking) || res || {};
    return { id: booking.id || (res && (res.id || res.bookingId)), raw: res };
  }

  async updateBooking(args) {
    const { booking_id: id, ...rest } = args;
    const res = await this.request('PATCH', `/public/v1/bookings/${id}`, {
      body: {
        status: rest.status,
        notes: rest.notes,
        silent: rest.silent,
        cancellationRefundMode: rest.cancellation_refund_mode,
      },
    });
    return flattenBooking(res.booking || res);
  }
}

function flattenBooking(b) {
  if (!b) return b;
  const guest = b.guest || {};
  const amounts = b.amounts || {};
  return {
    id: b.id,
    propertyId: b.propertyId,
    status: b.status,
    channel: b.channel,
    directBooking: b.directBooking,
    arrival: b.arrival,
    departure: b.departure,
    guestName: guest.fullName || [guest.firstName, guest.lastName].filter(Boolean).join(' '),
    guestEmail: guest.email,
    guestPhone: guest.phone,
    numAdults: b.adults,
    numChildren: b.children,
    amount: amounts.amount != null ? Number(amounts.amount) : null,
    currency: amounts.currency,
  };
}

function stripUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

// ---------------------------------------------------------------------------
// Mock client (NOWISTAY_MOCK=true)
// ---------------------------------------------------------------------------

class MockNowIstayClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.bookings = new Map();
    this.nextBookingId = 900001;
  }

  async getProperty(propertyId) {
    return {
      id: propertyId,
      name: 'Bonnevoie',
      propertyType: 'apartment',
      capacity: 2,
      checkInTime: '15:00:00',
      checkOutTime: '11:00:00',
      cutOffTime: '22:00:00',
      cutOffDays: 0,
      defaultNightRatePrice: '200.0000',
      defaultNightRateCurrency: 'EUR',
      defaultCleaningRate: '40.0000',
      shortStayCleaningRate: '40.0000',
      address: { city: 'Luxembourg', country: 'Luxembourg', timezone: 'Europe/Luxembourg' },
    };
  }

  async getCalendar(propertyId, startDate, endDate) {
    const days = [];
    for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
      const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
      const weekend = dow === 5 || dow === 6;
      const seed = [...d].reduce((a, c) => a + c.charCodeAt(0), 0);
      const blockedByChannel = seed % 9 === 0;
      const booked = [...this.bookings.values()].some(
        (b) => b.status !== 'cancelled' && b.arrival <= d && d < b.departure,
      );
      days.push({
        date: d,
        availability: booked || blockedByChannel ? 0 : 1,
        total_inventory: 1,
        rate: weekend ? 185 : 165,
        min_stay: weekend ? 1 : 2,
        max_stay: 1125,
        stop_sell: false,
        closed_to_arrival: false,
        closed_to_departure: false,
      });
    }
    return { property_id: propertyId, start_date: startDate, end_date: endDate, days };
  }

  async getBooking(bookingId) {
    const b = this.bookings.get(Number(bookingId));
    if (!b) throw new NowIstayError('Booking not found');
    return { ...b };
  }

  async createBooking(args) {
    const id = this.nextBookingId++;
    this.bookings.set(id, {
      id,
      channel: 'direct',
      status: args.status || 'pending',
      arrival: args.arrival,
      departure: args.departure,
      guestName: args.guest_name,
      guestEmail: args.guest_email,
      guestPhone: args.guest_phone || null,
      numAdults: args.num_adults,
      numChildren: args.num_children,
      amount: args.amount,
      currency: args.currency,
      notes: args.notes || '',
    });
    return { id, raw: { booking: { id } } };
  }

  async updateBooking(args) {
    const b = this.bookings.get(Number(args.booking_id));
    if (!b) throw new NowIstayError('Booking not found');
    if (args.status) b.status = args.status;
    if (args.notes !== undefined) b.notes = args.notes;
    return { booking: { ...b } };
  }
}

function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function createNowIstayClient(cfg) {
  if (cfg.mock) return new MockNowIstayClient(cfg);
  if (!cfg.clientId || !cfg.clientSecret) {
    console.warn('[nowistay] NOWISTAY_CLIENT_ID / NOWISTAY_CLIENT_SECRET are not set. Calls to NowIstay will fail. Use NOWISTAY_MOCK=true for local development.');
  }
  return new RestNowIstayClient(cfg);
}

module.exports = {
  createNowIstayClient,
  NowIstayError,
  addDays,
  // exported for tests
  RestNowIstayClient,
  MockNowIstayClient,
};

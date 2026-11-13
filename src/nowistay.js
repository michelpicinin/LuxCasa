'use strict';

// NowIstay client.
//
// NowIstay exposes its host data through a remote MCP server
// (Streamable HTTP + OAuth) at https://api.nowistay.com/mcp. This module is a
// tiny JSON-RPC client for that endpoint: it opens an MCP session, calls tools
// such as get_calendar_ari and create_booking_preview/confirm, and returns the
// parsed JSON results. Every write in NowIstay is a two-step "preview" then
// "confirm" with a one-time approval token; the helpers below do both steps.
//
// Set NOWISTAY_MOCK=true to run against an in-memory fake (local development
// and tests), so nothing touches the live calendar.

const PROTOCOL_VERSION = '2025-06-18';

class NowIstayError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'NowIstayError';
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Live MCP client
// ---------------------------------------------------------------------------

class McpNowIstayClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.accessToken = cfg.accessToken;
    this.sessionId = null;
    this.initializing = null;
    this.nextId = 1;
  }

  async post(body, { allowRetry = true } = {}) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
    };
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

    const res = await fetch(this.cfg.mcpUrl, { method: 'POST', headers, body: JSON.stringify(body) });

    if (res.status === 401 && allowRetry && (await this.refreshAccessToken())) {
      return this.post(body, { allowRetry: false });
    }
    if (res.status === 404 && this.sessionId && allowRetry && body.method !== 'initialize') {
      // Session expired on the server: open a new one and retry once.
      this.sessionId = null;
      await this.ensureSession();
      return this.post(body, { allowRetry: false });
    }
    if (!res.ok && res.status !== 202) {
      const text = await res.text().catch(() => '');
      throw new NowIstayError(`NowIstay MCP HTTP ${res.status}`, text.slice(0, 500));
    }

    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (res.status === 202 || body.id === undefined) return null; // notification

    const type = res.headers.get('content-type') || '';
    const raw = await res.text();
    let message;
    if (type.includes('text/event-stream')) {
      // Find the JSON-RPC response with our id among the SSE events.
      for (const line of raw.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        try {
          const parsed = JSON.parse(line.slice(5).trim());
          if (parsed && parsed.id === body.id) message = parsed;
        } catch (_) { /* ignore keep-alives */ }
      }
    } else {
      message = JSON.parse(raw);
    }
    if (!message) throw new NowIstayError('Empty response from NowIstay MCP');
    if (message.error) throw new NowIstayError(message.error.message || 'NowIstay MCP error', message.error);
    return message.result;
  }

  async refreshAccessToken() {
    const { refreshToken, tokenUrl, clientId, clientSecret } = this.cfg;
    if (!refreshToken || !tokenUrl) return false;
    const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
    if (clientId) form.set('client_id', clientId);
    if (clientSecret) form.set('client_secret', clientSecret);
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    if (!res.ok) return false;
    const json = await res.json();
    if (!json.access_token) return false;
    this.accessToken = json.access_token;
    if (json.refresh_token) this.cfg.refreshToken = json.refresh_token;
    this.sessionId = null;
    return true;
  }

  async ensureSession() {
    if (this.sessionId) return;
    if (!this.initializing) {
      this.initializing = (async () => {
        await this.post({
          jsonrpc: '2.0',
          id: this.nextId++,
          method: 'initialize',
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'luxcasa-booking-site', version: '1.0.0' },
          },
        });
        await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      })().finally(() => { this.initializing = null; });
    }
    await this.initializing;
  }

  async callTool(name, args) {
    await this.ensureSession();
    const result = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    const parsed = parseToolResult(result);
    if (result && result.isError) {
      throw new NowIstayError(`NowIstay ${name} failed`, parsed);
    }
    return parsed;
  }

  getProperty(propertyId) {
    return this.callTool('get_property', { property_id: propertyId }).then((r) => r.property || r);
  }

  getCalendar(propertyId, startDate, endDate) {
    return this.callTool('get_calendar_ari', { property_id: propertyId, start_date: startDate, end_date: endDate });
  }

  getBooking(bookingId) {
    return this.callTool('get_booking', { booking_id: bookingId, include_guest_contact_details: true })
      .then((r) => r.booking || r);
  }

  async createBooking(args) {
    const preview = await this.callTool('create_booking_preview', args);
    const token = findApprovalToken(preview);
    if (!token) throw new NowIstayError('NowIstay did not return an approval token', preview);
    const confirmed = await this.callTool('create_booking_confirm', { approval_token: token });
    return { id: findBookingId(confirmed), raw: confirmed };
  }

  async updateBooking(args) {
    const preview = await this.callTool('update_booking_preview', args);
    const token = findApprovalToken(preview);
    if (!token) throw new NowIstayError('NowIstay did not return an approval token', preview);
    return this.callTool('update_booking_confirm', { approval_token: token });
  }
}

function parseToolResult(result) {
  if (!result) return null;
  if (result.structuredContent) return result.structuredContent;
  const text = (result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  try { return JSON.parse(text); } catch (_) { return { text }; }
}

function findApprovalToken(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.approval_token === 'string') return obj.approval_token;
  if (typeof obj.approvalToken === 'string') return obj.approvalToken;
  for (const v of Object.values(obj)) {
    const t = typeof v === 'object' ? findApprovalToken(v) : null;
    if (t) return t;
  }
  return null;
}

function findBookingId(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.booking && obj.booking.id) return obj.booking.id;
  if (obj.booking_id) return obj.booking_id;
  if (obj.bookingId) return obj.bookingId;
  if (obj.id) return obj.id;
  for (const v of Object.values(obj)) {
    const id = typeof v === 'object' ? findBookingId(v) : null;
    if (id) return id;
  }
  return null;
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
  if (!cfg.accessToken && !cfg.refreshToken) {
    console.warn('[nowistay] No NOWISTAY_ACCESS_TOKEN set. Calls to NowIstay will fail. Use NOWISTAY_MOCK=true for local development.');
  }
  return new McpNowIstayClient(cfg);
}

module.exports = {
  createNowIstayClient,
  NowIstayError,
  addDays,
  // exported for tests
  parseToolResult,
  findApprovalToken,
  findBookingId,
  MockNowIstayClient,
};

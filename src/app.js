'use strict';

const path = require('path');
const express = require('express');
const { buildQuote, publicCalendar, QuoteError, localNow } = require('./pricing');
const { addDays, NowIstayError } = require('./nowistay');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const WEB_MARKER = 'Direct booking via luxcasa.lu';

function createApp({ config, nowistay, stripe }) {
  const app = express();
  const propertyId = config.nowistay.propertyId;
  app.disable('x-powered-by');

  // Serve everything on the canonical domain (www.luxcasa.lu -> luxcasa.lu).
  const canonicalHost = new URL(config.publicUrl).host;
  app.use((req, res, next) => {
    if (req.hostname === `www.${canonicalHost}`) return res.redirect(301, `${config.publicUrl}${req.originalUrl}`);
    next();
  });

  // ---- small caches so page views don't hammer NowIstay -----------------
  let propertyCache = { at: 0, value: null };
  async function getProperty() {
    if (propertyCache.value && Date.now() - propertyCache.at < 10 * 60 * 1000) return propertyCache.value;
    const value = await nowistay.getProperty(propertyId);
    propertyCache = { at: Date.now(), value };
    return value;
  }
  const calendarCache = new Map();
  async function getDays(start, end, { fresh = false } = {}) {
    const key = `${start}|${end}`;
    const hit = calendarCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < 60 * 1000) return hit.days;
    const res = await nowistay.getCalendar(propertyId, start, end);
    const days = (res && res.days) || [];
    calendarCache.set(key, { at: Date.now(), days });
    if (calendarCache.size > 50) calendarCache.delete(calendarCache.keys().next().value);
    return days;
  }
  function clearCalendarCache() { calendarCache.clear(); }

  async function freshQuote(body) {
    const property = await getProperty();
    const { arrival, departure } = body;
    if (typeof arrival !== 'string' || typeof departure !== 'string') {
      throw new QuoteError('Please choose your dates.', 'invalid_dates');
    }
    const days = await getDays(arrival, departure, { fresh: true });
    return buildQuote({
      property,
      days,
      arrival,
      departure,
      adults: body.adults,
      children: body.children,
    });
  }

  // ---- naive per-IP rate limit for lookups / checkout ------------------
  const hits = new Map();
  function rateLimit(max, windowMs) {
    return (req, res, next) => {
      const key = `${req.path}|${req.ip}`;
      const now = Date.now();
      const entry = hits.get(key) || { count: 0, reset: now + windowMs };
      if (now > entry.reset) { entry.count = 0; entry.reset = now + windowMs; }
      entry.count++;
      hits.set(key, entry);
      if (hits.size > 10000) hits.clear();
      if (entry.count > max) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
      next();
    };
  }

  // ---- Stripe webhook (needs the raw body, so it goes before express.json) ----
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!stripe) return res.status(503).send('Stripe not configured');
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], config.stripe.webhookSecret);
    } catch (err) {
      return res.status(400).send(`Webhook signature error: ${err.message}`);
    }
    try {
      await handleStripeEvent(event);
      res.json({ received: true });
    } catch (err) {
      console.error('[webhook]', event.type, err);
      res.status(500).send('Webhook handler failed'); // Stripe retries
    }
  });

  async function handleStripeEvent(event) {
    const session = event.data && event.data.object;
    const bookingId = session && session.metadata && Number(session.metadata.nowistay_booking_id);
    if (!bookingId) return;

    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      if (session.payment_status !== 'paid') return; // async methods confirm later
      const booking = await nowistay.getBooking(bookingId);
      if (booking.status === 'confirmed') return; // idempotent
      if (booking.status === 'cancelled') {
        // Hold expired before payment landed; dates may be gone. Refund and alert.
        console.error(`[webhook] Payment received for cancelled booking ${bookingId}; refunding.`);
        if (session.payment_intent) await stripe.refunds.create({ payment_intent: session.payment_intent });
        return;
      }
      await nowistay.updateBooking({
        booking_id: bookingId,
        status: 'confirmed', // NowIstay emails the guest a booking confirmation
        notes: `${WEB_MARKER}. Paid by Stripe (${session.payment_intent || session.id}).`,
      });
      clearCalendarCache();
    } else if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
      const booking = await nowistay.getBooking(bookingId);
      if (booking.status === 'pending') {
        await nowistay.updateBooking({ booking_id: bookingId, status: 'cancelled', silent: true });
        clearCalendarCache();
      }
    }
  }

  app.use(express.json({ limit: '20kb' }));

  // ---- public API ---------------------------------------------------------

  app.get('/api/property', async (req, res, next) => {
    try {
      const p = await getProperty();
      res.json({
        capacity: p.capacity,
        checkInTime: (p.checkInTime || '').slice(0, 5),
        checkOutTime: (p.checkOutTime || '').slice(0, 5),
        currency: p.defaultNightRateCurrency || 'EUR',
        cleaningFee: Number(p.defaultCleaningRate) || 0,
        city: p.address && p.address.city,
        country: p.address && p.address.country,
        freeCancellationDays: config.booking.freeCancellationDays,
      });
    } catch (err) { next(err); }
  });

  // GET /api/calendar?month=2026-12  -> that month plus the first days of the next
  app.get('/api/calendar', async (req, res, next) => {
    try {
      const property = await getProperty();
      const today = localNow(property.address && property.address.timezone).date;
      const month = MONTH_RE.test(req.query.month || '') ? req.query.month : today.slice(0, 7);
      const maxMonth = addMonths(today.slice(0, 7), config.booking.maxMonthsAhead);
      if (month < today.slice(0, 7) || month > maxMonth) return res.json({ month, days: [] });
      const start = `${month}-01`;
      const end = addDays(`${addMonths(month, 1)}-01`, 6);
      const days = await getDays(start, end);
      res.json({ month, today, days: publicCalendar(days, property) });
    } catch (err) { next(err); }
  });

  app.post('/api/quote', rateLimit(60, 60 * 1000), async (req, res, next) => {
    try {
      res.json(await freshQuote(req.body || {}));
    } catch (err) { next(err); }
  });

  app.post('/api/checkout', rateLimit(10, 10 * 60 * 1000), async (req, res, next) => {
    try {
      if (!stripe) return res.status(503).json({ error: 'Online payment is not configured yet.' });
      const body = req.body || {};
      const firstName = clean(body.firstName, 100);
      const lastName = clean(body.lastName, 100);
      const email = clean(body.email, 320).toLowerCase();
      const phone = clean(body.phone, 50);
      if (!firstName || !lastName) return res.status(400).json({ error: 'Please enter your name.' });
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

      const quote = await freshQuote(body);

      // 1. Hold the dates in NowIstay with a pending booking.
      const created = await nowistay.createBooking({
        property_id: propertyId,
        arrival: quote.arrival,
        departure: quote.departure,
        status: 'pending',
        guest_first_name: firstName,
        guest_last_name: lastName,
        guest_name: `${firstName} ${lastName}`,
        guest_email: email,
        guest_phone: phone || undefined,
        num_adults: quote.adults,
        num_children: quote.children,
        amount: quote.total,
        night_rate: quote.averageNightlyRate,
        cleaning_amount: quote.cleaning,
        currency: quote.currency,
        notes: `${WEB_MARKER}. Awaiting Stripe payment.`,
      });
      const bookingId = created.id;
      if (!bookingId) throw new NowIstayError('NowIstay did not return a booking id', created.raw);
      clearCalendarCache();

      // 2. Take payment with Stripe Checkout. The amount is computed on the server.
      let session;
      try {
        session = await stripe.checkout.sessions.create({
          mode: 'payment',
          customer_email: email,
          client_reference_id: String(bookingId),
          expires_at: Math.floor(Date.now() / 1000) + config.booking.holdMinutes * 60,
          line_items: [{
            quantity: 1,
            price_data: {
              currency: quote.currency.toLowerCase(),
              unit_amount: Math.round(quote.total * 100),
              product_data: {
                name: `LuxCasa · ${quote.nights} night${quote.nights > 1 ? 's' : ''}`,
                description: `${quote.arrival} → ${quote.departure} · ${quote.adults + quote.children} guest(s) · booking #${bookingId}`,
              },
            },
          }],
          metadata: { nowistay_booking_id: String(bookingId), arrival: quote.arrival, departure: quote.departure },
          payment_intent_data: {
            metadata: { nowistay_booking_id: String(bookingId) },
            description: `LuxCasa booking #${bookingId}`,
          },
          success_url: `${config.publicUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${config.publicUrl}/?cancelled=1#book`,
        });
      } catch (err) {
        // Release the hold if we could not start payment.
        await nowistay.updateBooking({ booking_id: bookingId, status: 'cancelled', silent: true }).catch(() => {});
        clearCalendarCache();
        throw err;
      }
      res.json({ url: session.url, sessionId: session.id, bookingId });
    } catch (err) { next(err); }
  });

  // Success page asks for a short summary of the paid session.
  app.get('/api/checkout/session', async (req, res, next) => {
    try {
      if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
      const id = String(req.query.session_id || '');
      if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return res.status(400).json({ error: 'Invalid session' });
      const s = await stripe.checkout.sessions.retrieve(id);
      res.json({
        paid: s.payment_status === 'paid',
        bookingId: s.metadata && s.metadata.nowistay_booking_id,
        arrival: s.metadata && s.metadata.arrival,
        departure: s.metadata && s.metadata.departure,
        email: s.customer_details && s.customer_details.email,
        amount: s.amount_total / 100,
        currency: (s.currency || '').toUpperCase(),
      });
    } catch (err) { next(err); }
  });

  // Guest came back from Stripe without paying: release the held dates now
  // instead of waiting for the Checkout session to expire.
  app.post('/api/checkout/release', rateLimit(20, 10 * 60 * 1000), async (req, res, next) => {
    try {
      if (!stripe) return res.json({ released: false });
      const id = String((req.body && req.body.sessionId) || '');
      if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return res.status(400).json({ error: 'Invalid session' });
      const s = await stripe.checkout.sessions.retrieve(id);
      if (s.status !== 'open') return res.json({ released: false });
      await stripe.checkout.sessions.expire(id);
      const bookingId = Number(s.metadata && s.metadata.nowistay_booking_id);
      if (bookingId) {
        const booking = await nowistay.getBooking(bookingId);
        if (booking.status === 'pending') {
          await nowistay.updateBooking({ booking_id: bookingId, status: 'cancelled', silent: true });
          clearCalendarCache();
        }
      }
      res.json({ released: true });
    } catch (err) { next(err); }
  });

  // ---- manage a booking (reference + email) ------------------------------

  async function findGuestBooking(body) {
    const bookingId = parseInt(body.bookingId, 10);
    const email = clean(body.email, 320).toLowerCase();
    if (!bookingId || !EMAIL_RE.test(email)) return null;
    let booking;
    try { booking = await nowistay.getBooking(bookingId); } catch (_) { return null; }
    const bookingEmail = String(guestEmailOf(booking) || '').toLowerCase();
    if (!bookingEmail || bookingEmail !== email) return null;
    if (Number(propertyOf(booking)) && Number(propertyOf(booking)) !== propertyId) return null;
    return booking;
  }

  function summarize(booking, property) {
    const arrival = booking.arrival || booking.arrivalDate || booking.checkIn;
    const departure = booking.departure || booking.departureDate || booking.checkOut;
    return {
      bookingId: booking.id,
      status: booking.status,
      arrival,
      departure,
      adults: booking.numAdults ?? booking.num_adults,
      children: booking.numChildren ?? booking.num_children,
      amount: Number(booking.amount ?? booking.totalAmount) || null,
      currency: booking.currency || 'EUR',
      guestName: booking.guestName || booking.guest_name || [booking.guestFirstName, booking.guestLastName].filter(Boolean).join(' '),
      checkInTime: (property.checkInTime || '').slice(0, 5),
      checkOutTime: (property.checkOutTime || '').slice(0, 5),
      canCancelOnline: canCancelOnline(booking, property),
      freeCancellationDays: config.booking.freeCancellationDays,
    };
  }

  function canCancelOnline(booking, property) {
    if (!['confirmed', 'pending'].includes(booking.status)) return false;
    const channel = String(booking.channel || booking.source || 'direct').toLowerCase();
    if (channel && !/direct|manual|nowistay|website/.test(channel)) return false; // OTA bookings: cancel on the OTA
    const arrival = booking.arrival || booking.arrivalDate;
    const today = localNow(property.address && property.address.timezone).date;
    return arrival >= addDays(today, config.booking.freeCancellationDays);
  }

  app.post('/api/booking/lookup', rateLimit(20, 15 * 60 * 1000), async (req, res, next) => {
    try {
      const booking = await findGuestBooking(req.body || {});
      if (!booking) return res.status(404).json({ error: 'We could not find a booking with this reference and email.' });
      res.json(summarize(booking, await getProperty()));
    } catch (err) { next(err); }
  });

  app.post('/api/booking/cancel', rateLimit(10, 15 * 60 * 1000), async (req, res, next) => {
    try {
      const booking = await findGuestBooking(req.body || {});
      if (!booking) return res.status(404).json({ error: 'We could not find a booking with this reference and email.' });
      const property = await getProperty();
      if (!canCancelOnline(booking, property)) {
        return res.status(400).json({ error: 'This booking can no longer be cancelled online. Please contact us.' });
      }

      let refunded = false;
      if (booking.status === 'confirmed' && stripe) {
        const found = await stripe.paymentIntents.search({
          query: `metadata['nowistay_booking_id']:'${booking.id}' AND status:'succeeded'`,
        });
        for (const pi of found.data) {
          await stripe.refunds.create({ payment_intent: pi.id }, { idempotencyKey: `cancel-${booking.id}-${pi.id}` });
          refunded = true;
        }
      }
      await nowistay.updateBooking({
        booking_id: booking.id,
        status: 'cancelled',
        // The refund is made directly in Stripe above, so NowIstay must not refund again.
        cancellation_refund_mode: 'none',
        notes: `${WEB_MARKER}. Cancelled by guest online${refunded ? ', full refund issued in Stripe' : ''}.`,
      });
      clearCalendarCache();
      res.json({ cancelled: true, refunded });
    } catch (err) { next(err); }
  });

  // ---- static site --------------------------------------------------------
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'], maxAge: '1h' }));

  // ---- errors -----------------------------------------------------------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof QuoteError) return res.status(400).json({ error: err.message, code: err.code });
    if (err instanceof NowIstayError) {
      console.error('[nowistay]', err.message, JSON.stringify(err.details || '').slice(0, 500));
      const text = JSON.stringify(err.details || '').toLowerCase();
      if (err.status === 409 || text.includes('already booked') || text.includes('not available') || text.includes('unavailable')) {
        return res.status(409).json({ error: 'Sorry, these dates were just booked. Please choose other dates.' });
      }
      return res.status(502).json({ error: 'Our booking system is unavailable right now. Please try again shortly.' });
    }
    if (err && err.type && String(err.type).startsWith('Stripe')) {
      console.error('[stripe]', err.message);
      return res.status(502).json({ error: 'Payment could not be started. Please try again.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  return app;
}

function clean(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

function guestEmailOf(b) {
  return b.guestEmail || b.guest_email || b.email || (b.guest && b.guest.email) || (b.contact && b.contact.email);
}

function propertyOf(b) {
  return b.propertyId || b.property_id || (b.property && b.property.id);
}

module.exports = { createApp };

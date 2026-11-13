'use strict';

// All secrets come from environment variables. Never commit real values.
// See .env.example for the full list.

function bool(v, dflt = false) {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function int(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

const config = {
  port: int(process.env.PORT, 3000),
  publicUrl: (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, ''),

  nowistay: {
    mock: bool(process.env.NOWISTAY_MOCK),
    apiUrl: process.env.NOWISTAY_API_URL || 'https://api.nowistay.com',
    propertyId: int(process.env.NOWISTAY_PROPERTY_ID, 2553),
    // Personal API credential created in NowIstay: My account > Developer > New credential.
    clientId: process.env.NOWISTAY_CLIENT_ID || '',
    clientSecret: process.env.NOWISTAY_CLIENT_SECRET || '',
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  },

  booking: {
    // Minutes a pending (unpaid) booking holds the dates before Stripe Checkout expires.
    // Stripe requires at least 30 minutes.
    holdMinutes: Math.max(30, int(process.env.BOOKING_HOLD_MINUTES, 30)),
    // Guests can cancel online with a full refund up to this many days before arrival.
    freeCancellationDays: int(process.env.FREE_CANCELLATION_DAYS, 7),
    // How many months ahead the calendar can be browsed.
    maxMonthsAhead: int(process.env.MAX_MONTHS_AHEAD, 12),
  },
};

module.exports = config;

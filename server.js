'use strict';

try { require('dotenv').config(); } catch (_) { /* dotenv is optional */ }

const config = require('./src/config');
const { createNowIstayClient } = require('./src/nowistay');
const { createApp } = require('./src/app');

let stripe = null;
if (config.stripe.secretKey) {
  stripe = require('stripe')(config.stripe.secretKey);
} else {
  console.warn('[stripe] STRIPE_SECRET_KEY is not set. Checkout is disabled.');
}

const nowistay = createNowIstayClient(config.nowistay);
const app = createApp({ config, nowistay, stripe });

// Behind a host's proxy (Render, Fly, etc.) so req.ip is the visitor's IP.
app.set('trust proxy', 1);

app.listen(config.port, () => {
  console.log(`LuxCasa booking site on ${config.publicUrl} (port ${config.port})${config.nowistay.mock ? ' [NowIstay MOCK]' : ''}`);
});

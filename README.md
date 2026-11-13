# LuxCasa

Direct booking website for the LuxCasa apartment in Bonnevoie, Luxembourg City, served at **https://luxcasa.lu**.

- **Pricing and availability** come live from **NowIstay** (property `2553`). Change prices, minimum stays or block dates in NowIstay and the site follows within a minute.
- **Bookings** are created in NowIstay as direct bookings, so they appear on the same calendar as Airbnb and Booking.com and block those channels automatically.
- **Payments** are taken by **Stripe Checkout**. No card data touches this server.
- Guests can **look up and cancel** their booking at `/manage` with their booking number and email.

## How a booking works

1. The guest picks dates. The browser shows prices from NowIstay's calendar (`get_calendar_ari`).
2. On "Continue to secure payment" the server re-quotes from NowIstay (prices never come from the browser), creates a **pending** booking in NowIstay to hold the dates, and opens a Stripe Checkout session for the total.
3. When Stripe reports the payment (`checkout.session.completed` webhook), the server sets the NowIstay booking to **confirmed**. NowIstay then emails the guest their confirmation.
4. If the guest abandons payment, the hold is released right away when they return, or when the Stripe session expires (30 minutes).
5. From `/manage`, a guest can cancel up to `FREE_CANCELLATION_DAYS` (default 7) before arrival. The server refunds the Stripe payment in full and cancels the booking in NowIstay. Later changes go through the host by email.

Stay rules enforced from NowIstay: per-night availability, stop-sell, minimum and maximum stay, closed to arrival / departure, guest capacity, and the same-day cut-off time. Total = sum of nightly rates + cleaning fee (+ extra-guest fees if configured in NowIstay).

## Project layout

```
server.js            starts the app
src/app.js           routes: calendar, quote, checkout, Stripe webhook, manage booking
src/pricing.js       quote + stay-rule validation from NowIstay ARI data
src/nowistay.js      NowIstay client (MCP over HTTP) + a mock for local dev
src/config.js        environment variables
public/              the website (HTML, CSS, JS, photos in public/images)
test/                node:test suite (runs against the mock, no network)
```

## Run locally

```bash
npm install
npm run dev        # NOWISTAY_MOCK=true: fake calendar, nothing touches NowIstay
npm test
```

Open http://localhost:3000. To test real payments locally, copy `.env.example` to `.env`, set Stripe **test** keys, and forward webhooks with the Stripe CLI:
`stripe listen --forward-to localhost:3000/api/stripe/webhook`.

## Environment variables

All secrets live in environment variables, never in the repo. See [.env.example](.env.example).

| Variable | Purpose |
| --- | --- |
| `PUBLIC_URL` | `https://luxcasa.lu` in production (Stripe return links, www redirect) |
| `NOWISTAY_PROPERTY_ID` | `2553` |
| `NOWISTAY_ACCESS_TOKEN` | OAuth access token for the NowIstay account |
| `NOWISTAY_REFRESH_TOKEN`, `NOWISTAY_TOKEN_URL`, `NOWISTAY_CLIENT_ID`, `NOWISTAY_CLIENT_SECRET` | optional, lets the server renew the token by itself |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_live_…`) |
| `STRIPE_WEBHOOK_SECRET` | signing secret of the webhook endpoint (`whsec_…`) |
| `FREE_CANCELLATION_DAYS` | online cancellation window, default `7` |

### NowIstay access

NowIstay does not publish a REST API; it exposes its data through its hosted MCP server at `https://api.nowistay.com/mcp` with OAuth sign-in. The site calls the same tools the NowIstay assistant uses (`get_property`, `get_calendar_ari`, `create_booking_preview/confirm`, `update_booking_preview/confirm`, `get_booking`). It needs an OAuth token for the host account. Ask NowIstay support for an API/OAuth token for a server integration, or sign in once with an MCP client and copy the access + refresh token into the environment.

## Deploy to luxcasa.lu

The site is a small Node server (it must keep the Stripe and NowIstay secrets private, so static hosting such as GitHub Pages will not work). `render.yaml` deploys it on [Render](https://render.com) (Frankfurt); the `Dockerfile` works on any other container host (Fly.io, Railway, a VPS).

1. In Render: **New → Blueprint**, pick this repository. Fill in the secret environment variables when asked.
2. In the service's **Settings → Custom Domains**, `luxcasa.lu` and `www.luxcasa.lu` are already listed by the blueprint. Render shows the DNS records to create.
3. At your `.lu` domain registrar, create the records Render shows. Typically:

   | Type | Name | Value |
   | --- | --- | --- |
   | `A` | `@` (luxcasa.lu) | `216.24.57.1` |
   | `CNAME` | `www` | `luxcasa.onrender.com` (your service's address) |

   Remove any other `A`/`AAAA` records on `@`. Render issues the HTTPS certificate automatically once DNS resolves. `www.luxcasa.lu` redirects to `luxcasa.lu`.
4. In Stripe: **Developers → Webhooks → Add endpoint** `https://luxcasa.lu/api/stripe/webhook` with events `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`. Put its signing secret in `STRIPE_WEBHOOK_SECRET`.
5. Make one test booking on far-future dates with Stripe test keys, check it appears in NowIstay, then cancel it from `/manage` and switch to live keys.

## Content

The description and photo captions in `public/index.html` and `public/photos.js` are a first draft. Replace them with the wording from the Airbnb / Booking.com listings as needed. Photos are in `public/images/`.

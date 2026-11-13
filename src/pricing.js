'use strict';

// Turns NowIstay calendar data (ARI: availability, rates, inventory) into a
// quote for a stay, enforcing the stay rules NowIstay sends: per-night
// availability, stop-sell, minimum/maximum stay of the arrival night, closed to
// arrival/departure, guest capacity and the same-day booking cut-off.
// Prices are never taken from the browser; the server always quotes from
// NowIstay right before charging.

const { addDays } = require('./nowistay');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class QuoteError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'QuoteError';
    this.code = code;
  }
}

function nightsBetween(arrival, departure) {
  return Math.round((Date.parse(`${departure}T00:00:00Z`) - Date.parse(`${arrival}T00:00:00Z`)) / 86400000);
}

// Today's date and the time of day in the property's timezone.
function localNow(timezone, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'Europe/Luxembourg',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function money(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * @param {object} p
 * @param {object} p.property  NowIstay property (get_property)
 * @param {Array}  p.days      NowIstay ARI days covering arrival .. departure (inclusive)
 * @param {string} p.arrival   YYYY-MM-DD
 * @param {string} p.departure YYYY-MM-DD
 * @param {number} p.adults
 * @param {number} p.children
 * @param {Date}   [p.now]
 */
function buildQuote({ property, days, arrival, departure, adults = 1, children = 0, now = new Date() }) {
  if (!DATE_RE.test(arrival || '') || !DATE_RE.test(departure || '')) {
    throw new QuoteError('Please choose valid dates.', 'invalid_dates');
  }
  const nights = nightsBetween(arrival, departure);
  if (!(nights > 0)) throw new QuoteError('Check-out must be after check-in.', 'invalid_dates');

  adults = Number(adults) || 0;
  children = Number(children) || 0;
  if (adults < 1) throw new QuoteError('At least one adult is required.', 'invalid_guests');
  const capacity = Number(property.capacity) || 0;
  if (capacity && adults + children > capacity) {
    throw new QuoteError(`This apartment hosts up to ${capacity} guests.`, 'too_many_guests');
  }

  const tz = property.address && property.address.timezone;
  const local = localNow(tz, now);
  const cutOffDays = Number(property.cutOffDays) || 0;
  const earliest = addDays(local.date, cutOffDays);
  if (arrival < earliest) throw new QuoteError('These dates are in the past.', 'past_dates');
  if (arrival === earliest && property.cutOffTime && local.time >= property.cutOffTime.slice(0, 5)) {
    throw new QuoteError('It is too late to book for tonight. Please choose a later date.', 'cut_off');
  }

  const byDate = new Map(days.map((d) => [d.date, d]));
  const first = byDate.get(arrival);
  if (!first) throw new QuoteError('These dates are not open for booking yet.', 'unavailable');

  if (first.closed_to_arrival) throw new QuoteError('Check-in is not possible on this date.', 'closed_to_arrival');
  if (first.min_stay && nights < first.min_stay) {
    throw new QuoteError(`A minimum stay of ${first.min_stay} nights applies for this check-in date.`, 'min_stay');
  }
  if (first.max_stay && nights > first.max_stay) {
    throw new QuoteError(`The maximum stay is ${first.max_stay} nights.`, 'max_stay');
  }
  const last = byDate.get(departure);
  if (last && last.closed_to_departure) {
    throw new QuoteError('Check-out is not possible on this date.', 'closed_to_departure');
  }

  const nightly = [];
  for (let i = 0; i < nights; i++) {
    const date = addDays(arrival, i);
    const day = byDate.get(date);
    if (!day || !(day.availability > 0) || day.stop_sell || day.linked_booked) {
      throw new QuoteError('Sorry, some of these nights are no longer available.', 'unavailable');
    }
    const rate = Number(day.rate);
    if (!(rate > 0)) throw new QuoteError('Sorry, these dates cannot be booked online.', 'unavailable');
    nightly.push({ date, rate: money(rate) });
  }

  const accommodation = money(nightly.reduce((s, n) => s + n.rate, 0));
  const cleaning = money(Number(nights <= 1 && property.shortStayCleaningRate != null
    ? property.shortStayCleaningRate
    : property.defaultCleaningRate) || 0);

  let extraGuests = 0;
  if (property.guestsIncluded && property.extraGuestFee) {
    const counted = property.extraGuestFeeChildrenExempt ? adults : adults + children;
    const extra = Math.max(0, counted - Number(property.guestsIncluded));
    extraGuests = money(extra * Number(property.extraGuestFee) * nights);
  }

  const total = money(accommodation + cleaning + extraGuests);
  return {
    arrival,
    departure,
    nights,
    adults,
    children,
    currency: property.defaultNightRateCurrency || 'EUR',
    nightly,
    averageNightlyRate: money(accommodation / nights),
    accommodation,
    cleaning,
    extraGuests,
    total,
  };
}

// Simplified per-day view of the calendar for the browser.
function publicCalendar(days, property, now = new Date()) {
  const local = localNow(property.address && property.address.timezone, now);
  return days.map((d) => ({
    date: d.date,
    available: d.availability > 0 && !d.stop_sell && !d.linked_booked && d.date >= local.date && Number(d.rate) > 0,
    rate: Number(d.rate) || null,
    minStay: d.min_stay || 1,
    closedToArrival: !!d.closed_to_arrival,
    closedToDeparture: !!d.closed_to_departure,
  }));
}

module.exports = { buildQuote, publicCalendar, QuoteError, nightsBetween, localNow };

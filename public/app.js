(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const state = {
    property: null,
    days: new Map(), // date -> { available, rate, minStay, closedToArrival, closedToDeparture }
    loadedMonths: new Set(),
    viewMonth: null, // 'YYYY-MM' of the left month
    today: null,
    arrival: null,
    departure: null,
    quote: null,
  };

  const fmtMoney = (n, cur) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur || 'EUR', maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);
  const fmtDate = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const addMonths = (m, n) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7); };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(path, body) {
    const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Something went wrong. Please try again.');
    return json;
  }

  function notice(msg, isError) {
    const el = $('#notice');
    if (!msg) { el.hidden = true; return; }
    el.textContent = msg;
    el.className = 'notice' + (isError ? ' error' : '');
    el.hidden = false;
  }

  // ---------------- gallery + lightbox ----------------
  const photos = window.LUXCASA_PHOTOS || [];
  const gallery = $('#gallery');
  photos.forEach((p, i) => {
    const b = document.createElement('button');
    b.dataset.photo = i;
    b.innerHTML = `<img src="${p.src}" alt="${esc(p.alt)}" loading="lazy">`;
    gallery.appendChild(b);
  });
  const lb = $('#lightbox');
  let current = 0;
  function showPhoto(i) {
    current = (i + photos.length) % photos.length;
    const img = lb.querySelector('img');
    img.src = photos[current].src;
    img.alt = photos[current].alt;
  }
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-photo]');
    if (t) { showPhoto(Number(t.dataset.photo)); lb.showModal(); }
  });
  lb.querySelector('.close').onclick = () => lb.close();
  lb.querySelector('.prev').onclick = () => showPhoto(current - 1);
  lb.querySelector('.next').onclick = () => showPhoto(current + 1);
  lb.addEventListener('click', (e) => { if (e.target === lb) lb.close(); });
  document.addEventListener('keydown', (e) => {
    if (!lb.open) return;
    if (e.key === 'ArrowLeft') showPhoto(current - 1);
    if (e.key === 'ArrowRight') showPhoto(current + 1);
  });

  // ---------------- calendar ----------------
  async function loadMonth(month) {
    if (state.loadedMonths.has(month)) return;
    state.loadedMonths.add(month);
    try {
      const res = await api('/api/calendar?month=' + month);
      if (res.today) state.today = res.today;
      res.days.forEach((d) => { if (!state.days.has(d.date) || d.date.startsWith(month)) state.days.set(d.date, d); });
    } catch (err) {
      state.loadedMonths.delete(month);
      notice('Availability could not be loaded. Please refresh the page.', true);
    }
  }

  function isNightFree(date) {
    const d = state.days.get(date);
    return !!(d && d.available);
  }

  function rangeFree(arrival, departure) {
    for (let d = arrival; d < departure; d = addDays(d, 1)) if (!isNightFree(d)) return false;
    return true;
  }

  function canArrive(date) {
    const d = state.days.get(date);
    return !!(d && d.available && !d.closedToArrival);
  }

  function canDepart(date) {
    if (!state.arrival || state.departure || date <= state.arrival) return false;
    const d = state.days.get(date);
    if (d && d.closedToDeparture) return false;
    return rangeFree(state.arrival, date);
  }

  function renderMonth(month) {
    const [y, m] = month.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1));
    const daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const offset = (first.getUTCDay() + 6) % 7; // Monday first
    const wrap = document.createElement('div');
    wrap.className = 'month';
    ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].forEach((d) => { wrap.insertAdjacentHTML('beforeend', `<div class="dow">${d}</div>`); });
    for (let i = 0; i < offset; i++) wrap.insertAdjacentHTML('beforeend', '<span class="day blank"></span>');
    for (let day = 1; day <= daysIn; day++) {
      const date = `${month}-${String(day).padStart(2, '0')}`;
      const info = state.days.get(date);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'day';
      b.dataset.date = date;
      const asDeparture = canDepart(date);
      const asArrival = canArrive(date);
      b.disabled = !(asArrival || asDeparture);
      if (asDeparture && !asArrival) b.classList.add('checkout-only');
      if (date === state.arrival) b.classList.add('start');
      if (date === state.departure) b.classList.add('end');
      if (state.arrival && state.departure && date > state.arrival && date < state.departure) b.classList.add('in-range');
      const price = info && info.available && info.rate ? fmtMoney(info.rate, state.property && state.property.currency) : '';
      b.innerHTML = `${day}<small>${price || '&nbsp;'}</small>`;
      b.setAttribute('aria-label', `${fmtDate(date)}${price ? ', ' + price : ''}${b.disabled ? ', unavailable' : ''}`);
      wrap.appendChild(b);
    }
    return wrap;
  }

  function monthName(m) {
    return new Date(m + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }

  function renderCalendar() {
    const grid = $('#cal-grid');
    grid.innerHTML = '';
    const second = addMonths(state.viewMonth, 1);
    grid.appendChild(renderMonth(state.viewMonth));
    grid.appendChild(renderMonth(second));
    $('#cal-title').innerHTML = `<span>${monthName(state.viewMonth)}</span><span>${monthName(second)}</span>`;
    $('#prev').disabled = state.today && state.viewMonth <= state.today.slice(0, 7);
  }

  async function showMonths(month) {
    state.viewMonth = month;
    await Promise.all([loadMonth(month), loadMonth(addMonths(month, 1)), loadMonth(addMonths(month, 2))]);
    renderCalendar();
  }

  $('#prev').onclick = () => showMonths(addMonths(state.viewMonth, -1));
  $('#next').onclick = () => showMonths(addMonths(state.viewMonth, 1));

  $('#cal-grid').addEventListener('click', (e) => {
    const b = e.target.closest('.day');
    if (!b || b.disabled) return;
    const date = b.dataset.date;
    if (state.arrival && !state.departure && date > state.arrival && canDepart(date)) {
      state.departure = date;
    } else {
      state.arrival = date;
      state.departure = null;
    }
    syncInputs();
    renderCalendar();
    requestQuote();
  });

  // ---------------- form ----------------
  const arrivalInput = $('#arrival');
  const departureInput = $('#departure');

  function syncInputs() {
    arrivalInput.value = state.arrival || '';
    departureInput.value = state.departure || '';
    departureInput.min = state.arrival ? addDays(state.arrival, 1) : '';
  }

  async function onDateInput() {
    state.arrival = arrivalInput.value || null;
    state.departure = departureInput.value && departureInput.value > (state.arrival || '') ? departureInput.value : null;
    if (state.arrival) {
      await showMonths(state.arrival.slice(0, 7));
    }
    syncInputs();
    renderCalendar();
    requestQuote();
  }
  arrivalInput.addEventListener('change', onDateInput);
  departureInput.addEventListener('change', onDateInput);
  $('#adults').addEventListener('change', requestQuote);
  $('#children').addEventListener('change', requestQuote);

  let quoteSeq = 0;
  async function requestQuote() {
    const box = $('#quote');
    const fields = $('#guest-fields');
    state.quote = null;
    if (!state.arrival || !state.departure) {
      box.hidden = !state.arrival;
      box.innerHTML = state.arrival ? '<p class="muted">Now choose your check-out date.</p>' : '';
      fields.hidden = true;
      return;
    }
    const seq = ++quoteSeq;
    box.hidden = false;
    box.innerHTML = '<p class="muted">Checking price…</p>';
    try {
      const q = await api('/api/quote', {
        arrival: state.arrival,
        departure: state.departure,
        adults: Number($('#adults').value),
        children: Number($('#children').value),
      });
      if (seq !== quoteSeq) return;
      state.quote = q;
      const cur = q.currency;
      box.innerHTML = `
        <div class="line"><span>${fmtDate(q.arrival)} → ${fmtDate(q.departure)}</span></div>
        <div class="line"><span>${fmtMoney(q.averageNightlyRate, cur)} × ${q.nights} night${q.nights > 1 ? 's' : ''}</span><span>${fmtMoney(q.accommodation, cur)}</span></div>
        ${q.cleaning ? `<div class="line"><span>Cleaning fee</span><span>${fmtMoney(q.cleaning, cur)}</span></div>` : ''}
        ${q.extraGuests ? `<div class="line"><span>Extra guests</span><span>${fmtMoney(q.extraGuests, cur)}</span></div>` : ''}
        <div class="line total"><span>Total</span><span>${fmtMoney(q.total, cur)}</span></div>`;
      fields.hidden = false;
    } catch (err) {
      if (seq !== quoteSeq) return;
      box.innerHTML = `<p class="err">${esc(err.message)}</p>`;
      fields.hidden = true;
    }
  }

  $('#booking-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    if (!state.quote) return;
    if (!form.reportValidity()) return;
    const data = Object.fromEntries(new FormData(form));
    const btn = $('#pay');
    btn.disabled = true;
    btn.textContent = 'Reserving your dates…';
    notice('');
    try {
      const res = await api('/api/checkout', {
        arrival: state.arrival,
        departure: state.departure,
        adults: Number(data.adults),
        children: Number(data.children),
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email,
        phone: data.phone,
      });
      try { sessionStorage.setItem('luxcasa_checkout', res.sessionId); } catch (_) { /* ignore */ }
      window.location.href = res.url;
    } catch (err) {
      notice(err.message, true);
      btn.disabled = false;
      btn.textContent = 'Continue to secure payment';
      // Availability may have changed: reload the calendar.
      state.loadedMonths.clear();
      showMonths(state.viewMonth);
    }
  });

  // ---------------- init ----------------
  async function init() {
    const params = new URLSearchParams(location.search);
    if (params.get('cancelled')) {
      notice('Payment was cancelled and your dates were released. You can try again below.');
      let sid = null;
      try { sid = sessionStorage.getItem('luxcasa_checkout'); sessionStorage.removeItem('luxcasa_checkout'); } catch (_) { /* ignore */ }
      if (sid) await api('/api/checkout/release', { sessionId: sid }).catch(() => {});
      history.replaceState(null, '', location.pathname + '#book');
    }
    try {
      state.property = await api('/api/property');
      document.querySelectorAll('[data-fact]').forEach((el) => {
        const v = state.property[el.dataset.fact];
        if (v) el.textContent = v;
      });
      const maxGuests = state.property.capacity || 2;
      const adults = $('#adults');
      const children = $('#children');
      adults.innerHTML = Array.from({ length: maxGuests }, (_, i) => `<option${i + 1 === Math.min(2, maxGuests) ? ' selected' : ''}>${i + 1}</option>`).join('');
      children.innerHTML = Array.from({ length: maxGuests }, (_, i) => `<option>${i}</option>`).join('');
      $('#policy').textContent = `Free cancellation up to ${state.property.freeCancellationDays} days before check-in. Your dates are held for 30 minutes while you pay.`;
    } catch (_) { /* facts keep their defaults */ }
    const res = await api('/api/calendar').catch(() => null);
    const month = (res && res.month) || new Date().toISOString().slice(0, 7);
    if (res) {
      state.today = res.today;
      state.loadedMonths.add(res.month);
      res.days.forEach((d) => state.days.set(d.date, d));
      arrivalInput.min = res.today;
    }
    await showMonths(month);
  }
  init();
})();

export const TZ = 'Europe/Vienna';

export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

// localStorage kann in privaten Fenstern fehlen oder werfen – nie die App crashen lassen.
export const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem('lz:' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('lz:' + key, JSON.stringify(value)); } catch { /* ignore */ }
  },
  del(key) {
    try { localStorage.removeItem('lz:' + key); } catch { /* ignore */ }
  },
  clearCache() {
    try {
      Object.keys(localStorage).filter((k) => k.startsWith('lz:cache:')).forEach((k) => localStorage.removeItem(k));
    } catch { /* ignore */ }
  },
};

const dtf = (opts) => new Intl.DateTimeFormat('de-AT', { timeZone: TZ, ...opts });
const fDay = dtf({ weekday: 'short', day: '2-digit', month: '2-digit' });
const fTime = dtf({ hour: '2-digit', minute: '2-digit' });
const fDate = dtf({ weekday: 'long', day: 'numeric', month: 'long' });
const fKey = dtf({ year: 'numeric', month: '2-digit', day: '2-digit' });

export const fmtDay = (ts) => fDay.format(ts);
export const fmtTime = (ts) => fTime.format(ts);
export const fmtLongDate = (ts) => fDate.format(ts);
export const dayKey = (ts) => fKey.format(ts);

export function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'gerade eben';
  const m = Math.round(s / 60);
  if (m < 60) return `vor ${m} Min.`;
  const h = Math.round(m / 60);
  if (h < 24) return `vor ${h} Std.`;
  const d = Math.round(h / 24);
  return d === 1 ? 'gestern' : `vor ${d} Tagen`;
}

export function countdown(ts) {
  const m = Math.max(0, Math.round((ts - Date.now()) / 60000));
  if (m < 60) return `in ${m} Min.`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h} Std. ${m % 60} Min.`;
  const d = Math.floor(h / 24);
  return `in ${d} ${d === 1 ? 'Tag' : 'Tagen'} ${h % 24} Std.`;
}

export const norm = (s) => String(s ?? '').toLowerCase().normalize('NFC');

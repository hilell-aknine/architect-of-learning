// Vercel serverless function — קולט אירוע מדידה מדף הנחיתה וכותב אותו ל-page_events.
//
// למה זה קיים: מטא סופרת רק מה שהיא רואה, ואין לנו שום דרך להצליב אותה.
// בלי מכנה משלנו אי אפשר לחשב אחוז המרה, ובוודאי לא להשוות בין שתי גרסאות קופי.
//
// הבדל מהותי מ-api/lead.js: ליד לעולם לא נאבד, ולכן שם כישלון מחזיר 500.
// כאן ההפך. אירוע מדידה הוא לא נכס, והוא לעולם לא יפיל בקשה למבקר.
// כל תקלה מוחזרת כ-204 ונרשמת בלוג. עדיף לאבד נקודת דאטה מאשר להאט דף.
//
// אפס מידע מזהה נכנס לכאן. לא שם, לא טלפון, לא טקסט שהוקלד.
//
// משתני סביבה (Vercel → Project → Settings → Environment Variables):
//   SUPABASE_URL                אותו אחד של api/lead.js
//   SUPABASE_SERVICE_ROLE_KEY   service_role, צד שרת בלבד
// בלי שניהם הפונקציה פשוט לא כותבת, ומחזירה 204. שום דבר לא נשבר.

const TABLE = 'page_events';

// רשימה סגורה. אירוע שלא כאן נזרק בשקט, כדי שאף אחד לא יוכל להזריק זבל לטבלה.
const ALLOWED = new Set([
  'view', 'cta_click', 'video_play', 'scroll_50', 'scroll_90',
  'form_start', 'form_submit'
]);

const ALLOWED_VARIANTS = new Set(['A', 'B']);

function cleanEnv(v) {
  return typeof v === 'string' ? v.trim().replace(/^["']|["']$/g, '') : '';
}

function str(v, max) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}

function sanitizeUtm(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!/^utm_[a-z_]{1,30}$/i.test(k)) continue;
    const val = str(String(v), 120);
    if (val) out[k] = val;
  }
  return Object.keys(out).length ? out : null;
}

function sanitizeExtra(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (n++ >= 10) break;
    if (!/^[a-z0-9_]{1,30}$/i.test(k)) continue;
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 120);
  }
  return Object.keys(out).length ? out : null;
}

async function fetchWithTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export default async function handler(req, res) {
  // sendBeacon שולח POST בלבד. כל דבר אחר לא מעניין אותנו.
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }

  try {
    let body = req.body;
    // sendBeacon שולח Blob, ולכן ב-Vercel הגוף יכול להגיע כמחרוזת.
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    if (!body || typeof body !== 'object') body = {};

    const event = str(body.event, 40);
    if (!ALLOWED.has(event)) return res.status(204).end();

    const variantRaw = str(body.variant, 4).toUpperCase();
    const variant = ALLOWED_VARIANTS.has(variantRaw) ? variantRaw : null;

    const supabaseUrl = cleanEnv(process.env.SUPABASE_URL).replace(/\/+$/, '');
    const serviceKey = cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY);
    if (!supabaseUrl || !serviceKey) {
      console.warn('[event] Supabase not configured, dropping event', { event, variant });
      return res.status(204).end();
    }

    const row = {
      event,
      variant,
      sid: str(body.sid, 64) || null,
      page: str(body.page, 60) || 'index',
      utm: sanitizeUtm(body.utm),
      referrer: str(body.referrer || req.headers?.referer || '', 300) || null,
      user_agent: str(req.headers?.['user-agent'] || '', 400) || null,
      extra: sanitizeExtra(body.extra)
    };

    const r = await fetchWithTimeout(
      `${supabaseUrl}/rest/v1/${TABLE}`,
      {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        },
        body: JSON.stringify(row)
      },
      4000
    );

    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error('[event] insert failed', r.status, detail, { event, variant });
    }
  } catch (e) {
    // בכוונה בולעים. אירוע מדידה לא מפיל בקשה של מבקר.
    console.error('[event] error', e && e.message);
  }

  return res.status(204).end();
}

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
//
// wa_click נוסף 9.9.2026: הכפתור "לתאם את שיחת האבחון" בדף האבחון היה עד היום
// האירוע היחיד שבאמת אומר "אני רוצה לדבר", והוא לא נמדד בשום מקום. לכן אחרי
// שליד נחת במסד לא הייתה שום דרך לדעת אם הוא ביקש שיחה או רק רצה לראות תוצאה.
//
// אירועי הסרטון נוספו 12.10.2026 עם הטמעת ה-VSL (y1z1dZ30mV0), כדי לראות
// כמה ראו את הנגן, כמה לחצו, ואיפה בדיוק נושרים. הפירוט ב-extra:
//   vid = מזהה יוטיוב · vl = תווית גרסת הסרטון · pos = המיקום הכי רחוק שהגיע אליו (שניות)
//   w = שניות צפייה בפועל בטעינת הדף הזו · pct = אחוז · dur = אורך · dev = m/t/d · pl = מזהה טעינת דף
//   video_ready    הנגן הוצג בדף (המכנה של "כמה ראו את הסרטון")
//   video_start    הסרטון באמת התחיל להתנגן (לא רק לחיצה על החזית)
//   video_hb       פעימה כל 10 שניות צפייה, נושאת את pos ו-w המעודכנים
//   video_progress אבן דרך: pct = 10/25/50/75/90/100
//   video_pause / video_end
// הדוח שקורא אותם: api/video-report.js.
const ALLOWED = new Set([
  'view', 'cta_click', 'video_play', 'scroll_50', 'scroll_90',
  'form_start', 'form_submit', 'wa_click',
  'video_ready', 'video_start', 'video_hb', 'video_progress', 'video_pause', 'video_end'
]);

// ---------- הגבלת קצב ----------
// הנקודה הזו פתוחה לכל העולם (sendBeacon בלי סוד), ולכן בלי תקרה מישהו
// יכול להציף את הטבלה. התקרה היא לכל IP, בחלון של דקה, בזיכרון של המופע.
// זו הגנה סבירה ולא הרמטית: מופע חדש של הפונקציה מתחיל ממונה ריק.
// 90 בדקה = פי 15 ממה שצופה אמיתי מייצר (פעימה כל 10 שניות + אירועי דף).
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = 90;
const rlHits = new Map();

function clientIp(req) {
  const xf = req.headers?.['x-forwarded-for'];
  if (typeof xf === 'string' && xf) return xf.split(',')[0].trim();
  return req.headers?.['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

function rateLimited(ip) {
  const now = Date.now();
  if (rlHits.size > 5000) {
    for (const [k, v] of rlHits) if (now - v.start > RL_WINDOW_MS) rlHits.delete(k);
  }
  const cur = rlHits.get(ip);
  if (!cur || now - cur.start > RL_WINDOW_MS) {
    rlHits.set(ip, { start: now, n: 1 });
    return false;
  }
  cur.n += 1;
  return cur.n > RL_MAX;
}

const ALLOWED_VARIANTS = new Set(['A', 'B']);

// דף האבחון יושב על מארח אחר (GitHub Pages), ולכן בלי CORS הדפדפן חוסם את
// הבקשה ממנו עוד לפני שהיא יוצאת. רשימה סגורה בכוונה: כל מארח אחר לא יקבל
// כותרת CORS, וכך הטבלה לא נפתחת לכתיבה מאתרים זרים.
const ALLOWED_ORIGINS = new Set([
  'https://hilell-aknine.github.io',
  'https://expert-clone-diagnostic.vercel.app',
  'https://architect-of-learning.vercel.app'
]);

function applyCors(req, res) {
  const origin = req.headers?.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

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
    if (typeof v === 'number') {
      // מספר לא סופי או מופרך נזרק, כדי שזבל לא יעוות את עקומת הצפייה.
      if (Number.isFinite(v) && Math.abs(v) <= 1e6) out[k] = Math.round(v * 10) / 10;
    } else if (typeof v === 'boolean') out[k] = v;
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
  applyCors(req, res);

  // בקשת ההקדמה של הדפדפן לפני POST חוצה-מארח.
  if (req.method === 'OPTIONS') return res.status(204).end();

  // sendBeacon שולח POST בלבד. כל דבר אחר לא מעניין אותנו.
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
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

    if (rateLimited(clientIp(req))) {
      console.warn('[event] rate limited', { event });
      return res.status(204).end();
    }

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

// site/live/ — "live features" sales tool. This endpoint powers ONE feature:
// "כניסה בלחיצה אחת מהודעת וואטסאפ, בלי סיסמה" (the welcome-learner magic-link pattern
// already proven live in ram-alus-portal). Pressing the button in a real sales meeting
// makes this happen for real, on Hillel's own phone, in front of the prospect:
//
//   1. Ask Supabase Auth (admin API) to mint a real magic-link for Hillel's own demo account.
//   2. Resolve that link server-side (GoTrue redirects with the session in a URL fragment) —
//      we never let the visitor's browser hit Supabase directly, we just relay the fragment.
//   3. Send a real WhatsApp message containing our own /live/welcome.html#<session> link,
//      via Green API, to Hillel's own phone.
//
// The phone buzzing IS the proof. Nothing here is recorded, staged or faked — see hindsight.md
// (2026-08-16) for the curl trail that proved this end to end before any code was written.
//
// REQUIRED env vars (Vercel → Project → Settings → Environment Variables):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   — same ones already used by api/lead.js
//   LIVE_FEATURES_PASSCODE                    — shared passcode gate (see site/live/index.html)
//   LIVE_DEMO_GREEN_ID_INSTANCE, LIVE_DEMO_GREEN_API_TOKEN,
//   LIVE_DEMO_GREEN_API_HOST (default https://api.green-api.com), LIVE_DEMO_NOTIFY_PHONE
//
// Never hardcode a fallback for LIVE_FEATURES_PASSCODE — if it's not configured, the
// endpoint refuses to run rather than silently accept any caller.
//
// 🔒 הוקשח 21.10.2026:
//   - הקישור (סשן אמיתי של חשבון הדמו) נשלח רק בוואטסאפ. הוא לא חוזר בגוף התשובה,
//     כי מי שמחזיק את קוד הגישה לא אמור לקבל ממנו כניסה לחשבון.
//   - השוואת קוד הגישה בזמן קבוע (גיבוב SHA-256 + timingSafeEqual).
//   - הגבלת ניסיונות לכל IP, בזיכרון המופע (אותו דפוס כמו api/video-report.js):
//     10 קודים שגויים בעשר דקות = חסימה, ו-10 קישורים בעשר דקות לכל היותר.
//     הגנה סבירה ולא הרמטית: מופע חדש של הפונקציה מתחיל ממונה ריק.

import crypto from 'node:crypto';

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return ha.length === hb.length && crypto.timingSafeEqual(ha, hb);
}

const RL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_MAX = 10;
const SEND_MAX = 10;
const failHits = new Map();
const sendHits = new Map();

function clientIp(req) {
  const xf = req.headers?.['x-forwarded-for'];
  if (typeof xf === 'string' && xf) return xf.split(',')[0].trim();
  return req.headers?.['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}
function overLimit(map, ip, max) {
  const v = map.get(ip);
  return !!v && Date.now() - v.start < RL_WINDOW_MS && v.n >= max;
}
function bump(map, ip) {
  const now = Date.now();
  if (map.size > 5000) for (const [k, v] of map) if (now - v.start > RL_WINDOW_MS) map.delete(k);
  const v = map.get(ip);
  if (!v || now - v.start > RL_WINDOW_MS) map.set(ip, { start: now, n: 1 });
  else v.n += 1;
}

function cleanEnv(v) {
  return (v == null ? '' : String(v)).trim().replace(/^=+/, '').trim();
}

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const passcode = cleanEnv(process.env.LIVE_FEATURES_PASSCODE);
  if (!passcode) {
    return res.status(500).json({ error: 'server_not_configured', detail: 'LIVE_FEATURES_PASSCODE missing' });
  }
  const ip = clientIp(req);
  if (overLimit(failHits, ip, FAIL_MAX)) {
    return res.status(429).json({ error: 'too_many_attempts' });
  }
  const supplied = cleanEnv(req.headers['x-live-passcode']);
  if (!supplied || !safeEqual(supplied, passcode)) {
    bump(failHits, ip);
    return res.status(401).json({ error: 'bad_passcode' });
  }
  if (overLimit(sendHits, ip, SEND_MAX)) {
    return res.status(429).json({ error: 'too_many_links' });
  }
  bump(sendHits, ip);

  const SUPABASE_URL = cleanEnv(process.env.SUPABASE_URL);
  const SERVICE_KEY = cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const DEMO_EMAIL = cleanEnv(process.env.LIVE_DEMO_LOGIN_EMAIL) || 'htjewelry.a474@gmail.com';

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'server_not_configured', detail: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing' });
  }

  try {
    // 1. Mint a real magic link (this is the exact call welcome-learner/index.ts makes).
    const genResp = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'magiclink', email: DEMO_EMAIL }),
    }, 10000);
    const genJson = await genResp.json().catch(() => null);
    if (!genResp.ok || !genJson?.action_link) {
      // בלי detail: תשובת generate_link מכילה גם email_otp ו-hashed_token.
      return res.status(502).json({ error: 'supabase_generate_link_failed', status: genResp.status });
    }

    // 2. Resolve it server-side: GoTrue answers with a 303 whose Location carries
    //    #access_token=...&refresh_token=...&expires_in=... . We only need that fragment.
    const verifyResp = await fetchWithTimeout(genJson.action_link, { redirect: 'manual' }, 10000);
    const location = verifyResp.headers.get('location');
    const hashIdx = location ? location.indexOf('#') : -1;
    if (!location || hashIdx === -1) {
      return res.status(502).json({ error: 'supabase_verify_no_fragment', detail: { status: verifyResp.status } });
    }
    const fragment = location.slice(hashIdx); // "#access_token=...&..."

    const origin = `https://${req.headers.host}`;
    const finalLink = `${origin}/live/welcome.html${fragment}`;

    // 3. Send it over real WhatsApp (Green API), best-effort — mirrors api/lead.js's pattern.
    const gId = cleanEnv(process.env.LIVE_DEMO_GREEN_ID_INSTANCE);
    const gToken = cleanEnv(process.env.LIVE_DEMO_GREEN_API_TOKEN);
    const gHost = cleanEnv(process.env.LIVE_DEMO_GREEN_API_HOST) || 'https://api.green-api.com';
    const notifyPhone = cleanEnv(process.env.LIVE_DEMO_NOTIFY_PHONE) || '972549116092';

    let sent = false;
    let sendError = null;
    if (gId && gToken) {
      try {
        const waResp = await fetchWithTimeout(`${gHost}/waInstance${gId}/sendMessage/${gToken}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chatId: `${notifyPhone}@c.us`,
            message: `🔑 הכניסה שלך, בלי סיסמה — בדיוק מה שהתלמיד שלך יקבל:\n${finalLink}\n\n(קישור אמיתי, תקף לשעה. נוצר עכשיו ממש דרך Supabase.)`,
          }),
        }, 10000);
        const waJson = await waResp.json().catch(() => null);
        sent = waResp.ok && !!waJson?.idMessage;
        if (!sent) sendError = JSON.stringify(waJson);
      } catch (e) {
        sendError = e.message;
      }
    } else {
      sendError = 'green_api_not_configured';
    }

    // finalLink לא חוזר כאן בכוונה: הוא סשן אמיתי, והערוץ היחיד שלו הוא הוואטסאפ.
    return res.status(200).json({ ok: true, sent, sendError });
  } catch (e) {
    return res.status(500).json({ error: 'unexpected', detail: e.message });
  }
}

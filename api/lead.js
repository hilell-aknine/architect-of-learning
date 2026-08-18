// Vercel serverless function — receives a landing-page / campaign lead.
//
// ORDER OF OPERATIONS (this is the whole point of the rewrite):
//   1. Validate.
//   2. PERSIST to Supabase (table: campaign_leads). If this fails → return a real 500 so the
//      page can tell the visitor something went wrong. A lead must never be lost silently.
//   3. THEN try to notify Hillel on WhatsApp via Green API. This is best-effort only —
//      the lead is already safe in the DB. The result is written back to notified / notify_error.
//
// Secrets are read from environment variables ONLY (Vercel → Project → Settings → Environment Variables).
// Never hardcode a key or token here, and never fall back to a default token.
//
//   REQUIRED (lead is lost without these):
//     SUPABASE_URL                e.g. https://vrqtelhjuydocxcletel.supabase.co
//     SUPABASE_SERVICE_ROLE_KEY   service_role key (server-side only — never expose to the browser)
//
//   OPTIONAL (WhatsApp notification only):
//     GREEN_API_URL               e.g. https://7103xxxxxx.api.greenapi.com
//     GREEN_API_INSTANCE          the idInstance (digits)
//     GREEN_API_TOKEN             the apiTokenInstance
//     LEAD_NOTIFY_CHAT            defaults to 972549116092@c.us

const TABLE = 'campaign_leads';
const DEFAULT_NOTIFY_CHAT = '972549116092@c.us';
const DUPLICATE_WINDOW_MS = 60 * 1000; // same phone twice inside a minute → treat as a double-submit

// Best-effort in-process guard against double-submits. Serverless instances are ephemeral and there
// may be several of them, so this is only the fast path — the authoritative check is done in the DB.
const recentSubmits = new Map();

function pruneRecentSubmits(now) {
  for (const [key, ts] of recentSubmits) {
    if (now - ts > DUPLICATE_WINDOW_MS) recentSubmits.delete(key);
  }
}

// Defensive: strip stray leading '=' and surrounding whitespace that can sneak in
// when pasting values into the Vercel dashboard.
function cleanEnv(v) {
  return (v == null ? '' : String(v)).trim().replace(/^=+/, '').trim();
}

function str(v, max) {
  if (v == null) return '';
  return String(v).trim().slice(0, max);
}

function digitsOnly(v) {
  return String(v || '').replace(/\D/g, '');
}

function clampPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

function toSeconds(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(Math.min(n, 86400) * 10) / 10;
}

// utm is a jsonb column — keep it a small, flat, string-valued object.
function sanitizeUtm(raw) {
  let src = raw;
  if (typeof src === 'string') {
    try { src = JSON.parse(src); } catch { return {}; }
  }
  if (!src || typeof src !== 'object' || Array.isArray(src)) return {};
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(src)) {
    if (n >= 15) break;
    if (v == null || typeof v === 'object') continue;
    const key = str(k, 60);
    if (!key) continue;
    out[key] = str(v, 300);
    n++;
  }
  return out;
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

  try {
    const body =
      typeof req.body === 'string'
        ? JSON.parse(req.body || '{}')
        : (req.body && typeof req.body === 'object' ? req.body : {});

    // ---------- 1. validate ----------
    const name = str(body.name, 120);
    const phone = str(body.phone, 40);
    const business = str(body.business, 200);
    const students = str(body.students, 120);
    // Backward compatible: index.html still sends `source`, campaign.html sends `adSource`.
    const adSource = str(body.adSource || body.source, 120) || 'landing';
    const page = str(body.page, 120) || 'index';
    const referrer = str(body.referrer || req.headers?.referer, 500);
    const userAgent = str(req.headers?.['user-agent'], 500);
    const utm = sanitizeUtm(body.utm);
    const videoWatchedPct = clampPct(body.videoWatchedPct);
    const videoSeconds = toSeconds(body.videoSeconds);
    const videoCompleted = body.videoCompleted === true || body.videoCompleted === 'true';

    const phoneDigits = digitsOnly(phone);
    if (!name || phoneDigits.length < 9) {
      return res.status(400).json({ error: 'missing_or_invalid' });
    }

    // ---------- 1b. flood guard (in-process fast path) ----------
    const now = Date.now();
    pruneRecentSubmits(now);
    const last = recentSubmits.get(phoneDigits);
    if (last && now - last < DUPLICATE_WINDOW_MS) {
      console.warn('[lead] duplicate submit within window (memory) — skipping insert');
      return res.status(200).json({ ok: true, duplicate: true, delivered: false });
    }
    recentSubmits.set(phoneDigits, now);

    // ---------- 2. persist to Supabase (MUST succeed) ----------
    const supabaseUrl = cleanEnv(process.env.SUPABASE_URL).replace(/\/+$/, '');
    const serviceKey = cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY);

    // The DB is the preferred system of record, but it is not the ONLY one. While the Supabase
    // project is unavailable (or simply not configured yet), the WhatsApp notification becomes the
    // system of record instead. The one thing that must never happen is answering "ok" to the
    // visitor when the lead reached neither of them — that is checked at the end of this handler.
    const hasSupabase = !!(supabaseUrl && serviceKey);
    let saved = false;

    if (!hasSupabase) {
      console.warn(
        '[lead] Supabase not configured — falling back to WhatsApp-only delivery for this lead.',
        { page, adSource }
      );
    }

    const restBase = `${supabaseUrl}/rest/v1/${TABLE}`;
    // New tables need the schema profile headers, otherwise PostgREST answers with a schema error.
    const sbHeaders = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      'Accept-Profile': 'public',
      'Content-Profile': 'public'
    };

    // Authoritative duplicate check — survives cold starts and multiple instances.
    if (hasSupabase) {
      try {
        const since = new Date(now - DUPLICATE_WINDOW_MS).toISOString();
        const dupUrl =
          `${restBase}?select=id&phone=eq.${encodeURIComponent(phone)}` +
          `&created_at=gte.${encodeURIComponent(since)}&limit=1`;
        const dupRes = await fetchWithTimeout(dupUrl, { method: 'GET', headers: sbHeaders }, 6000);
        if (dupRes.ok) {
          const rows = await dupRes.json().catch(() => []);
          if (Array.isArray(rows) && rows.length > 0) {
            console.warn('[lead] duplicate submit within window (db) — skipping insert');
            return res.status(200).json({ ok: true, duplicate: true, delivered: false });
          }
        } else {
          console.error('[lead] duplicate pre-check failed', dupRes.status, await dupRes.text().catch(() => ''));
        }
      } catch (e) {
        // A failed pre-check must never block a real lead from being saved.
        console.error('[lead] duplicate pre-check error', e && e.message);
      }
    }

    const row = {
      name,
      phone,
      business: business || null,
      students: students || null,
      ad_source: adSource,
      utm,
      video_watched_pct: videoWatchedPct,
      video_seconds: videoSeconds,
      video_completed: videoCompleted,
      page,
      referrer: referrer || null,
      user_agent: userAgent || null,
      notified: false,
      notify_error: null
    };

    let leadId = null;
    if (hasSupabase) {
      try {
        const insertRes = await fetchWithTimeout(
          restBase,
          {
            method: 'POST',
            headers: { ...sbHeaders, Prefer: 'return=representation' },
            body: JSON.stringify(row)
          },
          9000
        );

        if (!insertRes.ok) {
          const detail = await insertRes.text().catch(() => '');
          console.error('[lead] Supabase insert FAILED', insertRes.status, detail, { name, phone, page, adSource });
          // Deliberately NOT returning here: WhatsApp is still a live chance to deliver this lead.
          // The final check at the bottom fails the request only if BOTH channels failed.
        } else {
          const inserted = await insertRes.json().catch(() => null);
          leadId = Array.isArray(inserted) && inserted[0] ? inserted[0].id : null;
          saved = true;
        }
      } catch (e) {
        console.error('[lead] Supabase insert ERROR', e && e.message, { name, phone, page, adSource });
      }
    }

    // ---------- 3. notify on WhatsApp (allowed to fail) ----------
    let delivered = false;
    let notifyError = null;

    const base = cleanEnv(process.env.GREEN_API_URL).replace(/\/+$/, '');
    const instance = cleanEnv(process.env.GREEN_API_INSTANCE);
    const token = cleanEnv(process.env.GREEN_API_TOKEN);
    const chatId = cleanEnv(process.env.LEAD_NOTIFY_CHAT) || DEFAULT_NOTIFY_CHAT;

    if (!base || !instance || !token) {
      notifyError = 'green_api_env_missing';
      console.error('[lead] Green API env vars missing — lead SAVED but not delivered. lead_id:', leadId);
    } else {
      const lines = [
        '🟢 ליד חדש · קמפיין בניית פורטלים',
        `שם: ${name}`,
        `טלפון: ${phone}`
      ];
      if (business) lines.push(`עסק: ${business}`);
      if (students) lines.push(`תלמידים: ${students}`);
      lines.push(`מקור: ${adSource}`);
      lines.push(
        `צפה ב-${videoWatchedPct}% מהסרטון` +
          (videoCompleted ? ' (סיים את כל הסרטון)' : '') +
          (videoSeconds ? ` · ${Math.round(videoSeconds)} שניות` : '')
      );
      lines.push('רוצה לשריין שיחת אסטרטגיה.');
      const message = lines.join('\n');

      try {
        const gr = await fetchWithTimeout(
          `${base}/waInstance${instance}/sendMessage/${token}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId, message })
          },
          9000
        );

        if (gr.ok) {
          delivered = true;
        } else {
          const detail = await gr.text().catch(() => '');
          notifyError = `green_api_http_${gr.status}: ${detail}`.slice(0, 500);
          console.error('[lead] Green API send failed', gr.status, detail, 'lead_id:', leadId);
        }
      } catch (e) {
        notifyError = `green_api_exception: ${e && e.message}`.slice(0, 500);
        console.error('[lead] Green API send error', e && e.message, 'lead_id:', leadId);
      }
    }

    // ---------- 3b. write the notification result back to the row ----------
    if (leadId) {
      try {
        const patchRes = await fetchWithTimeout(
          `${restBase}?id=eq.${encodeURIComponent(leadId)}`,
          {
            method: 'PATCH',
            headers: { ...sbHeaders, Prefer: 'return=minimal' },
            body: JSON.stringify({ notified: delivered, notify_error: notifyError })
          },
          6000
        );
        if (!patchRes.ok) {
          console.error('[lead] notify-status update failed', patchRes.status, await patchRes.text().catch(() => ''));
        }
      } catch (e) {
        console.error('[lead] notify-status update error', e && e.message);
      }
    }

    // ---------- 4. the only rule that really matters ----------
    // The lead must have reached AT LEAST ONE of the two channels. If it reached neither, say so
    // honestly with a 500 so the page can show a fallback (a direct WhatsApp link) instead of a
    // thank-you screen that quietly swallowed a paid click.
    if (!saved && !delivered) {
      console.error('[lead] LEAD NOT DELIVERED — neither DB nor WhatsApp accepted it.', {
        name, phone, page, adSource, notifyError
      });
      recentSubmits.delete(phoneDigits);
      return res.status(500).json({ error: 'not_delivered' });
    }

    return res.status(200).json({ ok: true, saved, delivered });
  } catch (e) {
    // Unknown failure before/around the save — report it honestly, generic message to the client.
    console.error('[lead] handler error', e);
    return res.status(500).json({ error: 'server_error' });
  }
}

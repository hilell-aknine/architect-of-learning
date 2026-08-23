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
//
//   OPTIONAL (Meta Conversions API — server-side Lead event):
//     META_PIXEL_ID               the pixel the campaign optimises on
//     META_CAPI_TOKEN             a Conversions API access token for that pixel
//     META_TEST_EVENT_CODE        only while testing in Events Manager; remove afterwards

import { createHash } from 'node:crypto';

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

// Meta wants every identifier normalised the same way on both ends, then SHA-256 hex.
function sha256(v) {
  return createHash('sha256').update(String(v)).digest('hex');
}

// E.164 without the plus. Israeli mobiles arrive as 05x-xxx-xxxx far more often than as 9725x…,
// so a bare leading zero is expanded rather than hashed as-is — an unnormalised number simply
// fails to match and the event lands with no identity attached.
function normalizePhoneForMeta(raw) {
  let d = digitsOnly(raw);
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = '972' + d.slice(1);
  else if (d.length === 9) d = '972' + d;
  return d;
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
    // Shared with the browser pixel so Meta collapses the two into one Lead instead of counting two.
    const eventId = str(body.eventId, 64);

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
      // wa.me needs the international form. Israeli leads arrive as 05X / 054-XXX-XXXX.
      const waDigits = phoneDigits.startsWith('972')
        ? phoneDigits
        : '972' + phoneDigits.replace(/^0+/, '');

      // Vercel functions run in UTC. Stamp Israel time explicitly or the hour is wrong.
      const stamp = new Intl.DateTimeFormat('he-IL', {
        timeZone: 'Asia/Jerusalem',
        day: 'numeric', month: 'numeric',
        hour: '2-digit', minute: '2-digit'
      }).format(new Date());

      // Which ad brought them. The browser sends the full UTM string in the referer header.
      const adMatch = /utm_content=([^&\s]+)/.exec(referrer || '');
      let adName = adSource;
      if (adMatch) {
        try { adName = decodeURIComponent(adMatch[1]); } catch { adName = adMatch[1]; }
      }

      const lines = [
        'הילל, ליד חדש 🟢',
        'בניית פורטלים',
        '',
        name,
        phone
      ];
      if (business) lines.push(`עסק: ${business}`);
      if (students) lines.push(`תלמידים: ${students}`);
      lines.push(`${stamp} · ${adName}`);
      lines.push(
        `צפה ב-${videoWatchedPct}% מהסרטון` +
          (videoCompleted ? ' (סיים את כל הסרטון)' : '') +
          (videoSeconds ? ` · ${Math.round(videoSeconds)} שניות` : '')
      );
      lines.push('');
      lines.push(`פתח שיחה: https://wa.me/${waDigits}`);
      const message = lines.join('\n');

      try {
        // A disconnected Green API instance still answers 200 with a valid-looking idMessage,
        // so HTTP 200 is NOT proof of delivery. Two real leads (20-21.8) were written with
        // notified=true and never reached anyone. Gate the send on the instance state first.
        let state = null;
        try {
          const sr = await fetchWithTimeout(
            `${base}/waInstance${instance}/getStateInstance/${token}`,
            { method: 'GET' },
            6000
          );
          if (sr.ok) state = (await sr.json().catch(() => ({})))?.stateInstance || null;
          else state = `http_${sr.status}`;
        } catch (e) {
          state = `unreachable: ${e && e.message}`;
        }

        if (state !== 'authorized') {
          notifyError = `green_api_not_authorized (state=${state})`.slice(0, 500);
          console.error(
            '[lead] Green API instance is NOT authorized — lead SAVED but NOT delivered.',
            'state:', state, 'lead_id:', leadId
          );
        } else {
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
            // Require the idMessage receipt too — an empty/!ok body is not a delivery.
            const payload = await gr.json().catch(() => null);
            if (payload && payload.idMessage) {
              delivered = true;
            } else {
              notifyError = `green_api_no_id_message: ${JSON.stringify(payload)}`.slice(0, 500);
              console.error('[lead] Green API returned 200 without idMessage', payload, 'lead_id:', leadId);
            }
          } else {
            const detail = await gr.text().catch(() => '');
            notifyError = `green_api_http_${gr.status}: ${detail}`.slice(0, 500);
            console.error('[lead] Green API send failed', gr.status, detail, 'lead_id:', leadId);
          }
        }
      } catch (e) {
        notifyError = `green_api_exception: ${e && e.message}`.slice(0, 500);
        console.error('[lead] Green API send error', e && e.message, 'lead_id:', leadId);
      }
    }

    // ---------- 3a. kick off enrichment (best-effort, never blocks the lead) ----------
    // The enricher looks the person up and sends Hillel a SECOND WhatsApp with who they are.
    // It lives on Fly because the alert above must stay instant — speed-to-lead beats detail.
    // Deliberately short timeout: the service answers 202 immediately and works in the background.
    const enrichUrl = cleanEnv(process.env.ENRICH_URL);
    const enrichToken = cleanEnv(process.env.ENRICH_TOKEN);
    if (enrichUrl && enrichToken) {
      try {
        await fetchWithTimeout(
          enrichUrl,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-enrich-token': enrichToken },
            body: JSON.stringify({ id: leadId, name, phone })
          },
          4000
        );
      } catch (e) {
        // An enrichment miss costs context, not the lead. Log and move on.
        console.error('[lead] enrich trigger failed', e && e.message, 'lead_id:', leadId);
      }
    }

    // ---------- 3c. Meta Conversions API — the server's own Lead event ----------
    // WHY THIS EXISTS: the browser already fires fbq('track','Lead') on thank-you.html, but that
    // event only arrives if the visitor's browser lets it. Measured on 23.08.2026: 8 real leads in
    // the table, 5 Lead events in Meta — a 37% gap. Several of these leads came through the
    // Instagram in-app browser, which is exactly where third-party pixels get dropped.
    //
    // That gap is not a reporting nuisance. The ad set optimises for OFFSITE_CONVERSIONS, so Meta
    // learns who to target FROM THE EVENTS IT RECEIVES — it was tuning delivery on 5 of 8 people.
    //
    // This call fires from the server, after the lead is already saved, so it cannot be blocked.
    // Both events carry the same event_id and Meta deduplicates them into one.
    // Best-effort like everything else here: a measurement miss must never cost the lead itself.
    const pixelId = cleanEnv(process.env.META_PIXEL_ID);
    const capiToken = cleanEnv(process.env.META_CAPI_TOKEN);
    if (pixelId && capiToken && eventId) {
      try {
        const metaPhone = normalizePhoneForMeta(phone);
        const nameParts = name.trim().split(/\s+/);
        const userData = {
          client_user_agent: userAgent || undefined,
          client_ip_address:
            str((req.headers?.['x-forwarded-for'] || '').split(',')[0].trim(), 64) || undefined
        };
        if (metaPhone) userData.ph = [sha256(metaPhone)];
        if (nameParts[0]) userData.fn = [sha256(nameParts[0].toLowerCase())];
        if (nameParts.length > 1) userData.ln = [sha256(nameParts.slice(1).join(' ').toLowerCase())];

        const payload = {
          data: [
            {
              event_name: 'Lead',
              event_time: Math.floor(now / 1000),
              event_id: eventId,
              action_source: 'website',
              event_source_url: referrer || undefined,
              user_data: userData,
              custom_data: { content_name: page, content_category: adSource }
            }
          ]
        };
        const testCode = cleanEnv(process.env.META_TEST_EVENT_CODE);
        if (testCode) payload.test_event_code = testCode;

        const capiRes = await fetchWithTimeout(
          `https://graph.facebook.com/v21.0/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(capiToken)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          },
          5000
        );
        if (!capiRes.ok) {
          console.error('[lead] CAPI rejected', capiRes.status, await capiRes.text().catch(() => ''));
        }
      } catch (e) {
        console.error('[lead] CAPI send failed', e && e.message, 'lead_id:', leadId);
      }
    } else if (!eventId) {
      // A page posted without an eventId. The browser pixel still works; only dedup-safe
      // server-side reporting is skipped, so this is worth seeing in the logs.
      console.warn('[lead] no eventId on submit — CAPI skipped for', page);
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

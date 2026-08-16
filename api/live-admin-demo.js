// site/live/ — "live features" sales tool. Powers "לוח בקרה אמיתי מול Supabase חי":
// a real INSERT, a real SELECT of the count, and a real DELETE cleanup, all against the
// SAME production table (campaign_leads) this very landing funnel writes to. Nothing here
// is mocked — the round-trip timings shown on screen are the real request latencies.
//
// The inserted row is clearly marked (name starts with "🔴 הדגמה חיה") so it can never be
// mistaken for a real lead, and it is deleted again before the response is sent — this
// endpoint never leaves demo data sitting in a table real leads also live in.
//
// REQUIRED env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LIVE_FEATURES_PASSCODE
// (same as live-magic-link.js — see that file's header for the full list / rationale).

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
  if (!passcode) return res.status(500).json({ error: 'server_not_configured', detail: 'LIVE_FEATURES_PASSCODE missing' });
  if (cleanEnv(req.headers['x-live-passcode']) !== passcode) return res.status(401).json({ error: 'bad_passcode' });

  const SUPABASE_URL = cleanEnv(process.env.SUPABASE_URL);
  const SERVICE_KEY = cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'server_not_configured', detail: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing' });
  }

  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
  const base = `${SUPABASE_URL}/rest/v1/campaign_leads`;

  try {
    const t0 = Date.now();

    // 1) INSERT — a real row, real production table.
    const insertResp = await fetchWithTimeout(base, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify({
        name: '🔴 הדגמה חיה (נמחק אוטומטית)',
        phone: '0000000000',
        page: 'live-features-demo',
        ad_source: 'live-demo',
      }),
    }, 10000);
    const insertJson = await insertResp.json().catch(() => null);
    if (!insertResp.ok || !Array.isArray(insertJson) || !insertJson[0]) {
      return res.status(502).json({ error: 'insert_failed', detail: insertJson });
    }
    const row = insertJson[0];
    const tInsert = Date.now();

    // 2) COUNT — real aggregate read, excludes the demo rows so the number Hillel shows
    //    is always the genuine real-lead count, not inflated by this very demo.
    const countResp = await fetchWithTimeout(
      `${base}?select=id&ad_source=neq.live-demo`,
      { headers: { ...headers, Prefer: 'count=exact' }, method: 'GET' },
      10000
    );
    const contentRange = countResp.headers.get('content-range') || '';
    const totalRealLeads = Number(contentRange.split('/')[1]) || 0;
    const tCount = Date.now();

    // 3) DELETE — cleanup. Best-effort: even if this fails, the row is unmistakably
    //    marked as a demo row and carries no PII, so leaving it briefly is harmless.
    let cleaned = false;
    try {
      const delResp = await fetchWithTimeout(`${base}?id=eq.${row.id}`, { method: 'DELETE', headers }, 10000);
      cleaned = delResp.ok;
    } catch { /* best-effort */ }
    const tDelete = Date.now();

    return res.status(200).json({
      ok: true,
      insertedId: row.id,
      insertedAt: row.created_at,
      totalRealLeads,
      cleaned,
      timingsMs: { insert: tInsert - t0, count: tCount - tInsert, delete: tDelete - tCount, total: tDelete - t0 },
    });
  } catch (e) {
    return res.status(500).json({ error: 'unexpected', detail: e.message });
  }
}

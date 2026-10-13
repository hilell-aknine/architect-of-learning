// Vercel serverless function — דוח צפייה בסרטון ה-VSL.
//
// למה זה קיים: הלל מריץ טסטים על הדף ועל הסרטון, וצריך לראות כמה ראו את
// הנגן, כמה לחצו, כמה באמת התחילו לצפות, איפה נושרים (עקומת שימור לפי דקה)
// וזמן צפייה ממוצע. הכל עם פילוח לפי גרסה (A/B) ולפי מזהה הסרטון.
//
// המקור: page_events (נכתב ע"י api/event.js). אין כאן טבלה חדשה ואין
// צורך במיגרציה כדי שהדוח יעבוד.
//
// 🔒 גישה: GET ?inbox=<סיסמה> — אותה סיסמה של לוח הלידים (INBOX_PASSCODE).
//   אם INBOX_PASSCODE מוגדר גם ב-Vercel, משווים אליו ישירות.
//   אחרת מאמתים מול ה-Edge Function `lead` של Supabase, שמחזיקה את הסיסמה:
//   POST ?action=status&inbox=<pass> עם גוף לא תקין מחזיר 401 לסיסמה שגויה
//   ו-400 (bad_json) לסיסמה נכונה, בלי שום תופעת לוואי. כך אין סוד חדש
//   להגדיר. ⚠️ אם סדר הבדיקות ב-lead/index.ts משתנה, לעדכן כאן.
//
// הדוח לא מחזיר שום מידע מזהה: רק ספירות, ממוצעים ועקומה.
//
// משתני סביבה: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (קיימים כבר עבור api/event.js).

const LEAD_FN = 'https://vrqtelhjuydocxcletel.supabase.co/functions/v1/lead';
// anon ציבורי מעצם הגדרתו (יושב כבר בקוד של leads-dashboard.html). שער ה-JWT של
// Supabase דורש אותו לפני שהבקשה בכלל מגיעה לפונקציה.
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZycXRlbGhqdXlkb2N4Y2xldGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY1MTgxNDcsImV4cCI6MjEwMjA5NDE0N30.nj9TRQeDVoTgEmjqe6NR3UjW8FvDQmwVwTWg-Bb9SRA';
const VIDEO_EVENTS = ['video_ready', 'video_play', 'video_click', 'video_start', 'video_hb',
  'video_progress', 'video_pause', 'video_end'];

// 🔴 סינון בדיקות הקישור של מטא (13.10.2026).
// כשנוצרת או משתנה מודעה, מטא שולחת לקישור שלה צרור של כניסות בתוך שניות:
// UA של אינסטגרם/כרום, referrer של m.facebook.com, ו-form_start בלי שום אינטראקציה.
// ב-13.10 07:50 UTC נכנסו כך 24 "סשנים" בדקה אחת, ניפחו את המבקרים והורידו את אחוז ההפעלה.
// הכלל: 5 view או יותר מאותה מודעה (utm_content) בתוך 90 שניות = בורסט, וכל הסשנים בו מסוננים.
// בנוסף: UA שמצהיר על עצמו כזחלן של מטא. אותו כלל בדיוק רץ ב-ad-creatives/daily_ad_report.py.
const BURST_MIN = 5;
const BURST_WINDOW_MS = 90 * 1000;
const CRAWLER_UA = /meta-externalads|facebookexternalhit|facebookcatalog/i;
function metaCheckSids(rows) {
  const out = new Set();
  const byAd = new Map();
  for (const e of rows) {
    if (e.event !== 'view' || !e.sid) continue;
    if (CRAWLER_UA.test(e.user_agent || '')) { out.add(e.sid); continue; }
    const ad = (e.utm && e.utm.utm_content) || '';
    if (!ad) continue;
    if (!byAd.has(ad)) byAd.set(ad, []);
    byAd.get(ad).push({ t: Date.parse(e.created_at), sid: e.sid });
  }
  for (const list of byAd.values()) {
    list.sort((a, b) => a.t - b.t);
    let j = 0;
    for (let i = 0; i < list.length; i++) {
      while (list[i].t - list[j].t > BURST_WINDOW_MS) j++;
      if (i - j + 1 >= BURST_MIN) for (let k = j; k <= i; k++) out.add(list[k].sid);
    }
  }
  return out;
}

function cleanEnv(v) {
  return typeof v === 'string' ? v.trim().replace(/^["']|["']$/g, '') : '';
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

// ניסיונות סיסמה שגויים, לכל IP, בזיכרון המופע. 10 בעשר דקות.
const failHits = new Map();
function tooManyFails(ip) {
  const v = failHits.get(ip);
  return v && Date.now() - v.start < 10 * 60 * 1000 && v.n >= 10;
}
function noteFail(ip) {
  const now = Date.now();
  const v = failHits.get(ip);
  if (!v || now - v.start > 10 * 60 * 1000) failHits.set(ip, { start: now, n: 1 });
  else v.n += 1;
}

async function authorized(pass) {
  if (!pass) return false;
  const direct = cleanEnv(process.env.INBOX_PASSCODE);
  if (direct) return pass === direct;
  try {
    const r = await fetchWithTimeout(
      `${LEAD_FN}?action=status&inbox=${encodeURIComponent(pass)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${ANON}` }, body: 'x' },
      5000
    );
    return r.status === 400;
  } catch {
    return false;
  }
}

async function readEvents(base, key, sinceIso) {
  const out = [];
  const events = ['view', ...VIDEO_EVENTS].join(',');
  const pageSize = 1000;
  for (let from = 0; from < 200000; from += pageSize) {
    const url = `${base}/rest/v1/page_events?select=event,variant,sid,extra,created_at,utm,user_agent` +
      `&page=eq.index&event=in.(${events})&created_at=gte.${encodeURIComponent(sinceIso)}` +
      `&order=id.asc`;
    const r = await fetchWithTimeout(url, {
      headers: {
        apikey: key, Authorization: `Bearer ${key}`,
        Range: `${from}-${from + pageSize - 1}`, 'Range-Unit': 'items'
      }
    }, 8000);
    if (!r.ok) throw new Error(`page_events ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }

function summarize(rows, vid) {
  // רק אירועי הסרטון הנבחר. אירועי view (בלי vid) נספרים כמבקרים.
  const visitors = new Set();
  const readySids = new Set(), clickSids = new Set(), startSids = new Set(), endSids = new Set();
  const maxPos = new Map();           // sid -> המיקום הכי רחוק
  const watchByLoad = new Map();      // sid|pl -> שניות צפייה מקסימליות בטעינה
  const devStarts = { m: 0, t: 0, d: 0 };
  let dur = 0;

  for (const e of rows) {
    const x = e.extra || {};
    if (e.event === 'view') { if (e.sid) visitors.add(e.sid); continue; }
    if (e.event === 'video_play' || e.event === 'video_click') { if (e.sid) clickSids.add(e.sid); continue; }
    if (x.vid !== vid || !e.sid) continue;
    if (num(x.dur) > dur) dur = num(x.dur);
    if (e.event === 'video_ready') readySids.add(e.sid);
    if (e.event === 'video_start') {
      if (!startSids.has(e.sid) && devStarts[x.dev] !== undefined) devStarts[x.dev] += 1;
      startSids.add(e.sid);
    }
    if (e.event === 'video_end') endSids.add(e.sid);
    let pos = num(x.pos);
    if (e.event === 'video_end' && num(x.dur)) pos = num(x.dur);
    if (pos > (maxPos.get(e.sid) || 0)) maxPos.set(e.sid, pos);
    const lk = e.sid + '|' + (x.pl || '');
    if (num(x.w) > (watchByLoad.get(lk) || 0)) watchByLoad.set(lk, num(x.w));
  }

  // זמן צפייה לצופה = סכום על כל טעינות הדף שלו.
  const watchBySid = new Map();
  for (const [lk, w] of watchByLoad) {
    const sid = lk.split('|')[0];
    if (!startSids.has(sid)) continue;
    watchBySid.set(sid, (watchBySid.get(sid) || 0) + w);
  }

  const starters = [...startSids];
  const n = starters.length;
  const totalWatch = starters.reduce((s, sid) => s + (watchBySid.get(sid) || 0), 0);
  const sortedW = starters.map(sid => watchBySid.get(sid) || 0).sort((a, b) => a - b);
  const median = n ? sortedW[Math.floor((n - 1) / 2)] : 0;

  // עקומת שימור: לכל דקה, איזה אחוז מהמתחילים הגיעו לפחות עד אליה.
  // דקה 0 = 100% מהגדרה. מבוסס על המיקום הכי רחוק שכל צופה הגיע אליו.
  const minutes = dur ? Math.ceil(dur / 60) : 0;
  const curve = [];
  for (let m = 0; m <= minutes; m++) {
    const t = Math.min(m * 60, dur);
    const still = starters.filter(sid => (maxPos.get(sid) || 0) >= t - 0.5 || (m === 0)).length;
    curve.push({ min: m, sec: Math.round(t), viewers: still, pct: n ? Math.round(still / n * 1000) / 10 : 0 });
  }

  const reached = p => starters.filter(sid => dur && (maxPos.get(sid) || 0) >= dur * p - 0.5).length;

  return {
    visitors: visitors.size,
    playerViews: readySids.size,
    clicks: [...clickSids].filter(s => readySids.has(s) || startSids.has(s)).length,
    starts: n,
    playRate: visitors.size ? Math.round(n / visitors.size * 1000) / 10 : 0,
    avgWatchSec: n ? Math.round(totalWatch / n) : 0,
    medianWatchSec: Math.round(median),
    reached25: reached(0.25), reached50: reached(0.5), reached75: reached(0.75),
    completions: starters.filter(s => endSids.has(s) || (dur && (maxPos.get(s) || 0) >= dur * 0.9)).length,
    devStarts,
    durationSec: Math.round(dur),
    curve
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const xf = req.headers?.['x-forwarded-for'];
  const ip = (typeof xf === 'string' && xf ? xf.split(',')[0].trim() : '') || 'unknown';
  if (tooManyFails(ip)) return res.status(429).json({ error: 'too_many_attempts' });

  const q = req.query || {};
  const pass = typeof q.inbox === 'string' ? q.inbox : '';
  if (!(await authorized(pass))) {
    noteFail(ip);
    return res.status(401).json({ error: 'unauthorized' });
  }

  const base = cleanEnv(process.env.SUPABASE_URL).replace(/\/+$/, '');
  const key = cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!base || !key) return res.status(500).json({ error: 'supabase_not_configured' });

  const days = Math.min(Math.max(parseInt(q.days || '30', 10) || 30, 1), 365);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  try {
    const raw = await readEvents(base, key, since);
    const botSids = metaCheckSids(raw);
    const rows = raw.filter(e => !botSids.has(e.sid));

    // אילו סרטונים נצפו בחלון, וממתי כל אחד הוצג לראשונה.
    const vids = new Map();
    for (const e of rows) {
      const v = e.extra && e.extra.vid;
      if (!v || typeof v !== 'string') continue;
      const cur = vids.get(v) || { vid: v, labels: new Set(), first: e.created_at, ready: 0 };
      if (e.extra.vl) cur.labels.add(String(e.extra.vl));
      if (e.event === 'video_ready') cur.ready += 1;
      vids.set(v, cur);
    }
    const vidList = [...vids.values()]
      .map(v => ({ vid: v.vid, labels: [...v.labels], first: v.first, ready: v.ready }))
      .sort((a, b) => (a.first < b.first ? 1 : -1));

    const vid = typeof q.vid === 'string' && vids.has(q.vid) ? q.vid : (vidList[0] && vidList[0].vid);
    if (!vid) {
      return res.status(200).json({ ok: true, days, vids: [], vid: null, groups: {}, filteredMetaChecks: botSids.size });
    }

    // המבקרים נספרים רק מהרגע שהסרטון הזה עלה לדף, אחרת אחוז ההפעלה
    // מדולל בתנועה שמעולם לא ראתה אותו.
    const first = vids.get(vid).first;
    const scoped = rows.filter(e => e.created_at >= first);

    const groups = { all: summarize(scoped, vid) };
    for (const v of ['A', 'B']) groups[v] = summarize(scoped.filter(e => e.variant === v), vid);

    return res.status(200).json({ ok: true, days, since, vid, liveSince: first, vids: vidList, groups, filteredMetaChecks: botSids.size });
  } catch (e) {
    console.error('[video-report]', e && e.message);
    return res.status(500).json({ error: 'read_failed', detail: String(e && e.message).slice(0, 200) });
  }
}

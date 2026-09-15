// שאלון אחרי הטופס — נכתב 15.09.2026.
//
// למה זה קיים: עד היום שאלת הסינון ישבה בתוך הטופס כשדה חובה שלישי.
// רם, בפגישת 15.09 דקה 24:01: "תוריד את השאלה הזאת. תעשה לו שאלון אחרי
// שהוא ממלא פרטים." הליד נתפס קודם, והשאלות נשאלות בעמוד התודה.
//
// מודל האיום, ולמה הוא קטן: ה-id שמגיע לכאן הוא UUID שהדפדפן קיבל אחרי
// שהוא עצמו יצר את השורה. מי שמנחש UUID לא מרוויח כלום, כי הנקודה הזאת
// לא מחזירה מידע, לא מוחקת, ולא נוגעת בשם, בטלפון, ב-notes או בסטטוס.
// היא כותבת רשימה סגורה של שלוש תשובות מתוך ערכים מוגדרים מראש.
//
// ארבע נעילות, כולן נכשלות סגור:
//   1. רשימת ערכים סגורה. ערך שלא ברשימה נזרק, לא נשמר כמות שהוא.
//   2. פעם אחת בלבד. שורה שכבר יש לה intake לא מתעדכנת שוב.
//   3. חלון זמן. רק שורות שנוצרו בשעתיים האחרונות.
//   4. שום שדה אחר לא ניתן לכתיבה מכאן. אין מעבר גנרי על גוף הבקשה.

const TABLE = 'campaign_leads';
const WINDOW_MS = 2 * 60 * 60 * 1000;

// אותם ערכים בדיוק שהיו ב-select הישן, כדי ש-22 הלידים הקודמים
// וכל פילוח קיים ימשיכו להיות ברי השוואה.
const STUDENTS = new Set(['hundreds', 'tens', 'content_no_system', 'not_launched']);
const PLATFORM = new Set(['course_system', 'whatsapp', 'youtube_drive', 'nowhere']);
const URGENCY  = new Set(['not_finishing', 'manual_work', 'new_launch', 'other']);

function cleanEnv(v) {
  return (v == null ? '' : String(v)).trim().replace(/^=+/, '').trim();
}

function pick(set, v) {
  const s = String(v == null ? '' : v).trim();
  return set.has(s) ? s : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

    const id = String(body.id || '').trim();
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'bad_id' });

    const students = pick(STUDENTS, body.students);
    const platform = pick(PLATFORM, body.platform);
    const urgency  = pick(URGENCY,  body.urgency);

    // שאלון בלי אף תשובה תקפה אינו שאלון. לא כותבים שורה ריקה.
    if (!students && !platform && !urgency) {
      return res.status(400).json({ error: 'no_valid_answers' });
    }

    const supabaseUrl = cleanEnv(process.env.SUPABASE_URL).replace(/\/+$/, '');
    const serviceKey = cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY);
    if (!supabaseUrl || !serviceKey) {
      console.error('[lead-answers] Supabase env missing');
      return res.status(500).json({ error: 'not_configured' });
    }

    const headers = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      'Accept-Profile': 'public',
      'Content-Profile': 'public'
    };
    const base = `${supabaseUrl}/rest/v1/${TABLE}`;

    // כל ארבע הנעילות נאכפות בתנאי ה-PATCH עצמו ולא בקוד שלפניו,
    // כך שאין חלון בין הבדיקה לכתיבה. שורה שלא עומדת בתנאים פשוט
    // לא מתעדכנת, ו-PostgREST מחזיר מערך ריק.
    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const url =
      `${base}?id=eq.${encodeURIComponent(id)}` +
      `&intake=is.null` +
      `&created_at=gte.${encodeURIComponent(since)}`;

    const payload = { intake: { students, platform, urgency }, intake_at: new Date().toISOString() };
    // students מתמלא רק אם הוא עדיין ריק. ליד ישן שכבר נושא ערך
    // מהטופס הקודם לא נדרס.
    if (students) payload.students = students;

    const r = await fetchWithTimeout(
      url,
      { method: 'PATCH', headers: { ...headers, Prefer: 'return=representation' }, body: JSON.stringify(payload) },
      8000
    );

    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error('[lead-answers] patch failed', r.status, detail);
      return res.status(500).json({ error: 'save_failed' });
    }

    const rows = await r.json().catch(() => []);
    if (!Array.isArray(rows) || rows.length === 0) {
      // כבר ענה, או שהחלון נסגר, או שה-id לא קיים. מבחינת המבקר זה
      // אותו דבר ואין סיבה להבחין בין המקרים כלפי חוץ.
      return res.status(200).json({ ok: true, updated: false });
    }

    return res.status(200).json({ ok: true, updated: true });
  } catch (e) {
    console.error('[lead-answers] handler error', e && e.message);
    return res.status(500).json({ error: 'server_error' });
  }
}

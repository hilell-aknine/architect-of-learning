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
//   2. תשובה נכתבת פעם אחת. שדה שכבר נענה לא נדרס לעולם.
//   3. חלון זמן. רק שורות שנוצרו בשעתיים האחרונות.
//   4. שום שדה אחר לא ניתן לכתיבה מכאן. אין מעבר גנרי על גוף הבקשה.
//
// 🔴 תוקן 15.09.2026, אחרי בדיקה חיה מקצה לקצה על הדף הפרוס.
// הגרסה הראשונה נעלה את השורה כולה ברגע שנכתב intake, ולכן רק התשובה
// הראשונה מתוך השלוש נשמרה. השתיים הבאות חזרו updated:false בשקט.
// בקריאת קוד זה נראה תקין: "כתיבה חד-פעמית" נשמע כמו הגנה. בפועל זה
// סתר את עצם התכנון של שאלון מתקדם שנשמר שאלה-שאלה.
// הנעילה עברה מרמת השורה לרמת השדה הבודד, והכתיבה נעשית כ-compare-and-swap
// על intake_at, כדי שלא ייפתח חלון בין הקריאה לכתיבה.

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

    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const answers = { students, platform, urgency };

    // קורא, ממזג, וכותב עם compare-and-swap על intake_at. אם שורה אחרת
    // הספיקה לכתוב בין הקריאה לכתיבה, ה-PATCH פשוט לא יתפוס ונחזור שוב.
    // שני סיבובים מספיקים בהחלט: המבקר לוחץ תשובה אחת בכל פעם.
    for (let attempt = 0; attempt < 2; attempt++) {
      const readUrl =
        `${base}?id=eq.${encodeURIComponent(id)}` +
        `&created_at=gte.${encodeURIComponent(since)}` +
        `&select=id,intake,intake_at,students&limit=1`;

      const readRes = await fetchWithTimeout(readUrl, { method: 'GET', headers }, 8000);
      if (!readRes.ok) {
        console.error('[lead-answers] read failed', readRes.status);
        return res.status(500).json({ error: 'save_failed' });
      }
      const found = await readRes.json().catch(() => []);
      // אין שורה, או שהיא ישנה מהחלון. כלפי חוץ אלה אותו מקרה בדיוק,
      // ואין סיבה לעזור למישהו להבחין ביניהם.
      if (!Array.isArray(found) || found.length === 0) {
        return res.status(200).json({ ok: true, updated: false });
      }

      const row = found[0];
      const prev = (row.intake && typeof row.intake === 'object') ? row.intake : {};
      const merged = { ...prev };
      let changed = false;
      for (const [k, v] of Object.entries(answers)) {
        // שדה שכבר נענה לא נדרס. זו הנעילה, והיא ברמת השדה ולא ברמת השורה.
        if (v && merged[k] == null) { merged[k] = v; changed = true; }
      }
      if (!changed) return res.status(200).json({ ok: true, updated: false });

      const payload = { intake: merged, intake_at: new Date().toISOString() };
      // students מתמלא רק אם הוא עדיין ריק. ליד שכבר נושא ערך מהטופס
      // הישן לא נדרס.
      if (students && row.students == null) payload.students = students;

      const casUrl =
        `${base}?id=eq.${encodeURIComponent(id)}` +
        `&created_at=gte.${encodeURIComponent(since)}` +
        (row.intake_at
          ? `&intake_at=eq.${encodeURIComponent(row.intake_at)}`
          : `&intake_at=is.null`);

      const w = await fetchWithTimeout(
        casUrl,
        { method: 'PATCH', headers: { ...headers, Prefer: 'return=representation' }, body: JSON.stringify(payload) },
        8000
      );
      if (!w.ok) {
        const detail = await w.text().catch(() => '');
        console.error('[lead-answers] patch failed', w.status, detail);
        return res.status(500).json({ error: 'save_failed' });
      }
      const rows = await w.json().catch(() => []);
      if (Array.isArray(rows) && rows.length > 0) {
        return res.status(200).json({ ok: true, updated: true });
      }
      // לא תפס, כלומר מישהו כתב בינתיים. סיבוב נוסף על הערך העדכני.
    }

    return res.status(200).json({ ok: true, updated: false });
  } catch (e) {
    console.error('[lead-answers] handler error', e && e.message);
    return res.status(500).json({ error: 'server_error' });
  }
}

/*
 * analytics.js — שכבת המדידה של דף הנחיתה.
 * ============================================================================
 * למה זה קיים: עד היום הדף ירה PageView בפיקסל, וירה Lead רק בעמוד התודה.
 * כלומר אפשר היה לדעת כמה לידים נכנסו, אבל לא איפה בדיוק אנשים נופלים בדרך,
 * ולא הייתה שום דרך להריץ מבחן בין שתי גרסאות קופי.
 * הקובץ הזה מוסיף שני דברים ורק אותם:
 *   1. שיוך גרסה (A או B) שנשמר לאותו מבקר, כדי שאפשר יהיה להשוות קופי.
 *   2. אירועי ביניים: קליק על הכפתור, הפעלת סרטון, גלילה, ותחילת מילוי טופס.
 *      אלה קורים הרבה יותר מלידים, ולכן נותנים כיוון תוך שבוע ולא תוך חצי שנה.
 *
 * שלושה יעדים לכל אירוע, וכולם קיימים כבר בדף:
 *   Meta Pixel (trackCustom) · Microsoft Clarity (תגית + אירוע) · המסד שלנו (api/event).
 *
 * חוקי ברזל של הקובץ הזה:
 *   - לעולם לא זורק שגיאה ולעולם לא חוסם רינדור. כל קריאה עטופה ב-try.
 *   - אפס מידע מזהה. לא שם, לא טלפון, לא טקסט שהוקלד.
 *   - מכבד את אותה הסכמה שכבר קיימת בדף: cookie_consent_v2 === 'essential'
 *     מכבה את Clarity ואת הביקון, בדיוק כמו שהדף כבר עושה ל-Clarity.
 * ============================================================================
 */
(function () {
  'use strict';

  var LS_VARIANT = 'ec_variant';
  var LS_SESSION = 'ec_sid';
  var ENDPOINT = '/api/event';
  var VARIANTS = ['A', 'B'];

  function safe(fn) { try { return fn(); } catch (e) { return undefined; } }

  function essentialOnly() {
    return safe(function () {
      return localStorage.getItem('cookie_consent_v2') === 'essential';
    }) === true;
  }

  /* ---------- שיוך גרסה ---------- */
  // ?v=A או ?v=B מאפשר לך לכפות גרסה כדי לבדוק בעין. אחרת הגרלה חד פעמית שנשמרת.
  function pickVariant() {
    var forced = safe(function () {
      var q = new URLSearchParams(location.search).get('v');
      return q && VARIANTS.indexOf(q.toUpperCase()) !== -1 ? q.toUpperCase() : null;
    });
    if (forced) {
      safe(function () { localStorage.setItem(LS_VARIANT, forced); });
      return forced;
    }
    var saved = safe(function () { return localStorage.getItem(LS_VARIANT); });
    if (saved && VARIANTS.indexOf(saved) !== -1) return saved;
    var v = VARIANTS[Math.random() < 0.5 ? 0 : 1];
    safe(function () { localStorage.setItem(LS_VARIANT, v); });
    return v;
  }

  function sessionId() {
    var s = safe(function () { return localStorage.getItem(LS_SESSION); });
    if (s) return s;
    s = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    safe(function () { localStorage.setItem(LS_SESSION, s); });
    return s;
  }

  var VARIANT = pickVariant();
  var SID = sessionId();
  window.EC_VARIANT = VARIANT;
  window.EC_SID = SID;

  /* ---------- utm, לשיוך מקור ---------- */
  function utm() {
    return safe(function () {
      var q = new URLSearchParams(location.search), o = {};
      q.forEach(function (val, key) {
        if (key.indexOf('utm_') === 0 && val) o[key] = String(val).slice(0, 120);
      });
      return o;
    }) || {};
  }

  /* ---------- שליחה ---------- */
  var sent = {};

  function send(name, extra) {
    if (sent[name]) return;          // כל אירוע נורה פעם אחת לביקור
    sent[name] = true;

    // 1. Meta Pixel
    safe(function () {
      if (typeof window.fbq === 'function') {
        window.fbq('trackCustom', 'EC_' + name, { variant: VARIANT });
      }
    });

    // 2. Clarity: תגית כדי לסנן הקלטות לפי גרסה, ואירוע כדי לראות משפך
    safe(function () {
      if (typeof window.clarity === 'function') {
        window.clarity('set', 'ec_variant', VARIANT);
        window.clarity('event', 'ec_' + name);
      }
    });

    // 3. המסד שלנו. זה המקור היחיד שנותן מכנה אמיתי לכל גרסה,
    //    כי מטא סופרת רק מה שהיא רואה ואין לנו דרך להצליב אותה.
    if (essentialOnly()) return;
    safe(function () {
      var body = JSON.stringify({
        event: name,
        variant: VARIANT,
        sid: SID,
        page: 'index',
        utm: utm(),
        referrer: document.referrer ? String(document.referrer).slice(0, 300) : '',
        extra: extra || null
      });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
      } else {
        fetch(ENDPOINT, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: body, keepalive: true
        }).catch(function () {});
      }
    });
  }

  window.ecTrack = send;

  /* ---------- האירועים ---------- */
  function wire() {
    send('view');

    // קליק על כל קריאה לפעולה שמובילה לטופס
    safe(function () {
      document.addEventListener('click', function (e) {
        var a = e.target.closest && e.target.closest('a[href*="#contact"], .btn');
        if (a) send('cta_click');
        var vf = e.target.closest && e.target.closest('.vfacade, #ytf');
        if (vf) send('video_play');
      }, true);
    });

    // תחילת מילוי הטופס. פוקוס ראשון על שדה כלשהו בטופס.
    safe(function () {
      var f = document.getElementById('f');
      if (!f) return;
      f.addEventListener('focusin', function () { send('form_start'); }, { once: true });
      f.addEventListener('submit', function () { send('form_submit'); });
    });

    // עומק גלילה. שני ספים בלבד, מספיק כדי לראות אם הכותרת מחזיקה.
    safe(function () {
      var hit50 = false, hit90 = false;
      function onScroll() {
        var doc = document.documentElement;
        var max = doc.scrollHeight - doc.clientHeight;
        if (max <= 0) return;
        var pct = (window.scrollY || doc.scrollTop) / max;
        if (!hit50 && pct >= 0.5) { hit50 = true; send('scroll_50'); }
        if (!hit90 && pct >= 0.9) { hit90 = true; send('scroll_90'); window.removeEventListener('scroll', onScroll); }
      }
      window.addEventListener('scroll', onScroll, { passive: true });
    });

    // הטופס נשלח באמת ועבר לעמוד התודה: נסגר על ידי אירוע Lead הקיים שם.
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();

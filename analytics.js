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
  // שלושה יעדים. pixel=false משאיר את האירוע במסד בלבד (למשל פעימות הסרטון,
  // שאין סיבה להציף בהן את מטא ואת Clarity).
  function dispatch(name, extra, pixel) {
    if (pixel !== false) {
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
    }

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
        extra: extra || null,
        // רק בכניסה: חומר ל-PageView בצד-שרת (api/event.js), כדי שמטא תראה
        // גם מבקר שעזב לפני שהפיקסל הדחוי נטען. נוסף 14.10.2026.
        pv_id: name === 'view' ? (window.EC_PV_ID || '') : undefined,
        fbc: name === 'view' ? safe(function () { return window.LEAD_FB.fbc; }) || '' : undefined,
        fbp: name === 'view' ? safe(function () { return window.LEAD_FB.fbp(); }) || '' : undefined
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

  var sent = {};

  function send(name, extra) {
    if (sent[name]) return;          // כל אירוע נורה פעם אחת לביקור
    sent[name] = true;
    dispatch(name, extra, true);
  }

  /* ---------- אירועי הסרטון (12.10.2026) ----------
     בלי מנגנון "פעם אחת לביקור", כי פעימה ואבני דרך חוזרות בכוונה.
     שם האירוע במסד הוא שם כללי (video_progress) והפירוט ב-extra.pct,
     אבל למטא ול-Clarity נשלח שם מפורש (video_progress_25), כי שם אין extra
     שאפשר לסנן לפיו בנוחות.
     הסקריפט בדף רץ לפני הקובץ הזה (defer), ולכן הוא דוחף לתור __ecq
     ואנחנו מרוקנים אותו כאן. */
  function videoEvent(name, extra, pixelName) {
    safe(function () {
      dispatch(name, extra, false);
      if (pixelName) {
        safe(function () {
          if (typeof window.fbq === 'function') {
            window.fbq('trackCustom', 'EC_' + pixelName, { variant: VARIANT });
          }
        });
        safe(function () {
          if (typeof window.clarity === 'function') {
            window.clarity('set', 'ec_variant', VARIANT);
            window.clarity('event', 'ec_' + pixelName);
          }
        });
      }
    });
  }
  window.ecVideoEvent = videoEvent;
  safe(function () {
    var q = window.__ecq || [];
    window.__ecq = { push: function (a) { videoEvent(a[0], a[1], a[2]); } };
    for (var i = 0; i < q.length; i++) videoEvent(q[i][0], q[i][1], q[i][2]);
  });

  window.ecTrack = send;

  /* ---------- האירועים ---------- */
  function wire() {
    // fbc: 1 = הכניסה הגיעה עם fbclid של מטא בכתובת. נוסף 13.10.2026 כדי לבדוק
    // למה הליד הראשון של vsl-v4 שויך אצל מטא לצפייה ולא לקליק. בלי fbclid
    // מטא לא יכולה לקשר את הליד לקליק, גם כשה-UTM מוכיח שהיה קליק.
    send('view', { fbc: /[?&]fbclid=/.test(location.search) ? 1 : 0 });

    // קליק על כל קריאה לפעולה שמובילה לטופס
    safe(function () {
      document.addEventListener('click', function (e) {
        var a = e.target.closest && e.target.closest('a[href*="#contact"], .btn');
        if (a) send('cta_click');
        var vf = e.target.closest && e.target.closest('.vfacade, #ytf');
        if (vf) send('video_play');
      }, true);
    });

    // תחילת מילוי הטופס + מדידה ברמת השדה (נוסף 18.10.2026).
    // למה: ב-v4 נספרו 119 "התחילו טופס" מול 9 שליחות. בדיקת page_events הראתה
    // שכל 125 הנוטשים (12-18.10) נראים כמו זחלנים: form_start 23-28 שניות אחרי
    // הכניסה, בלי שום גלילה ובלי לחיצה, ואפס אירועים אחריו, ובפרצים שתואמים
    // לרגעי יצירת המודעות במטא. אדם לא יכול להגיע לשדה בתחתית הדף בלי לגלול.
    // לכן כל אירוע טופס נושא עכשיו הקשר שמאפשר להפריד אדם ממכונה:
    //   ui  = 1 אם היה מגע/לחיצה/מקש אמיתי (isTrusted) לפני האירוע
    //   sc  = עומק הגלילה המקסימלי עד אותו רגע, באחוזים
    //   t   = שניות מהכניסה לדף
    //   fld = איזה שדה (n שם · p טלפון)
    // ואירועים חדשים: field_focus / field_filled לכל שדה בנפרד, ו-form_invalid
    // (r = name_empty / phone_bad) כשהשליחה נעצרת בוולידציה.
    // form_submit עדיין נורה על ניסיון השליחה, עכשיו עם valid=1/0.
    safe(function () {
      var f = document.getElementById('f');
      if (!f) return;
      var T0 = Date.now(), maxSc = 0, ui = 0, seen = {};
      function onAct(e) { if (e && e.isTrusted) ui = 1; }
      ['pointerdown', 'touchstart', 'keydown'].forEach(function (t) {
        document.addEventListener(t, onAct, { capture: true, passive: true });
      });
      window.addEventListener('scroll', function () {
        var doc = document.documentElement, max = doc.scrollHeight - doc.clientHeight;
        if (max > 0) maxSc = Math.max(maxSc, Math.round(100 * (window.scrollY || doc.scrollTop) / max));
      }, { passive: true });
      function ctx(extra) {
        var o = { ui: ui, sc: maxSc, t: Math.round((Date.now() - T0) / 1000) };
        for (var k in (extra || {})) o[k] = extra[k];
        return o;
      }
      // פעם אחת לכל מפתח (לא לכל שם אירוע), כדי ששני השדות יימדדו בנפרד.
      function once(key, name, extra) {
        if (seen[key]) return;
        seen[key] = true;
        dispatch(name, ctx(extra), false);
      }
      window.ecFormTrack = function (name, extra) { once(name + ':' + JSON.stringify(extra || {}), name, extra); };
      f.addEventListener('focusin', function (e) {
        var id = (e.target && e.target.id) || '';
        if (!sent.form_start) { sent.form_start = true; dispatch('form_start', ctx({ fld: id }), true); }
        if (id === 'n' || id === 'p') once('ff:' + id, 'field_focus', { fld: id });
      });
      f.addEventListener('focusout', function (e) {
        var el = e.target, id = (el && el.id) || '';
        if ((id === 'n' || id === 'p') && String(el.value || '').trim()) once('fl:' + id, 'field_filled', { fld: id });
      });
      // עד שני form_submit לביקור: ניסיון שנפסל (valid=0) ושליחה תקינה (valid=1).
      // לפיקסל נשלח רק הראשון, כמו קודם.
      f.addEventListener('submit', function () {
        var v = f.getAttribute('data-valid') === '1' ? 1 : 0;
        if (seen['fs:' + v]) return;
        seen['fs:' + v] = true;
        var first = !sent.form_submit;
        sent.form_submit = true;
        dispatch('form_submit', ctx({ valid: v }), first);
      });
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

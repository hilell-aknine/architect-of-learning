-- ============================================================================
-- מדידת צפייה בסרטון ה-VSL (12.10.2026)
--
-- ⚠️ קובץ בלבד. לא הורץ. הדוח (api/video-report.js) והקליטה (api/event.js)
-- עובדים גם בלעדיו, כי אירועי הסרטון נכתבים לטבלה הקיימת page_events
-- (עם הפירוט ב-extra). המיגרציה הזו מוסיפה רק נוחות ומהירות:
--   1. אינדקס חלקי לאירועי הסרטון, כדי שהדוח לא יסרוק את כל הטבלה.
--   2. תצוגה vsl_viewers: שורה לכל צופה לכל סרטון, לשאילתות ידניות ב-SQL.
--
-- SAFETY: אדיטיבי בלבד. לא נוגע בטבלאות, בעמודות, בנתונים או במדיניות.
-- אין כאן שום policy, ובפרט אין anon INSERT. הכתיבה ל-page_events נשארת
-- אך ורק דרך api/event.js עם service_role (עם רשימת אירועים סגורה והגבלת קצב).
-- התצוגה נוצרת עם security_invoker, כך שהיא כפופה ל-RLS של page_events
-- (שאין לה policy לקריאה, כלומר רק service_role רואה אותה).
-- ============================================================================

create index if not exists page_events_video_idx
  on public.page_events ((extra->>'vid'), created_at)
  where event like 'video\_%';

create or replace view public.vsl_viewers
with (security_invoker = true) as
select
  e.extra->>'vid'                                            as vid,
  e.sid,
  min(e.variant)                                             as variant,
  min(e.created_at)                                          as first_seen,
  bool_or(e.event = 'video_start')                           as started,
  bool_or(e.event = 'video_end')                             as ended,
  max(case when e.event = 'video_end' then (e.extra->>'dur')::numeric
           else (e.extra->>'pos')::numeric end)              as max_pos_sec,
  max((e.extra->>'dur')::numeric)                            as duration_sec,
  min(e.extra->>'dev')                                       as device
from public.page_events e
where e.event like 'video\_%'
  and e.extra ? 'vid'
  and coalesce(e.page, 'index') = 'index'
group by 1, 2;

comment on view public.vsl_viewers is
  'שורה לכל צופה לכל סרטון VSL. max_pos_sec = המקום הכי רחוק שהגיע אליו. מקור: page_events.';

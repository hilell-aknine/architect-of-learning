-- ============================================================================
-- מדידת דף האבחון + הגנה על משפך ה-A/B
--
-- WHY: מ-9.9.2026 גם דף האבחון (hilell-aknine.github.io/expert-clone-diagnostic)
-- כותב ל-page_events, עם page='diagnostic'. הסיבה: הכפתור "לתאם את שיחת האבחון"
-- הוא האירוע היחיד בדף שאומר "אני רוצה לדבר", והוא לא נמדד מעולם. לכן ליד
-- שנחת במסד לא אמר כלום על כוונה, כי הפרטים נמסרים כדי לראות את התוצאה.
--
-- הבעיה שזה יוצר: variant_funnel מקבץ לפי variant בלבד. לאירועי האבחון אין
-- גרסת A/B, ולכן בלי תיקון הם היו נופלים לדלי 'ללא גרסה' ומערבבים שני דפים
-- שונים באותו משפך. התיקון: המשפך מסונן במפורש לדף הנחיתה בלבד.
--
-- SAFETY: אדיטיבי בלבד. create or replace על תצוגה קיימת, בלי שינוי חתימה,
-- ותצוגה חדשה אחת. לא נוגע בטבלאות, לא בעמודות ולא בנתונים.
-- ============================================================================

-- ---------- 1. משפך ה-A/B חוזר לעסוק רק בדף הנחיתה ----------
create or replace view public.variant_funnel as
select
  coalesce(e.variant, 'ללא גרסה')                 as variant,
  count(*) filter (where e.event = 'view')        as views,
  count(*) filter (where e.event = 'video_play')  as video_plays,
  count(*) filter (where e.event = 'scroll_50')   as scroll_50,
  count(*) filter (where e.event = 'cta_click')   as cta_clicks,
  count(*) filter (where e.event = 'form_start')  as form_starts,
  count(*) filter (where e.event = 'form_submit') as form_submits
from public.page_events e
where coalesce(e.page, 'index') = 'index'
group by 1;

comment on view public.variant_funnel is
  'משפך לפי גרסת קופי, דף הנחיתה בלבד. אירועי דף האבחון מסוננים החוצה במכוון.';

-- ---------- 2. משפך דף האבחון ----------
-- שלוש מדרגות: מי נכנס, מי השאיר פרטים כדי לראות תוצאה, ומי באמת ביקש לדבר.
-- המדרגה השלישית היא זו שהייתה חסרה לגמרי.
create or replace view public.diagnostic_funnel as
select
  date_trunc('day', e.created_at)::date            as day,
  count(*) filter (where e.event = 'view')         as views,
  count(*) filter (where e.event = 'form_submit')  as details_left,
  count(*) filter (where e.event = 'wa_click')     as call_requests
from public.page_events e
where e.page = 'diagnostic'
group by 1
order by 1 desc;

comment on view public.diagnostic_funnel is
  'משפך דף האבחון לפי יום. call_requests = לחיצות על "לתאם את שיחת האבחון", כלומר בקשה מפורשת לדבר.';

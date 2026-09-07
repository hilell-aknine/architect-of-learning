-- ============================================================================
-- page_events + campaign_leads.variant
--
-- WHY: עד היום היה אפשר לספור לידים אבל לא כניסות. המכנה היחיד היה מטא,
-- ובלי מכנה משלנו אי אפשר לחשב אחוז המרה, ובוודאי לא להשוות בין שתי גרסאות
-- קופי. הטבלה הזו היא המכנה, והעמודה החדשה ב-campaign_leads היא המונה.
--
-- CONTRACT: שמות העמודות כאן הם חוזה מול site/api/event.js ו-site/api/lead.js.
-- אין לשנות שם עמודה בלי לעדכן את שניהם.
--
-- SAFETY: המיגרציה הזו אדיטיבית בלבד. היא יוצרת טבלה חדשה ומוסיפה עמודה אחת
-- שמותר לה להיות null. היא לא נוגעת, לא משנה ולא מוחקת שום אובייקט קיים,
-- ובפרט לא את public.leads ולא את הנתונים שכבר יושבים ב-campaign_leads.
-- ============================================================================

-- ---------- 1. המכנה: אירועי דף ----------
create table if not exists public.page_events (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),

  -- מה קרה
  event        text not null,      -- view | cta_click | video_play | scroll_50 | scroll_90 | form_start | form_submit
  variant      text,               -- 'A' או 'B'. null לתנועה שהגיעה לפני התקנת השכבה.

  -- מי, בלי לזהות מי
  sid          text,               -- מזהה אקראי שנוצר בדפדפן. אין בו שום מידע אישי.

  -- מאיפה
  page         text,               -- 'index' וכו'
  utm          jsonb,
  referrer     text,

  -- הקשר בקשה
  user_agent   text,
  extra        jsonb               -- שדה פתוח לאירועים עתידיים, כדי לא לשנות סכמה כל פעם
);

comment on table  public.page_events         is 'אירועי דף נחיתה. נכתב בצד שרת עם service_role בלבד. אפס מידע מזהה.';
comment on column public.page_events.event   is 'שם אירוע מרשימה סגורה שנאכפת ב-api/event.js.';
comment on column public.page_events.variant is 'גרסת הקופי שהוצגה למבקר. המפתח להשוואה בין גרסאות.';
comment on column public.page_events.sid     is 'מזהה ביקור אקראי מהדפדפן. לא מקושר לשום זהות.';

-- אינדקסים לשאילתות שבאמת נריץ: משפך לפי גרסה, ולפי תאריך.
create index if not exists page_events_variant_event_idx on public.page_events (variant, event);
create index if not exists page_events_created_at_idx    on public.page_events (created_at desc);
create index if not exists page_events_sid_idx           on public.page_events (sid);

alter table public.page_events enable row level security;

-- אין policy בכוונה: הכתיבה נעשית אך ורק עם service_role מצד השרת,
-- שעוקף RLS. הדפדפן לעולם לא נוגע בטבלה הזו ישירות.

-- ---------- 2. המונה: איזו גרסה הביאה את הליד ----------
alter table public.campaign_leads
  add column if not exists variant text;

comment on column public.campaign_leads.variant is 'גרסת הקופי שהמבקר ראה כשהשאיר פרטים. null לכל הלידים שנוצרו לפני 6.9.2026.';

-- ---------- 3. תצוגת המשפך, כדי שלא נחשב ידנית כל פעם ----------
create or replace view public.variant_funnel as
select
  coalesce(e.variant, 'ללא גרסה')                                     as variant,
  count(*) filter (where e.event = 'view')        as views,
  count(*) filter (where e.event = 'video_play')  as video_plays,
  count(*) filter (where e.event = 'scroll_50')   as scroll_50,
  count(*) filter (where e.event = 'cta_click')   as cta_clicks,
  count(*) filter (where e.event = 'form_start')  as form_starts,
  count(*) filter (where e.event = 'form_submit') as form_submits
from public.page_events e
group by 1;

comment on view public.variant_funnel is 'משפך לפי גרסת קופי. הלידים עצמם נספרים מ-campaign_leads.variant.';

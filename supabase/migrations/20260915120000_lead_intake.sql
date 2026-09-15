-- שאלון אחרי הטופס — 15.09.2026
--
-- הרקע: עד 15.09 שאלת הסינון ("כמה לקוחות קנו את הקורס") ישבה בתוך הטופס
-- עצמו, כשדה שלישי חובה. רם, בפגישת 15.09 דקה 24:01:
--   "תוריד את השאלה הזאת. תעשה לו שאלון אחרי שהוא ממלא פרטים."
--
-- כלומר הסינון לא מבוטל, הוא זז אחרי נקודת ההמרה. הליד נתפס קודם,
-- והשאלות נשאלות בעמוד התודה, כשכבר אין מה להפסיד.
--
-- intake מחזיק את התשובות המלאות. students ממשיך להתמלא מאותה תשובה
-- ראשונה בדיוק, כדי שכל הפילוחים והדשבורד הקיימים ימשיכו לעבוד
-- בלי שינוי, ובלי לשבור השוואה לעשרים ושניים הלידים הקודמים.

alter table public.campaign_leads
  add column if not exists intake    jsonb,
  add column if not exists intake_at timestamptz;

comment on column public.campaign_leads.intake is
  'תשובות השאלון בעמוד התודה, אחרי שהליד כבר נשמר. נכתב פעם אחת בלבד דרך /api/lead-answers.';

comment on column public.campaign_leads.intake_at is
  'מתי השאלון מולא. null = הליד השאיר פרטים ולא ענה על השאלון.';

-- אינדקס חלקי: השאילתה היחידה שמעניינת היא "מי ענה", והיא מיעוט מהשורות.
create index if not exists campaign_leads_intake_at_idx
  on public.campaign_leads (intake_at desc)
  where intake_at is not null;

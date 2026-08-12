-- ============================================================================
-- campaign_leads — persistence for paid-campaign leads (Expert Clone / בניית פורטלים)
--
-- WHY: campaign.html only opened WhatsApp, and api/lead.js only fired a Green API
-- notification. If the notification failed, the lead was gone forever — money burned
-- on ads with nothing to show. This table is the durable store; the WhatsApp alert
-- becomes a best-effort side channel whose outcome is recorded (notified/notify_error).
--
-- CONTRACT: column names here are an agreed contract with the server-side handler.
-- Do NOT rename columns without updating api/lead.js (or the `lead` Edge Function).
--
-- SAFETY: this migration is ADDITIVE ONLY. It creates one new table plus its own
-- indexes and policies. It does not touch, alter or drop any existing object
-- (notably the pre-existing public.leads table, which is left completely alone).
-- ============================================================================

create table if not exists public.campaign_leads (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),

  -- who
  name                text not null,
  phone               text not null,
  business            text,
  students            text,

  -- where they came from
  ad_source           text,      -- utm_content or utm_campaign, whichever identifies the creative
  utm                 jsonb,     -- every utm_* parameter exactly as it arrived

  -- how warm they are: VSL engagement at the moment they submitted
  video_watched_pct   integer,   -- 0-100, percentage of the sales video watched
  video_seconds       numeric,   -- actual seconds watched
  video_completed     boolean default false,

  -- request context
  page                text,      -- 'campaign' or 'index'
  referrer            text,
  user_agent          text,

  -- delivery bookkeeping for the WhatsApp alert
  notified            boolean not null default false,
  notify_error        text       -- why the alert failed, when it did
);

comment on table  public.campaign_leads               is 'Leads from the paid campaign landing page. Written server-side with the service_role key only.';
comment on column public.campaign_leads.ad_source     is 'utm_content or utm_campaign — identifies which creative produced the lead.';
comment on column public.campaign_leads.utm           is 'All utm_* query parameters as received, unmodified.';
comment on column public.campaign_leads.video_watched_pct is 'Expected range 0-100. Deliberately NOT constrained: a rounding error must never cost us a lead.';
comment on column public.campaign_leads.page          is 'Expected ''campaign'' or ''index''. Deliberately unconstrained so a new page cannot drop leads.';
comment on column public.campaign_leads.notified      is 'True once the WhatsApp alert was confirmed sent.';
comment on column public.campaign_leads.notify_error  is 'Error text when the WhatsApp alert failed. The lead is still stored.';

-- ----------------------------------------------------------------------------
-- Indexes
-- ----------------------------------------------------------------------------
create index if not exists campaign_leads_created_at_idx
  on public.campaign_leads (created_at desc);

create index if not exists campaign_leads_phone_idx
  on public.campaign_leads (phone);

-- ----------------------------------------------------------------------------
-- Security
--
-- Writes arrive ONLY from the server using the service_role key, which bypasses
-- RLS entirely. There is therefore NO anon INSERT policy, and specifically no
-- `with check (true)` — that pattern has burned this business before and is banned.
-- ----------------------------------------------------------------------------
alter table public.campaign_leads enable row level security;

-- Belt and braces: even if a policy were ever added by mistake, anon holds no
-- table privilege on this table at all.
revoke all on public.campaign_leads from anon;
grant  select on public.campaign_leads to authenticated;
grant  all    on public.campaign_leads to service_role;

-- Read access for the future leads dashboard: logged-in users only.
drop policy if exists "campaign_leads_select_authenticated" on public.campaign_leads;
create policy "campaign_leads_select_authenticated"
  on public.campaign_leads
  for select
  to authenticated
  using (true);

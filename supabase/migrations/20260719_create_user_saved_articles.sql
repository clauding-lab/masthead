-- Phase 2 Slice 2C: per-user read-it-later library (spec §3).
-- Owner-only rows via RLS; the client writes under the user's own JWT.
create table public.user_saved_articles (
  user_id      uuid not null references auth.users (id) on delete cascade,
  article_id   text not null,
  url          text not null check (url ~* '^https?://'),
  title        text,
  byline       text,
  excerpt      text,
  content      text,
  content_truncated boolean not null default false,
  lead_image   text,
  word_count   integer,
  source_id    text,
  source_name  text,
  source_color text,
  is_paywall   boolean not null default false,
  saved_at     timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  primary key (user_id, article_id),
  constraint content_size check (content is null or length(content) <= 1600000)
);

create index user_saved_articles_user_saved_idx
  on public.user_saved_articles (user_id, saved_at desc);

-- Explicit privilege baseline, correct under both Supabase default-privilege
-- regimes. RLS enabled; policies below are the only access path for api roles.
alter table public.user_saved_articles enable row level security;
revoke all on table public.user_saved_articles from public, anon, authenticated;
grant select, insert, update, delete on table public.user_saved_articles to authenticated;
grant select, insert, update, delete on table public.user_saved_articles to service_role;

create policy "saved select own" on public.user_saved_articles
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "saved insert own" on public.user_saved_articles
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "saved update own" on public.user_saved_articles
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "saved delete own" on public.user_saved_articles
  for delete to authenticated using ((select auth.uid()) = user_id);
-- No policies for anon; UPDATE carries USING + WITH CHECK so user_id can never
-- be reassigned.

-- Carry existing favorites over as metadata shells. Filtered so a legacy row
-- with an invalid url cannot abort the transaction (spec §12); thumbnail maps
-- to lead_image; category is not part of the library model.
insert into public.user_saved_articles
  (user_id, article_id, url, title, excerpt, lead_image, source_id, source_name, saved_at)
select user_id, article_id, url, title, excerpt, thumbnail, source_id, source_name,
       coalesce(saved_at, now())
from public.user_favorites
where url ~* '^https?://'
on conflict (user_id, article_id) do nothing;

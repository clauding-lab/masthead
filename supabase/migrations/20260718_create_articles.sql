-- Phase 2 Slice 2B: server-side headline store (spec §4, §6).
-- Write path: service_role only (the cron poller). Read path: public SELECT.
create table public.articles (
  source_id text not null,
  id text not null,
  url text not null,
  title text,
  source_name text,
  source_short_name text,
  source_color text,
  category text,
  thumbnail text,
  is_paywall boolean not null default false,
  published_at timestamptz,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (source_id, id)
);

create index articles_published_at_idx on public.articles (published_at desc);
create index articles_source_published_idx on public.articles (source_id, published_at desc);
create index articles_category_published_idx on public.articles (category, published_at desc);
create index articles_first_seen_idx on public.articles (first_seen_at);

-- Creating a policy does NOT enable RLS; this statement is load-bearing.
alter table public.articles enable row level security;

-- Explicit privilege baseline, correct under BOTH Supabase default-privilege
-- regimes (older auto-grant-all and newer no-default-grant). Revoking from
-- PUBLIC as well: role grants can be inherited through PUBLIC membership.
revoke all on table public.articles from public, anon, authenticated;
grant select on table public.articles to anon, authenticated;
grant select, insert, update, delete on table public.articles to service_role;

create policy "articles public read"
  on public.articles for select to anon, authenticated using (true);
-- Deliberately NO insert/update/delete policy for anon/authenticated.

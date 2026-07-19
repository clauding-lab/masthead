-- Phase 2 Slice 2E: per-user premium subscriber feeds (spec §3).
-- SERVICE-ROLE-ONLY custody: zero client grants; url never crosses PostgREST.
create table public.user_premium_feeds (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  url         text not null check (url ~* '^https://'),
  label       text not null check (length(label) <= 200),
  kind        text not null check (kind in ('news', 'blog')),
  category    text not null default 'custom' check (length(category) <= 50),
  host_hint   text not null check (length(host_hint) <= 300),
  created_at  timestamptz not null default now(),
  constraint user_premium_feeds_unique_url unique (user_id, url),
  constraint sane_url_size check (length(url) <= 4000)
);

create index user_premium_feeds_user_idx on public.user_premium_feeds (user_id);

-- DB-enforced cap (spec §3.1): check-then-insert in the API is a TOCTOU race;
-- the 5th-vs-6th decision belongs to Postgres. The per-user advisory lock
-- serializes concurrent inserts for the same user.
create or replace function public.enforce_premium_feed_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtext('premium_cap'), hashtext(new.user_id::text));
  if (select count(*) from public.user_premium_feeds where user_id = new.user_id) >= 5 then
    raise exception 'premium feed cap reached' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger user_premium_feeds_cap
  before insert on public.user_premium_feeds
  for each row execute function public.enforce_premium_feed_cap();

-- Custody: RLS on with NO policies (defense in depth) + explicit zero grants.
-- Revoke from PUBLIC too — revoking only anon/authenticated is a no-op if the
-- grant came via PUBLIC (AGENT_LEARNINGS: revoke-PUBLIC gotcha).
alter table public.user_premium_feeds enable row level security;
revoke all on table public.user_premium_feeds from anon, authenticated, public;
revoke all on function public.enforce_premium_feed_cap() from anon, authenticated, public;

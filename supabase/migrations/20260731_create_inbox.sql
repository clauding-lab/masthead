-- Phase 3: newsletter inbox (spec §4). Addresses: service-role-only custody.
-- Messages: service-role insert; owner may read + update read_at/deleted_at.
create table public.user_ingest_addresses (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null unique references auth.users (id) on delete cascade,
  slug              text unique check (slug is null or slug ~ '^[a-z]{3,12}-[a-z]{3,12}-[0-9a-f]{4}$'),
  over_quota_since  timestamptz,
  deferred_count    bigint not null default 0,
  last_deferred_at  timestamptz,
  created_at        timestamptz not null default now()
);

create table public.user_inbox_messages (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  from_email       text not null check (length(from_email) <= 320),
  from_name        text check (from_name is null or length(from_name) <= 200),
  subject          text not null default '' check (length(subject) <= 500),
  html_body        text,
  text_body        text,
  excerpt          text check (excerpt is null or length(excerpt) <= 500),
  size_bytes       integer not null check (size_bytes >= 0),
  web_url          text check (web_url is null or (web_url ~* '^https://' and length(web_url) <= 4000)),
  unsubscribe_url  text check (unsubscribe_url is null or length(unsubscribe_url) <= 4000),
  auth_results     text check (auth_results is null or length(auth_results) <= 2000),
  dedupe_key       text not null check (length(dedupe_key) <= 998),
  message_id       text check (message_id is null or length(message_id) <= 998),
  received_at      timestamptz not null default now(),
  read_at          timestamptz,
  deleted_at       timestamptz,
  constraint user_inbox_messages_dedupe unique (user_id, dedupe_key)
);

create index user_inbox_messages_list_idx
  on public.user_inbox_messages (user_id, received_at desc) where deleted_at is null;
create index user_inbox_messages_unread_idx
  on public.user_inbox_messages (user_id) where read_at is null and deleted_at is null;

-- Quota enforcement lives in Postgres (2E cap-trigger pattern; spec §4.2):
-- app-level check-then-insert is a TOCTOU race. Per-user advisory xact lock.
create or replace function public.enforce_inbox_quota()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  live_count int;
  live_bytes bigint;
begin
  perform pg_advisory_xact_lock(hashtext('inbox_quota'), hashtext(new.user_id::text));
  -- Dedupe precedes quota (spec §5.1): this is a BEFORE-row trigger, and
  -- Postgres fires BEFORE-row triggers before it checks constraints — so
  -- without this short-circuit, a redelivered message whose (user_id,
  -- dedupe_key) already exists would hit the quota check below FIRST. At a
  -- full inbox that raises 'inbox quota exceeded' (P0001, a permanent
  -- over_quota_final/507 NDR) for a message that should read as a harmless
  -- 'duplicate'. Returning NEW here — without touching live_count/live_bytes
  -- at all — lets the INSERT fall through to constraint checking, where the
  -- UNIQUE(user_id, dedupe_key) index (not this trigger) is what decides
  -- duplicates, via a normal 23505 the caller already maps to 'duplicate'.
  if exists (
    select 1 from public.user_inbox_messages
     where user_id = new.user_id and dedupe_key = new.dedupe_key
  ) then
    return new;
  end if;
  select count(*), coalesce(sum(size_bytes), 0)
    into live_count, live_bytes
    from public.user_inbox_messages
   where user_id = new.user_id and deleted_at is null;
  if live_count >= 500 or live_bytes + new.size_bytes > 104857600 then
    raise exception 'inbox quota exceeded' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger user_inbox_messages_quota
  before insert on public.user_inbox_messages
  for each row execute function public.enforce_inbox_quota();

-- Un-delete is forbidden (spec §4.2): the deleted_at column grant would
-- otherwise let a client resurrect tombstoned rows past the quota with no
-- trigger on the UPDATE path. The product has no restore feature.
create or replace function public.forbid_inbox_undelete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.deleted_at is not null and new.deleted_at is null then
    raise exception 'undelete is not permitted' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger user_inbox_messages_no_undelete
  before update of deleted_at on public.user_inbox_messages
  for each row execute function public.forbid_inbox_undelete();

-- Custody (landmines 5 + 12: this project auto-grants via pg_default_acl —
-- explicit revokes are mandatory, and PUBLIC must be named).
alter table public.user_ingest_addresses enable row level security;
revoke all on table public.user_ingest_addresses from anon, authenticated, public;

alter table public.user_inbox_messages enable row level security;
revoke all on table public.user_inbox_messages from anon, authenticated, public;
grant select on table public.user_inbox_messages to authenticated;
grant update (read_at, deleted_at) on table public.user_inbox_messages to authenticated;
create policy inbox_messages_select_own on public.user_inbox_messages
  for select to authenticated using (auth.uid() = user_id);
create policy inbox_messages_update_own on public.user_inbox_messages
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

revoke all on function public.enforce_inbox_quota() from anon, authenticated, public;
revoke all on function public.forbid_inbox_undelete() from anon, authenticated, public;

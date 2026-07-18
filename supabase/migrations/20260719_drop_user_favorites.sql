-- Phase 2 Slice 2C rollout step 4 (spec §9): apply ONLY after the 2C app
-- deploy is live-verified. Until then the previous app version still syncs
-- favorites against this table.
drop table if exists public.user_favorites;

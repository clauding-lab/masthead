// lib/inboxConfig.js — single home for the ingest domain + quota constants (spec §6).
export const INGEST_DOMAIN = 'masthead.clauding-lab.com';
export const MAX_RAW_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
export const MAX_LIVE_MESSAGES = 500;
export const MAX_LIVE_BYTES = 100 * 1024 * 1024;
export const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

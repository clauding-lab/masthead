// lib/premiumService.js (Task 5 scope — Task 6 extends this file)
// Premium orchestration (spec §4). Validation is add-time only; error DETAIL
// never reaches the caller (anti-oracle — the route returns one generic 422).
import { fetchRawItems } from './feedParser.js';

export class PremiumValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PremiumValidationError';
  }
}

export const PREMIUM_TIMEOUT_MS = 3000;

export async function validateFeedUrl(url, { fetchRaw = fetchRawItems } = {}) {
  try {
    const { items, title, finalUrl } = await fetchRaw({ feedUrl: url }, { timeoutMs: 8000 });
    if (!items || items.length === 0) throw new PremiumValidationError('no items');
    return { title: title || '', finalUrl };
  } catch (err) {
    if (err instanceof PremiumValidationError) throw err;
    throw new PremiumValidationError('validation failed');
  }
}

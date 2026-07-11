// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { buildSourceRows } from './sync.js';
import sourcesData from '../../lib/sources.json';

describe('buildSourceRows', () => {
  it('maps only the selected known source ids to user_sources rows', () => {
    const first = sourcesData.sources[0];
    const rows = buildSourceRows('user-1', [first.id, 'nonexistent-id']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: 'user-1',
      source_id: first.id,
      name: first.name,
      feed_url: first.feedUrl,
      is_default: true,
      is_enabled: true,
    });
  });

  it('returns empty array for empty selection', () => {
    expect(buildSourceRows('user-1', [])).toEqual([]);
  });
});

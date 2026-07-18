import { describe, it, expect } from 'vitest';
import { newsTabCategories, blogsTabCategories } from './feedCategories';

const ACTIVE = [
  { id: 'n1', category: 'macro' },                      // kind absent ⇒ news
  { id: 'n2', category: 'tech', kind: 'news' },
  { id: 'b1', category: 'economics', kind: 'blog' },
  { id: 'b2', category: 'tech', kind: 'blog' },
  { id: 's1', category: 'macro', kind: 'social' },
];

describe('newsTabCategories', () => {
  const cats = newsTabCategories(ACTIVE);
  it('leads with All, ends with Social, news categories between', () => {
    expect(cats).toEqual([
      { id: null, label: 'All' },
      { id: 'macro', label: 'Macro' },
      { id: 'tech', label: 'Tech' },
      { id: 'social', label: 'Social' },
    ]);
  });
  it('shows the Social chip even with zero social sources active', () => {
    expect(newsTabCategories([{ id: 'n1', category: 'macro' }]).at(-1)).toEqual({ id: 'social', label: 'Social' });
  });
});

describe('blogsTabCategories', () => {
  it('derives only from blog-kind sources', () => {
    expect(blogsTabCategories(ACTIVE)).toEqual([
      { id: null, label: 'All' },
      { id: 'economics', label: 'Economics' },
      { id: 'tech', label: 'Tech' },
    ]);
  });
});

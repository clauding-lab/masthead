import { randomBytes } from 'node:crypto';

// Curated word list for ingest-address slugs (spec §4): generic nature/
// geography/material nouns only — no offensive terms, no brand names.
// 200 entries, each lowercase letters, 3-12 chars long, verified by
// lib/ingestSlug.test.js.
export const INGEST_SLUG_WORDS = [
  // landforms / geography
  'river', 'ocean', 'ridge', 'canyon', 'valley', 'forest', 'meadow', 'harbor', 'delta', 'tundra',
  'prairie', 'glacier', 'volcano', 'plateau', 'lagoon', 'marsh', 'cave', 'cliff', 'dune', 'fjord',
  'grove', 'hollow', 'knoll', 'ledge', 'mesa', 'moor', 'oasis', 'peak', 'plain', 'pond',
  // water / terrain
  'reef', 'shoal', 'shore', 'slope', 'spring', 'stream', 'summit', 'swamp', 'thicket', 'trail',
  'wetland', 'woodland', 'brook', 'cove', 'gorge', 'gully', 'headland', 'inlet', 'isthmus', 'cascade',
  // weather / sky
  'cloud', 'storm', 'breeze', 'gale', 'mist', 'frost', 'dawn', 'dusk', 'twilight', 'aurora',
  'comet', 'nebula', 'meteor', 'eclipse', 'zenith', 'horizon', 'thunder', 'lightning', 'rainbow', 'drizzle',
  // weather extra
  'monsoon', 'blizzard', 'cyclone', 'sunrise', 'sunset', 'daybreak', 'nightfall', 'moonrise', 'starlight', 'skyline',
  // colors / materials
  'amber', 'coral', 'ivory', 'onyx', 'topaz', 'quartz', 'granite', 'cobalt', 'cinder', 'ember',
  'copper', 'bronze', 'silver', 'golden', 'crimson', 'scarlet', 'indigo', 'violet', 'emerald', 'sapphire',
  // materials extra
  'jade', 'pearl', 'marble', 'slate', 'chalk', 'flint', 'basalt', 'obsidian', 'alabaster', 'limestone',
  // trees / plants
  'cedar', 'walnut', 'willow', 'maple', 'birch', 'pine', 'oak', 'elm', 'fern', 'moss',
  'thorn', 'bramble', 'ivy', 'lotus', 'tulip', 'daisy', 'clover', 'heather', 'jasmine', 'poppy',
  // herbs / plants extra
  'fennel', 'sage', 'basil', 'mint', 'thyme', 'clove', 'ginger', 'saffron', 'lichen', 'reed',
  // birds
  'falcon', 'heron', 'sparrow', 'robin', 'wren', 'finch', 'swift', 'osprey', 'condor', 'raven',
  'crow', 'hawk', 'eagle', 'owl', 'dove', 'lark', 'magpie', 'kingfisher', 'pelican', 'stork',
  // land animals
  'otter', 'fox', 'wolf', 'badger', 'beaver', 'hare', 'lynx', 'mole', 'marten', 'weasel',
  'stoat', 'deer', 'elk', 'moose', 'bison', 'ram', 'goat', 'hedgehog', 'squirrel', 'raccoon',
  // sea animals
  'seal', 'whale', 'dolphin', 'salmon', 'trout', 'pike', 'perch', 'marlin', 'urchin', 'anemone',
  // abstract / neutral nouns
  'haven', 'refuge', 'beacon', 'compass', 'anchor', 'voyage', 'journey', 'meridian', 'latitude', 'longitude',
];

// word-word-hex4, e.g. "cedar-otter-4f2a". randomFn defaults to
// node:crypto.randomBytes and, given the same 6-byte input, is injectable
// for deterministic tests. Two words + 4 hex chars need 6 bytes total: 2
// bytes per word index (mod word-list length) + 2 bytes for the hex suffix.
export function generateSlug(randomFn = randomBytes) {
  const bytes = randomFn(6);
  const wordCount = INGEST_SLUG_WORDS.length;
  const firstIndex = bytes.readUInt16BE(0) % wordCount;
  const secondIndex = bytes.readUInt16BE(2) % wordCount;
  const hex = bytes.subarray(4, 6).toString('hex');
  return `${INGEST_SLUG_WORDS[firstIndex]}-${INGEST_SLUG_WORDS[secondIndex]}-${hex}`;
}

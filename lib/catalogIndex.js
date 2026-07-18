// Alias-aware catalog index (2D spec §5.1). Pure JS with zero imports so
// server (feedService) and browser (settingsStore healing) share it, like
// articleId. Live ids are registered before aliases, so a live id always
// wins if an alias mistakenly claims it (the structural catalog test
// forbids that state in the real catalog anyway).

export function buildCatalogIndex(catalog) {
  const byId = new Map();
  for (const source of catalog.sources) {
    byId.set(source.id, source);
  }
  for (const source of catalog.sources) {
    for (const alias of source.aliases ?? []) {
      if (!byId.has(alias)) byId.set(alias, source);
    }
  }
  return {
    byId,
    canonicalId(id) {
      const entry = byId.get(id);
      return entry ? entry.id : null;
    },
    has(id) {
      return byId.has(id);
    },
  };
}

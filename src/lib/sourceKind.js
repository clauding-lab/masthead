// Absent kind ⇒ news: keeps the 9 pre-2D catalog entries and every
// pre-2D custom source in localStorage exactly where they live today.
export function sourceKind(source) {
  return source?.kind ?? 'news';
}

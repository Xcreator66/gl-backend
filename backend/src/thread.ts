export interface C { id: string; parent_id: string | null; [k: string]: unknown }
export type Threaded<T extends C> = T & { replies: T[] };
/** Two levels only: top-level comments with their replies, both in id order (ids are numeric strings from bigserial).
 *  A reply whose parent is missing from the input (hidden, blocked, muted) is dropped, never promoted to top level,
 *  so hiding a comment also hides the conversation under it. */
export function thread<T extends C>(rows: T[]): Threaded<T>[] {
  const byId = (a: T, b: T) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1);
  const tops = rows.filter(r => r.parent_id == null).sort(byId).map(r => ({ ...r, replies: [] as T[] }));
  const index = new Map(tops.map(t => [t.id, t]));
  for (const r of [...rows].sort(byId)) if (r.parent_id != null) index.get(r.parent_id)?.replies.push(r);
  return tops;
}

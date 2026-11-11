/**
 * A fixed, reproducible development / held-out split of a corpus.
 *
 * Anything learned from the corpus (profiles, thresholds, a generator's guidance) is developed on the development
 * pieces only; the held-out pieces are used to check it. The split is stratified by category (so every kind of tune
 * is on both sides when it can be) and decided by a hash of the piece id and a seed: the same corpus and seed always
 * give the same split, whatever order the pieces arrive in. With so few pieces the held-out side is small and any
 * conclusion drawn from it is weak; reports must say so.
 */
import { fnv1a } from "./musicxml";

export interface SplitItem {
  readonly id: string;
  readonly category: string;
}
export interface CorpusSplit {
  readonly seed: number;
  readonly heldOutShare: number;
  readonly development: readonly string[];
  readonly heldOut: readonly string[];
}

export function splitCorpus(items: readonly SplitItem[], seed = 1, heldOutShare = 0.3): CorpusSplit {
  const byCat = new Map<string, SplitItem[]>();
  for (const it of items) byCat.set(it.category, [...(byCat.get(it.category) ?? []), it]);
  const development: string[] = [];
  const heldOut: string[] = [];
  for (const [, group] of [...byCat.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const ranked = [...group].sort((a, b) => {
      const ha = fnv1a(`${seed}:${a.id}`);
      const hb = fnv1a(`${seed}:${b.id}`);
      return ha < hb ? -1 : ha > hb ? 1 : a.id < b.id ? -1 : 1;
    });
    // a category of one stays in development: it cannot be on both sides
    const nHeld = group.length < 2 ? 0 : Math.max(1, Math.round(group.length * heldOutShare));
    ranked.forEach((it, i) => (i < nHeld ? heldOut : development).push(it.id));
  }
  return { seed, heldOutShare, development: development.sort(), heldOut: heldOut.sort() };
}

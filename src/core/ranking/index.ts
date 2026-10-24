// Search ranking: filter and order snapshot rows for a query (C-SRCH-08 to C-SRCH-10, 03-components 4.7).

import type { RowRef } from '../types.ts';

export interface Candidate {
  ref: RowRef;
  title: string;
  url: string;
  useRank: number | null; // global recency, 0 most recent; null = never activated
  windowRank: number; // window recency; 0 is the source window, so it also settles the current window tie
  barIndex: number; // tab bar position in its window; a recently closed row's place, most recent first
  closed: boolean; // a recently closed tab (C-SRCH-27)
}

// Explicit and locale free, so results match on every machine: compatibility decompose, drop marks, lower case.
export const normalize = (s: string): string => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

const words = (query: string): string[] => normalize(query).split(/\s+/u).filter(Boolean);

const WORD_START = /[\p{L}\p{N}]/u;

function startsWord(title: string, word: string): boolean {
  for (let i = title.indexOf(word); i >= 0; i = title.indexOf(word, i + 1)) {
    if (i === 0 || !WORD_START.test(title.charAt(i - 1))) return true;
  }
  return false;
}

// 0: every word starts a title word; 1: every word in the title; 2: the rest that match; null: no match.
function tier(query: readonly string[], c: Candidate): number | null {
  const title = normalize(c.title);
  const url = normalize(c.url);
  if (!query.every((w) => title.includes(w) || url.includes(w))) return null;
  if (query.every((w) => startsWord(title, w))) return 0;
  return query.every((w) => title.includes(w)) ? 1 : 2;
}

// Most recent tab, then window recency (current window first) and tab bar order.
function byRecency(a: Candidate, b: Candidate): number {
  const use = (c: Candidate) => c.useRank ?? Infinity;
  return use(a) - use(b) || a.windowRank - b.windowRank || a.barIndex - b.barIndex;
}

// An empty query lists every open row in tie order (C-SRCH-08); recently closed rows join only a typed query, after
// the open rows of their tier, since they are never used and their window ranks last (C-SRCH-27).
export function rank(query: string, candidates: readonly Candidate[]): readonly RowRef[] {
  const q = words(query);
  return candidates
    .flatMap((c) => {
      const t = q.length ? tier(q, c) : c.closed ? null : 0;
      return t === null ? [] : [{ c, t }];
    })
    .sort((a, b) => a.t - b.t || byRecency(a.c, b.c))
    .map(({ c }) => c.ref);
}

// Runbooks are markdown files in /runbooks. They are small, so we load them
// all into memory and rank them with BM25 (classic keyword relevance).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Runbook {
  slug: string; // file name without .md, e.g. "overheating"
  title: string; // first "# " heading
  content: string;
}

const RUNBOOK_DIR = fileURLToPath(new URL("../../runbooks/", import.meta.url));

export function loadRunbooks(dir = RUNBOOK_DIR): Runbook[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((file) => {
      const content = readFileSync(join(dir, file), "utf8");
      const title = content.match(/^# (.+)$/m)?.[1] ?? file;
      return { slug: file.replace(/\.md$/, ""), title, content };
    });
}

const STOPWORDS = new Set(["the", "a", "an", "is", "are", "it", "do", "does", "of", "to", "and", "or", "in", "on", "for", "why", "what", "how", "with", "my", "too", "keeps"]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

// Operator vocabulary -> runbook vocabulary. Operators say "too hot" or
// "keeps dropping"; runbooks say "overheating" and "connectivity". Keyword
// search cannot bridge that gap, so each query word that has an entry here
// adds the runbook words to the query. A tiny, explicit stand-in for semantic
// search (embeddings) that needs no model and is easy to audit.
const SYNONYMS: Record<string, string[]> = {
  hot: ["overheating", "temperature"],
  heat: ["overheating", "temperature"],
  warm: ["temperature"],
  shaking: ["vibration"],
  shake: ["vibration"],
  rattling: ["vibration"],
  noisy: ["vibration"],
  offline: ["connectivity", "signal"],
  dropping: ["connectivity", "signal"],
  disconnected: ["connectivity", "signal"],
  reception: ["signal"],
  draining: ["battery"],
  charge: ["battery"],
  reboot: ["restart"],
  reset: ["restart"],
  cycle: ["restart"],
};

/** Query terms plus the runbook words for any operator vocabulary they contain. */
export function expandQuery(query: string): string[] {
  const terms = tokenize(query);
  return [...new Set([...terms, ...terms.flatMap((t) => SYNONYMS[t] ?? [])])];
}

// BM25 parameters (the usual defaults): K1 controls how fast repeated
// occurrences of a word stop adding score; B controls how much long
// documents are penalised.
const K1 = 1.2;
const B = 0.75;
const TITLE_BOOST = 3; // title words count as if they appeared 3 times

/**
 * BM25 ranking. For each query term t and document d:
 *
 *   idf(t)      = ln(1 + (N - n_t + 0.5) / (n_t + 0.5))     rare words matter more
 *   tf(t, d)    = occurrences of t in d (a term also matches words that start with it)
 *   score(t, d) = idf(t) * tf * (K1 + 1) / (tf + K1 * (1 - B + B * len(d) / avgLen))
 *
 * Compared with plain term counting, a word that appears in every runbook
 * ("device") barely counts, repeating a word has diminishing returns, and a
 * long document does not win just by being long.
 */
export function searchRunbooks(runbooks: Runbook[], query: string, limit = 3) {
  const terms = expandQuery(query);
  // Each document as a bag of words; title words are repeated to boost them.
  const docs = runbooks.map((rb) => [...tokenize(rb.content), ...Array(TITLE_BOOST).fill(tokenize(rb.title)).flat()]);
  const avgLen = docs.reduce((sum, d) => sum + d.length, 0) / Math.max(docs.length, 1);
  const count = (words: string[], term: string) => words.filter((w) => w.startsWith(term)).length;

  const idf = new Map(
    terms.map((t) => {
      const n = docs.filter((d) => count(d, t) > 0).length;
      return [t, Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))];
    }),
  );

  return runbooks
    .map((rb, i) => {
      const words = docs[i]!;
      const score = terms.reduce((sum, t) => {
        const tf = count(words, t);
        return sum + (idf.get(t)! * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * words.length) / avgLen));
      }, 0);
      return { slug: rb.slug, title: rb.title, score: Number(score.toFixed(3)), uri: `runbook://${rb.slug}`, content: rb.content };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

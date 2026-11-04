// Runbooks are markdown files in /runbooks. They are small, so we load them
// all into memory and search them with simple keyword scoring.
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

const STOPWORDS = new Set(["the", "a", "an", "is", "of", "to", "and", "or", "in", "on", "for", "why", "what", "how", "with", "my"]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Score = sum over query terms of (occurrences in body + 3 x occurrences in title).
 * A term also matches words that start with it ("overheat" matches "overheating").
 * Good enough for a handful of documents; see docs/adr for why there are no embeddings.
 */
export function searchRunbooks(runbooks: Runbook[], query: string, limit = 3) {
  const terms = tokenize(query);
  return runbooks
    .map((rb) => {
      const body = tokenize(rb.content);
      const title = tokenize(rb.title);
      const count = (words: string[], term: string) => words.filter((w) => w.startsWith(term)).length;
      const score = terms.reduce((sum, t) => sum + count(body, t) + 3 * count(title, t), 0);
      return { slug: rb.slug, title: rb.title, score, uri: `runbook://${rb.slug}`, content: rb.content };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/* Parsing of pasted reference lists into individual entries, plus light
 * extraction of DOI, year and first-author surname from each entry. */

const DOI_RE = /\b(10\.\d{4,9}\/[^\s"<>]+)/i;
const LEADING_NUMBER_RE = /^\s*(?:\[\d+\]|\(\d+\)|\d+[.)]|\d+\s+|[•\-–*]\s+)\s*/;

/**
 * Split a block of pasted text into reference strings.
 * Strategy: if there are blank lines, treat each blank-line-separated block as
 * one reference (handles references that wrap across lines). Otherwise, treat
 * each non-empty line as one reference. Leading numbering is stripped.
 */
function parseReferences(text) {
  if (!text) return [];
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];

  let chunks;
  const lines = normalized.split('\n');
  const numberedLines = lines.filter(l => LEADING_NUMBER_RE.test(l) && l.trim().length > 0).length;
  const nonEmpty = lines.filter(l => l.trim().length > 0).length;

  if (numberedLines >= 2 && numberedLines >= nonEmpty * 0.5) {
    // Numbered list: start a new reference at every numbered line, append
    // continuation lines to the current one.
    chunks = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      if (LEADING_NUMBER_RE.test(line) || chunks.length === 0) chunks.push(line);
      else chunks[chunks.length - 1] += ' ' + line.trim();
    }
  } else if (/\n\s*\n/.test(normalized)) {
    chunks = normalized.split(/\n\s*\n+/).map(c => c.replace(/\s*\n\s*/g, ' '));
  } else {
    chunks = lines;
  }

  return chunks
    .map(c => c.replace(LEADING_NUMBER_RE, '').replace(/\s+/g, ' ').trim())
    .filter(c => c.length > 0);
}

function extractDoi(ref) {
  const m = ref.match(DOI_RE);
  if (!m) return null;
  // Trim trailing punctuation that is almost never part of a DOI.
  return m[1].replace(/[.,;:)\]]+$/, '');
}

function extractYear(ref) {
  // Prefer a four-digit year in parentheses or followed by ; or . as in common styles.
  const m = ref.match(/\b(1[89]\d{2}|20\d{2})\b/g);
  if (!m) return null;
  // If several years appear (e.g. a date accessed), take the first.
  return parseInt(m[0], 10);
}

function extractFirstSurname(ref) {
  // Take the first word-like token before the first comma or period.
  const head = ref.split(/[,.;(]/)[0] || '';
  const tokens = head.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  // Drop leading particles like "van", "de" handled loosely: use the longest
  // token in the first three positions that looks like a surname.
  const candidates = tokens.slice(0, 3).filter(t => /^[A-Za-zÀ-ÿ'’-]{2,}$/.test(t));
  if (candidates.length === 0) return null;
  return candidates[0];
}

function extractTitleGuess(ref) {
  // Heuristic: the longest sentence-ish segment between periods/question marks
  // that is not the author block and is not the journal/volume tail.
  const segments = ref.split(/(?<=[.?!])\s+/).map(s => s.trim()).filter(Boolean);
  if (segments.length <= 1) return ref;
  let best = '';
  for (const s of segments) {
    const words = s.split(/\s+/).length;
    const looksLikeAuthors = /^[A-Z][a-z]+ [A-Z]{1,3}[,.]/.test(s) || /\bet al\b/i.test(s) && words < 8;
    const looksLikeTail = /\b(vol|pp?|doi|https?:|\d{4};|\d+\(\d+\))/i.test(s) && words < 10;
    if (!looksLikeAuthors && !looksLikeTail && s.length > best.length) best = s;
  }
  return best || ref;
}

window.RefParse = { parseReferences, extractDoi, extractYear, extractFirstSurname, extractTitleGuess };

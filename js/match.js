/* Field-by-field comparison of a reference with a Crossref record.
 *
 * Each check returns { ok, given, expected, note } where ok is
 *   true      the reference agrees with Crossref
 *   false     the reference disagrees with Crossref (an error)
 *   'missing' Crossref has a value the reference leaves out (a warning)
 *   null      nothing to compare (Crossref has no value)
 */

const STOP = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'and', 'or', 'for', 'to', 'with', 'by', 'at', 'from', 'is', 'as', 'its', 'into', 'via']);
const JOURNAL_STOP = new Set(['the', 'of', 'and', 'for', 'in', 'on', 'de', 'la', 'le', 'des', 'du', 'der', 'und', 'et']);
const NAME_SKIP = new Set(['and', 'et', 'al', 'jr', 'sr', 'ii', 'iii', 'iv', 'ed', 'eds', 'editor', 'editors', 'with']);

function deaccent(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normalizeText(s) {
  return deaccent(s)
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[’'‘`]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(s) {
  const n = normalizeText(s);
  return n ? n.split(' ') : [];
}

function significant(s) {
  return words(s).filter(t => (t.length > 1 || /\d/.test(t)) && !STOP.has(t));
}

// ---- Crossref record accessors ----

function workTitle(work) {
  return (work.title && work.title[0]) || '';
}

function workTitleFull(work) {
  const sub = work.subtitle && work.subtitle[0];
  return sub ? `${workTitle(work)}: ${sub}` : workTitle(work);
}

function yearOf(field) {
  const dp = field && field['date-parts'] && field['date-parts'][0];
  return dp && dp[0] ? dp[0] : null;
}

function workYear(work) {
  return yearOf(work.issued) || yearOf(work['published-print']) || yearOf(work['published-online']) || yearOf(work.created);
}

/** Every year a work could correctly be cited with (online first vs print). */
function workYears(work) {
  return new Set([work.issued, work.published, work['published-print'], work['published-online']].map(yearOf).filter(Boolean));
}

function workJournal(work) {
  return {
    full: (work['container-title'] || [])[0] || '',
    short: (work['short-container-title'] || [])[0] || '',
  };
}

function workPages(work) {
  if (work.page) {
    const [s, e] = work.page.split(/\s*[-–—]+\s*/);
    return { start: s || null, end: e || null };
  }
  if (work['article-number']) return { start: String(work['article-number']), end: null };
  return { start: null, end: null };
}

function workFirstAuthor(work) {
  const a = (work.author || [])[0];
  return a ? (a.family || a.name || null) : null;
}

function initialsOf(given) {
  return deaccent(given || '').split(/[\s.\-]+/).filter(Boolean).map(p => p[0].toUpperCase()).join('');
}

// ---- Locating parts of the reference ----

/** Find where the Crossref title begins and ends inside the reference. */
function locateTitle(plain, work) {
  const tw = words(workTitle(work));
  if (tw.length === 0) return null;
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Try the first two title words, then words two and three (in case a leading "The" was dropped).
  const attempts = [];
  if (tw.length >= 2) attempts.push([tw[0], tw[1]]);
  if (tw.length >= 3) attempts.push([tw[1], tw[2]]);
  if (tw.length === 1) attempts.push([tw[0]]);
  for (const pair of attempts) {
    const re = new RegExp('(^|[^a-z0-9])(' + pair.map(esc).join('[^a-z0-9]+') + ')(?![a-z0-9])', 'i');
    const m = re.exec(plain.replace(/[’'‘`]/g, ''));
    if (!m) continue;
    // Map the index back to the plain string (only apostrophes were removed).
    const start = mapIndex(plain, m.index + m[1].length);
    const minLen = Math.floor(workTitleFull(work).length * 0.5);
    // A title in quotes ends at the closing quote; otherwise at the next sentence end.
    const quoted = /["“'‘]\s*$/.test(plain.slice(0, start));
    const term = quoted ? /[,.?!]?["”'’»](?=[\s,.;:]|$)/g : /[.?!]["”’'»]?(?=\s|$)/g;
    term.lastIndex = Math.min(plain.length, start + Math.max(minLen, 1));
    const t = term.exec(plain);
    const end = t ? t.index + t[0].length : plain.length;
    return { start, end };
  }
  return null;
}

function mapIndex(plain, idx) {
  // Convert an index in the apostrophe-stripped string back to the plain string.
  let i = 0, j = 0;
  while (i < plain.length && j < idx) {
    if (!/[’'‘`]/.test(plain[i])) j++;
    i++;
  }
  while (i < plain.length && /[’'‘`]/.test(plain[i])) i++;
  return i;
}

/** The author block: text before the title, or a best guess. */
function authorSegment(plain, titleLoc) {
  if (titleLoc && titleLoc.start > 0) return plain.slice(0, titleLoc.start).replace(/["“'‘]\s*$/, '');
  const y = plain.match(/\(\s*(?:1[89]|20)\d{2}/);
  if (y && y.index < 300) return plain.slice(0, y.index);
  const p = plain.match(/\.\s/);
  return p ? plain.slice(0, p.index) : '';
}

function isInitials(tok) {
  return /^(?:[A-Z]\.?-?){1,4}$/.test(tok) && !/^[A-Z][a-z]/.test(tok);
}

function tokenizeAuthors(seg) {
  // Keep track of whether a comma (or ; or &) separates each token from the one before.
  const out = [];
  const re = /[^\s,;&]+/g;
  let m, prevEnd = 0;
  while ((m = re.exec(seg)) !== null) {
    const gap = seg.slice(prevEnd, m.index);
    prevEnd = m.index + m[0].length;
    const raw = m[0].replace(/^[("“'‘\[]+/, '').replace(/[)"”'’\].,:;]+$/, '').trim();
    if (!raw) continue;
    const key = normalizeText(raw).replace(/ /g, '');
    let kind = 'name';
    if (isInitials(raw)) kind = 'initials';
    else if (!key || NAME_SKIP.has(key) || /^\d+$/.test(key) || raw === '…' || raw === '...') kind = 'skip';
    out.push({ raw, key, kind, used: false, commaBefore: /[,;&]/.test(gap) });
  }
  return out;
}

// ---- Individual checks ----

function checkTitle(plain, work, titleLoc, refText) {
  const expected = workTitleFull(work);
  const cross = significant(expected);
  const crossSet = new Set(cross);
  const coverageBase = new Set(significant(refText));
  const covered = cross.filter(t => coverageBase.has(t)).length;
  const coverage = cross.length ? covered / cross.length : 0;

  if (!titleLoc) {
    const missing = cross.filter(t => !coverageBase.has(t));
    return { ok: missing.length === 0 ? true : false, coverage, expected, missing, extra: [], located: false };
  }
  const given = plain.slice(titleLoc.start, titleLoc.end).replace(/[,."”'’»]+$/, '').trim();
  const refWords = significant(given);
  const refSet = new Set(refWords);
  const missing = [...new Set(cross.filter(t => !refSet.has(t)))];
  const extra = [...new Set(refWords.filter(t => !crossSet.has(t)))];
  return { ok: missing.length === 0 && extra.length === 0, coverage, expected, given, missing, extra, located: true };
}

function checkAuthors(plain, work, titleLoc) {
  const authors = work.author || [];
  if (authors.length === 0) return { ok: null, note: 'Crossref lists no authors' };
  const seg = authorSegment(plain, titleLoc);
  const etAl = /\bet\.?\s*al\b/i.test(seg) || /\bet\.?\s*al\b/i.test(plain.slice(0, 400));
  const toks = tokenizeAuthors(seg);
  const names = toks.filter(t => t.kind === 'name');
  if (names.length === 0) return { ok: 'missing', note: 'no authors found in the reference', total: authors.length };

  const givenParts = new Set();
  for (const a of authors) for (const p of words(a.given || '')) if (p.length > 1) givenParts.add(p);

  // Match each Crossref author to a surname in the reference.
  const found = authors.map((a, ai) => {
    const fam = normalizeText(a.family || a.name || '').replace(/ /g, '');
    if (!fam) return null;
    const lastPart = words(a.family || a.name || '').slice(-1)[0] || '';
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].kind !== 'name' || toks[i].used) continue;
      let acc = '';
      for (let j = i; j < Math.min(toks.length, i + 4); j++) {
        if (toks[j].kind !== 'name') break;
        acc += toks[j].key;
        if (acc === fam || (j === i && toks[i].key === lastPart && lastPart.length > 2)) {
          for (let k = i; k <= j; k++) toks[k].used = true;
          return { ai, pos: i, endPos: j };
        }
        if (!fam.startsWith(acc)) break;
      }
    }
    return null;
  });

  // Mark given names (e.g. "Leo Anthony Celi") as recognised rather than unknown.
  for (const t of toks) if (t.kind === 'name' && !t.used && givenParts.has(t.key)) { t.used = true; t.given = true; }

  const hits = found.filter(Boolean);
  const lastFoundIdx = hits.length ? Math.max(...hits.map(h => h.ai)) : -1;
  const missing = [];
  authors.forEach((a, ai) => {
    if (found[ai]) return;
    if (etAl && ai > lastFoundIdx) return; // covered by "et al."
    missing.push(a.family || a.name || '?');
  });
  const unknown = toks.filter(t => t.kind === 'name' && !t.used).map(t => t.raw);

  // Order: the reference positions should rise in Crossref order.
  let orderOk = true;
  for (let i = 1; i < hits.length; i++) if (hits[i].pos < hits[i - 1].pos) orderOk = false;
  const firstOk = !!found[0] && hits.every(h => h.pos >= found[0].pos) &&
    !toks.slice(0, found[0] ? found[0].pos : 0).some(t => t.kind === 'name' && !t.used);

  // Initials: compare the first initial next to each surname with Crossref's given name.
  // Styles like IEEE put initials before the surname; most others put them after.
  const firstTok = toks.find(t => t.kind !== 'skip');
  const initialsFirst = !!firstTok && (firstTok.kind === 'initials' || firstTok.given);
  const letters = t => t.kind === 'initials' ? t.raw.replace(/[.\-]/g, '') : t.raw[0].toUpperCase();
  const before = h => {
    let s = '';
    for (let k = h.pos - 1; k >= 0 && (toks[k].kind === 'initials' || toks[k].given) && !toks[k + 1].commaBefore; k--) s = letters(toks[k]) + s;
    return s;
  };
  const after = (h, kinds) => {
    let s = '';
    for (let k = h.endPos + 1; k < toks.length && kinds(toks[k]); k++) s += letters(toks[k]);
    return s;
  };
  const initialsWrong = [];
  for (const h of hits) {
    const a = authors[h.ai];
    const want = initialsOf(a.given);
    if (!want) continue;
    let got = initialsFirst
      ? before(h)
      : (after(h, t => t.kind === 'initials') || before(h) || after(h, t => t.given));
    if (got && got[0].toUpperCase() !== want[0]) initialsWrong.push(`${a.family} (${got}, Crossref ${want})`);
  }

  const ok = missing.length === 0 && unknown.length === 0 && orderOk && firstOk && initialsWrong.length === 0;
  return {
    ok, total: authors.length, matched: hits.length, etAl, missing, unknown, orderOk, firstOk, initialsWrong,
    expected: authors.map(a => a.family || a.name).filter(Boolean),
  };
}

/** True if abbreviation `ab` could stand for `word` (N Engl J Med, Natl, Assoc...). */
function abbreviates(ab, word) {
  if (!ab || !word || ab[0] !== word[0] || ab.length > word.length) return false;
  let i = 0;
  for (const ch of word) if (ch === ab[i]) i++;
  return i === ab.length;
}

function checkJournal(plain, work, titleLoc) {
  const j = workJournal(work);
  if (!j.full && !j.short) return { ok: null };
  const after = titleLoc ? plain.slice(titleLoc.end) : plain;
  const hay = normalizeText(after);
  const hayWords = hay.split(' ');
  const expected = j.full || j.short;
  const candidates = [j.full, j.short].filter(Boolean);
  for (const c of candidates) {
    const n = normalizeText(c);
    if (n && (' ' + hay + ' ').includes(' ' + n + ' ')) return { ok: true, expected };
    const nNoThe = n.replace(/^the /, '');
    if (nNoThe && (' ' + hay + ' ').includes(' ' + nNoThe + ' ')) return { ok: true, expected };
  }
  for (const c of candidates) {
    const jw = words(c).filter(w => !JOURNAL_STOP.has(w));
    if (jw.length === 0) continue;
    for (let i = 0; i + jw.length <= hayWords.length; i++) {
      let all = true;
      for (let k = 0; k < jw.length; k++) if (!abbreviates(hayWords[i + k], jw[k])) { all = false; break; }
      if (all) return { ok: true, expected };
    }
  }
  return { ok: false, expected };
}

function normId(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function sameId(a, b) {
  if (normId(a) === normId(b)) return true;
  const da = String(a).replace(/\D/g, ''), db = String(b).replace(/\D/g, '');
  return da !== '' && da === db && /^\D*\d+\D*$/.test(a) && /^\D*\d+\D*$/.test(b);
}

function checkSimple(given, expected) {
  if (!expected) return { ok: null, given, expected: null };
  if (!given) return { ok: 'missing', given: null, expected };
  return { ok: sameId(given, expected), given, expected };
}

function checkPages(details, work) {
  const exp = workPages(work);
  const expectedStr = exp.start ? (exp.end ? `${exp.start}-${exp.end}` : exp.start) : null;
  if (!exp.start) return { ok: null, expected: null };
  const givenStr = details.pageStart ? (details.pageEnd ? `${details.pageStart}-${details.pageEnd}` : details.pageStart) : null;
  if (!details.pageStart) return { ok: 'missing', given: null, expected: expectedStr };
  let ok = sameId(details.pageStart, exp.start);
  if (ok && details.pageEnd && exp.end) ok = sameId(details.pageEnd, exp.end);
  return { ok, given: givenStr, expected: expectedStr };
}

function checkYear(details, work) {
  const years = workYears(work);
  const expected = workYear(work);
  if (years.size === 0) return { ok: null };
  if (!details.year) return { ok: 'missing', expected };
  return { ok: years.has(details.year), given: details.year, expected, allowed: [...years].sort() };
}

function checkDoi(ref, work) {
  const expected = work.DOI;
  if (!ref.doi) return { ok: 'missing', expected };
  return { ok: ref.doi.toLowerCase() === String(expected).toLowerCase(), given: ref.doi, expected };
}

/**
 * Compare every part of a reference with a Crossref work.
 * `ref` is { text, doi, details } from the parser.
 */
function checkWork(work, ref) {
  const plain = deaccent(ref.text);
  const titleLoc = locateTitle(plain, work);
  const c = {
    title: checkTitle(plain, work, titleLoc, ref.text),
    authors: checkAuthors(plain, work, titleLoc),
    journal: checkJournal(plain, work, titleLoc),
    year: checkYear(ref.details, work),
    volume: checkSimple(ref.details.volume, work.volume),
    issue: checkSimple(ref.details.issue, work.issue),
    pages: checkPages(ref.details, work),
    doi: checkDoi(ref, work),
  };
  c.coverage = c.title.coverage;

  // Evidence that this is the same paper, independent of the title.
  const anyAuthor = c.authors.matched > 0;
  c.agreements = [anyAuthor, c.year.ok === true, c.journal.ok === true, c.volume.ok === true, c.pages.ok === true].filter(Boolean).length;
  c.disagreements = [c.authors.matched === 0, c.year.ok === false, c.journal.ok === false, c.volume.ok === false, c.pages.ok === false].filter(Boolean).length;
  c.score = c.coverage + 0.15 * c.agreements - 0.2 * c.disagreements;

  const FIELDS = ['title', 'authors', 'journal', 'year', 'volume', 'issue', 'pages'];
  c.errors = FIELDS.filter(f => c[f].ok === false);
  c.warnings = FIELDS.filter(f => c[f].ok === 'missing');
  if (ref.doi && c.doi.ok === false) c.errors.push('doi');
  return c;
}

/** Decide the overall status from the field checks. */
function classify(c, viaDoi) {
  const cov = c.coverage;
  const samePaper = (cov >= 0.8 && (c.agreements >= 2 || (cov >= 0.95 && c.agreements >= 1))) || (viaDoi && cov >= 0.8);
  if (samePaper) return c.errors.length ? 'errors' : 'match';
  if (cov >= 0.55 && c.agreements >= 1) return 'likely';
  if (cov >= 0.8) return 'likely';
  return viaDoi ? 'mismatch' : 'unverified';
}

/** A Vancouver-style citation built from the Crossref record. */
function formatVancouver(work) {
  const authors = (work.author || []).map(a => a.family ? `${a.family} ${initialsOf(a.given)}`.trim() : a.name).filter(Boolean);
  const list = authors.length > 6 ? authors.slice(0, 6).join(', ') + ', et al' : authors.join(', ');
  const j = workJournal(work);
  const journal = j.short || j.full;
  const year = workYear(work);
  const pages = workPages(work);
  const pageStr = pages.start ? `:${pages.start}${pages.end ? '-' + pages.end : ''}` : '';
  const vol = work.volume ? `;${work.volume}` : '';
  const iss = work.issue ? `(${work.issue})` : '';
  const title = workTitleFull(work).replace(/<[^>]+>/g, '').replace(/[.]$/, '');
  const end = /[?!]$/.test(title) ? '' : '.';
  return `${list ? list + '. ' : ''}${title}${end} ${journal ? journal + '. ' : ''}${year || ''}${vol}${iss}${pageStr}. doi:${work.DOI}`.replace(/\s+/g, ' ').trim();
}

window.RefMatch = {
  checkWork, classify, formatVancouver, workTitle, workTitleFull, workYear, workJournal, workPages,
  workFirstAuthor, normalizeText, abbreviates,
};

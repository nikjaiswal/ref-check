/* Scoring a Crossref work against the text of a reference. */

function normalizeText(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(s) {
  const stop = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'and', 'or', 'for', 'to', 'with', 'by', 'at', 'from', 'is', 'as']);
  return new Set(normalizeText(s).split(' ').filter(t => t.length > 1 && !stop.has(t)));
}

/** Fraction of the work's title tokens that appear in the reference text. */
function titleCoverage(workTitle, refText) {
  const t = tokenSet(workTitle);
  if (t.size === 0) return 0;
  const r = tokenSet(refText);
  let hit = 0;
  for (const tok of t) if (r.has(tok)) hit++;
  return hit / t.size;
}

function workYear(work) {
  const dp = (work.issued && work.issued['date-parts'] && work.issued['date-parts'][0])
    || (work['published-print'] && work['published-print']['date-parts'][0])
    || (work['published-online'] && work['published-online']['date-parts'][0])
    || (work.created && work.created['date-parts'] && work.created['date-parts'][0]);
  return dp && dp[0] ? dp[0] : null;
}

function workTitle(work) {
  return (work.title && work.title[0]) || (work['container-title'] && work['container-title'][0]) || '';
}

function workFirstAuthor(work) {
  const a = (work.author || [])[0] || (work.editor || [])[0];
  if (!a) return null;
  return a.family || a.name || null;
}

function authorsMatch(refSurname, work) {
  if (!refSurname) return null;
  const ref = normalizeText(refSurname);
  const authors = (work.author || []).concat(work.editor || []);
  if (authors.length === 0) return null;
  return authors.some(a => {
    const fam = normalizeText(a.family || a.name || '');
    return fam && (fam === ref || fam.includes(ref) || ref.includes(fam));
  });
}

/**
 * Score one Crossref work against a parsed reference.
 * Returns { title, author, year, score, status }.
 *  title: 0..1 coverage, author: true/false/null, year: true/false/null
 */
function scoreWork(work, parsed) {
  const title = titleCoverage(workTitle(work), parsed.text);
  const author = authorsMatch(parsed.surname, work);
  const wy = workYear(work);
  let year = null;
  if (parsed.year && wy) year = Math.abs(parsed.year - wy) <= 1; // allow online-first vs print

  let score = title;
  if (author === true) score += 0.3;
  if (author === false) score -= 0.2;
  if (year === true) score += 0.2;
  if (year === false) score -= 0.25;

  return { title, author, year, score, workYear: wy };
}

function classify(result, viaDoi) {
  const { title, author, year } = result;
  const strongTitle = title >= 0.8;
  const okTitle = title >= 0.55;
  const agree = [author, year].filter(v => v === true).length;
  const disagree = [author, year].filter(v => v === false).length;

  if (viaDoi) {
    if (strongTitle && disagree === 0) return 'match';
    if (okTitle && disagree <= 1) return 'likely';
    return 'mismatch';
  }
  if (strongTitle && disagree === 0 && agree >= 1) return 'match';
  if (strongTitle && disagree === 0) return 'match';
  if (okTitle && disagree === 0) return 'likely';
  if (strongTitle && disagree === 1) return 'likely';
  return 'unverified';
}

window.RefMatch = { scoreWork, classify, workYear, workTitle, workFirstAuthor, normalizeText };

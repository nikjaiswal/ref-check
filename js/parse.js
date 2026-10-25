/* Parsing of pasted reference lists into individual entries, plus extraction
 * of the DOI, year, volume, issue and pages from each entry. Author and title
 * parsing happens in match.js, because it uses the Crossref record to find
 * where the title starts. */

const DOI_RE = /\b(10\.\d{4,9}\/[^\s"<>]+)/i;
const LEADING_NUMBER_RE = /^\s*(?:\[\d+\]|\(\d+\)|\d+[.)]|\d+\s+|[•\-–*]\s+)\s*/;
const YEAR = '((?:1[89]|20)\\d{2})';
const PAGE = '([A-Za-z]{0,2}\\d+[A-Za-z]?)';
const DASH = '\\s*[-–—]+\\s*';

/**
 * Split a block of pasted text into reference strings.
 * Numbered lists start a new reference at every number. Otherwise blank lines
 * separate references, and failing that each line is one reference.
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
  return m[1].replace(/[.,;:)\]]+$/, '');
}

/** Text with URLs and DOIs removed, so their digits are not read as pages. */
function stripLinks(ref) {
  return ref
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b(?:doi:?\s*)?10\.\d{4,9}\/\S+/gi, ' ')
    .replace(/\b(?:PMID|PMCID):?\s*\S+/gi, ' ');
}

/** Expand abbreviated end pages: 1716-20 becomes 1716-1720. */
function expandPages(start, end) {
  if (!start) return { start: null, end: null };
  start = start.trim();
  end = end ? end.trim() : null;
  if (end) {
    const sm = start.match(/^([A-Za-z]*)(\d+)([A-Za-z]?)$/);
    const em = end.match(/^([A-Za-z]*)(\d+)([A-Za-z]?)$/);
    if (sm && em && em[2].length < sm[2].length) {
      end = (em[1] || sm[1]) + sm[2].slice(0, sm[2].length - em[2].length) + em[2] + em[3];
    }
  }
  return { start, end };
}

/**
 * Pull year, volume, issue and pages out of a reference.
 * Handles Vancouver/AMA (2018;24(11):1716-20), APA (24(11), 1716-1720),
 * and labeled styles (vol. 24, no. 11, pp. 1716-1720).
 */
function extractDetails(ref) {
  const text = stripLinks(ref);
  const out = { year: null, volume: null, issue: null, pageStart: null, pageEnd: null, style: null };

  // Vancouver / AMA: year, optional month/day, semicolon, volume(issue):pages
  const van = new RegExp(
    '\\b' + YEAR + '[a-z]?(?:\\s+[A-Z][a-z]{2,8}\\.?(?:[-–/][A-Z][a-z]{2,8})?(?:\\s+\\d{1,2})?)?\\s*;\\s*' +
    '(\\d+[A-Za-z]?)?\\s*(?:\\(([^)]+)\\))?\\s*(?::\\s*' + PAGE + '(?:' + DASH + PAGE + ')?)?'
  );
  const v = text.match(van);
  if (v && (v[2] || v[4])) {
    const p = expandPages(v[4], v[5]);
    Object.assign(out, { year: +v[1], volume: v[2] || null, issue: v[3] || null, pageStart: p.start, pageEnd: p.end, style: 'vancouver' });
    return out;
  }

  // Labeled: vol. 24, no. 11, pp. 1716-1720 (MLA, IEEE, Harvard and others)
  const apaYear = text.match(new RegExp('\\(\\s*' + YEAR + '[a-z]?[^)]*\\)'));
  const vol = text.match(/\b(?:vol(?:ume)?)\.?\s*(\d+[A-Za-z]?)/i);
  const iss = text.match(/\b(?:no|issue|iss)\.?\s*(\d+[A-Za-z]?)/i);
  const pp = text.match(new RegExp('\\b(?:pp?|pages?)\\.?\\s*' + PAGE + '(?:' + DASH + PAGE + ')?', 'i'));
  if (vol) {
    const p = pp ? expandPages(pp[1], pp[2]) : { start: null, end: null };
    Object.assign(out, { volume: vol[1], issue: iss ? iss[1] : null, pageStart: p.start, pageEnd: p.end, style: 'labeled' });
    out.year = apaYear ? +apaYear[1] : firstYear(text);
    return out;
  }

  // APA: (2018). Title. Journal, 24(11), 1716-1720.
  const apaRe = new RegExp(',\\s*(\\d+[A-Za-z]?)\\s*(?:\\(([^)]+)\\))?\\s*,\\s*(?:pp?\\.\\s*)?' + PAGE + '(?:' + DASH + PAGE + ')?', 'g');
  let a, last = null;
  while ((a = apaRe.exec(text)) !== null) last = a;
  if (last) {
    const p = expandPages(last[3], last[4]);
    Object.assign(out, { volume: last[1], issue: last[2] || null, pageStart: p.start, pageEnd: p.end, style: 'apa' });
    out.year = apaYear ? +apaYear[1] : firstYear(text);
    return out;
  }

  // Chicago and similar: Journal 24 (11): 1716-20
  const chi = text.match(new RegExp('\\b(\\d+[A-Za-z]?)\\s*(?:\\(([^)]+)\\))?\\s*:\\s*' + PAGE + '(?:' + DASH + PAGE + ')?'));
  if (chi) {
    const p = expandPages(chi[3], chi[4]);
    Object.assign(out, { volume: chi[1], issue: chi[2] || null, pageStart: p.start, pageEnd: p.end, style: 'chicago' });
    out.year = apaYear ? +apaYear[1] : firstYear(text);
    return out;
  }

  // Only page or issue labels, no volume.
  if (iss || pp) {
    const p = pp ? expandPages(pp[1], pp[2]) : { start: null, end: null };
    Object.assign(out, { issue: iss ? iss[1] : null, pageStart: p.start, pageEnd: p.end, style: 'labeled' });
  }
  out.year = apaYear ? +apaYear[1] : firstYear(text);
  return out;
}

function firstYear(text) {
  const m = text.match(/\b(1[89]\d{2}|20\d{2})\b/);
  return m ? parseInt(m[1], 10) : null;
}

function extractYear(ref) {
  return extractDetails(ref).year;
}

window.RefParse = { parseReferences, extractDoi, extractYear, extractDetails, expandPages, stripLinks };

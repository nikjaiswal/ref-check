/* Thin client for the Crossref REST API.
 * Docs: https://www.crossref.org/documentation/retrieve-metadata/rest-api/
 * Crossref asks for a mailto parameter to use the "polite" pool, and limits
 * clients to roughly 3 requests per second with 3 concurrent requests. */

const CROSSREF_BASE = 'https://api.crossref.org';
const SELECT_FIELDS = 'DOI,title,subtitle,author,editor,issued,published,published-print,published-online,created,container-title,short-container-title,volume,issue,page,article-number,type,score,publisher';

function buildUrl(path, params, mailto) {
  const url = new URL(CROSSREF_BASE + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  if (mailto) url.searchParams.set('mailto', mailto);
  return url.toString();
}

async function fetchJson(url, signal) {
  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    } catch (e) {
      // Crossref's error responses (429, 5xx) sometimes carry no CORS headers,
      // which surfaces in the browser as a generic network failure. Retry.
      if (e.name === 'AbortError') throw e;
      attempt++;
      if (attempt > 3) throw new Error('Could not reach Crossref after 3 attempts');
      await sleep(1500 * attempt, signal);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      attempt++;
      if (attempt > 3) throw new Error('Crossref returned HTTP ' + res.status + ' after 3 retries');
      const retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10);
      await sleep((retryAfter > 0 ? retryAfter * 1000 : 1500 * attempt), signal);
      continue;
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('Crossref HTTP ' + res.status);
    return res.json();
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}

/** Look up a single DOI. Returns the work object or null if not found. */
async function getWorkByDoi(doi, mailto, signal) {
  const data = await fetchJson(buildUrl('/works/' + encodeURIComponent(doi), {}, mailto), signal);
  return data && data.message ? data.message : null;
}

/** Bibliographic search. Returns up to `rows` works. */
async function searchBibliographic(text, rows, mailto, signal) {
  // URLs and DOIs add noise to the bibliographic search; strip them.
  const cleaned = text.replace(/https?:\/\/\S+/gi, ' ').replace(/\b(doi:?\s*)?10\.\d{4,9}\/\S+/gi, ' ').replace(/\s+/g, ' ').trim();
  const data = await fetchJson(buildUrl('/works', {
    'query.bibliographic': (cleaned || text).slice(0, 500),
    rows: String(rows || 3),
    select: SELECT_FIELDS,
  }, mailto), signal);
  return data && data.message && data.message.items ? data.message.items : [];
}

/** Simple token-bucket limiter: at most `perSecond` calls per second. */
function makeRateLimiter(perSecond) {
  const interval = 1000 / perSecond;
  let next = 0;
  return async function wait(signal) {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + interval;
    if (at > now) await sleep(at - now, signal);
  };
}

window.Crossref = { getWorkByDoi, searchBibliographic, makeRateLimiter };

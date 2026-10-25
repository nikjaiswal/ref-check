/* UI wiring: parse input, run checks with limited concurrency, render table. */
(function () {
  const $ = (sel) => document.querySelector(sel);
  const refsEl = $('#refs');
  const mailtoEl = $('#mailto');
  const checkBtn = $('#check');
  const cancelBtn = $('#cancel');
  const progressEl = $('#progress');
  const barFill = $('#bar-fill');
  const progressText = $('#progress-text');
  const summaryEl = $('#summary');
  const resultsSection = $('#results-section');
  const tbody = $('#results tbody');

  const STATUS_LABEL = {
    match: 'Match', likely: 'Likely', unverified: 'Unverified', mismatch: 'DOI mismatch', error: 'Error', pending: 'Checking…',
  };

  const SAMPLE = `1. Watson JD, Crick FHC. Molecular structure of nucleic acids: a structure for deoxyribose nucleic acid. Nature. 1953;171(4356):737-738.
2. Lowry OH, Rosebrough NJ, Farr AL, Randall RJ. Protein measurement with the Folin phenol reagent. J Biol Chem. 1951;193(1):265-275.
3. Kaplan EL, Meier P. Nonparametric estimation from incomplete observations. J Am Stat Assoc. 1958;53(282):457-481. doi:10.1080/01621459.1958.10501452
4. Smith JA, Doe RB. Longitudinal outcomes of imaginary interventions in a fictional cohort. J Nonexistent Med. 2019;12(3):45-52.
5. Bland JM, Altman DG. Statistical methods for assessing agreement between two methods of clinical measurement. Lancet. 1986;1(8476):307-310. https://doi.org/10.1038/171737a0`;

  let state = { results: [], controller: null };

  // Persist the email locally as a convenience; wrapped because storage can be blocked.
  try { const saved = localStorage.getItem('refcheck.mailto'); if (saved) mailtoEl.value = saved; } catch (e) { /* ignore */ }
  mailtoEl.addEventListener('change', () => { try { localStorage.setItem('refcheck.mailto', mailtoEl.value.trim()); } catch (e) { /* ignore */ } });

  // Point the footer link at the repo if served from GitHub Pages.
  (function setRepoLink() {
    const a = $('#repo-link');
    const m = location.hostname.match(/^([^.]+)\.github\.io$/);
    if (m) {
      const repo = location.pathname.split('/').filter(Boolean)[0];
      a.href = repo ? `https://github.com/${m[1]}/${repo}` : `https://github.com/${m[1]}`;
    } else {
      a.href = 'https://github.com';
    }
  })();

  $('#sample').addEventListener('click', () => { refsEl.value = SAMPLE; });
  $('#clear').addEventListener('click', () => { refsEl.value = ''; resetOutput(); });
  checkBtn.addEventListener('click', runCheck);
  cancelBtn.addEventListener('click', () => { if (state.controller) state.controller.abort(); });
  $('#export-csv').addEventListener('click', exportCsv);
  $('#copy-dois').addEventListener('click', copyDois);

  function resetOutput() {
    tbody.innerHTML = '';
    summaryEl.hidden = true;
    resultsSection.hidden = true;
    state.results = [];
  }

  async function runCheck() {
    const refs = RefParse.parseReferences(refsEl.value);
    if (refs.length === 0) { refsEl.focus(); return; }
    const mailto = mailtoEl.value.trim() || undefined;

    resetOutput();
    state.controller = new AbortController();
    const signal = state.controller.signal;

    state.results = refs.map((text, i) => ({
      index: i + 1,
      text,
      doi: RefParse.extractDoi(text),
      year: RefParse.extractYear(text),
      surname: RefParse.extractFirstSurname(text),
      status: 'pending',
      best: null,
      candidates: [],
      score: null,
      error: null,
    }));

    resultsSection.hidden = false;
    for (const r of state.results) tbody.appendChild(renderRow(r));

    checkBtn.disabled = true;
    progressEl.hidden = false;
    let done = 0;
    updateProgress(0, refs.length);

    const limiter = Crossref.makeRateLimiter(2.5);
    const queue = state.results.slice();
    const CONCURRENCY = 3;

    async function worker() {
      while (queue.length && !signal.aborted) {
        const r = queue.shift();
        try {
          await checkOne(r, mailto, limiter, signal);
        } catch (e) {
          if (e.name === 'AbortError') { r.status = 'error'; r.error = 'Cancelled'; }
          else { r.status = 'error'; r.error = e.message || String(e); }
        }
        done++;
        updateProgress(done, refs.length);
        replaceRow(r);
      }
    }

    try {
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    } finally {
      checkBtn.disabled = false;
      progressEl.hidden = true;
      state.controller = null;
      renderSummary();
    }
  }

  async function checkOne(r, mailto, limiter, signal) {
    if (r.doi) {
      await limiter(signal);
      const work = await Crossref.getWorkByDoi(r.doi, mailto, signal);
      if (work) {
        const s = RefMatch.scoreWork(work, r);
        r.best = work;
        r.score = s;
        r.status = RefMatch.classify(s, true);
        r.viaDoi = true;
        // If the DOI points elsewhere, also search by text so the user can see the probable intended work.
        if (r.status === 'mismatch') {
          await limiter(signal);
          const items = await Crossref.searchBibliographic(r.text, 3, mailto, signal);
          r.candidates = rankCandidates(items, r);
        }
        return;
      }
      r.doiNotFound = true; // fall through to bibliographic search
    }

    await limiter(signal);
    const items = await Crossref.searchBibliographic(r.text, 3, mailto, signal);
    const ranked = rankCandidates(items, r);
    r.candidates = ranked;
    if (ranked.length === 0) { r.status = 'unverified'; return; }
    r.score = ranked[0].score;
    r.status = RefMatch.classify(ranked[0].score, false);
    if (r.status !== 'unverified') r.best = ranked[0].work;
  }

  function rankCandidates(items, r) {
    return items
      .map(work => ({ work, score: RefMatch.scoreWork(work, r) }))
      .sort((a, b) => b.score.score - a.score.score);
  }

  function updateProgress(done, total) {
    barFill.style.width = Math.round((done / total) * 100) + '%';
    progressText.textContent = `${done} / ${total}`;
  }

  // ---- Rendering ----

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else e.setAttribute(k, v);
    }
    for (const c of children) if (c != null) e.append(c);
    return e;
  }

  function badge(status) {
    return el('span', { class: 'badge ' + status }, STATUS_LABEL[status] || status);
  }

  function formatWork(work) {
    const title = RefMatch.workTitle(work);
    const authors = (work.author || []).slice(0, 3).map(a => a.family || a.name).filter(Boolean);
    const more = (work.author || []).length > 3 ? ' et al' : '';
    const journal = (work['container-title'] || [])[0] || work.publisher || '';
    const year = RefMatch.workYear(work);
    const vol = work.volume ? `;${work.volume}` : '';
    const issue = work.issue ? `(${work.issue})` : '';
    const page = work.page ? `:${work.page}` : '';
    const parts = [authors.length ? authors.join(', ') + more : '', journal, `${year || ''}${vol}${issue}${page}`].filter(Boolean);
    return { title, meta: parts.join('. ') };
  }

  function checkLine(label, value, detail) {
    const cls = value === true ? 'ok' : value === false ? 'bad' : 'na';
    const mark = value === true ? '✓' : value === false ? '✗' : '–';
    return el('div', { class: cls }, `${mark} ${label}${detail ? ' ' + detail : ''}`);
  }

  function renderRow(r) {
    const tr = el('tr', { 'data-index': r.index });
    tr.append(el('td', { class: 'num' }, String(r.index)));
    tr.append(el('td', { class: 'ref' }, r.text));

    const statusTd = el('td', null, badge(r.status));
    if (r.error) statusTd.append(el('div', { class: 'hint' }, r.error));
    if (r.doiNotFound) statusTd.append(el('div', { class: 'hint bad' }, 'DOI not in Crossref'));
    tr.append(statusTd);

    const matchedTd = el('td', { class: 'matched' });
    if (r.status === 'unverified') {
      matchedTd.append(el('div', { class: 'hint' }, 'No plausible match found'));
      if (r.candidates.length) {
        const det = el('details', { class: 'alt' }, el('summary', null, 'Closest Crossref results (not matches)'));
        const ul = el('ul');
        for (const c of r.candidates) {
          const g = formatWork(c.work);
          ul.append(el('li', null, `${g.title} `, el('a', { href: 'https://doi.org/' + c.work.DOI, target: '_blank', rel: 'noopener' }, c.work.DOI)));
        }
        det.append(ul);
        matchedTd.append(det);
      }
    } else if (r.best) {
      const f = formatWork(r.best);
      matchedTd.append(el('div', { class: 'mt' }, f.title));
      matchedTd.append(el('div', { class: 'meta' }, f.meta));
      matchedTd.append(el('div', { class: 'doi' }, el('a', { href: 'https://doi.org/' + r.best.DOI, target: '_blank', rel: 'noopener' }, r.best.DOI)));
      const alts = r.candidates.filter(c => c.work.DOI !== r.best.DOI);
      if (alts.length) {
        const det = el('details', { class: 'alt' }, el('summary', null, r.status === 'mismatch' ? 'Probable intended work' : `${alts.length} other candidate${alts.length > 1 ? 's' : ''}`));
        const ul = el('ul');
        for (const c of alts) {
          const g = formatWork(c.work);
          ul.append(el('li', null, `${g.title} `, el('a', { href: 'https://doi.org/' + c.work.DOI, target: '_blank', rel: 'noopener' }, c.work.DOI)));
        }
        det.append(ul);
        matchedTd.append(det);
      }
    } else if (r.status === 'pending') {
      matchedTd.append(el('span', { class: 'hint' }, '…'));
    }
    tr.append(matchedTd);

    const checksTd = el('td', { class: 'checks' });
    if (r.score) {
      const s = r.score;
      checksTd.append(checkLine('Title', s.title >= 0.8 ? true : s.title >= 0.55 ? null : false, `${Math.round(s.title * 100)}%`));
      checksTd.append(checkLine('Author', s.author, r.surname ? `(${r.surname})` : ''));
      checksTd.append(checkLine('Year', s.year, r.year && s.workYear && r.year !== s.workYear ? `(${r.year} vs ${s.workYear})` : r.year ? `(${r.year})` : ''));
      checksTd.append(checkLine('DOI', r.doi ? (r.viaDoi ? true : r.doiNotFound ? false : (r.best && r.best.DOI.toLowerCase() === r.doi.toLowerCase())) : null, r.doi ? '' : '(none given)'));
    }
    tr.append(checksTd);
    return tr;
  }

  function replaceRow(r) {
    const old = tbody.querySelector(`tr[data-index="${r.index}"]`);
    const fresh = renderRow(r);
    if (old) old.replaceWith(fresh); else tbody.append(fresh);
  }

  function renderSummary() {
    const counts = {};
    for (const r of state.results) counts[r.status] = (counts[r.status] || 0) + 1;
    summaryEl.innerHTML = '';
    const stat = (n, label) => el('div', { class: 'stat' }, el('span', { class: 'n' }, String(n)), el('span', { class: 'l' }, label));
    summaryEl.append(stat(state.results.length, 'references'));
    summaryEl.append(stat(counts.match || 0, 'matched'));
    summaryEl.append(stat(counts.likely || 0, 'likely'));
    summaryEl.append(stat(counts.unverified || 0, 'unverified'));
    summaryEl.append(stat((counts.mismatch || 0), 'DOI mismatch'));
    if (counts.error) summaryEl.append(stat(counts.error, 'errors'));
    summaryEl.hidden = false;
  }

  // ---- Export ----

  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportCsv() {
    const rows = [['#', 'reference', 'status', 'matched_title', 'matched_doi', 'matched_year', 'title_similarity', 'author_match', 'year_match']];
    for (const r of state.results) {
      rows.push([
        r.index, r.text, STATUS_LABEL[r.status] || r.status,
        r.best ? RefMatch.workTitle(r.best) : '',
        r.best ? r.best.DOI : '',
        r.best ? RefMatch.workYear(r.best) : '',
        r.score ? Math.round(r.score.title * 100) + '%' : '',
        r.score ? fmtBool(r.score.author) : '',
        r.score ? fmtBool(r.score.year) : '',
      ]);
    }
    const csv = rows.map(row => row.map(csvCell).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'reference-check.csv' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function fmtBool(v) { return v === true ? 'yes' : v === false ? 'no' : 'n/a'; }

  async function copyDois() {
    const dois = state.results.filter(r => r.best && (r.status === 'match' || r.status === 'likely')).map(r => r.best.DOI);
    try { await navigator.clipboard.writeText(dois.join('\n')); $('#copy-dois').textContent = `Copied ${dois.length}`; }
    catch (e) { $('#copy-dois').textContent = 'Copy failed'; }
    setTimeout(() => { $('#copy-dois').textContent = 'Copy matched DOIs'; }, 1500);
  }
})();

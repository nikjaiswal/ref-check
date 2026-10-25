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
    match: 'Match', errors: 'Errors found', likely: 'Likely', unverified: 'Unverified',
    mismatch: 'DOI mismatch', error: 'Error', pending: 'Checking…',
  };

  const SAMPLE = `1. Sikora A, Celi LA, Abdulnour RE. Can AI say "I don't know"? N Engl J Med. 2026;394(19):1873-1875. doi:10.1056/NEJMp2517624
2. Komorowski M, Celi LA, Badawi O, Gordon AC, Faisal AA. The Artificial Intelligence Clinician learns optimal treatment strategies for sepsis in intensive care. Nat Med. 2018;24(11):1716-1720. doi:10.1038/s41591-018-0213-5
3. Futoma J, Simons M, Panch T, Doshi-Velez F, Celi LA. The myth of generalisability in clinical research and machine learning in health care. Lancet Digit Health. 2020;2(9):e489-e492.
4. Johnson AEW, Stone DJ, Celi LA, Pollard TJ. The MIMIC Code Repository: enabling reproducibility in critical care research. J Am Med Inform Assoc. 2018;25(1):32-39.
5. Gottesman O, Johansson F, Komorowski M, Faisal A, Sontag D, Doshi-Velez F, Celi LA. Guidelines for reinforcement learning in healthcare. Nat Med. 2019;25(1):16-18.
6. Panch T, Mattie H, Celi LA. The "inconvenient truth" about AI in healthcare. NPJ Digit Med. 2019;2(1):77.
7. Ghasemi M, Celi LA, Stone DJ. State of the art review: the data revolution in critical care. Crit Care. 2016;19(1):181.
8. Smith JA, Doe RB. Longitudinal outcomes of imaginary interventions in a fictional cohort. J Nonexistent Med. 2019;12(3):45-52.
9. Bland JM, Altman DG. Statistical methods for assessing agreement between two methods of clinical measurement. Lancet. 1986;1(8476):307-310. https://doi.org/10.1038/s41591-018-0213-5`;

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
      details: RefParse.extractDetails(text),
      status: 'pending',
      best: null,
      checks: null,
      candidates: [],
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
        r.best = work;
        r.checks = RefMatch.checkWork(work, r);
        r.viaDoi = true;
        r.status = RefMatch.classify(r.checks, true);
        // If the DOI points elsewhere, also search by text to show the probable intended work.
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
    r.checks = ranked[0].checks;
    r.status = RefMatch.classify(r.checks, false);
    if (r.status !== 'unverified') r.best = ranked[0].work;
  }

  function rankCandidates(items, r) {
    return items
      .map(work => ({ work, checks: RefMatch.checkWork(work, r) }))
      .sort((a, b) => b.checks.score - a.checks.score);
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
      else e.setAttribute(k, v);
    }
    for (const c of children) if (c != null) e.append(c);
    return e;
  }

  function badge(status) {
    return el('span', { class: 'badge ' + status }, STATUS_LABEL[status] || status);
  }

  function formatWork(work) {
    const title = RefMatch.workTitleFull(work).replace(/<[^>]+>/g, '');
    const authors = (work.author || []).slice(0, 3).map(a => a.family || a.name).filter(Boolean);
    const more = (work.author || []).length > 3 ? ' et al' : '';
    const journal = RefMatch.workJournal(work).full || work.publisher || '';
    const year = RefMatch.workYear(work);
    const vol = work.volume ? `;${work.volume}` : '';
    const issue = work.issue ? `(${work.issue})` : '';
    const p = RefMatch.workPages(work);
    const page = p.start ? `:${p.start}${p.end ? '-' + p.end : ''}` : '';
    const parts = [authors.length ? authors.join(', ') + more : '', journal, `${year || ''}${vol}${issue}${page}`].filter(Boolean);
    return { title, meta: parts.join('. ') };
  }

  const MARK = { ok: '✓', bad: '✗', warn: '!', na: '–' };

  function line(kind, label, ...notes) {
    const d = el('div', { class: 'check ' + kind }, el('span', { class: 'mark' }, MARK[kind]), ' ', el('span', { class: 'lbl' }, label));
    for (const n of notes.filter(Boolean)) d.append(el('div', { class: 'note' }, n));
    return d;
  }

  /** One line per part of the citation, with the Crossref value when it differs. */
  function renderChecks(r) {
    const c = r.checks;
    const out = [];

    // A DOI that belongs to another paper: comparing fields with that paper is not useful.
    if (r.status === 'mismatch') {
      const top = r.candidates[0];
      const intended = top && ['match', 'errors', 'likely'].includes(RefMatch.classify(top.checks, false)) ? top.work : null;
      out.push(line('bad', 'DOI belongs to a different paper',
        `That DOI is: ${RefMatch.workTitleFull(r.best).replace(/<[^>]+>/g, '')}`,
        intended ? `Likely correct DOI: ${intended.DOI}` : 'No likely correct DOI found'));
      return out;
    }

    // Title
    const t = c.title;
    if (t.ok === true) out.push(line('ok', 'Title'));
    else {
      const notes = [];
      if (t.missing.length) notes.push('Missing words: ' + t.missing.join(', '));
      if (t.extra.length) notes.push('Extra words: ' + t.extra.join(', '));
      out.push(line('bad', 'Title differs', ...notes));
    }

    // Authors
    const a = c.authors;
    if (a.ok === null) out.push(line('na', 'Authors', a.note));
    else if (a.ok === 'missing') out.push(line('warn', 'Authors not found in reference'));
    else {
      const count = a.etAl ? `${a.matched} listed, et al.` : `${a.matched} of ${a.total}`;
      if (a.ok) out.push(line('ok', `Authors (${count})`));
      else {
        const notes = [];
        if (!a.firstOk) notes.push(`First author should be ${a.expected[0]}`);
        if (a.missing.length) notes.push('Missing: ' + a.missing.join(', '));
        if (a.unknown.length) notes.push('Not in Crossref record: ' + a.unknown.join(', '));
        if (!a.orderOk) notes.push('Author order differs from Crossref');
        if (a.initialsWrong.length) notes.push('Initials differ: ' + a.initialsWrong.join('; '));
        out.push(line('bad', `Authors (${count})`, ...notes));
      }
    }

    // Journal
    const j = c.journal;
    if (j.ok === true) out.push(line('ok', 'Journal'));
    else if (j.ok === false) out.push(line('bad', 'Journal differs', `Crossref: ${j.expected}`));
    else out.push(line('na', 'Journal', 'Crossref lists none'));

    // Year, volume, issue, pages
    const simple = [['Year', c.year], ['Volume', c.volume], ['Issue', c.issue], ['Pages', c.pages]];
    for (const [label, f] of simple) {
      if (f.ok === true) out.push(line('ok', `${label} ${f.given}`));
      else if (f.ok === false) out.push(line('bad', `${label} ${f.given}`, `Crossref: ${f.expected}`));
      else if (f.ok === 'missing') out.push(line('warn', `${label} missing`, `Crossref: ${f.expected}`));
      else out.push(line('na', label, 'Crossref lists none'));
    }

    // DOI
    const d = c.doi;
    if (r.doiNotFound) out.push(line('bad', 'DOI not in Crossref', r.best ? `Crossref: ${r.best.DOI}` : null));
    else if (d.ok === true) out.push(line('ok', 'DOI'));
    else if (d.ok === false) out.push(line('bad', 'DOI differs', `Crossref: ${d.expected}`));
    else out.push(line('na', 'DOI not given', r.best ? `Crossref: ${d.expected}` : null));

    return out;
  }

  function candidateList(cands, title) {
    const det = el('details', { class: 'alt' }, el('summary', null, title));
    const ul = el('ul');
    for (const c of cands) {
      const g = formatWork(c.work);
      ul.append(el('li', null, `${g.title} `, el('a', { href: 'https://doi.org/' + c.work.DOI, target: '_blank', rel: 'noopener' }, c.work.DOI)));
    }
    det.append(ul);
    return det;
  }

  function renderRow(r) {
    const tr = el('tr', { 'data-index': r.index });
    tr.append(el('td', { class: 'num' }, String(r.index)));
    tr.append(el('td', { class: 'ref' }, r.text));

    const statusTd = el('td', null, badge(r.status));
    if (r.error) statusTd.append(el('div', { class: 'hint' }, r.error));
    if (r.checks && (r.status === 'match' || r.status === 'errors')) {
      const n = r.checks.errors.length, w = r.checks.warnings.length;
      if (n) statusTd.append(el('div', { class: 'hint bad' }, `${n} error${n > 1 ? 's' : ''}`));
      if (w) statusTd.append(el('div', { class: 'hint warn' }, `${w} missing`));
    }
    tr.append(statusTd);

    const matchedTd = el('td', { class: 'matched' });
    if (r.status === 'unverified') {
      matchedTd.append(el('div', { class: 'hint' }, 'No plausible match found'));
      if (r.candidates.length) matchedTd.append(candidateList(r.candidates, 'Closest Crossref results (not matches)'));
    } else if (r.best) {
      const f = formatWork(r.best);
      matchedTd.append(el('div', { class: 'mt' }, f.title));
      matchedTd.append(el('div', { class: 'meta' }, f.meta));
      matchedTd.append(el('div', { class: 'doi' }, el('a', { href: 'https://doi.org/' + r.best.DOI, target: '_blank', rel: 'noopener' }, r.best.DOI)));
      if (r.status !== 'mismatch') {
        const cite = RefMatch.formatVancouver(r.best);
        const copyBtn = el('button', { type: 'button', class: 'link small' }, 'Copy');
        copyBtn.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(cite); copyBtn.textContent = 'Copied'; } catch (e) { copyBtn.textContent = 'Copy failed'; }
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
        });
        const det = el('details', { class: 'alt' }, el('summary', null, 'Citation from Crossref'), el('div', { class: 'cite' }, cite, ' ', copyBtn));
        if (r.status === 'errors') det.open = true;
        matchedTd.append(det);
      }
      const alts = r.candidates.filter(c => c.work.DOI !== r.best.DOI);
      if (alts.length) {
        matchedTd.append(candidateList(alts, r.status === 'mismatch' ? 'Probable intended work' : `${alts.length} other candidate${alts.length > 1 ? 's' : ''}`));
      }
    } else if (r.status === 'pending') {
      matchedTd.append(el('span', { class: 'hint' }, '…'));
    }
    tr.append(matchedTd);

    const checksTd = el('td', { class: 'checks' });
    if (r.checks && r.best) for (const l of renderChecks(r)) checksTd.append(l);
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
    summaryEl.append(stat(counts.match || 0, 'fully correct'));
    summaryEl.append(stat(counts.errors || 0, 'with errors'));
    summaryEl.append(stat(counts.likely || 0, 'likely'));
    summaryEl.append(stat(counts.unverified || 0, 'unverified'));
    summaryEl.append(stat(counts.mismatch || 0, 'DOI mismatch'));
    if (counts.error) summaryEl.append(stat(counts.error, 'failed'));
    summaryEl.hidden = false;
  }

  // ---- Export ----

  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function fieldStatus(ok) {
    return ok === true ? 'ok' : ok === false ? 'wrong' : ok === 'missing' ? 'missing' : 'n/a';
  }

  function exportCsv() {
    const rows = [[
      '#', 'reference', 'status', 'errors', 'crossref_title', 'crossref_doi', 'crossref_citation',
      'title', 'title_missing_words', 'title_extra_words',
      'authors', 'authors_missing', 'authors_not_in_record', 'author_order_ok', 'initials_wrong',
      'journal', 'crossref_journal', 'year', 'crossref_year', 'volume', 'crossref_volume',
      'issue', 'crossref_issue', 'pages', 'crossref_pages', 'doi', 'given_doi',
    ]];
    for (const r of state.results) {
      const c = r.checks;
      const has = !!(c && r.best);
      const A = has ? c.authors : {};
      rows.push([
        r.index, r.text, STATUS_LABEL[r.status] || r.status,
        has ? c.errors.join('; ') : '',
        has ? RefMatch.workTitleFull(r.best) : '',
        has ? r.best.DOI : '',
        has && r.status !== 'mismatch' ? RefMatch.formatVancouver(r.best) : '',
        has ? fieldStatus(c.title.ok) : '', has ? c.title.missing.join(' ') : '', has ? c.title.extra.join(' ') : '',
        has ? fieldStatus(A.ok) : '', (A.missing || []).join('; '), (A.unknown || []).join('; '),
        A.orderOk === undefined ? '' : (A.orderOk ? 'yes' : 'no'), (A.initialsWrong || []).join('; '),
        has ? fieldStatus(c.journal.ok) : '', has ? c.journal.expected || '' : '',
        has ? fieldStatus(c.year.ok) : '', has ? c.year.expected || '' : '',
        has ? fieldStatus(c.volume.ok) : '', has ? c.volume.expected || '' : '',
        has ? fieldStatus(c.issue.ok) : '', has ? c.issue.expected || '' : '',
        has ? fieldStatus(c.pages.ok) : '', has ? c.pages.expected || '' : '',
        has ? (r.doiNotFound ? 'not in crossref' : fieldStatus(c.doi.ok)) : '', r.doi || '',
      ]);
    }
    const csv = rows.map(row => row.map(csvCell).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'reference-check.csv' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function copyDois() {
    const dois = state.results.filter(r => r.best && ['match', 'errors', 'likely'].includes(r.status)).map(r => r.best.DOI);
    try { await navigator.clipboard.writeText(dois.join('\n')); $('#copy-dois').textContent = `Copied ${dois.length}`; }
    catch (e) { $('#copy-dois').textContent = 'Copy failed'; }
    setTimeout(() => { $('#copy-dois').textContent = 'Copy matched DOIs'; }, 1500);
  }
})();

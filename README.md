# Reference Checker

A single-page web tool that verifies a pasted reference list against the
[Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/).
Paste a bibliography, click **Check references**, and each entry is looked up,
scored, and shown with its best Crossref match and DOI.

It runs entirely in the browser. There is no backend, no build step, and
nothing is stored anywhere except the optional email you enter (kept in your
own browser's local storage).

## Features

- Accepts numbered lists, one-reference-per-line, or blank-line-separated
  references in any common citation style.
- If a reference already contains a DOI, the DOI is fetched directly and
  checked against the reference text. A DOI that resolves to a different
  paper is flagged as a **DOI mismatch**, with the probable intended work shown.
- References without a DOI go through Crossref's bibliographic search. The top
  three candidates are scored on title similarity, first-author surname, and
  year.
- Each entry is labeled **Match**, **Likely**, **Unverified**, or **DOI mismatch**.
- Results can be downloaded as CSV, and matched DOIs copied to the clipboard.
- Respects Crossref's rate limits and uses the "polite" pool when an email is
  provided.

## Running locally

Any static file server works. For example:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Deploying to GitHub Pages

1. Push this repository to GitHub.
2. In the repository, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **GitHub Actions**.
4. The included workflow in `.github/workflows/pages.yml` deploys the site on
   every push to `main`. The site will be at
   `https://<your-username>.github.io/<repo-name>/`.

Alternatively, choose **Deploy from a branch** and pick `main` / root. No
workflow is needed in that case.

## How matching works

| Check  | Rule                                                                 |
| ------ | -------------------------------------------------------------------- |
| Title  | Share of the Crossref title's words that appear in your reference.   |
| Author | The first surname in your reference appears among the work's authors.|
| Year   | Your year is within one year of the work's issued date.              |

- **Match**: title ≥ 80% and no author/year disagreement.
- **Likely**: title ≥ 55% with no disagreement, or title ≥ 80% with one.
- **Unverified**: nothing in Crossref scored well enough. This does not mean
  the reference is wrong, only that it could not be confirmed. Books, reports,
  preprints without DOIs, and older material are often absent from Crossref.
- **DOI mismatch**: the DOI in the reference resolves to a different work.

## Project layout

```
index.html          page structure
css/style.css       styling, light and dark
js/parse.js         splits pasted text into references, extracts DOI / year / surname
js/match.js         scores a Crossref work against a reference
js/crossref.js      Crossref API client with rate limiting and retry
js/app.js           UI, concurrency, rendering, CSV export
```

## License

MIT. See [LICENSE](LICENSE).

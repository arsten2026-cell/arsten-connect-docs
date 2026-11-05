# Arsten Docs — Trimble Connect project extension

Document register, revisions & statuses, transmittals and todos for Arsten projects, inside
Trimble Connect (left navigation of each project). Design: [../DESIGN.md](../DESIGN.md).

- **Register** — every file named like `1018-ST-DR-0101_R02_Title.pdf` becomes a document row
  (number, discipline, type, current revision, status, last change). Other files are listed under
  "files not matching the numbering pattern".
- **Statuses** — Draft → For approval → Issued → Superseded. Issuing a revision automatically
  supersedes all lower revisions. Every change is logged with user and time.
- **Transmittals** — pick documents, recipient and purpose; the exact file versions are frozen,
  statuses are updated, and an Arsten-branded PDF is saved to `_ArstenDocs/Transmittals/TR-1018-001.pdf`.
- **Todos** — Trimble Connect's own ToDos when the token can use them (visible in Connect web and mobile),
  otherwise stored in the tracker file. Optional link to a document, overdue highlighting.
- **Settings** — numbering pattern (regex), project code, todo storage, API diagnostics.

All tracker data (statuses, log, transmittals, local todos, settings) is one file per project:
`_ArstenDocs/tracker.json`. Each save is a new Connect version of that file, so Connect's version
history is the audit trail and any version can be restored. Don't rename/move that folder.

No backend, no database: the app runs in the user's browser with the user's own Trimble Connect token,
so everybody sees only what their Connect permissions allow.

## Develop

```bash
npm install
npm test            # unit tests (naming, register, supersede rules, transmittal numbering)
npm run dev         # https://localhost:5173 (self-signed cert; manifest at /manifest.json)
```

Opened directly in a browser (not inside Connect) the app runs in **demo mode** with sample data.
`?mock=local` simulates a project where Connect ToDos are not available.

## Hosting (GitHub Pages)

1. Create a GitHub repository (public, or private on a paid plan) and push this folder as its root.
2. Repository **Settings → Pages → Source: GitHub Actions**.
3. Push to `main` — `.github/workflows/pages.yml` tests, builds and deploys.
   The site is `https://<owner>.github.io/<repo>/` and the manifest is
   `https://<owner>.github.io/<repo>/manifest.json`.
   For a custom domain (e.g. `docs.arsten-bg.com`) set a repository variable `SITE_URL` to it and
   configure the domain under Settings → Pages.

GitHub Pages serves files with `Access-Control-Allow-Origin: *`, which Trimble Connect needs to read
the manifest. Any other static HTTPS host works the same way: run
`SITE_URL=https://your.host/path npm run build` and upload `dist/`.

## Install in a Trimble Connect project

Needs a **project administrator** (Connect Business licence or higher).

1. Open the project in Trimble Connect for Browser (EU: <https://web.connect.trimble.com>).
2. **Settings → Apps & Capabilities** (Extensions) → **+ Add Custom** (Add custom extension).
3. Paste the manifest URL, e.g. `https://<owner>.github.io/<repo>/manifest.json`, confirm.
4. Switch the extension **on**. "Arsten Docs" appears in the project's left navigation.
5. First open: Connect asks to allow the extension access to your account (access token) — **Allow**.
   Each user is asked once.
6. Open **Settings → Check access** in the extension. It lists which Trimble APIs accept the token
   (Core v2, legacy 2.0, ToDos, Releases, Issues). Send a screenshot if anything is ✗.

Repeat steps 2–4 for each project that should use it (an extension is installed per project).

### Testing a local build inside Connect (optional)

`npm run dev`, open <https://localhost:5173> once and accept the certificate, then add the custom
extension with `https://localhost:5173/manifest.json`. This only works on the developer's PC and only if
Connect fetches the manifest from the browser; otherwise use the GitHub Pages URL.

## Updating

Push to `main`; the next page load in Connect uses the new version (no reinstall). If the manifest
itself changes (title, icon), remove and re-add the extension in the project.

## Notes / limits

- Region is detected from the project location (`/tc/api/2.0/regions`), EU by default.
  Files are read with Core v2 (`eu.api.trimble.com/connect/v2`); if that is not reachable with the
  token the app falls back to the legacy `app21.connect.trimble.com/tc/api/2.0` (same endpoints).
- The register reads the whole project tree in one call (`/files/fs/snapshot`); fine up to tens of
  thousands of files.
- Concurrent edits: saves use `If-Match` on `tracker.json`; on a conflict the app re-reads and
  re-applies the change automatically.
- The extension uses the token Connect hands to extensions, so a Trimble Developer Console app
  registration should not be needed for it (to be confirmed at first install with *Check access*).
  It is needed later for the cross-project dashboard / bot user.

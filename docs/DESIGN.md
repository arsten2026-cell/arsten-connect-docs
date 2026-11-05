# Arsten Docs — Trimble Connect project extension (design — agreed 2026-11-05)

Implementation: [arsten-docs/](../) (README there has hosting + install steps).
Deviation from the draft: files are read via Core v2 when the token works there, otherwise automatically
via legacy 2.0 (same `fs` endpoints); the Diagnostics tab lives under Settings → "Check access".

Decisions from the user (2026-11-05):
- v1 covers: **document register, revisions & statuses, transmittals, todos & deadlines**
- **Per-project** extension first; cross-project dashboard later (needs bot user + backend)
- Numbering in file name: **`1018-ST-DR-0101_R02`** = Project-Discipline-Type-Number_Revision
- Statuses: **Draft → For approval → Issued → Superseded**
- **Any project member** may change status / create transmittals; every change is logged (who, when)
- Hosting: **GitHub Pages** (static, HTTPS)

## 1. Shape

One `extensionType: ["project"]` extension, "Arsten Docs", in the project's left navigation.
Pure static front-end (TypeScript + Vite, no backend). It runs with the **signed-in user's token**
(`api.extension.requestPermission("accesstoken")`), so it only sees what that user can see.

Tabs:
1. **Register** — table of all documents in the project: number, discipline, type, title, current revision,
   status, Connect version, last modified (who/when), folder. Filter by discipline/status/folder, search,
   group by discipline. Click → history drawer (all revisions R01…Rnn, status log, transmittals it was in,
   open/download in Connect). Export to CSV/XLSX.
2. **Transmittals** — create an issue package: pick documents (current revision pre-selected), recipient
   (client / contractor / ТК / other), purpose (for approval / for construction / for information), date,
   note. Saving freezes the exact `versionId`s, sets those documents to *Issued* (if purpose = for construction
   or info) or *For approval*, and generates an Arsten-branded transmittal sheet (HTML → PDF via print) that is
   uploaded to `_ArstenDocs/Transmittals/TR-1018-001.pdf`. List of past transmittals.
3. **Todos** — tasks with assignee, due date, status, optional link to a document; overdue highlighted.
4. **Overview** (top of Register) — counts per status and discipline, overdue todos, last transmittal.

## 2. Where data lives

| Data | Source | Notes |
|---|---|---|
| Files, folders, versions, who/when | **Core v2** `GET /files/fs/snapshot?projectId=` + `/versions` | read-only, confirmed API |
| Number / discipline / type / revision | **Parsed from file name** | regex below; non-matching files listed under "Unnumbered" (hideable) |
| Status, status log, transmittals | **`_ArstenDocs/tracker.json`** in the project, written via Core v2 upload | see 2.1 |
| Todos | **Connect native** (legacy ToDos or Issues API — whichever the spike shows works with our token); fallback: `tracker.json` | native = also visible in Connect's own ToDo/Issues UI and mobile app |

### 2.1 Why a JSON file in the project (not Property Set API)
- Uses only Core v2 endpoints already documented; same permissions as the files themselves.
- Every save is a new Connect version → **free audit trail and rollback**.
- Concurrency: read with version id, upload new version with `If-Match`; on conflict re-read, re-apply, retry.
- Lives with the project (copying/archiving the project keeps the tracker).
- Property Set API stays an option for v2 (would show status in Connect's own property panel); the store is
  behind one interface (`TrackerStore`) so it can be swapped.

`tracker.json` (schema v1):
```json
{ "schema": 1,
  "docs": { "1018-ST-DR-0101": { "revs": { "R02": { "status": "Issued", "fileId": "...", "versionId": "..." } },
            "log": [ { "at": "2026-11-05T10:00Z", "by": "Nayden Kochev", "rev": "R02", "from": "Draft", "to": "For approval", "note": "" } ] } },
  "transmittals": [ { "id": "TR-1018-001", "date": "2026-11-05", "to": "Client", "purpose": "For approval",
                      "items": [ { "doc": "1018-ST-DR-0101", "rev": "R02", "fileId": "...", "versionId": "..." } ],
                      "by": "...", "note": "", "pdfFileId": "..." } ],
  "todos": [] }
```

### 2.2 Revision & status rules
- File name regex: `^(?<proj>\d{3,5})-(?<disc>[A-Z]{2,4})-(?<type>[A-Z]{2,3})-(?<num>\d{3,5})_R(?<rev>\d{2})` (case-insensitive, any extension).
  Configurable per project in a Settings panel (stored in `tracker.json`).
- Document key = `proj-disc-type-num`; same key with several `_Rnn` files = revisions. Highest `Rnn` = current.
- New revision appears with no status → **Draft**. When a revision becomes *Issued*, all lower revisions
  become **Superseded** automatically. Same name re-uploaded (Connect version 2,3…) = same revision, shown as "v3".
- Any member can change status; each change is appended to the log with Trimble user name.

## 3. Phase 0 spike (first thing to build — decides todos backend)
A tiny page inside the extension ("Diagnostics" tab) that, with the user's token, calls and reports:
1. Core v2 `GET eu.api.trimble.com/connect/v2/projects/{id}` and `/files/fs/snapshot`
2. Legacy `GET app21.connect.trimble.com/tc/api/2.0/todos?projectId=` and `/releases?projectId=`
3. Issues `GET app21.connect.trimble.com/v1/issues/context/{trn}/issues`
4. Upload a small file to `_ArstenDocs/` (and delete it)
Region/base URLs from `GET /tc/api/2.0/regions` + the project `location`, not hardcoded.

## 4. Look
Arsten house style (arsten-style skill tokens): warm off-white background, ink text, orange #E37424 only as
accent, Ubuntu / Ubuntu Mono, square corners, 1px hairlines; Arsten logo on the transmittal sheet and Plovdiv
footer. UI language: Bulgarian + English toggle (BG default).

## 5. Install / hosting
- GitHub repo (e.g. `arsten/connect-docs`), GitHub Actions builds Vite → GitHub Pages.
- `manifest.json` served from the same site (GitHub Pages sends `Access-Control-Allow-Origin: *`).
- Project admin: Settings → Apps & Capabilities → + Add Custom → `https://<org>.github.io/connect-docs/manifest.json`.
- Local dev: `vite --https` + a test manifest pointing at `https://localhost:5173` (Connect allows it while the
  browser trusts the cert).

## 6. Out of v1 / later
- Cross-project dashboard (backend + bot Trimble ID user, polling `/projects/{id}/status` cursors).
- Status in Connect's property panel via Property Set API.
- Email to recipients on transmittal (Connect has no mail API; would need M365 Graph from a backend).

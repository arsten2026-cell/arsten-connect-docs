# Документи · Arsten / MULTIPLAN — document control for the general contractor

A Trimble Connect extension for the GC / execution side: what the site may build from, received design documents,
revisions, transmittals, acknowledgements, questions to the designer (RFI) and shop drawings.
Research and design background: [docs/DESIGN.md](docs/DESIGN.md) and `plugins/DOC-CONTROL-RESEARCH.md` (local).

Live: https://arsten2026-cell.github.io/arsten-connect-docs/ · manifest `…/manifest.json` · installed in project 1028 (pilot).

## What it does

| Tab | For | What |
|---|---|---|
| **За изпълнение** | site, PM | The documents valid for construction (one current revision each), "Текущ ли е?" check by number, "получена нова ревизия" hints, acknowledgement per person, links to the stamped PDF |
| **Регистър** | PM / document control | All tracked documents in three categories: Проектна документация, Документи на изпълнителя (актове, декларации, протоколи…), Работни чертежи (изпълнител). Filters, bulk actions, details panel with metadata, revisions, status log, transmittals, RFIs |
| **Трансмитали** | PM | Every issue with its PDF, acknowledgement ToDo state, email draft; other transmittals (for information / review / approval / tender) |
| **Въпроси (RFI)** | GC, designer | Questions with ball-in-court, due date and outcome (no change / site instruction book / new revision); each RFI is also a Connect ToDo |
| **Настройки** | admin | Site folder, who gets acknowledgement ToDos, who gets RFIs, tracked file types, numbering pattern, API check |

### Statuses
- **Received design:** Получен → За преглед → **За изпълнение** (→ Заменен automatically when a newer revision is issued) · За информация
- **Contractor records:** Чернова → Подаден → Върнат със забележки → **Подписан** → Екзекутивен · Анулиран
- **Shop drawings:** Подаден → За преглед → **A** Одобрен / **B** Одобрен със забележки / **C** За корекция / **D** Отхвърлен.
  A and B can be issued to site. The decision buttons are for designers and admins only.

A document is either a file named like `1028-ST-DR-0101_R02_….pdf` (revisions = `_Rnn` in the name) or any PDF
(revisions = Connect versions v1, v2…, i.e. upload a file with the same name into the same folder).

### "Издай за изпълнение" (one action)
1. A transmittal number (TR-1028-00n).
2. For each document: a **copy** with the orange stamp "ЗА ИЗПЪЛНЕНИЕ" + QR code (links to the site folder in Connect)
   in `<site folder>/<part>/` named `<number> <rev>.pdf`. The designer's original is never changed (КЕП signatures stay valid).
3. The previous copy is stamped red "ЗАМЕНЕН / SUPERSEDED" (as a new Connect version of that copy) and moved to
   `<site folder>/Заменени/`.
4. Status За изпълнение (older revisions → Заменен) only for documents whose copy was written; a failed one can be issued again.
5. The transmittal PDF in `_AM_Docs/Transmittals/`, one Connect ToDo "потвърдете получаване" for the configured
   group, and an email draft button for people outside Connect.

Site people only need the Connect mobile app: the site folder holds only current stamped drawings (mark it for offline),
and the ToDo is their notice + acknowledgement (closing it = received). The in-app "Потвърждавам" button is the other way.

### Roles (from Connect groups, same as the other Arsten / MULTIPLAN panels)
admin (project admin / 00_ADMIN) and GC (GENERAL CONTRACTOR, EXECUTION PROJECT MANAGER): everything ·
designers (DESIGNERS, STRUCTURAL DESIGNER): read, answer RFIs, decide shop drawings · client, subcontractors,
viewers, fabricator: no access (same as the tile in the combined panel). Someone in several groups has all their roles' rights.

### Data
One file per project: `_AM_Docs/tracker.json` (older projects: `_ArstenDocs/`, still read; only `_AM_Docs` is created) (schema 2; v1 files are migrated on load). Saves use If-Match and retry
on conflict; every save is a Connect version (= audit trail). Shop-drawing review copies: `_AM_Docs/Submittals/`.

## Going live in a project (checklist)
1. Install: project Settings → Apps & Capabilities → **+ Add Custom** → manifest URL → on → Allow.
2. **Настройки:** site folder `ЗА СТРОИТЕЛСТВО` (default), "Задача потвърди получаване към" = the site group
   (e.g. 02.GENERAL CONTRACTOR), "Въпроси и работни чертежи към" = 4.1-STRUCTURAL DESIGNER (or DESIGNERS). Save.
3. In the Connect mobile app the site team marks `ЗА СТРОИТЕЛСТВО` for offline use.
4. Received designs (by email): Регистър → **⇪ Качи получени файлове** (or drop them into a Connect folder), check them,
   then **▶ Издай за изпълнение**.

### Pilot project 1028 – test data from 16.11.2026 (remove or keep)
- Folder `ZZ_TEST_Документи` (test drawings + its `ЗА СТРОИТЕЛСТВО` with stamped/superseded copies).
- In tracker.json: TR-1028-001, TR-1028-002, RFI-1028-001, test acknowledgements, M-01 decision B, and the setting
  site folder = `ZZ_TEST_Документи/ЗА СТРОИТЕЛСТВО`, ToDo assignee = Nayden Kochev (change both in Настройки for real use).
- Two Connect ToDos assigned to Nayden Kochev ("За изпълнение: … (TR-1028-002)" and "RFI-1028-001: ТЕСТ…").

## Develop
```bash
npm install
npm test         # unit tests (model, statuses, transmittals, migration)
npm run dev      # https://localhost:5173 ; outside Connect it runs in demo mode with sample data
```
`?shell=1` = narrow layout used inside the combined Arsten / MULTIPLAN 3D-viewer panel; `?mock=local` = demo without ToDos.
Deploy: push to `main` (GitHub Actions → Pages). Connect caches the page up to 10 minutes.

## Combined panel
`viewer-arsten/app.js` has a "Документи" tile (roles admin, GC, designers) that opens this app with `?shell=1`.
That change is **local only**: the combined panel also has other unpublished changes, so publish it deliberately
(`viewer-arsten/scripts/publish-pages.sh`).

## Notes / limits
- All calls go to the legacy `app21…/tc/api/2.0` (Core v2 is CORS-blocked for extensions).
- Connect rejects some ToDo due-date formats; the app tries several and finally puts the date in the description.
- Encrypted PDFs cannot be stamped; they are copied unstamped with a warning.
- Not built yet: QR "is this current?" page without login, cross-project overview, email digests (need a backend),
  acts/handover dossier export, drawing-list import.

import { ApiError, type ConnectApi } from "./api";
import { emptyTracker, findToolFolder, normalizeTracker, TRACKER_FILE, TRACKER_FOLDER, type Tracker } from "./model";

/**
 * tracker.json lives in <project root>/_AM_Docs/ (older projects: _ArstenDocs/, still read; only _AM_Docs is created). Every save uploads a new Connect version of the file,
 * guarded by If-Match = the version we read. On a conflict (someone saved in between) we re-read,
 * re-apply the same change and try again — changes are small and additive, so this is safe.
 */
export class TrackerStore {
  tracker: Tracker = emptyTracker();
  folderId?: string;
  fileId?: string;
  versionId?: string;

  constructor(private api: ConnectApi) {}

  async load(folderId?: string, fileId?: string): Promise<Tracker> {
    this.folderId = folderId;
    this.fileId = fileId;
    if (!fileId) {
      this.tracker = emptyTracker();
      this.versionId = undefined;
      return this.tracker;
    }
    const { text, versionId } = await this.api.readText(fileId);
    this.versionId = versionId;
    this.tracker = normalizeTracker(JSON.parse(text));
    return this.tracker;
  }

  /** The tool folder (_AM_Docs, or an existing _ArstenDocs that holds the tracker); created as _AM_Docs if missing. */
  async ensureFolder(): Promise<string> {
    if (this.folderId) return this.folderId;
    const root = await this.api.rootFolderId();
    try {
      this.folderId = await this.api.createFolder(TRACKER_FOLDER, root);
    } catch (e) {
      // created by someone else in the meantime: find it
      const f = findToolFolder(await this.api.snapshot()).folder;
      if (!f) throw e;
      this.folderId = f.id;
    }
    return this.folderId;
  }

  private async refreshFromServer() {
    const { folder, file } = findToolFolder(await this.api.snapshot());
    await this.load(folder?.id, file?.id);
  }

  async save(change: (t: Tracker) => Tracker): Promise<Tracker> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      const next = change(this.tracker);
      if (next === this.tracker) return next;
      const folderId = await this.ensureFolder();
      const body = new Blob([JSON.stringify(next, null, 1)], { type: "application/json" });
      try {
        // first save: If-None-Match * so two people creating tracker.json at once cannot overwrite each other
        const r = await this.api.upload(folderId, TRACKER_FILE, body, this.versionId, !this.versionId);
        this.fileId = r.fileId;
        this.versionId = r.versionId;
        this.tracker = next;
        return next;
      } catch (e) {
        lastErr = e;
        if (e instanceof ApiError && (e.status === 409 || e.status === 412)) {
          await this.refreshFromServer();
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }
}

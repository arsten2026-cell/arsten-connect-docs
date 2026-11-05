import { ApiError, type ConnectApi } from "./api";
import { emptyTracker, normalizeTracker, TRACKER_FILE, TRACKER_FOLDER, type Tracker } from "./model";

/**
 * tracker.json lives in <project root>/_ArstenDocs/. Every save uploads a new Connect version of the file,
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

  private async ensureFolder(): Promise<string> {
    if (this.folderId) return this.folderId;
    const root = await this.api.rootFolderId();
    try {
      this.folderId = await this.api.createFolder(TRACKER_FOLDER, root);
    } catch (e) {
      // created by someone else in the meantime: find it
      const items = await this.api.snapshot();
      const f = items.find((i) => i.tp === "FOLDER" && i.nm === TRACKER_FOLDER && !i.del);
      if (!f) throw e;
      this.folderId = f.id;
    }
    return this.folderId;
  }

  private async refreshFromServer() {
    const items = await this.api.snapshot();
    const folder = items.find((i) => i.tp === "FOLDER" && i.nm === TRACKER_FOLDER && !i.del);
    const file = folder ? items.find((i) => i.tp === "FILE" && i.nm === TRACKER_FILE && i.pid === folder.id && !i.del) : undefined;
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
        const r = await this.api.upload(folderId, TRACKER_FILE, body, this.versionId);
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

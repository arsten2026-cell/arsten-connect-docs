import * as WorkspaceAPI from "trimble-connect-workspace-api";
import { RestConnectApi, type ConnectApi } from "./api";
import { MockConnectApi } from "./mock";

export interface Host {
  api: ConnectApi;
  inConnect: boolean;
  projectId: string;
  projectName: string;
  user: { id?: string; name: string; email?: string };
  language?: string;
  /** Left-navigation sub menu → our tabs */
  onCommand(cb: (command: string) => void): void;
  setMenu(items: { title: string; command: string }[]): Promise<void>;
}

const TOKEN_WORDS = new Set(["pending", "denied", "granted", "true", "false", ""]);

export async function connectHost(): Promise<Host> {
  const params = new URLSearchParams(location.search);
  const embedded = window.parent !== window;
  if (!embedded || params.has("mock")) return mockHost(params.get("mock") !== "local");

  let token = "";
  let tokenWaiters: ((t: string) => void)[] = [];
  const commandHandlers: ((c: string) => void)[] = [];
  const setToken = (t: unknown) => {
    if (typeof t !== "string" || TOKEN_WORDS.has(t.toLowerCase())) return;
    token = t;
    tokenWaiters.forEach((w) => w(t));
    tokenWaiters = [];
  };

  const ws: any = await WorkspaceAPI.connect(
    window.parent,
    (event: string, args: any) => {
      if (event === "extension.accessToken") setToken(args?.data);
      else if (event === "extension.command") commandHandlers.forEach((h) => h(String(args?.data ?? "")));
    },
    30000,
  );

  setToken(await ws.extension.requestPermission("accesstoken").catch(() => ""));
  const getToken = () =>
    token
      ? Promise.resolve(token)
      : new Promise<string>((resolve, reject) => {
          tokenWaiters.push(resolve);
          setTimeout(() => reject(new Error("No access token from Trimble Connect (permission not granted?)")), 30000);
        });

  const project = await ws.project.getProject();
  const u = await ws.user.getUser().catch(() => undefined);
  const settings = await ws.user.getSettings?.().catch(() => undefined);
  await getToken();
  const api = await RestConnectApi.create(project.id, project.location, getToken);

  return {
    api,
    inConnect: true,
    projectId: project.id,
    projectName: project.name ?? project.id,
    user: { id: u?.id, name: [u?.firstName, u?.lastName].filter(Boolean).join(" ") || u?.email || "?", email: u?.email },
    language: settings?.language ?? u?.language,
    onCommand: (cb) => commandHandlers.push(cb),
    setMenu: async (items) => {
      try {
        await ws.ui.setMenu({
          title: "Arsten Docs",
          icon: new URL("icon.png", location.href).href,
          command: items[0]?.command ?? "register",
          subMenus: items.map((i) => ({ title: i.title, command: i.command })),
        });
      } catch (e) {
        console.warn("[arsten-docs] setMenu failed", e);
      }
    },
  };
}

function mockHost(nativeTodos: boolean): Host {
  const api = new MockConnectApi(nativeTodos);
  return {
    api,
    inConnect: false,
    projectId: api.projectId,
    projectName: "1018 · Жилищна сграда Пловдив (demo)",
    user: { id: "u1", name: "Найден Кочев", email: "nkochev@arsten-bg.com" },
    onCommand: () => {},
    setMenu: async () => {},
  };
}

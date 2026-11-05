import type { ConnectApi, NativeTodo, NativeTodoStatus } from "./api";
import type { LocalTodo, TodoState, UserRef } from "./model";
import type { TrackerStore } from "./store";

export interface TodoView {
  id: string;
  label?: string;
  title: string;
  description?: string;
  assignee?: UserRef;
  due?: string;
  state: TodoState;
  docKey?: string;
  source: "native" | "local";
}

export interface TodoInput {
  title: string;
  description?: string;
  assignee?: UserRef;
  due?: string;
  docKey?: string;
}

const DOC_TAG = /\[doc:([^\]]+)\]/;

export function nativeToState(s: NativeTodoStatus): TodoState {
  return s === "IN_PROGRESS" || s === "BLOCKED" ? "In progress" : s === "RESOLVED" || s === "CLOSED" ? "Done" : "Open";
}
export function stateToNative(s: TodoState): NativeTodoStatus {
  return s === "In progress" ? "IN_PROGRESS" : s === "Done" ? "CLOSED" : "NEW";
}

export function fromNative(t: NativeTodo): TodoView {
  const a = t.assignees?.find((x) => x.type === "USER") ?? t.assignees?.[0];
  const desc = t.description ?? "";
  return {
    id: t.id,
    label: t.label,
    title: t.title,
    description: desc.replace(DOC_TAG, "").trim() || undefined,
    assignee: a ? { id: a.id, name: a.name ?? ([a.firstName, a.lastName].filter(Boolean).join(" ") || a.id) } : undefined,
    due: t.dueDate?.slice(0, 10),
    state: nativeToState(t.status),
    docKey: DOC_TAG.exec(desc)?.[1],
    source: "native",
  };
}

export function fromLocal(t: LocalTodo): TodoView {
  return { id: t.id, title: t.title, description: t.description, assignee: t.assignee, due: t.due, state: t.state, docKey: t.docKey, source: "local" };
}

/**
 * Todos live in Connect's own ToDo list when our token may use it (visible in Connect web + mobile),
 * otherwise in tracker.json. The choice is made once per project and stored in tracker settings.
 */
export class TodoService {
  backend: "native" | "local" = "local";
  nativeError?: string;

  constructor(private api: ConnectApi, private store: TrackerStore, private actorName: () => string) {}

  async detect(): Promise<void> {
    const pref = this.store.tracker.settings.todoBackend;
    if (pref === "local") { this.backend = "local"; return; }
    try {
      await this.api.listTodos();
      this.backend = "native";
    } catch (e: any) {
      this.nativeError = e?.message ?? String(e);
      this.backend = "local";
    }
  }

  async list(): Promise<TodoView[]> {
    if (this.backend === "native") return (await this.api.listTodos()).map(fromNative);
    return this.store.tracker.todos.map(fromLocal);
  }

  async create(i: TodoInput): Promise<void> {
    if (this.backend === "native") {
      const description = [i.description ?? "", i.docKey ? `[doc:${i.docKey}]` : ""].filter(Boolean).join("\n");
      await this.api.createTodo({
        title: i.title,
        description: description || undefined,
        dueDate: i.due ? new Date(i.due + "T12:00:00Z").toISOString() : undefined,
        assignees: i.assignee ? [{ id: i.assignee.id, type: "USER" }] : undefined,
      });
      return;
    }
    const todo: LocalTodo = {
      id: "td-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: i.title, description: i.description, assignee: i.assignee, due: i.due, docKey: i.docKey,
      state: "Open", createdAt: new Date().toISOString(), createdBy: this.actorName(),
    };
    await this.store.save((t) => ({ ...t, todos: [...t.todos, todo] }));
  }

  async setState(v: TodoView, state: TodoState): Promise<void> {
    if (v.source === "native") {
      await this.api.updateTodo(v.id, { status: stateToNative(state) });
      return;
    }
    await this.store.save((t) => ({
      ...t,
      todos: t.todos.map((x) => (x.id === v.id ? { ...x, state, doneAt: state === "Done" ? new Date().toISOString() : undefined } : x)),
    }));
  }
}

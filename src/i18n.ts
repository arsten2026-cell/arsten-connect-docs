export type Lang = "bg" | "en";

const dict = {
  register: ["Регистър", "Register"],
  transmittals: ["Трансмитали", "Transmittals"],
  todos: ["Задачи", "Todos"],
  settings: ["Настройки", "Settings"],
  refresh: ["Обнови", "Refresh"],
  loading: ["Зареждане…", "Loading…"],
  saving: ["Записване…", "Saving…"],
  saved: ["Записано", "Saved"],
  documents: ["документа", "documents"],
  search: ["Търсене…", "Search…"],
  allDisciplines: ["Всички части", "All disciplines"],
  allStatuses: ["Всички статуси", "All statuses"],
  number: ["Номер", "Number"],
  rev: ["Рев.", "Rev"],
  title: ["Наименование", "Title"],
  discipline: ["Част", "Discipline"],
  type: ["Вид", "Type"],
  status: ["Статус", "Status"],
  modified: ["Променен", "Modified"],
  by: ["от", "by"],
  folder: ["Папка", "Folder"],
  version: ["Версия", "Version"],
  history: ["История", "History"],
  revisions: ["Ревизии", "Revisions"],
  statusLog: ["Промени на статус", "Status changes"],
  noLog: ["Няма промени.", "No changes yet."],
  open: ["Отвори", "Open"],
  download: ["Изтегли", "Download"],
  close: ["Затвори", "Close"],
  selected: ["избрани", "selected"],
  newTransmittal: ["Нов трансмитал", "New transmittal"],
  fromSelected: ["Трансмитал от избраните", "Transmittal from selected"],
  setStatus: ["Смени статус", "Set status"],
  exportCsv: ["Експорт CSV", "Export CSV"],
  unnumbered: ["Файлове без номер по шаблона", "Files not matching the numbering pattern"],
  noDocs: ["Няма документи по шаблона в този проект.", "No documents match the numbering pattern in this project."],
  overdue: ["просрочени", "overdue"],
  lastTransmittal: ["Последен трансмитал", "Last transmittal"],
  none: ["няма", "none"],
  to: ["До", "To"],
  attn: ["На вниманието на", "Attention"],
  purpose: ["Цел", "Purpose"],
  date: ["Дата", "Date"],
  note: ["Бележка", "Note"],
  items: ["Документи", "Documents"],
  create: ["Създай", "Create"],
  cancel: ["Отказ", "Cancel"],
  pdf: ["PDF", "PDF"],
  noTransmittals: ["Още няма трансмитали.", "No transmittals yet."],
  pickDocs: ["Изберете документи (текуща ревизия)", "Pick documents (current revision)"],
  trCreated: ["Трансмиталът е създаден", "Transmittal created"],
  trWillSet: ["Статусът на включените ревизии ще стане", "Included revisions will be set to"],
  newTodo: ["Нова задача", "New todo"],
  assignee: ["Отговорник", "Assignee"],
  due: ["Срок", "Due"],
  document: ["Документ", "Document"],
  description: ["Описание", "Description"],
  noTodos: ["Няма задачи.", "No todos."],
  filterOpen: ["Отворени", "Open"],
  filterMine: ["Мои", "Mine"],
  filterOverdue: ["Просрочени", "Overdue"],
  filterAll: ["Всички", "All"],
  todoNative: ["Задачите се пазят в ToDo на Trimble Connect.", "Todos are stored in Trimble Connect ToDos."],
  todoLocal: ["Задачите се пазят в _ArstenDocs/tracker.json (ToDo на Connect не е достъпно).", "Todos are stored in _ArstenDocs/tracker.json (Connect ToDos not reachable)."],
  pattern: ["Шаблон за номер (регулярен израз)", "Numbering pattern (regular expression)"],
  patternHelp: ["Групи: proj, disc, type, num, rev. Пример: 1018-ST-DR-0101_R02", "Groups: proj, disc, type, num, rev. Example: 1018-ST-DR-0101_R02"],
  testName: ["Тест на име на файл", "Test a file name"],
  projectCode: ["Код на проекта (за номер на трансмитал)", "Project code (for transmittal numbers)"],
  todoBackend: ["Къде да се пазят задачите", "Where todos are stored"],
  auto: ["Автоматично", "Automatic"],
  save: ["Запази", "Save"],
  diagnostics: ["Диагностика на API", "API diagnostics"],
  runDiagnostics: ["Провери достъпа", "Check access"],
  trackerFile: ["Файл с данни", "Data file"],
  notCreated: ["още не е създаден (създава се при първа промяна)", "not created yet (created on first change)"],
  error: ["Грешка", "Error"],
  mockBanner: ["Демо режим – отворено извън Trimble Connect, данните са примерни.", "Demo mode – opened outside Trimble Connect, sample data."],
  todoState_Open: ["Отворена", "Open"],
  "todoState_In progress": ["В процес", "In progress"],
  todoState_Done: ["Готова", "Done"],
  st_Draft: ["Чернова", "Draft"],
  "st_For approval": ["За съгласуване", "For approval"],
  st_Issued: ["Издаден", "Issued"],
  st_Superseded: ["Заменен", "Superseded"],
  "pu_For approval": ["За съгласуване", "For approval"],
  "pu_For construction": ["За строителство", "For construction"],
  "pu_For information": ["За информация", "For information"],
  "pu_For tender": ["За търг", "For tender"],
} as const;

export type Key = keyof typeof dict;

let lang: Lang = "bg";
export function setLang(l: Lang) {
  lang = l;
  try { localStorage.setItem("arsten-docs-lang", l); } catch { /* storage blocked */ }
}
export function getLang(): Lang { return lang; }
export function initLang(hostLanguage?: string) {
  let stored: string | null = null;
  try { stored = localStorage.getItem("arsten-docs-lang"); } catch { /* storage blocked */ }
  if (stored === "bg" || stored === "en") lang = stored;
  else if (hostLanguage && !hostLanguage.toLowerCase().startsWith("bg")) lang = "en";
}
export function t(k: Key | string): string {
  const e = (dict as Record<string, readonly [string, string]>)[k];
  return e ? e[lang === "bg" ? 0 : 1] : k;
}

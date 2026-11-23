/* 应用状态：服务端数据、离线缓存、待同步队列。 */

import { api, isNetworkError } from "./api.js";

const CACHE_KEY = "paperpal.cache.v2";
const SESSION_KEY = "paperpal.session.v1";
const OUTBOX_KEY = "paperpal.outbox.v1";

const DEFAULT_SETTINGS = {
  interaction_mode: "guided",
  voice_enabled: true,
  voice_rate: 1,
  voice_pitch: 1,
  verbosity: "standard",
  theme: "auto",
  high_contrast: false,
  font_scale: 1,
  auto_advance: false,
  auto_advance_delay: 2.5,
  reading_mode: "manual",
  text_script: "simplified",
  translation_target: "off",
  speak_translation: false,
  haptics: true,
  guidance_sounds: true,
  always_listen: false,
  screen_reader_mode: false,
  reader_name: "",
  keep_screen_awake: true,
};

const DEMO_LINES = [
  "读书使人充实，讨论使人机智，笔记使人准确。",
  "读史使人明智，读诗使人灵秀，数学使人周密。",
  "科学使人深刻，伦理学使人庄重，逻辑修辞使人善辩。",
  "凡有所学，皆成性格。",
  "把手机固定在书页上方，纸伴会逐行朗读。",
  "你可以随时说“暂停”“下一行”或“添加批注”。",
];

export const state = {
  ready: false,
  offline: false,
  backend: false,
  profile: { id: "local", name: "我" },
  settings: { ...DEFAULT_SETTINGS },
  books: [],
  notes: [],
  progress: [],
  stats: {
    books: 0,
    pages: 0,
    lines: 0,
    notes: 0,
    reading_seconds: 0,
    streak_days: 0,
    today: { date: "", lines: 0, seconds: 0 },
    daily: [],
  },
  server: { version: "", ocr_ready: false, ocr_engine: "" },
  session: null,
  current: null,
  cachedPage: null,
  lastError: null,
};

const listeners = new Set();
let outbox = [];
let flushing = false;
let bootPromise = null;

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(reason) {
  for (const listener of listeners) {
    try {
      listener(state, reason);
    } catch (error) {
      console.error("state listener failed", error);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 本地缓存                                                                    */
/* -------------------------------------------------------------------------- */

export function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return false;
    const cached = JSON.parse(raw);
    if (!cached || typeof cached !== "object") return false;
    state.profile = cached.profile || state.profile;
    state.settings = { ...DEFAULT_SETTINGS, ...(cached.settings || {}) };
    state.books = Array.isArray(cached.books) ? cached.books : [];
    state.notes = Array.isArray(cached.notes) ? cached.notes : [];
    state.progress = Array.isArray(cached.progress) ? cached.progress : [];
    state.stats = { ...state.stats, ...(cached.stats || {}) };
    state.server = { ...state.server, ...(cached.server || {}) };
    state.cachedPage = cached.cachedPage || null;
    return true;
  } catch {
    return false;
  }
}

function cache() {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        profile: state.profile,
        settings: state.settings,
        books: state.books,
        notes: state.notes,
        progress: state.progress,
        stats: state.stats,
        server: state.server,
        cachedPage: state.cachedPage,
        saved_at: new Date().toISOString(),
      })
    );
  } catch {
    /* 存储已满时不影响运行 */
  }
}

export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (!session || !session.bookId) return null;
    state.session = session;
    return session;
  } catch {
    return null;
  }
}

function persistSession() {
  try {
    if (state.session) localStorage.setItem(SESSION_KEY, JSON.stringify(state.session));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* 忽略 */
  }
}

function loadOutbox() {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY);
    outbox = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(outbox)) outbox = [];
  } catch {
    outbox = [];
  }
}

function saveOutbox() {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox.slice(-300)));
  } catch {
    /* 忽略 */
  }
}

function queue(operation) {
  const entry = {
    id: `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    ...operation,
  };
  if (entry.type === "progress") {
    outbox = outbox.filter((op) => !(op.type === "progress" && op.payload.book_id === entry.payload.book_id));
  }
  if (entry.type === "settings") {
    outbox = outbox.filter((op) => op.type !== "settings");
  }
  if (entry.type === "activity") {
    const activities = outbox.filter((op) => op.type === "activity");
    if (activities.length > 60) {
      outbox = outbox.filter((op) => !(op.type === "activity" && op.id === activities[0].id));
    }
  }
  outbox.push(entry);
  saveOutbox();
}

export function pendingCount() {
  return outbox.length;
}

/* -------------------------------------------------------------------------- */
/* 启动                                                                        */
/* -------------------------------------------------------------------------- */

export function boot() {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    loadCache();
    loadOutbox();
    loadSession();
    const hadCache = state.books.length > 0;
    try {
      await flushOutbox({ silent: true });
      const payload = await api.bootstrap();
      applyBootstrap(payload);
      state.backend = true;
      state.offline = false;
      state.ready = true;
      state.lastError = null;
      cache();
      emit("bootstrap");
    } catch (error) {
      state.offline = true;
      state.backend = false;
      state.lastError = error;
      state.ready = true;
      if (!hadCache) seedLocalDemo();
      mergePendingNotes();
      cache();
      emit("offline");
    }
    return state;
  })();
  return bootPromise;
}

function applyBootstrap(payload) {
  state.profile = payload.profile || state.profile;
  state.settings = { ...DEFAULT_SETTINGS, ...(payload.settings || {}) };
  state.books = Array.isArray(payload.books) ? payload.books : [];
  state.notes = Array.isArray(payload.notes) ? payload.notes : [];
  state.progress = Array.isArray(payload.progress) ? payload.progress : [];
  state.stats = { ...state.stats, ...(payload.stats || {}) };
  state.server = { ...state.server, ...(payload.server || {}) };
  mergePendingNotes();
  restoreFromServerProgress();
}

function restoreFromServerProgress() {
  const saved = state.session;
  let candidate = null;
  if (saved) {
    candidate = state.progress.find((entry) => entry.book_id === saved.bookId) || null;
    if (!candidate) {
      const book = findBook(saved.bookId);
      if (book) candidate = { book_id: book.id, page_number: saved.pageNumber || 1, line_index: saved.lineIndex || 0 };
    }
  }
  if (!candidate && state.progress.length) candidate = state.progress[0];
  if (candidate) {
    state.session = {
      bookId: candidate.book_id,
      pageNumber: candidate.page_number,
      lineIndex: candidate.line_index || 0,
      bookTitle: candidate.book_title || findBook(candidate.book_id)?.title || "",
    };
    persistSession();
  }
}

function mergePendingNotes() {
  const pending = outbox.filter((op) => op.type === "note:create" && op.note);
  for (const op of pending) {
    if (!state.notes.some((note) => note.id === op.localId)) {
      state.notes.unshift({ ...op.note, pending: true });
    }
  }
}

function seedLocalDemo() {
  if (state.books.length) return;
  const now = new Date().toISOString();
  const book = {
    id: "bk_local_demo",
    title: "示例书籍 · 论读书",
    author: "弗朗西斯·培根",
    color: "jade",
    demo: true,
    local: true,
    page_count: 1,
    note_count: 0,
    last_page: 12,
    last_line: 0,
    created_at: now,
    updated_at: now,
  };
  const page = {
    id: "pg_local_demo",
    book_id: book.id,
    book_title: book.title,
    book_color: book.color,
    page_number: 12,
    line_count: DEMO_LINES.length,
    confidence: 0.99,
    layout: "none",
    rotation: 0,
    text: DEMO_LINES.join("\n"),
    warnings: [],
    lines: DEMO_LINES.map((text, index) => ({
      reading_order: index + 1,
      text,
      confidence: 0.99,
      region_id: "page-1",
      block_id: "block-1",
      bbox: [],
    })),
    has_image: false,
    demo: true,
  };
  state.books = [book];
  state.notes = [];
  state.progress = [
    {
      book_id: book.id,
      book_title: book.title,
      page_number: 12,
      line_index: 0,
      page_line_count: DEMO_LINES.length,
      updated_at: now,
    },
  ];
  state.stats = { ...state.stats, books: 1, pages: 1, lines: DEMO_LINES.length, notes: 0 };
  state.session = { bookId: book.id, pageNumber: 12, lineIndex: 0, bookTitle: book.title };
  state.localDemoPage = page;
  persistSession();
}

/* -------------------------------------------------------------------------- */
/* 查询                                                                        */
/* -------------------------------------------------------------------------- */

export function findBook(id) {
  return state.books.find((book) => book.id === id) || null;
}

export function findNote(id) {
  return state.notes.find((note) => note.id === id) || null;
}

export function currentBook() {
  return state.current ? findBook(state.current.bookId) : null;
}

export function currentLines() {
  return state.current?.page?.lines || [];
}

export function bookPages(bookId) {
  return findBook(bookId)?.pages || [];
}

export function settings() {
  return state.settings;
}

export function isOffline() {
  return state.offline;
}

/* -------------------------------------------------------------------------- */
/* 数据修改                                                                    */
/* -------------------------------------------------------------------------- */

export async function refreshBootstrap() {
  const payload = await api.bootstrap();
  applyBootstrap(payload);
  state.backend = true;
  state.offline = false;
  cache();
  emit("bootstrap");
  return payload;
}

export async function refreshBooks() {
  try {
    state.books = await api.getBooks();
    state.backend = true;
    state.offline = false;
    cache();
    emit("books");
  } catch (error) {
    if (isNetworkError(error)) markOffline(error);
    else throw error;
  }
}

export async function refreshBook(bookId) {
  try {
    const book = await api.getBook(bookId);
    const index = state.books.findIndex((item) => item.id === bookId);
    if (index >= 0) state.books[index] = { ...book, pages: book.pages || [] };
    else state.books.unshift({ ...book, pages: book.pages || [] });
    cache();
    emit("books");
    return book;
  } catch (error) {
    if (isNetworkError(error)) markOffline(error);
    else throw error;
    return findBook(bookId);
  }
}

export async function createBook(title, author = "") {
  const palette = ["jade", "amber", "indigo", "rose", "slate", "clay"];
  const seed = Array.from(String(title)).reduce((total, char) => total + char.codePointAt(0), 0);
  const color = palette[seed % palette.length];
  const book = await api.createBook({ title, author, color });
  state.books.unshift({ ...book, pages: book.pages || [] });
  cache();
  emit("books");
  return book;
}

export async function deleteBook(bookId) {
  await api.deleteBook(bookId);
  state.books = state.books.filter((book) => book.id !== bookId);
  state.notes = state.notes.filter((note) => note.book_id !== bookId);
  state.progress = state.progress.filter((entry) => entry.book_id !== bookId);
  if (state.current?.bookId === bookId) {
    state.current = null;
    state.session = null;
    persistSession();
  }
  cache();
  emit("books");
}

export async function ensureDemoBook() {
  if (state.offline) {
    if (!state.books.some((book) => book.demo)) {
      seedLocalDemo();
      cache();
      emit("books");
    }
    return state.books.find((book) => book.demo);
  }
  const book = await api.ensureDemoBook();
  const index = state.books.findIndex((item) => item.id === book.id);
  if (index >= 0) state.books[index] = { ...book, pages: book.pages || [] };
  else state.books.unshift({ ...book, pages: book.pages || [] });
  cache();
  emit("books");
  return book;
}

export async function refreshNotes() {
  if (!state.backend) {
    mergePendingNotes();
    emit("notes");
    return state.notes;
  }
  try {
    const payload = await api.listNotes({ limit: 500 });
    const serverNotes = payload.notes || [];
    const pending = state.notes.filter((note) => note.pending);
    state.notes = [...pending, ...serverNotes];
    cache();
    emit("notes");
    return state.notes;
  } catch (error) {
    if (isNetworkError(error)) markOffline(error);
    else throw error;
    return state.notes;
  }
}

/* -------------------------------------------------------------------------- */
/* 当前书页                                                                    */
/* -------------------------------------------------------------------------- */

export async function openPage(bookId, pageNumber, lineIndex = 0) {
  const book = findBook(bookId);
  if (!book) throw new Error("找不到这本书。");
  if (
    state.current &&
    state.current.bookId === bookId &&
    Number(state.current.pageNumber) === Number(pageNumber) &&
    state.current.page
  ) {
    setLine(lineIndex);
    return state.current;
  }
  let page = null;
  if (book.local && book.demo) {
    page = demoPage(book, Number(pageNumber));
  } else if (
    state.cachedPage &&
    state.cachedPage.bookId === bookId &&
    Number(state.cachedPage.pageNumber) === Number(pageNumber)
  ) {
    page = state.cachedPage.page;
  } else if (state.offline) {
    throw new Error("离线时只能阅读上次打开过的一页。连接本机服务后可以扫描新页。");
  } else {
    try {
      page = await api.getPageByNumber(bookId, pageNumber);
    } catch (error) {
      if (error.status === 404) return null;
      if (isNetworkError(error)) {
        markOffline(error);
        if (
          state.cachedPage &&
          state.cachedPage.bookId === bookId &&
          Number(state.cachedPage.pageNumber) === Number(pageNumber)
        ) {
          page = state.cachedPage.page;
        } else {
          throw new Error("连接不到本机服务，这一页也没有缓存。");
        }
      } else {
        throw error;
      }
    }
  }
  if (!page) return null;
  state.cachedPage = { bookId, pageNumber: Number(page.page_number || pageNumber), page };
  state.current = {
    bookId,
    bookTitle: page.book_title || book.title,
    bookColor: page.book_color || book.color,
    pageId: page.id,
    pageNumber: Number(page.page_number || pageNumber),
    lineIndex: 0,
    page,
  };
  setLine(lineIndex);
  state.session = {
    bookId,
    pageNumber: state.current.pageNumber,
    lineIndex: state.current.lineIndex,
    bookTitle: state.current.bookTitle,
  };
  persistSession();
  setProgress(bookId, state.current.pageNumber, state.current.lineIndex, { immediate: true });
  emit("page");
  return state.current;
}

function demoPage(book, pageNumber) {
  if (state.localDemoPage && state.localDemoPage.page_number === pageNumber) return state.localDemoPage;
  return {
    ...(state.localDemoPage || {}),
    book_id: book.id,
    book_title: book.title,
    page_number: pageNumber,
    lines: DEMO_LINES.map((text, index) => ({
      reading_order: index + 1,
      text,
      confidence: 0.99,
      region_id: "page-1",
      block_id: "block-1",
      bbox: [],
    })),
    line_count: DEMO_LINES.length,
    text: DEMO_LINES.join("\n"),
    demo: true,
  };
}

export function setCurrentPage(page, book) {
  if (!page) return null;
  state.cachedPage = { bookId: page.book_id, pageNumber: Number(page.page_number), page };
  state.current = {
    bookId: page.book_id,
    bookTitle: page.book_title || book?.title || "",
    bookColor: page.book_color || book?.color || "jade",
    pageId: page.id,
    pageNumber: Number(page.page_number),
    lineIndex: 0,
    page,
  };
  state.session = {
    bookId: page.book_id,
    pageNumber: Number(page.page_number),
    lineIndex: 0,
    bookTitle: state.current.bookTitle,
  };
  persistSession();
  cache();
  emit("page");
  return state.current;
}

export function setLine(index) {
  if (!state.current) return 0;
  const lines = state.current.page?.lines || [];
  const max = Math.max(0, lines.length - 1);
  const next = Math.min(max, Math.max(0, Number(index) || 0));
  state.current.lineIndex = next;
  state.session = {
    bookId: state.current.bookId,
    pageNumber: state.current.pageNumber,
    lineIndex: next,
    bookTitle: state.current.bookTitle,
  };
  persistSession();
  setProgress(state.current.bookId, state.current.pageNumber, next);
  return next;
}

export function clearCurrent() {
  state.current = null;
  state.session = null;
  state.cachedPage = null;
  persistSession();
  emit("page");
}

/* -------------------------------------------------------------------------- */
/* 进度、活动与统计                                                            */
/* -------------------------------------------------------------------------- */

let progressTimer = null;
const pendingProgress = new Map();

export function setProgress(bookId, pageNumber, lineIndex, { immediate = false } = {}) {
  const existing = state.progress.find((entry) => entry.book_id === bookId);
  const book = findBook(bookId);
  const entry = {
    book_id: bookId,
    book_title: book?.title || existing?.book_title || "",
    book_color: book?.color || existing?.book_color || "jade",
    page_number: Number(pageNumber),
    line_index: Number(lineIndex) || 0,
    page_line_count: state.current?.page?.lines?.length || existing?.page_line_count || 0,
    updated_at: new Date().toISOString(),
  };
  if (existing) Object.assign(existing, entry);
  else state.progress.unshift(entry);
  state.progress.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  if (book) {
    book.last_page = Number(pageNumber);
    book.last_line = Number(lineIndex) || 0;
  }
  cache();
  pendingProgress.set(bookId, { book_id: bookId, page_number: Number(pageNumber), line_index: Number(lineIndex) || 0 });
  clearTimeout(progressTimer);
  if (immediate) {
    flushProgress();
  } else {
    progressTimer = setTimeout(flushProgress, 900);
  }
}

function sendProgress(payload) {
  if (!payload) return;
  api.saveProgress(payload).catch((error) => {
    if (isNetworkError(error)) {
      markOffline(error);
      queue({ type: "progress", payload });
    }
  });
}

/** 立即提交尚未发出的阅读进度。来电/切后台/关闭页面前调用。 */
export function flushProgress() {
  clearTimeout(progressTimer);
  for (const [bookId, payload] of [...pendingProgress.entries()]) {
    pendingProgress.delete(bookId);
    sendProgress(payload);
  }
}

export function currentProgressPayload() {
  if (!state.current) return null;
  return {
    book_id: state.current.bookId,
    page_number: Number(state.current.pageNumber),
    line_index: Number(state.current.lineIndex) || 0,
  };
}

export async function recordActivity(activity) {
  const payload = {
    kind: activity.kind || "read",
    book_id: activity.book_id || null,
    page_number: activity.page_number || null,
    lines: Math.max(0, Math.round(activity.lines || 0)),
    seconds: Math.max(0, Math.round(activity.seconds || 0)),
  };
  if (!payload.seconds && !payload.lines) return;
  if (state.offline) {
    queue({ type: "activity", payload });
    return;
  }
  try {
    await api.postActivity(payload);
  } catch (error) {
    if (isNetworkError(error)) {
      markOffline(error);
      queue({ type: "activity", payload });
    }
  }
}

export async function refreshStats() {
  if (state.offline) return state.stats;
  try {
    state.stats = await api.getStats(14);
    cache();
    emit("stats");
  } catch (error) {
    if (isNetworkError(error)) markOffline(error);
  }
  return state.stats;
}

/* -------------------------------------------------------------------------- */
/* 批注                                                                        */
/* -------------------------------------------------------------------------- */

function localId() {
  if (globalThis.crypto?.randomUUID) return `local_${crypto.randomUUID()}`;
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function noteDisplay(payload) {
  const book = findBook(payload.book_id);
  return {
    id: localId(),
    book_id: payload.book_id,
    book_title: book?.title || "未知书籍",
    book_color: book?.color || "jade",
    page_id: payload.page_id || null,
    page_number: Number(payload.page_number) || 1,
    line_number: payload.scope === "line" ? Number(payload.line_number) || 1 : null,
    scope: payload.scope === "page" ? "page" : "line",
    text: String(payload.text || ""),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    pending: true,
  };
}

export async function createNote(payload) {
  const clean = {
    book_id: payload.book_id,
    page_id: payload.page_id || null,
    page_number: Number(payload.page_number) || 1,
    line_number: payload.scope === "line" ? Number(payload.line_number) || 1 : null,
    scope: payload.scope === "page" ? "page" : "line",
    text: String(payload.text || "").trim(),
  };
  if (!clean.text) throw new Error("批注内容不能为空。");
  if (!state.offline && state.backend) {
    try {
      const note = await api.createNote(clean);
      state.notes.unshift(note);
      cache();
      emit("notes");
      return note;
    } catch (error) {
      if (!isNetworkError(error)) throw error;
      markOffline(error);
    }
  }
  const note = noteDisplay(clean);
  state.notes.unshift(note);
  queue({ type: "note:create", localId: note.id, payload: clean, note });
  cache();
  emit("notes");
  return note;
}

export async function updateNote(id, patch) {
  const note = findNote(id);
  if (!note) throw new Error("找不到这条批注。");
  const clean = {
    text: String(patch.text ?? note.text).trim(),
    scope: (patch.scope ?? note.scope) === "page" ? "page" : "line",
    line_number:
      (patch.scope ?? note.scope) === "page" ? null : Number(patch.line_number ?? note.line_number) || 1,
    page_number: Number(patch.page_number ?? note.page_number) || 1,
  };
  if (!clean.text) throw new Error("批注内容不能为空。");
  if (note.pending || id.startsWith("local_")) {
    Object.assign(note, clean, { updated_at: new Date().toISOString() });
    const pendingOp = outbox.find((op) => op.type === "note:create" && op.localId === id);
    if (pendingOp) Object.assign(pendingOp.payload, clean);
    else queue({ type: "note:update", id, patch: clean });
    cache();
    emit("notes");
    return note;
  }
  if (!state.offline && state.backend) {
    try {
      const updated = await api.updateNote(id, clean);
      Object.assign(note, updated);
      cache();
      emit("notes");
      return note;
    } catch (error) {
      if (!isNetworkError(error)) throw error;
      markOffline(error);
    }
  }
  Object.assign(note, clean, { updated_at: new Date().toISOString() });
  queue({ type: "note:update", id, patch: clean });
  cache();
  emit("notes");
  return note;
}

export async function deleteNote(id) {
  const note = findNote(id);
  if (!note) return;
  if (note.pending || id.startsWith("local_")) {
    outbox = outbox.filter((op) => !(op.type === "note:create" && op.localId === id));
    outbox = outbox.filter((op) => !(op.type === "note:update" && op.id === id));
    saveOutbox();
  } else if (!state.offline && state.backend) {
    try {
      await api.deleteNote(id);
    } catch (error) {
      if (!isNetworkError(error)) throw error;
      markOffline(error);
      queue({ type: "note:delete", id });
    }
  } else {
    queue({ type: "note:delete", id });
  }
  state.notes = state.notes.filter((item) => item.id !== id);
  cache();
  emit("notes");
}

// 兼容旧调用
export async function saveNote(payload) {
  if (payload.id) return updateNote(payload.id, payload);
  return createNote(payload);
}

/* -------------------------------------------------------------------------- */
/* 设置与称呼                                                                  */
/* -------------------------------------------------------------------------- */

export async function persistSettings(patch, { silent = false } = {}) {
  state.settings = { ...state.settings, ...patch };
  cache();
  emit("settings");
  if (state.offline || !state.backend) {
    queue({ type: "settings", patch });
    return state.settings;
  }
  try {
    const saved = await api.updateSettings(patch);
    state.settings = { ...DEFAULT_SETTINGS, ...saved };
    cache();
    emit("settings");
    return state.settings;
  } catch (error) {
    if (isNetworkError(error)) {
      markOffline(error);
      queue({ type: "settings", patch });
      return state.settings;
    }
    state.lastError = error;
    if (!silent) throw error;
    return state.settings;
  }
}

export async function saveName(name) {
  const clean = String(name || "").trim().slice(0, 40);
  state.profile = { ...state.profile, name: clean };
  cache();
  emit("profile");
  if (state.offline) {
    queue({ type: "profile", name: clean });
    return state.profile;
  }
  try {
    const profile = await api.updateProfile(clean);
    state.profile = profile;
    cache();
    emit("profile");
  } catch (error) {
    if (isNetworkError(error)) {
      markOffline(error);
      queue({ type: "profile", name: clean });
    } else throw error;
  }
  return state.profile;
}

/* -------------------------------------------------------------------------- */
/* 离线队列                                                                    */
/* -------------------------------------------------------------------------- */

export function markOffline(error = null) {
  if (error) state.lastError = error;
  const wasOffline = state.offline;
  state.offline = true;
  state.backend = false;
  if (!wasOffline) emit("offline");
}

export function markOnline() {
  const wasOffline = state.offline;
  state.offline = false;
  state.backend = true;
  if (wasOffline) {
    cache();
    emit("online");
  }
  void flushOutbox();
}

export async function flushOutbox({ silent = false } = {}) {
  if (flushing || !outbox.length) return { synced: 0 };
  flushing = true;
  let synced = 0;
  const failures = [];
  for (const op of [...outbox]) {
    try {
      if (op.type === "note:create") {
        const note = await api.createNote(op.payload);
        const index = state.notes.findIndex((item) => item.id === op.localId);
        if (index >= 0) state.notes[index] = note;
        outbox = outbox.filter((item) => item.id !== op.id);
        saveOutbox();
      } else if (op.type === "note:update") {
        await api.updateNote(op.id, op.patch);
        outbox = outbox.filter((item) => item.id !== op.id);
        saveOutbox();
      } else if (op.type === "note:delete") {
        await api.deleteNote(op.id).catch((error) => {
          if (error.status !== 404) throw error;
        });
        outbox = outbox.filter((item) => item.id !== op.id);
        saveOutbox();
      } else if (op.type === "progress") {
        await api.saveProgress(op.payload);
        outbox = outbox.filter((item) => item.id !== op.id);
        saveOutbox();
      } else if (op.type === "activity") {
        await api.postActivity(op.payload);
        outbox = outbox.filter((item) => item.id !== op.id);
        saveOutbox();
      } else if (op.type === "settings") {
        const saved = await api.updateSettings(op.patch);
        state.settings = { ...DEFAULT_SETTINGS, ...saved };
        outbox = outbox.filter((item) => item.id !== op.id);
        saveOutbox();
      } else if (op.type === "profile") {
        const profile = await api.updateProfile(op.name);
        state.profile = profile;
        outbox = outbox.filter((item) => item.id !== op.id);
        saveOutbox();
      } else {
        outbox = outbox.filter((item) => item.id !== op.id);
        saveOutbox();
      }
      synced += 1;
      if (state.offline) {
        state.offline = false;
        state.backend = true;
        emit("online");
      }
    } catch (error) {
      if (isNetworkError(error)) {
        markOffline(error);
        failures.push({ op, error, retry: true });
        break;
      }
      // 服务端拒绝的条目不再重试，避免卡住整个队列。
      outbox = outbox.filter((item) => item.id !== op.id);
      saveOutbox();
      failures.push({ op, error, retry: false });
    }
  }
  flushing = false;
  if (synced) {
    cache();
    emit("sync");
    if (state.backend && !state.offline) {
      refreshBootstrap().catch(() => {});
    }
  }
  return { synced, failures };
}

/* -------------------------------------------------------------------------- */
/* 备份与清理                                                                  */
/* -------------------------------------------------------------------------- */

export async function exportData() {
  if (!state.offline && state.backend) {
    try {
      return await api.exportAll();
    } catch (error) {
      if (!isNetworkError(error)) throw error;
      markOffline(error);
    }
  }
  const payload = {
    format: "paperpal-export",
    version: 1,
    exported_at: new Date().toISOString(),
    profile: state.profile,
    settings: state.settings,
    books: state.books,
    notes: state.notes,
    progress: state.progress,
  };
  return {
    text: JSON.stringify(payload, null, 2),
    filename: `paperpal-local-${new Date().toISOString().slice(0, 10)}.json`,
  };
}

export async function importData(payload, mode = "merge") {
  const result = await api.importAll(payload, mode);
  await refreshBootstrap();
  return result;
}

export async function clearAllData() {
  if (state.offline) throw new Error("离线时无法清除本机数据库，请先连接服务。");
  await api.clearAll();
  state.books = [];
  state.notes = [];
  state.progress = [];
  state.current = null;
  state.session = null;
  state.cachedPage = null;
  state.stats = { ...state.stats, books: 0, pages: 0, lines: 0, notes: 0, reading_seconds: 0, streak_days: 0, daily: [], today: { lines: 0, seconds: 0 } };
  persistSession();
  outbox = [];
  saveOutbox();
  cache();
  emit("clear");
}

export function reportError(error) {
  state.lastError = error;
  emit("error");
}

export { DEFAULT_SETTINGS };

/* 纸伴 PaperPal — 应用主控制器
   路由、页面渲染、相机、扫描、朗读、批注、设置与语音指令。 */

import { api, isNetworkError } from "./api.js";
import {
  state,
  boot,
  loadCache,
  loadSession,
  subscribe,
  findBook,
  findNote,
  currentLines,
  openPage,
  setCurrentPage,
  setLine,
  clearCurrent,
  setProgress,
  flushProgress,
  currentProgressPayload,
  recordActivity,
  refreshStats,
  refreshNotes,
  refreshBook,
  createBook,
  deleteBook,
  ensureDemoBook,
  createNote,
  updateNote,
  deleteNote,
  persistSettings,
  saveName,
  markOffline,
  markOnline,
  flushOutbox,
  exportData,
  importData,
  clearAllData,
  pendingCount,
} from "./store.js";
import * as voice from "./voice.js";
import * as bluetooth from "./bluetooth.js";
import * as input from "./input.js";
import * as autoscan from "./autoscan.js";
import * as devices from "./devices.js";
import {
  $,
  $$,
  el,
  icon,
  toast,
  openDialog,
  confirmDialog,
  formatDate,
  clamp,
  debounce,
  vibrate,
  screenReaderSay,
} from "./ui.js";

/* -------------------------------------------------------------------------- */
/* 常量与状态                                                                  */
/* -------------------------------------------------------------------------- */

const ROUTES = new Set([
  "welcome",
  "library",
  "setup",
  "scan",
  "review",
  "reading",
  "annotate",
  "notes",
  "settings",
  "devices",
  "phone",
]);

const ROUTE_TITLES = {
  welcome: "纸伴 · 陪你读书",
  library: "纸伴 · 书架",
  setup: "纸伴 · 摆放引导",
  scan: "纸伴 · 扫描书页",
  review: "纸伴 · 识别结果",
  reading: "纸伴 · 阅读",
  annotate: "纸伴 · 批注",
  notes: "纸伴 · 我的批注",
  settings: "纸伴 · 设置",
  devices: "纸伴 · 蓝牙、键盘与手柄",
  phone: "纸伴 · 用手机打开",
};

const SCAN_PREFS_KEY = "paperpal.scanPrefs.v1";
const LAST_BOOK_KEY = "paperpal.lastBook.v1";

let currentRoute = "welcome";
let cameraStream = null;
let cameraQualityTimer = null;
let lastQualityMessage = null;
let capturedBlob = null;
let previewUrl = null;
let torchOn = false;
let scanBusy = false;
let scanSlowTimer = null;
let scanIntent = null;
let annotation = null;
let annotationInitial = "";
let readingSession = null;
let playToken = 0;
let speechPlaying = false;
let speechPaused = false;
let autoTimer = null;
let listening = false;
let dictating = false;
let phoneInfo = null;
let mediaBootstrapped = false;
let autoScanOn = false;
let autoScanPage = null;
let autoScanLastAction = "";
let pairingWatch = 0;
let autoBadgeTimer = null;
let readingDisplay = null;
let readingDisplayKey = "";
let readingTransformToken = 0;
let wakeLock = null;
let interruptedPlayback = false;
let bleSnapshot = { supported: false, connected: false, name: "", battery: null, knownNames: [] };
let bleLearning = false;
let bleMap = loadBleMap();
let pendingAutoRead = false;
let welcomeSpoken = false;
let autoListenTimer = null;
let pendingSettings = {};
let notesQuery = "";
let notesScope = "all";
let libraryQuery = "";
let initialized = false;

const flushSettings = debounce(async () => {
  const patch = pendingSettings;
  pendingSettings = {};
  if (!Object.keys(patch).length) return;
  try {
    await persistSettings(patch);
  } catch (error) {
    toast("设置没有保存成功，稍后重试。", { tone: "warn", iconName: "info" });
    console.warn("settings", error);
  }
}, 650);

const saveNotesSearch = debounce(() => {
  notesQuery = $("#noteSearch")?.value.trim() || "";
  renderNotes();
}, 160);

/* -------------------------------------------------------------------------- */
/* 启动                                                                        */
/* -------------------------------------------------------------------------- */

async function init() {
  loadCache();
  loadSession();
  applyPreferences();
  bindEvents();
  updateOfflineBanner();
  updateServerChip();
  showRoute(parseRoute());

  await boot();
  applyPreferences();
  updateServerChip();
  updateOfflineBanner();
  syncSettingsUI();
  renderRoute(currentRoute);
  registerServiceWorker();
  initializeInput();
  initializeBluetooth();
  renderDeviceRegistry();
  setAutoUi(false);

  setTimeout(() => {
    if (!welcomeSpoken && currentRoute === "welcome" && !voice.screenReaderMode()) {
      welcomeSpoken = true;
      void speakWelcome();
    }
  }, 700);

  window.addEventListener("pointerdown", unlockFirst, { once: true });
  window.addEventListener("keydown", unlockFirst, { once: true });
}

function unlockFirst() {
  voice.unlock();
  // 第一次手势里同时启用耳机媒体键（浏览器要求由用户点击触发）
  if (!mediaBootstrapped) {
    mediaBootstrapped = true;
    void input.enableMediaControls();
  }
  if (!welcomeSpoken && currentRoute === "welcome") {
    welcomeSpoken = true;
    void speakWelcome();
  }
}

async function speakWelcome() {
  if (currentRoute !== "welcome") return;
  const name = state.profile.name && state.profile.name !== "我" ? `，${state.profile.name}` : "";
  const text = state.offline
    ? `你好${name}，我是纸伴。现在是离线模式，书架和批注从本机读取。你可以先体验演示阅读。`
    : `你好${name}，我是纸伴。选择一种交互方式开始，或者继续上次阅读。`;
  setAssistant("语音助手", state.offline ? "离线模式，使用本机缓存" : "选择一种交互方式，我带你开始扫描。");
  announce(text, { interrupt: true });
}

/* -------------------------------------------------------------------------- */
/* 路由                                                                        */
/* -------------------------------------------------------------------------- */

function parseRoute() {
  const value = location.hash.replace(/^#\/?/, "").split("?")[0];
  return ROUTES.has(value) ? value : "welcome";
}

function navigate(route, { replace = false } = {}) {
  if (!ROUTES.has(route)) route = "welcome";
  if (route === "reading" && !state.current && !state.session) {
    toast("先扫描一页，或从书架选一本读过的书。", { tone: "warn", iconName: "info" });
    route = "welcome";
  }
  if (route === "annotate" && !annotation) {
    toast("先打开一页书，再添加批注。", { tone: "warn", iconName: "info" });
    route = state.current ? "reading" : "welcome";
  }
  const hash = `#/${route}`;
  if (parseRoute() === route) {
    showRoute(route);
    return;
  }
  if (replace) {
    history.replaceState(null, "", hash);
    showRoute(route);
  } else {
    location.hash = hash;
  }
}

function showRoute(route) {
  if (currentRoute === "scan" && route !== "scan" && !autoScanOn) stopCamera();
  if (currentRoute === "reading" && route !== "reading") {
    stopSpeech();
    flushReadingSession(true);
  }
  if (route !== "annotate" && annotation && currentRoute === "annotate") {
    annotation = null;
  }
  if (currentRoute !== route) stopListening();

  currentRoute = route;
  document.body.dataset.inputBench = route === "devices" ? "on" : "off";
  const screens = $$(".screen");
  for (const screen of screens) {
    const active = screen.dataset.route === route;
    screen.hidden = !active;
    screen.classList.toggle("active", active);
  }
  renderRoute(route);
  document.documentElement.dataset.nightReading =
    route === "reading" && readingMode() === "overnight" ? "on" : "off";
  void syncWakeLock();
  $$(".tabbar button").forEach((button) => {
    if (button.dataset.route === route) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  document.title = ROUTE_TITLES[route] || "纸伴";
  const main = $("#main");
  main?.focus({ preventScroll: true });
  window.scrollTo(0, 0);
  const screen = $(`.screen[data-route="${route}"]`);
  if (screen) {
    screen.classList.remove("screen-enter");
    void screen.offsetWidth;
    screen.classList.add("screen-enter");
    setTimeout(() => screen.classList.remove("screen-enter"), 560);
  }
  enterRoute(route).catch((error) => handleActionError(error, "打开页面"));
  if (autoScanOn) {
    setAutoUi(true);
    window.setTimeout(() => attachCameraStream(), 80);
  }
}

async function enterRoute(route) {
  if (route === "welcome") {
    renderWelcome();
    return;
  }
  if (route === "library") {
    renderLibrary();
    return;
  }
  if (route === "setup") {
    speakGuide();
    return;
  }
  if (route === "scan") {
    const autoCamera = Boolean(scanIntent?.autoCamera);
    prepareScanForm();
    scanIntent = null;
    if (autoCamera) await startCamera();
    return;
  }
  if (route === "review") {
    renderReview();
    return;
  }
  if (route === "reading") {
    await enterReading();
    return;
  }
  if (route === "annotate") {
    renderAnnotate();
    return;
  }
  if (route === "notes") {
    renderNotes();
    void storeRefreshNotes();
    return;
  }
  if (route === "settings") {
    syncSettingsUI();
    return;
  }
  if (route === "devices") {
    updateDeviceUI();
    $("#devicePad")?.focus({ preventScroll: true });
  }
  if (route === "phone") {
    await renderPhone();
  }
}

function renderRoute(route) {
  if (route === "welcome") renderWelcome();
  else if (route === "library") renderLibrary();
  else if (route === "scan") {
    updateScanCameraLabel();
  } else if (route === "review") renderReview();
  else if (route === "reading") renderReading();
  else if (route === "annotate") renderAnnotate();
  else if (route === "notes") renderNotes();
  else if (route === "settings") syncSettingsUI();
  else if (route === "devices") updateDeviceUI();
  updateTabs(route);
}

function updateTabs(route) {
  let active = route;
  if (route === "setup" || route === "scan" || route === "review") active = "welcome";
  if (route === "annotate") active = "reading";
  if (route === "devices" || route === "phone") active = "settings";
  $$(".tabbar button").forEach((button) => {
    if (button.dataset.route === active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
}

/* -------------------------------------------------------------------------- */
/* 偏好与状态                                                                  */
/* -------------------------------------------------------------------------- */

function applyPreferences() {
  const settings = state.settings;
  if (!settings.reading_mode) {
    settings.reading_mode = settings.auto_advance ? "page" : "manual";
  }
  const root = document.documentElement;
  root.dataset.theme = settings.theme || "auto";
  root.dataset.contrast = settings.high_contrast ? "high" : "normal";
  root.lang = settings.text_script === "traditional" ? "zh-Hant" : "zh-CN";
  root.dataset.nightReading =
    currentRoute === "reading" && settings.reading_mode === "overnight" ? "on" : "off";
  root.style.setProperty("--font-scale", String(settings.font_scale || 1));
  voice.configure(settings);
  updatePlaybackUI();
  updateServerChip();
  void syncWakeLock();
}

function updateServerChip() {
  const chip = $("#serverChip");
  const text = $("#serverChipText");
  if (!chip || !text) return;
  chip.classList.remove("chip--ok", "chip--warn");
  if (state.offline) {
    chip.classList.add("chip--warn");
    text.textContent = "离线";
    chip.title = "连接不到本机服务，批注会先存在本机";
    chip.setAttribute("aria-label", "离线：连接不到本机服务");
    return;
  }
  if (state.server?.ocr_ready) {
    chip.classList.add("chip--ok");
    text.textContent = "识别就绪";
    chip.title = "本机 OCR 引擎已就绪";
    chip.setAttribute("aria-label", "已连接本机服务，OCR 识别就绪");
  } else {
    chip.classList.add("chip--ok");
    text.textContent = "本机服务";
    chip.title = "已连接本机服务，首次扫描时加载 OCR 模型";
    chip.setAttribute("aria-label", "已连接本机服务，OCR 将在首次扫描时加载");
  }
}

function updateOfflineBanner() {
  const banner = $("#offlineBanner");
  if (!banner) return;
  banner.hidden = !state.offline;
}

function setAssistant(status, line) {
  const statusEl = $("#assistantStatus");
  const lineEl = $("#assistantLine");
  if (statusEl && status) statusEl.textContent = status;
  if (lineEl && line !== undefined) lineEl.textContent = line;
}

function setReadStatus(status, line) {
  const statusEl = $("#readStatus");
  const lineEl = $("#readLine");
  if (statusEl) statusEl.textContent = status;
  if (lineEl && line !== undefined) lineEl.textContent = line;
}

function announce(text, { interrupt = true, toastIt = false, tone = "" } = {}) {
  if (!text) return;
  if (voice.screenReaderMode()) screenReaderSay(text);
  else if (voice.voiceEnabled()) void voice.speak(text, { interrupt });
  if (toastIt) toast(text, { tone, iconName: tone === "error" ? "info" : "volume" });
}

function announceError(error, context = "") {
  const message = error?.message || "出了点问题，请再试一次。";
  console.warn(context, error);
  if (isNetworkError(error)) {
    markOffline(error);
    updateOfflineBanner();
    updateServerChip();
  }
  toast(message, { tone: "error", iconName: "info", duration: 5200 });
  announce(message, { interrupt: true });
}

function handleActionError(error, context) {
  if (isNetworkError(error)) markOffline(error);
  updateOfflineBanner();
  updateServerChip();
  announceError(error, context);
}

/* -------------------------------------------------------------------------- */
/* 首页                                                                        */
/* -------------------------------------------------------------------------- */

function renderWelcome() {
  const stats = state.stats || {};
  const pages = $("#statPages");
  if (pages) pages.textContent = String(stats.pages || 0);
  const notes = $("#statNotes");
  if (notes) notes.textContent = String(stats.notes || state.notes.length || 0);
  const streak = $("#statStreak");
  if (streak) streak.textContent = String(stats.streak_days || 0);
  const minutes = $("#statMinutes");
  if (minutes) minutes.textContent = String(Math.round((stats.reading_seconds || 0) / 60));

  $$(".mode-card").forEach((button) => {
    const active = button.dataset.mode === state.settings.interaction_mode;
    button.setAttribute("aria-checked", String(active));
  });

  const resume = $("#resumeCard");
  const entry = pickResume();
  if (entry) {
    const book = findBook(entry.bookId);
    resume.hidden = false;
    $("#resumeCover").textContent = coverLetter(book?.title || entry.bookTitle || "书");
    $("#resumeCover").dataset.color = book?.color || "jade";
    $("#resumeTitle").textContent = book?.title || entry.bookTitle || "上次阅读";
    const lineNumber = Number(entry.lineIndex || 0) + 1;
    $("#resumeMeta").textContent = `第 ${entry.pageNumber || 1} 页 · 第 ${lineNumber} 行`;
  } else if (resume) {
    resume.hidden = true;
  }

  if (!speechPlaying && !listening) {
    if (state.offline) {
      setAssistant("离线模式", "本机服务暂时连不上。批注会先保存在本机，联网后自动同步。");
    } else {
      setAssistant("我在听", "选择一种交互方式，我带你开始扫描。");
    }
  }
}

function pickResume() {
  if (state.session?.bookId) {
    const book = findBook(state.session.bookId);
    if (book && (book.page_count > 0 || book.demo)) {
      return {
        bookId: state.session.bookId,
        pageNumber: state.session.pageNumber,
        lineIndex: state.session.lineIndex,
        bookTitle: state.session.bookTitle,
      };
    }
  }
  const entry = state.progress?.[0];
  if (entry && findBook(entry.book_id)) {
    return {
      bookId: entry.book_id,
      pageNumber: entry.page_number,
      lineIndex: entry.line_index,
      bookTitle: entry.book_title,
    };
  }
  return null;
}

function coverLetter(title) {
  return Array.from(String(title || "书").trim())[0] || "书";
}

/* -------------------------------------------------------------------------- */
/* 书架                                                                        */
/* -------------------------------------------------------------------------- */

function renderLibrary() {
  const list = $("#libraryList");
  const empty = $("#libraryEmpty");
  if (!list) return;
  const query = libraryQuery.toLowerCase();
  const books = state.books.filter((book) => {
    if (!query) return true;
    return `${book.title} ${book.author || ""}`.toLowerCase().includes(query);
  });
  list.replaceChildren();
  if (!state.books.length) {
    empty.hidden = false;
    $("#libraryLead").textContent = "扫描过的书页会自动归到书名下。";
    return;
  }
  empty.hidden = true;
  $("#libraryLead").textContent = `共 ${state.books.length} 本书，按最近阅读排序。`;
  if (!books.length) {
    list.append(
      el(
        "div",
        { class: "empty-state" },
        el("h2", { text: "没有找到这本书" }),
        el("p", { text: "换个书名或作者再试试。" })
      )
    );
    return;
  }
  for (const book of books) {
    list.append(bookCard(book));
  }
}

function bookCard(book) {
  const cover = el("span", {
    class: "cover",
    dataset: { color: book.color || "jade" },
    "aria-hidden": "true",
    text: coverLetter(book.title),
  });
  const info = el(
    "div",
    { class: "book-info" },
    el("strong", { text: book.title }),
    book.author ? el("span", { class: "book-author", text: book.author }) : null,
    el(
      "div",
      { class: "book-meta" },
      el("span", { text: `${book.page_count || 0} 页已扫描` }),
      el("span", { text: `${book.note_count || 0} 条批注` }),
      book.last_page ? el("span", { text: `上次第 ${book.last_page} 页` }) : null
    ),
    book.demo ? el("span", { class: "book-tag", text: "演示书籍" }) : null
  );
  const actions = el(
    "div",
    { class: "book-actions" },
    el(
      "button",
      {
        class: "btn btn--primary",
        type: "button",
        text: book.page_count ? "继续阅读" : "开始扫描",
        onclick: (event) => {
          event.stopPropagation();
          if (book.page_count) openReading(book.id, book.last_page || 1, book.last_line || 0, { speak: false });
          else openScan(book.id, 1, { autoCamera: true });
        },
      }
    ),
    el(
      "button",
      {
        class: "btn btn--secondary",
        type: "button",
        text: "扫描新页",
        onclick: (event) => {
          event.stopPropagation();
          openScan(book.id, (Number(book.last_page) || 0) + 1, { autoCamera: true });
        },
      }
    )
  );
  const subActions = el(
    "div",
    { class: "book-subactions" },
    el("button", {
      class: "btn btn--ghost",
      type: "button",
      text: "改名",
      "aria-label": `重命名《${book.title}》`,
      onclick: (event) => {
        event.stopPropagation();
        void renameBook(book);
      },
    }),
    el("button", {
      class: "btn btn--ghost btn--danger",
      type: "button",
      text: "删除",
      "aria-label": `删除《${book.title}》`,
      onclick: (event) => {
        event.stopPropagation();
        void removeBook(book);
      },
    })
  );
  actions.append(subActions);
  return el("article", { class: "book-card" }, cover, info, actions);
}

async function renameBook(book) {
  const field = el("input", {
    type: "text",
    value: book.title,
    maxlength: "120",
    "aria-label": "新书名",
    autocomplete: "off",
  });
  const body = el("div", { class: "dialog-fields" }, el("label", {}, "书名", input));
  const value = await openDialog({
    title: "重命名这本书",
    body,
    confirmText: "保存",
    getValue: () => field.value.trim(),
  });
  if (!value || value === book.title) return;
  try {
    await api.updateBook(book.id, { title: value });
    await refreshBook(book.id);
    void storeRefreshNotes();
    toast("书名已更新。");
    renderLibrary();
  } catch (error) {
    handleActionError(error, "重命名书籍");
  }
}

async function removeBook(book) {
  const ok = await confirmDialog(
    "删除这本书？",
    `《${book.title}》的 ${book.page_count || 0} 页扫描文字和 ${book.note_count || 0} 条批注都会删除，无法恢复。`,
    { confirmText: "删除", tone: "danger" }
  );
  if (!ok) return;
  try {
    await deleteBook(book.id);
    toast("已删除这本书。");
    renderLibrary();
    if (state.current?.bookId === book.id) {
      clearCurrent();
      if (currentRoute === "reading") navigate("welcome");
    }
  } catch (error) {
    handleActionError(error, "删除书籍");
  }
}

async function addBookDialog() {
  const title = el("input", {
    type: "text",
    placeholder: "例如：瓦尔登湖",
    maxlength: "120",
    "aria-label": "书名",
    autocomplete: "off",
  });
  const author = el("input", {
    type: "text",
    placeholder: "作者（可选）",
    maxlength: "80",
    "aria-label": "作者",
    autocomplete: "off",
  });
  const body = el(
    "div",
    { class: "dialog-fields" },
    el("label", {}, "书名", title),
    el("label", {}, "作者", author)
  );
  const value = await openDialog({
    title: "添加一本书",
    body,
    confirmText: "添加",
    getValue: () => ({ title: title.value.trim(), author: author.value.trim() }),
  });
  if (!value) return;
  if (!value.title) {
    toast("书名不能为空。", { tone: "warn" });
    return;
  }
  try {
    const book = await createBook(value.title, value.author);
    toast(`已添加《${book.title}》。`);
    renderLibrary();
  } catch (error) {
    handleActionError(error, "添加书籍");
  }
}

/* -------------------------------------------------------------------------- */
/* 引导与扫描                                                                  */
/* -------------------------------------------------------------------------- */

function speakGuide() {
  const text =
    "请把手机固定好，镜头朝下，让整页书进入画面。放书和翻页由你完成。准备好了，就按“我已摆好，开始检查”，或者说“好了”。";
  const status = $("#setupStatus");
  if (status) status.textContent = "我在等你";
  const line = $("#setupLine");
  if (line) line.textContent = "摆好书后，按下面的按钮，或说“好了”。";
  void voice.speak(text, { interrupt: true }).then((ok) => {
    if (ok) maybeAutoListen(() => openCameraFromSetup());
  });
}

function maybeAutoListen(onYes) {
  if (!state.settings.always_listen || voice.screenReaderMode() || !voice.recognitionSupported()) return;
  clearTimeout(autoListenTimer);
  autoListenTimer = setTimeout(async () => {
    if (listening || currentRoute !== "setup") return;
    try {
      const { transcript } = await voice.listen({ timeout: 7000 });
      if (currentRoute !== "setup") return;
      const command = voice.parseCommand(transcript);
      if (command && (command.intent === "yes" || command.intent === "scan")) {
        onYes();
        return;
      }
      if (command?.intent === "repeat") speakGuide();
    } catch {
      /* 自动聆听失败时静默，按钮始终可用 */
    }
  }, 1200);
}

function openCameraFromSetup() {
  const book = findBook(state.current?.bookId);
  const useCurrent = Boolean(book && !book.demo);
  const page = useCurrent ? Number(state.current.pageNumber) + 1 : null;
  openScan(useCurrent ? state.current.bookId : null, page, { autoCamera: true });
}

function openScan(bookId = null, pageNumber = null, { autoCamera = false } = {}) {
  scanIntent = { bookId, pageNumber, autoCamera };
  navigate("scan");
}

function prepareScanForm() {
  const select = $("#bookSelect");
  if (!select) return;
  const currentValue = scanIntent?.bookId || localStorage.getItem(LAST_BOOK_KEY) || "";
  select.replaceChildren();
  select.append(el("option", { value: "", text: "＋ 新建一本书" }));
  for (const book of state.books) {
    select.append(el("option", { value: book.id, text: book.title }));
  }
  const exists = state.books.some((book) => book.id === currentValue);
  select.value = exists ? currentValue : "";
  toggleNewBookFields();

  const prefs = loadScanPrefs();
  const rotation = $("#rotationSelect");
  if (rotation) rotation.value = String(prefs.rotation || 0);
  setLayout(prefs.layout || "none", {silent: true});

  const book = exists ? findBook(select.value) : null;
  const defaultPage = scanIntent?.pageNumber || (book ? (Number(book.last_page) || 0) + 1 : 1);
  const page = $("#pageNumber");
  if (page) page.value = String(Math.max(1, defaultPage));
  updateScanCameraLabel();
  updateScanSettingsSummary();
  setScanStatus("等待拍照或选择照片", { percent: 0 });
  const message = $("#cameraMessage");
  if (message) message.textContent = "照片只在本机识别，不会上传云端。";

  if (!cameraStream && !capturedBlob) {
    $("#cameraPlaceholder")?.classList.remove("is-off");
  }
}

function toggleNewBookFields() {
  const select = $("#bookSelect");
  const fields = $("#newBookFields");
  if (!select || !fields) return;
  const isNew = !select.value;
  fields.hidden = !isNew;
  updateScanSettingsSummary();
  if (isNew) {
    const title = $("#newBookTitle");
    if (title && !title.value && state.books.length === 0) title.focus({ preventScroll: true });
  }
}

function loadScanPrefs() {
  try {
    return JSON.parse(localStorage.getItem(SCAN_PREFS_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function saveScanPrefs(patch) {
  const prefs = { ...loadScanPrefs(), ...patch };
  try {
    localStorage.setItem(SCAN_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* 忽略 */
  }
}

function setLayout(layout, { silent = false } = {}) {
  const group = $("#layoutGroup");
  if (!group) return;
  for (const button of group.querySelectorAll("button")) {
    button.setAttribute("aria-checked", String(button.dataset.value === layout));
  }
  saveScanPrefs({ layout });
  updateScanCameraLabel();
  updateSplitField();
  updateScanSettingsSummary();
  if (!silent) {
    const labels = { none: "单页", pages: "左右双页", columns: "左右双栏" };
    toast(`布局：${labels[layout] || layout}`, { duration: 1500 });
  }
}

function updateSplitField() {
  const group = $("#layoutGroup");
  const layout = group?.querySelector('button[aria-checked="true"]')?.dataset.value || "none";
  const field = $("#splitField");
  if (field) field.hidden = layout === "none";
  const range = $("#splitPosition");
  if (range) range.value = String(loadScanPrefs().splitPosition ?? range.value ?? 0.5);
  updateSplitOutput();
}

function updateSplitOutput() {
  const range = $("#splitPosition");
  const output = $("#splitValue");
  if (range && output) output.textContent = `${Math.round(Number(range.value) * 100)}%`;
}

function updateScanCameraLabel() {
  const group = $("#layoutGroup");
  const selected = group?.querySelector('button[aria-checked="true"]')?.dataset.value || "none";
  const labels = { none: "单页模式", pages: "双页模式", columns: "双栏模式" };
  const mode = $("#cameraMode");
  if (mode) mode.textContent = labels[selected] || "单页模式";
}

function updateScanSettingsSummary() {
  const target = $("#scanSettingsSummary");
  if (!target) return;
  const select = $("#bookSelect");
  const book = select?.value ? findBook(select.value) : null;
  const title = book?.title || $("#newBookTitle")?.value.trim() || "新建书籍";
  const page = Math.max(1, Number($("#pageNumber")?.value) || 1);
  const layout = $("#layoutGroup")?.querySelector('button[aria-checked="true"]')?.dataset.value || "none";
  const labels = { none: "单页", pages: "左右双页", columns: "左右双栏" };
  target.textContent = `${title} · 第 ${page} 页 · ${labels[layout] || "单页"}`;
}

function setScanStatus(text, { percent = null, busy = false, error = false } = {}) {
  const card = $("#scanStatusCard");
  const textEl = $("#scanStatusText");
  const percentEl = $("#scanStatusPercent");
  const bar = $("#scanProgress");
  if (card) {
    card.classList.toggle("is-busy", busy);
    card.classList.toggle("is-error", error);
  }
  if (textEl) textEl.textContent = text;
  if (percentEl) percentEl.textContent = percent === null ? "" : `${Math.round(percent)}%`;
  if (bar && percent !== null) bar.style.width = `${clamp(percent, 0, 100)}%`;
  if (bar && percent === null && !busy) bar.style.width = "0%";
}

function setScanMessage(text) {
  const message = $("#cameraMessage");
  if (message) message.textContent = text;
}

async function startCamera() {
  if (cameraStream) return true;
  if (!window.isSecureContext) {
    const message =
      "相机只能在 HTTPS 下使用。手机请用电脑上的「启动手机测试.bat」打开纸伴，第一次先安装本机证书；也可以先用「从相册选择照片」扫描书页。";
    setScanStatus("相机需要 HTTPS", { error: true });
    setScanMessage(`${message}（当前地址：${location.origin}）`);
    announce(message);
    return false;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    const message = "这个浏览器没有开放相机接口。可以用“从相册选择照片”。";
    setScanStatus("相机不可用", { error: true });
    setScanMessage(message);
    announce(message);
    return false;
  }
  setScanStatus("正在请求相机…", { busy: true });
  setScanMessage("第一次使用时，浏览器会询问相机权限。");
  try {
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 2560 },
        height: { ideal: 1440 },
      },
    };
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      if (["OverconstrainedError", "NotFoundError", "NotReadableError"].includes(error.name)) {
        cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } else {
        throw error;
      }
    }
    const video = $("#camera");
    video.srcObject = cameraStream;
    video.hidden = false;
    $("#photoPreview").hidden = true;
    $("#cameraPlaceholder")?.classList.add("is-off");
    await video.play();
    await detectTorch();
    setScanStatus("相机已开启，可以拍照", { percent: 0 });
    setScanMessage("让书页占满取景框，保持稳定，然后按“拍照并识别”。");
    startCameraQualityMonitor();
    return true;
  } catch (error) {
    stopCamera();
    const message = cameraErrorMessage(error);
    setScanStatus("相机没有画面", { error: true });
    setScanMessage(`${message} 也可以从相册选择书页照片。`);
    announce(message);
    return false;
  }
}

function cameraErrorMessage(error) {
  switch (error?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "相机权限被拒绝。请在浏览器地址栏的权限设置里允许相机，然后刷新页面。";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "没有找到可用的相机。可以改用相册里的书页照片。";
    case "NotReadableError":
    case "TrackStartError":
      return "相机被其他应用占用。请关掉相机应用后重试。";
    case "OverconstrainedError":
      return "这个相机不支持所需分辨率，请换一个相机或从相册选择。";
    default:
      return `相机没有画面：${error?.message || "未知原因"}。`;
  }
}

function stopCamera() {
  if (cameraQualityTimer) {
    clearInterval(cameraQualityTimer);
    cameraQualityTimer = null;
  }
  lastQualityMessage = null;
  if (cameraStream) {
    for (const track of cameraStream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* 忽略 */
      }
    }
    cameraStream = null;
  }
  const video = $("#camera");
  if (video) {
    video.srcObject = null;
    video.hidden = false;
  }
  const autoVideo = $("#autoCamera");
  if (autoVideo) autoVideo.srcObject = null;
  const placeholder = $("#cameraPlaceholder");
  placeholder?.classList.remove("is-off");
  torchOn = false;
  const torch = $("#torchBtn");
  if (torch) {
    torch.hidden = true;
    torch.setAttribute("aria-pressed", "false");
  }
}

async function detectTorch() {
  const torch = $("#torchBtn");
  if (!torch || !cameraStream) return;
  const track = cameraStream.getVideoTracks()[0];
  const capabilities = track?.getCapabilities?.() || {};
  torch.hidden = !capabilities.torch;
}

function startCameraQualityMonitor() {
  clearInterval(cameraQualityTimer);
  cameraQualityTimer = setInterval(() => {
    if (!cameraStream || scanBusy || currentRoute !== "scan" || capturedBlob) return;
    const video = $("#camera");
    if (!video || video.readyState < 2 || !video.videoWidth) return;
    try {
      const width = 160;
      const height = Math.max(1, Math.round((width * video.videoHeight) / video.videoWidth));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(video, 0, 0, width, height);
      const { data } = context.getImageData(0, 0, width, height);
      let sum = 0;
      let square = 0;
      const values = new Float32Array(width * height);
      for (let index = 0; index < values.length; index += 1) {
        const offset = index * 4;
        const luminance = data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
        values[index] = luminance;
        sum += luminance;
        square += luminance * luminance;
      }
      const mean = sum / values.length;
      const variance = Math.max(0, square / values.length - mean * mean);
      let message;
      if (mean < 48) {
        message = "画面偏暗：打开补光，或让光线更均匀。";
      } else if (variance < 90) {
        message = "画面有点模糊：把手机固定稳，等对焦清楚。";
      } else {
        message = "画面清楚，可以拍照。";
      }
      if (message !== lastQualityMessage) {
        lastQualityMessage = message;
        setScanMessage(message);
      }
    } catch {
      /* 某些浏览器不允许读取视频像素，静默跳过 */
    }
  }, 1600);
}

async function toggleTorch() {
  if (!cameraStream) return;
  const track = cameraStream.getVideoTracks()[0];
  if (!track) return;
  try {
    torchOn = !torchOn;
    await track.applyConstraints({ advanced: [{ torch: torchOn }] });
    $("#torchBtn").setAttribute("aria-pressed", String(torchOn));
  } catch {
    toast("这个相机不支持补光。", { tone: "warn", iconName: "info" });
  }
}

async function capturePhoto() {
  const video = $("#camera");
  if (!cameraStream || !video || video.readyState < 2 || !video.videoWidth) {
    setScanStatus("相机还没有画面", { error: true });
    setScanMessage("等画面出现后再拍，或从相册选择照片。");
    announce("相机还没有画面，请稍等，或从相册选择照片。");
    return;
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) throw new Error("照片编码失败，请重试。");
    stopCamera();
    setCapturedPhoto(blob);
    setScanStatus("照片已拍好", { percent: 0 });
    setScanMessage("确认书页完整清楚后，按“识别这张照片”；不满意可以重新拍摄。");
    announce("照片已拍好。确认后按识别这张照片。");
    vibrate(18);
  } catch (error) {
    announceError(error, "拍照");
  }
}

function setCapturedPhoto(blob) {
  capturedBlob = blob;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(blob);
  const preview = $("#photoPreview");
  preview.src = previewUrl;
  preview.hidden = false;
  $("#cameraPlaceholder")?.classList.add("is-off");
  const label = $("#captureLabel");
  if (label) label.textContent = "识别这张照片";
  const retake = $("#retakeBtn");
  if (retake) retake.hidden = false;
}

function clearCapturedPhoto() {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  capturedBlob = null;
  const preview = $("#photoPreview");
  if (preview) {
    preview.hidden = true;
    preview.removeAttribute("src");
  }
  const label = $("#captureLabel");
  if (label) label.textContent = "拍照并识别";
  const retake = $("#retakeBtn");
  if (retake) retake.hidden = true;
}

async function retakePhoto() {
  clearCapturedPhoto();
  setScanStatus("重新拍摄", { percent: 0 });
  setScanMessage("请把手机对准书页。");
  await startCamera();
}

async function resolveScanBook() {  const select = $("#bookSelect");
  const selectedId = select?.value || "";
  if (selectedId) {
    const book = findBook(selectedId);
    if (book) return book;
  }
  if (state.offline) {
    throw new Error("离线时无法新建书籍。请先连接本机服务，或从书架选择已有的书。");
  }
  const titleInput = $("#newBookTitle");
  const authorInput = $("#newBookAuthor");
  let title = titleInput?.value.trim() || "";
  const autoNamed = !title;
  if (!title) {
    title = "我的书";
    const existing = state.books.find((book) => book.title === title);
    if (existing) {
      if (select) select.value = existing.id;
      toggleNewBookFields();
      updateScanSettingsSummary();
      return existing;
    }
  }
  const book = await createBook(title, authorInput?.value.trim() || "");
  select?.append(el("option", { value: book.id, text: book.title }));
  if (select) select.value = book.id;
  toggleNewBookFields();
  updateScanSettingsSummary();
  toast(autoNamed ? "已新建《我的书》，可以在书架里改名。" : `已新建《${book.title}》。`);
  return book;
}

function loadImageSource(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法读取这张照片，请换一张。"));
    };
    image.src = url;
  });
}

async function prepareImageFile(file) {
  const limit = 7 * 1024 * 1024;
  const accepted = ["image/jpeg", "image/png", "image/webp"];
  if (!file) return file;
  if (accepted.includes(file.type || "") && file.size <= limit) return file;
  if (file.type && !file.type.startsWith("image/")) return file;
  try {
    const image = await loadImageSource(file);
    const maxSide = 2560;
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob || blob.size >= file.size) return file;
    toast("照片较大，已自动压缩后识别。", { duration: 2200 });
    const name = String(file.name || "page").replace(/\.[^.]+$/, "") || "page";
    return new File([blob], `${name}.jpg`, { type: "image/jpeg" });
  } catch {
    return file;
  }
}

async function submitScan(file) {
  if (scanBusy) return;
  if (!file) {
    setScanStatus("还没有照片", { error: true });
    announce("请先拍照，或从相册选择书页照片。");
    return;
  }
  scanBusy = true;
  const captureBtn = $("#captureBtn");
  const galleryBtn = $('[data-action="gallery"]');
  if (captureBtn) captureBtn.disabled = true;
  if (galleryBtn) galleryBtn.disabled = true;
  setScanStatus("正在准备照片…", { percent: 2, busy: true });
  setScanMessage("正在检查照片大小与格式。");
  clearTimeout(scanSlowTimer);
  scanSlowTimer = setTimeout(() => {
    if (scanBusy) setScanMessage("页面文字较多，识别可能需要十几秒，请保持页面打开。");
  }, 9000);
  try {
    file = await prepareImageFile(file);
    if (file.size > 8 * 1024 * 1024) {
      throw new Error("照片压缩后仍超过 8 MiB，请降低相机分辨率或裁剪后重试。");
    }
    setScanStatus("正在上传照片…", { percent: 4, busy: true });
    setScanMessage("正在把照片交给本机 OCR 服务。");
    announce("正在识别这张照片，请稍候。", { interrupt: false });
    const book = await resolveScanBook();
    const pageNumber = Math.max(1, Number($("#pageNumber")?.value) || 1);
    const layout = $("#layoutGroup")?.querySelector('button[aria-checked="true"]')?.dataset.value || "none";
    const rotation = Number($("#rotationSelect")?.value) || 0;
    const splitPosition = Number($("#splitPosition")?.value) || 0.5;
    localStorage.setItem(LAST_BOOK_KEY, book.id);
    const result = await api.scanPage({
      bookId: book.id,
      pageNumber,
      layout,
      rotation,
      splitPosition,
      file,
      onProgress: ({ phase, loaded, total }) => {
        if (phase === "upload" && total) {
          const percent = Math.round((loaded / total) * 40);
          setScanStatus("正在上传照片…", { percent, busy: true });
        } else if (phase === "recognize") {
          setScanStatus("正在识别文字…", { percent: 55, busy: true });
          setScanMessage("正在校正页面、分区并逐行识别。");
        }
      },
    });
    const page = result.page;
    state.server.ocr_ready = true;
    updateServerChip();
    setScanStatus(`识别完成，共 ${page.lines?.length || 0} 行`, { percent: 100 });
    try {
      await refreshBook(book.id);
    } catch (error) {
      console.warn("刷新书籍", error);
    }
    setCurrentPage(page, findBook(book.id));
    void refreshStats();
    toast(`识别完成：${page.lines?.length || 0} 行文字。`);
    announce(`识别完成，共 ${page.lines?.length || 0} 行。先确认文字，再开始阅读。`, {
      interrupt: true,
    });
    clearCapturedPhoto();
    vibrate([12, 40, 12]);
    navigate("review");
  } catch (error) {
    if (error.code === "ocr_unavailable") {
      setScanStatus("OCR 引擎不可用", { error: true });
      setScanMessage("请运行 start.ps1 安装依赖，或在设置中查看服务状态。");
    } else if (error.code === "ocr_busy") {
      setScanStatus("正在处理上一张照片", { error: true });
      setScanMessage("等几秒再试一次。");
    } else if (error.status === 413) {
      setScanStatus("照片太大了", { error: true });
      setScanMessage("照片不能超过 8 MiB，请降低相机分辨率或压缩后重试。");
    } else {
      setScanStatus("识别没有完成", { error: true });
      setScanMessage(error.message || "请调整光线、方向后重试。");
    }
    handleActionError(error, "扫描");
  } finally {
    scanBusy = false;
    clearTimeout(scanSlowTimer);
    if (captureBtn) captureBtn.disabled = false;
    if (galleryBtn) galleryBtn.disabled = false;
  }
}

/* -------------------------------------------------------------------------- */
/* 识别结果                                                                    */
/* -------------------------------------------------------------------------- */

function renderReview() {
  const current = state.current;
  if (!current?.page) {
    if (currentRoute === "review") navigate("welcome");
    return;
  }
  const page = current.page;
  const book = findBook(current.bookId);
  $("#reviewLead").textContent = `《${current.bookTitle}》第 ${current.pageNumber} 页，共 ${
    page.lines?.length || 0
  } 行。确认文字是否清楚，再开始阅读。`;
  $("#reviewBook").textContent = current.bookTitle;
  $("#reviewPage").textContent = `第 ${current.pageNumber} 页`;
  $("#reviewLines").textContent = `${page.lines?.length || 0} 行`;

  const confidence = Number(page.confidence) || 0;
  $("#reviewConfidence").textContent = `${Math.round(confidence * 100)}%`;
  const badge = $("#reviewBadge");
  badge.classList.remove("badge--soft", "badge--warn");
  if (confidence >= 0.85) {
    badge.textContent = "识别清晰";
  } else if (confidence >= 0.6) {
    badge.textContent = "可以阅读";
    badge.classList.add("badge--soft");
  } else {
    badge.textContent = "建议重扫";
    badge.classList.add("badge--warn");
  }

  const image = $("#reviewImage");
  const fallback = $("#reviewImageFallback");
  const url = page.rectified_url || page.thumb_url || page.image_url;
  if (url) {
    image.src = url;
    image.hidden = false;
    fallback.hidden = true;
    image.onerror = () => {
      image.hidden = true;
      fallback.hidden = false;
    };
  } else {
    image.hidden = true;
    fallback.hidden = false;
  }

  const warnings = page.warnings || [];
  const warningBox = $("#reviewWarnings");
  const warningList = $("#reviewWarningList");
  warningList.replaceChildren();
  warningBox.hidden = !warnings.length;
  for (const warning of warnings) warningList.append(el("li", { text: warning }));

  const list = $("#reviewText");
  list.replaceChildren();
  const lines = page.lines || [];
  const preview = lines.slice(0, 8);
  for (const line of preview) list.append(el("li", { text: line.text }));
  $("#previewCount").textContent = lines.length > preview.length ? `共 ${lines.length} 行，显示前 8 行` : `共 ${lines.length} 行`;

  const start = $('[data-action="start-reading"]');
  if (start) start.disabled = !lines.length;
}

async function startReadingFromReview() {
  if (!state.current?.page) return;
  const index = 0;
  setLine(index);
  pendingAutoRead = true;
  navigate("reading");
}

async function rescanCurrentPage() {
  const current = state.current;
  if (!current) return;
  openScan(current.bookId, current.pageNumber, { autoCamera: true });
}

async function deleteCurrentPage() {
  const current = state.current;
  if (!current) return;
  const ok = await confirmDialog(
    "删除这一页？",
    `《${current.bookTitle}》第 ${current.pageNumber} 页的扫描文字会删除，但不会删除批注。`,
    { confirmText: "删除", tone: "danger" }
  );
  if (!ok) return;
  try {
    await api.deletePage(current.pageId);
    try {
      await refreshBook(current.bookId);
    } catch (error) {
      console.warn("刷新书籍", error);
    }
    clearCurrent();
    toast("已删除这一页。");
    navigate("library");
  } catch (error) {
    handleActionError(error, "删除书页");
  }
}

/* -------------------------------------------------------------------------- */
/* 阅读                                                                        */
/* -------------------------------------------------------------------------- */

function readingMode() {
  const mode = state.settings.reading_mode;
  if (mode === "manual" || mode === "page" || mode === "overnight") return mode;
  return state.settings.auto_advance ? "page" : "manual";
}

function currentDisplay() {
  const current = state.current;
  if (!current?.page) return null;
  const key = `${current.pageId}|${state.settings.text_script || "simplified"}|${
    state.settings.translation_target || "off"
  }`;
  return readingDisplay?.key === key ? readingDisplay : null;
}

function currentDisplayItem(index) {
  const raw = currentLines()[index];
  const transformed = currentDisplay()?.lines?.[index];
  return {
    text: transformed?.text ?? raw?.text ?? "",
    translation: transformed?.translation || "",
  };
}

function speechTextFor(index) {
  const item = currentDisplayItem(index);
  if (state.settings.speak_translation && item.translation) return item.translation;
  return item.text;
}

async function prepareReadingText({ force = false } = {}) {
  const current = state.current;
  if (!current?.page) return;
  const raw = currentLines();
  const script = state.settings.text_script || "simplified";
  const translation = state.settings.translation_target || "off";
  const key = `${current.pageId}|${script}|${translation}`;
  readingDisplayKey = key;
  if (!force && readingDisplay?.key === key) return;
  const token = ++readingTransformToken;
  if (script === "simplified" && translation === "off") {
    readingDisplay = {
      key,
      script,
      translation,
      lines: raw.map((line) => ({ text: line.text || "", translation: null })),
      warnings: [],
    };
    return;
  }

  setReadStatus("正在准备文字", "正在转换文字版本…");
  try {
    // 先做本地繁简转换，马上显示；在线译文在后台继续准备，不阻塞阅读。
    const payload = await api.transformText(
      raw.map((line) => line.text || ""),
      { script, translation: "off" }
    );
    if (token !== readingTransformToken) return;
    const lines = (payload.lines || []).map((line, index) => ({
      text: line?.text ?? raw[index]?.text ?? "",
      translation: "",
    }));
    while (lines.length < raw.length) {
      lines.push({ text: raw[lines.length]?.text || "", translation: "" });
    }
    readingDisplay = {
      key,
      script,
      translation,
      lines,
      provider: null,
      warnings: [],
      translating: translation !== "off",
    };
    if (translation !== "off") {
      void loadReadingTranslation({ raw, script, translation, key, token });
    }
  } catch (error) {
    if (token !== readingTransformToken) return;
    readingDisplay = {
      key,
      script: "simplified",
      translation: "off",
      lines: raw.map((line) => ({ text: line.text || "", translation: null })),
      error: true,
    };
    const message = error?.payload?.error || "文字转换暂时不可用，先显示原文。";
    toast(message, { tone: "warn", iconName: "info", duration: 4200 });
  }
}

async function loadReadingTranslation({ raw, script, translation, key, token }) {
  try {
    const payload = await api.transformText(
      raw.map((line) => line.text || ""),
      { script, translation }
    );
    if (token !== readingTransformToken || readingDisplay?.key !== key) return;
    const lines = (payload.lines || []).map((line, index) => ({
      text: line?.text ?? raw[index]?.text ?? "",
      translation: line?.translation || "",
    }));
    while (lines.length < raw.length) {
      lines.push({ text: raw[lines.length]?.text || "", translation: "" });
    }
    readingDisplay = {
      ...readingDisplay,
      lines,
      provider: payload.provider,
      warnings: payload.warnings || [],
      translating: false,
    };
    if (currentRoute === "reading" && state.current?.page) {
      renderReading();
      updateReadingUI();
      if (!speechPlaying) {
        setReadStatus(
          "译文已准备好",
          state.settings.speak_translation
            ? "按朗读会读译文。"
            : "原文下方已显示译文，可按朗读继续。"
        );
      }
    }
    if (payload.warnings?.length) {
      toast(payload.warnings[0], { tone: "warn", iconName: "info", duration: 3600 });
    }
  } catch (error) {
    if (token !== readingTransformToken || readingDisplay?.key !== key) return;
    readingDisplay = { ...readingDisplay, translating: false };
    const message = error?.payload?.error || "在线译文暂时不可用，先显示原文。";
    toast(message, { tone: "warn", iconName: "info", duration: 4200 });
    if (currentRoute === "reading" && !speechPlaying) {
      setReadStatus("译文暂时不可用", "仍可阅读原文，或稍后在设置中重试。");
    }
  }
}

async function enterReading() {
  if (!state.current?.page) {
    const session = state.session;
    if (!session) {
      navigate("welcome");
      return;
    }
    try {
      const current = await openPage(session.bookId, session.pageNumber, session.lineIndex);
      if (!current) {
        toast("上次读的那一页已经不在了，请重新扫描。", { tone: "warn", iconName: "info" });
        navigate("welcome");
        return;
      }
    } catch (error) {
      handleActionError(error, "打开上次阅读");
      navigate("welcome");
      return;
    }
  }
  await prepareReadingText();
  renderReading();
  beginReadingSession();
  if (pendingAutoRead) {
    pendingAutoRead = false;
    setTimeout(() => {
      if (currentRoute === "reading" && !speechPlaying) void speakCurrent();
    }, 350);
  } else {
    const lines = currentLines();
    setReadStatus(
      "准备朗读",
      `第 ${(state.current?.lineIndex || 0) + 1} 行，共 ${lines.length} 行。按朗读，或直接点一行。`
    );
  }
}

function renderReading() {
  const current = state.current;
  if (!current?.page) return;
  const lines = currentLines();
  current.lineIndex = clamp(current.lineIndex, 0, Math.max(0, lines.length - 1));
  const book = findBook(current.bookId);
  const pageNumbers = (book?.pages || []).map((page) => Number(page.page_number)).filter(Boolean);
  const hasPages = pageNumbers.length > 0;
  const isDemo = Boolean(current.page.demo || current.page.book_demo || book?.demo);

  $("#readingBook").textContent = current.bookTitle || book?.title || "未命名书籍";
  $("#readingPage").textContent = `第 ${current.pageNumber} 页`;
  $("#readingLineLabel").textContent = `第 ${current.lineIndex + 1} / ${Math.max(1, lines.length)} 行`;
  $("#readingSource").textContent = isDemo ? "演示内容" : "扫描文字";
  $("#readingSource").classList.toggle("badge--soft", isDemo);
  $("#readLine").textContent = `第 ${current.lineIndex + 1} 行，共 ${lines.length} 行。点一行文字，或按朗读。`;
  $("#speedValue").textContent = formatRate(state.settings.voice_rate);
  const modeBadge = $("#textModeBadge");
  if (modeBadge) {
    const labels = [];
    if ((state.settings.text_script || "simplified") === "traditional") labels.push("繁体");
    if ((state.settings.translation_target || "off") !== "off") labels.push("译文");
    modeBadge.hidden = labels.length === 0;
    modeBadge.textContent = labels.join(" · ");
  }

  const text = $("#readingText");
  text.replaceChildren();
  text.classList.toggle("is-empty", lines.length === 0);
  if (!lines.length) {
    text.append(
      el(
        "p",
        { class: "empty-reading" },
        "这一页还没有文字。可以重新扫描，或扫描下一页。"
      )
    );
  } else {
    lines.forEach((line, index) => {
      const item = currentDisplayItem(index);
      const label = item.translation
        ? `第 ${index + 1} 行：${item.text || "空白行"}。译文：${item.translation}`
        : `第 ${index + 1} 行：${item.text || "空白行"}`;
      const node = el(
        "p",
        {
          class: "reading-line",
          tabindex: "0",
          role: "button",
          "aria-label": label,
          dataset: { index: String(index) },
        },
        el("span", { class: "line-text", text: item.text || "（空白行）" })
      );
      if (item.translation) {
        node.append(
          el("span", {
            class: "line-translation",
            lang: state.settings.translation_target === "en" ? "en" : "zh-CN",
            text: item.translation,
          })
        );
      }
      if (!item.text) node.classList.add("is-empty");
      node.addEventListener("click", () => jumpToLine(index));
      node.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          jumpToLine(index);
        }
      });
      text.append(node);
    });
  }

  const translationCard = $("#pageTranslation");
  if (translationCard) {
    const hasBlock = Boolean(readingDisplay?.blockTranslation);
    translationCard.hidden = !hasBlock;
    const translationText = $("#pageTranslationText");
    if (translationText) translationText.textContent = readingDisplay?.blockTranslation || "";
  }

  $("#prevPageBtn").disabled = !hasPages && current.pageNumber <= 1;
  $("#nextPageBtn").disabled = !hasPages && isDemo;
  updateReadingUI();
  updatePlaybackUI();
}

function updateReadingUI() {
  const current = state.current;
  if (!current) return;
  const lines = currentLines();
  const total = Math.max(1, lines.length);
  const index = current.lineIndex;
  const nodes = $$("#readingText .reading-line");
  nodes.forEach((node, i) => {
    node.classList.toggle("is-current", i === index);
    node.classList.toggle("is-read", i < index);
    if (i === index) node.setAttribute("aria-current", "true");
    else node.removeAttribute("aria-current");
  });
  $("#readingLineLabel").textContent = `第 ${index + 1} / ${total} 行`;
  const progress = ((index + 1) / total) * 100;
  const bar = $("#readingProgress");
  if (bar) bar.style.width = `${progress}%`;
  const currentText = currentDisplayItem(index);
  const spokenText =
    state.settings.speak_translation && currentText.translation
      ? currentText.translation
      : currentText.text;
  setReadStatus(
    speechPlaying ? (speechPaused ? "已暂停" : "正在朗读") : "准备朗读",
    spokenText ? `第 ${index + 1} 行：${spokenText}` : "这一行没有文字。"
  );
  scrollLineIntoView(nodes[index]);
  syncNowPlaying();
}

function scrollLineIntoView(node) {
  const container = $("#readingText");
  if (!container || !node) return;
  const nodeRect = node.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const delta =
    nodeRect.top - containerRect.top - container.clientHeight / 2 + nodeRect.height / 2;
  const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  try {
    container.scrollTo({ top: Math.max(0, container.scrollTop + delta), behavior });
  } catch {
    container.scrollTop += delta;
  }
}

function updatePlaybackUI() {
  const button = $("#playBtn");
  const label = $("#playLabel");
  const use = $("#playIcon use");
  if (!button) return;
  button.classList.toggle("is-playing", speechPlaying && !speechPaused);
  if (speechPlaying && !speechPaused) {
    if (label) label.textContent = "暂停";
    button.setAttribute("aria-label", "暂停朗读");
    use?.setAttribute("href", "#i-pause");
  } else if (speechPaused) {
    if (label) label.textContent = "继续";
    button.setAttribute("aria-label", "继续朗读");
    use?.setAttribute("href", "#i-play");
  } else {
    if (label) label.textContent = "朗读";
    button.setAttribute("aria-label", "开始朗读当前行");
    use?.setAttribute("href", "#i-play");
  }
}

function formatRate(value) {
  return `${Number(value || 1).toFixed(1)}×`;
}

async function speakCurrent({ automatic = false } = {}) {
  if (!state.current?.page) return;
  const lines = currentLines();
  const index = state.current.lineIndex;
  const item = currentDisplayItem(index);
  const spoken = speechTextFor(index);
  if (!item.text || !spoken) {
    setReadStatus("这一行没有文字", "可以跳到下一行，或重新扫描这一页。");
    announce("这一行没有文字，可以按下一行。");
    return;
  }
  clearTimeout(autoTimer);
  const total = lines.length;
  const mode = readingMode();
  if (readingSession) readingSession.lines += 1;
  const lang =
    state.settings.speak_translation && state.settings.translation_target === "en"
      ? "en-US"
      : "zh-CN";

  if (voice.screenReaderMode()) {
    setReadStatus("读屏播报", `第 ${index + 1} 行：${spoken}`);
    screenReaderSay(`第 ${index + 1} 行。${spoken}`);
    if (mode !== "manual" && index < total - 1) {
      const delay = clamp(Number(state.settings.auto_advance_delay) || 2.5, 0.5, 20);
      autoTimer = setTimeout(() => {
        if (currentRoute === "reading") moveLine(1, { read: true });
      }, delay * 1000);
    } else if (mode === "overnight" && index >= total - 1) {
      autoTimer = setTimeout(() => void continueOvernight(), 900);
    }
    return;
  }

  const token = ++playToken;
  speechPlaying = true;
  speechPaused = false;
  updatePlaybackUI();
  input.setPlaying(true);
  syncNowPlaying();
  setReadStatus("正在朗读", `第 ${index + 1} 行：${spoken}`);
  let ok = false;
  try {
    ok = await voice.speak(spoken, {
      interrupt: true,
      rate: state.settings.voice_rate,
      pitch: state.settings.voice_pitch,
      lang,
    });
  } catch (error) {
    console.warn("speech", error);
  }
  if (token !== playToken) return;
  speechPlaying = false;
  speechPaused = false;
  updatePlaybackUI();
  input.setPlaying(false);
  if (!ok) {
    setReadStatus("朗读没有开始", `第 ${index + 1} 行：${spoken}。可以检查系统语音，或直接点按文字。`);
    return;
  }
  const delay = clamp(Number(state.settings.auto_advance_delay) || 2.5, 0.5, 20);
  if (mode !== "manual" && index < total - 1) {
    setReadStatus("本行读完", "稍后自动读下一行。");
    autoTimer = setTimeout(() => {
      if (currentRoute === "reading" && !speechPlaying) moveLine(1, { read: true });
    }, delay * 1000);
  } else if (index >= total - 1) {
    if (mode === "overnight") {
      setReadStatus("本页读完", "整夜阅读继续到下一页。");
      autoTimer = setTimeout(() => void continueOvernight(), 1200);
    } else {
      setReadStatus("这一页读完了", "可以扫描下一页，或回到书架。");
      announce("这一页读完了。可以扫描下一页，或回到书架。");
    }
  } else {
    setReadStatus("本行读完", "按下一行继续，或切换整页/整夜阅读模式。");
  }
}

async function continueOvernight() {
  if (currentRoute !== "reading" || !state.current) return;
  const target = adjacentPage(1);
  const book = findBook(state.current.bookId);
  const exists = (book?.pages || []).some((page) => Number(page.page_number) === target);
  if (!target || !exists) {
    setReadStatus("整夜阅读结束", "没有更多已扫描的书页。可以扫描下一页，或休息。");
    announce("整夜阅读结束，没有更多已扫描的书页。");
    return;
  }
  await openReading(state.current.bookId, target, 0, { speak: true });
}

/** 立即保存进度；来电、切后台或关闭页面前调用。 */
function persistProgressNow() {
  flushProgress();
  const payload = currentProgressPayload();
  if (!payload || !state.backend) return;
  const token = localStorage.getItem("paperpal.token");
  if (token) {
    try {
      fetch("/api/v1/progress", {
        method: "POST",        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {});
    } catch {
      /* 忽略 */
    }
    return;
  }
  if (!navigator.sendBeacon) return;
  try {
    navigator.sendBeacon(
      "/api/v1/progress",
      new Blob([JSON.stringify(payload)], { type: "application/json" })
    );
  } catch {
    /* 忽略 */
  }
}

async function releaseWakeLock() {
  if (!wakeLock) return;
  try {
    await wakeLock.release();
  } catch {
    /* 忽略 */
  }
  wakeLock = null;
}

async function syncWakeLock() {
  if (!navigator.wakeLock?.request) return;
  const want =
    currentRoute === "reading" &&
    !document.hidden &&
    (readingMode() === "overnight" || Boolean(state.settings.keep_screen_awake));
  if (!want) {
    await releaseWakeLock();
    return;
  }
  if (wakeLock && !wakeLock.released) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch {
    wakeLock = null;
  }
}

function togglePlay() {
  if (!state.current?.page) return;
  if (speechPaused) {
    if (voice.resumeSpeech()) {
      speechPaused = false;
      updatePlaybackUI();
      setReadStatus("正在朗读");
      input.setPlaying(true);
    }
    return;
  }
  if (speechPlaying) {
    if (voice.pauseSpeech()) {
      speechPaused = true;
      updatePlaybackUI();
      setReadStatus("已暂停", "按继续，或说“继续”。");
      input.setPlaying(false);
    }
    return;
  }
  void speakCurrent();
}

function stopSpeech() {
  playToken += 1;
  voice.stop();
  speechPlaying = false;
  speechPaused = false;
  clearTimeout(autoTimer);
  updatePlaybackUI();
  input.setPlaying(false);
}

/** 把当前书 / 页 / 行同步到锁屏与蓝牙耳机控制中心。 */
function syncNowPlaying() {
  if (!state.current?.page) return;
  const lines = currentLines();
  const index = state.current.lineIndex;
  const total = Math.max(1, lines.length);
  const book = findBook(state.current.bookId);
  input.setNowPlaying({
    title: `${book?.title || state.current.bookTitle || "纸伴"} · 第 ${state.current.pageNumber} 页`,
    artist: `第 ${index + 1} / ${total} 行`,
    album: "纸伴 PaperPal",
    position: index,
    duration: total,
  });
}

function jumpToLine(index) {
  if (!state.current) return;
  stopSpeech();
  setLine(index);
  updateReadingUI();
  void speakCurrent();
}

function moveLine(delta, { read = true } = {}) {
  if (!state.current) return;
  const lines = currentLines();
  if (!lines.length) return;
  const next = state.current.lineIndex + delta;
  if (next < 0) {
    announce("已经是这一页的第一行。");
    return;
  }
  if (next >= lines.length) {
    if (delta > 0) {
      announce("这一页最后一行已经读完。可以扫描下一页。");
    }
    return;
  }
  stopSpeech();
  setLine(next);
  updateReadingUI();
  if (read) void speakCurrent();
  else setReadStatus("已定位", `第 ${next + 1} 行。`);
}

async function openReading(bookId, pageNumber, lineIndex = 0, { speak = false } = {}) {
  try {
    const current = await openPage(bookId, pageNumber, lineIndex);
    if (!current) {
      toast(`第 ${pageNumber} 页还没有扫描。`, { tone: "warn", iconName: "info" });
      openScan(bookId, pageNumber, { autoCamera: true });
      return false;
    }
    if (currentRoute !== "reading") {
      pendingAutoRead = speak;
      navigate("reading");
    } else {
      await prepareReadingText();
      renderReading();
      beginReadingSession();
      if (speak) void speakCurrent();
    }
    return true;
  } catch (error) {
    handleActionError(error, "打开书页");
    return false;
  }
}

function adjacentPage(delta) {
  const current = state.current;
  if (!current) return null;
  const book = findBook(current.bookId);
  const numbers = (book?.pages || [])
    .map((page) => Number(page.page_number))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (!numbers.length) return Math.max(1, current.pageNumber + delta);
  if (delta > 0) {
    return numbers.find((number) => number > current.pageNumber) ?? current.pageNumber + 1;
  }
  return [...numbers].reverse().find((number) => number < current.pageNumber) ?? Math.max(1, current.pageNumber - 1);
}

async function goToAdjacentPage(delta) {
  const target = adjacentPage(delta);
  if (!target || target === state.current?.pageNumber) return;
  const book = findBook(state.current.bookId);
  const exists = (book?.pages || []).some((page) => Number(page.page_number) === target);
  if (!exists) {
    toast(`第 ${target} 页还没有扫描。`, { tone: "warn", iconName: "info" });
    openScan(state.current.bookId, target, { autoCamera: true });
    return;
  }
  await openReading(state.current.bookId, target, 0, { speak: false });
}

function beginReadingSession() {
  if (!state.current) return;
  if (
    readingSession &&
    readingSession.bookId === state.current.bookId &&
    readingSession.pageNumber === state.current.pageNumber
  ) {
    return;
  }
  flushReadingSession(true);
  readingSession = {
    start: Date.now(),
    lines: 0,
    bookId: state.current.bookId,
    pageNumber: state.current.pageNumber,
    timer: null,
  };
  readingSession.timer = setInterval(() => flushReadingSession(false), 30000);
}

function flushReadingSession(final = false) {
  if (!readingSession) return;
  const seconds = Math.round((Date.now() - readingSession.start) / 1000);
  const lines = readingSession.lines;
  if (seconds > 2 || lines > 0) {
    void recordActivity({
      kind: "read",
      book_id: readingSession.bookId,
      page_number: readingSession.pageNumber,
      seconds: Math.min(seconds, 3600),
      lines,
    });
  }
  readingSession.start = Date.now();
  readingSession.lines = 0;
  if (final) {
    clearInterval(readingSession.timer);
    readingSession = null;
  }
}

/* -------------------------------------------------------------------------- */
/* 批注                                                                        */
/* -------------------------------------------------------------------------- */

function openAnnotate({ note = null, append = false } = {}) {
  if (note) {
    annotation = {
      noteId: note.id,
      append,
      bookId: note.book_id,
      bookTitle: note.book_title,
      pageId: note.page_id,
      pageNumber: note.page_number,
      lineNumber: note.line_number || 1,
      scope: note.scope,
      returnTo: currentRoute === "notes" ? "notes" : "reading",
    };
    annotationInitial = append ? `${note.text}\n` : note.text;
  } else {
    if (!state.current?.page) {
      toast("先打开一页书，再添加批注。", { tone: "warn" });
      return;
    }
    annotation = {
      noteId: null,
      append: false,
      bookId: state.current.bookId,
      bookTitle: state.current.bookTitle,
      pageId: state.current.pageId,
      pageNumber: state.current.pageNumber,
      lineNumber: state.current.lineIndex + 1,
      scope: "line",
      returnTo: "reading",
    };
    annotationInitial = "";
  }
  const text = $("#annotationText");
  if (text) text.value = annotationInitial;
  renderAnnotate();
  navigate("annotate");
  updateCharCount();
}

function renderAnnotate() {
  if (!annotation) return;
  const title = $("#annotateTitle");
  const context = $("#annotateContext");
  if (title) {
    title.textContent = annotation.noteId
      ? annotation.append
        ? "补充这条批注"
        : "编辑这条批注"
      : "记下你的想法";
  }
  if (context) {
    context.textContent = `《${annotation.bookTitle}》 · 第 ${annotation.pageNumber} 页 · ${
      annotation.scope === "page" ? "整页" : `第 ${annotation.lineNumber} 行`
    }`;
  }
  $$("#scopeGroup button").forEach((button) => {
    button.setAttribute("aria-checked", String(button.dataset.value === annotation.scope));
  });
  const status = $("#recordStatus");
  const hint = $("#recordHint");
  if (status) status.textContent = "准备聆听";
  if (hint) {
    hint.textContent = annotation.noteId
      ? "可以直接修改文字，或按“开始说话”重新说一遍。"
      : "按“开始说话”说出批注，也可以直接打字。";
  }
  updateCharCount();
}

function setAnnotationScope(scope) {
  if (!annotation) return;
  annotation.scope = scope;
  $$("#scopeGroup button").forEach((button) => {
    button.setAttribute("aria-checked", String(button.dataset.value === scope));
  });
  const context = $("#annotateContext");
  if (context) {
    context.textContent = `《${annotation.bookTitle}》 · 第 ${annotation.pageNumber} 页 · ${
      scope === "page" ? "整页" : `第 ${annotation.lineNumber} 行`
    }`;
  }
  toast(scope === "page" ? "批注范围：整页" : `批注范围：第 ${annotation.lineNumber} 行`, {
    duration: 1600,
  });
}

function updateCharCount() {
  const text = $("#annotationText");
  const count = $("#charCount");
  if (text && count) count.textContent = `${text.value.length} / 4000`;
}

async function startNoteDictation() {
  if (dictating) return;
  if (!voice.recognitionSupported()) {
    toast("这个浏览器不支持语音识别，可以直接打字。", { tone: "warn", iconName: "info" });
    $("#annotationText")?.focus();
    return;
  }
  voice.stop();
  stopSpeech();
  dictating = true;
  const button = $('[data-action="listen-note"]');
  const label = $("#listenNoteLabel");
  const status = $("#recordStatus");
  const hint = $("#recordHint");
  button?.classList.add("is-listening");
  if (label) label.textContent = "正在聆听…";
  if (status) status.textContent = "正在聆听";
  if (hint) hint.textContent = "请说出批注内容，说完后会自动填入。";
  const textarea = $("#annotationText");
  try {
    const { transcript } = await voice.listen({
      interim: true,
      timeout: 20000,
      onInterim: (partial) => {
        if (!textarea) return;
        textarea.value = partial;
        updateCharCount();
      },
    });
    if (textarea) {
      textarea.value = transcript;
      updateCharCount();
      textarea.focus({ preventScroll: true });
    }
    if (status) status.textContent = "已听到内容";
    if (hint) hint.textContent = "确认内容无误后，按“确认并保存”。";
    vibrate(12);
  } catch (error) {
    if (status) status.textContent = "没有听清";
    if (hint) hint.textContent = "可以再试一次，或直接输入批注。";
    toast(error.message || "没有听清，请再试一次。", { tone: "warn", iconName: "mic" });
    if (error.code === "unsupported") textarea?.focus();
  } finally {
    dictating = false;
    button?.classList.remove("is-listening");
    if (label) label.textContent = "开始说话";
  }
}

async function saveAnnotation() {
  if (!annotation) return;
  const textarea = $("#annotationText");
  const text = textarea?.value.trim() || "";
  if (!text) {
    toast("请先说出或输入批注内容。", { tone: "warn" });
    textarea?.focus();
    return;
  }
  const scope = annotation.scope;
  const range = scope === "page" ? `第 ${annotation.pageNumber} 页整页` : `第 ${annotation.pageNumber} 页第 ${annotation.lineNumber} 行`;
  const readback = `将保存到《${annotation.bookTitle}》，${range}。内容：${text}。`;
  if (voice.voiceEnabled() && voice.voiceCount() > 0) {
    await Promise.race([
      voice.speak(readback, { interrupt: true }),
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ]);
  }
  const body = el(
    "div",
    {},
    el("p", { class: "readback", text }),
    el("p", { class: "muted", text: `范围：${range}` })
  );
  const confirmed = await openDialog({
    title: annotation.noteId ? "确认修改批注" : "确认保存批注",
    body,
    confirmText: "保存",
    cancelText: "返回修改",
  });
  if (!confirmed) {
    textarea?.focus();
    return;
  }
  try {
    let saved;
    if (annotation.noteId) {
      saved = await updateNote(annotation.noteId, {
        text,
        scope,
        line_number: scope === "line" ? annotation.lineNumber : null,
        page_number: annotation.pageNumber,
      });
    } else {
      saved = await createNote({
        book_id: annotation.bookId,
        page_id: annotation.pageId,
        page_number: annotation.pageNumber,
        line_number: annotation.lineNumber,
        scope,
        text,
      });
    }
    const pending = Boolean(saved?.pending);
    toast(pending ? "已保存到本机，联网后会自动同步。" : "批注已保存。", {
      tone: pending ? "warn" : "",
      iconName: pending ? "info" : "check",
    });
    announce(pending ? "批注已保存在本机，联网后自动同步。" : "批注已保存。", { interrupt: true });
    const returnTo = annotation.returnTo;
    annotation = null;
    annotationInitial = "";
    navigate(returnTo);
  } catch (error) {
    handleActionError(error, "保存批注");
  }
}

async function cancelAnnotation() {
  if (!annotation) {
    navigate("reading");
    return;
  }
  const text = $("#annotationText")?.value.trim() || "";
  if (text && text !== annotationInitial.trim()) {
    const ok = await confirmDialog("放弃这次批注？", "已经说出的内容不会保存。", {
      confirmText: "放弃",
      tone: "danger",
    });
    if (!ok) return;
  }
  const returnTo = annotation.returnTo;
  annotation = null;
  annotationInitial = "";
  navigate(returnTo);
}

/* -------------------------------------------------------------------------- */
/* 批注库                                                                      */
/* -------------------------------------------------------------------------- */

async function storeRefreshNotes() {
  try {
    await refreshNotes();
  } catch (error) {
    if (isNetworkError(error)) {
      markOffline(error);
      updateOfflineBanner();
    }
  }
  renderNotes();
}

function renderNotes() {
  const list = $("#notesList");
  const empty = $("#notesEmpty");
  if (!list) return;
  const query = notesQuery.toLowerCase();
  const filtered = state.notes
    .filter((note) => (notesScope === "all" ? true : note.scope === notesScope))
    .filter((note) => {
      if (!query) return true;
      const scopeText = note.scope === "page" ? "整页" : `第 ${note.line_number || 1} 行`;
      return `${note.book_title || ""} ${note.page_number} ${note.text} ${scopeText}`
        .toLowerCase()
        .includes(query);
    })
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));

  $("#notesCount").textContent = `${filtered.length} 条`;
  $("#notesLead").textContent = query
    ? `找到 ${filtered.length} 条与“${notesQuery}”相关的批注。`
    : "按书籍、页码或内容查找，可以回听、补充和编辑。";
  list.replaceChildren();
  if (!state.notes.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  if (!filtered.length) {
    list.append(
      el(
        "div",
        { class: "empty-state" },
        el("h2", { text: "没有匹配的批注" }),
        el("p", { text: "换个关键词，或把筛选切回“全部”。" })
      )
    );
    return;
  }
  for (const note of filtered) list.append(noteCard(note));
}

function noteCard(note) {
  const scopeText = note.scope === "page" ? "整页" : `第 ${note.line_number || 1} 行`;
  const head = el(
    "div",
    { class: "note-head" },
    el("strong", { text: note.book_title || "未知书籍" }),
    el("time", { datetime: note.updated_at, text: formatDate(note.updated_at) })
  );
  const meta = el(
    "div",
    { class: "note-meta" },
    el("span", { text: `第 ${note.page_number} 页` }),
    el("span", { text: scopeText }),
    note.pending ? el("span", { class: "note-pending", text: "待同步" }) : null
  );
  const text = el("p", { class: "note-text", text: note.text });
  const actions = el(
    "div",
    { class: "note-actions" },
    el("button", {
      class: "btn btn--secondary",
      type: "button",
      text: "听取",
      onclick: () => listenNote(note),
    }),
    el("button", {
      class: "btn btn--secondary",
      type: "button",
      text: "补充",
      onclick: () => openAnnotate({ note, append: true }),
    }),
    el("button", {
      class: "btn btn--secondary",
      type: "button",
      text: "编辑",
      onclick: () => openAnnotate({ note }),
    }),
    el("button", {
      class: "btn btn--ghost btn--danger",
      type: "button",
      text: "删除",
      onclick: () => removeNote(note),
    })
  );
  return el(
    "article",
    { class: "note-card", dataset: { color: note.book_color || "jade" } },
    head,
    meta,
    text,
    actions
  );
}

function listenNote(note) {
  const scope = note.scope === "page" ? "整页" : `第 ${note.line_number || 1} 行`;
  announce(`${note.book_title || "这本书"}，第 ${note.page_number} 页，${scope}。${note.text}`, {
    interrupt: true,
    toastIt: true,
  });
}

async function removeNote(note) {
  const ok = await confirmDialog(
    "删除这条批注？",
    `《${note.book_title || "这本书"}》第 ${note.page_number} 页：${note.text.slice(0, 80)}`,
    { confirmText: "删除", tone: "danger" }
  );
  if (!ok) return;
  try {
    await deleteNote(note.id);
    toast("批注已删除。");
    renderNotes();
  } catch (error) {
    handleActionError(error, "删除批注");
  }
}

/* -------------------------------------------------------------------------- */
/* 设置                                                                        */
/* -------------------------------------------------------------------------- */

const SETTING_LABELS = {
  voice_enabled: (value) => (value ? "语音提示已开启" : "语音提示已关闭"),
  screen_reader_mode: (value) => (value ? "已切换到读屏模式" : "已切换回应用朗读"),
  always_listen: (value) => (value ? "免按键聆听已开启" : "免按键聆听已关闭"),
  auto_advance: (value) => (value ? "自动下一行已开启" : "自动下一行已关闭"),
  reading_mode: (value) =>
    ({
      manual: "阅读模式：手动点读",
      page: "阅读模式：整页连续",
      overnight: "阅读模式：整夜阅读",
    }[value] || ""),
  text_script: (value) => (value === "traditional" ? "文字版本：繁体" : "文字版本：简体"),
  translation_target: (value) =>
    ({ off: "翻译已关闭", en: "译文：中文→英文", zh: "译文：英文→中文" }[value] || ""),
  speak_translation: (value) => (value ? "朗读译文已开启" : "朗读译文已关闭"),
  high_contrast: (value) => (value ? "高对比度已开启" : "高对比度已关闭"),
  interaction_mode: (value) => (value === "guided" ? "已切换到语音引导" : "已切换到语音指令"),
  theme: (value) => ({ auto: "外观：跟随系统", light: "外观：浅色", dark: "外观：深色" }[value] || ""),
  verbosity: (value) => ({ brief: "提示：简洁", standard: "提示：标准", detailed: "提示：详细" }[value] || ""),
  voice_rate: (value) => `朗读速度 ${Number(value).toFixed(1)} 倍`,
  voice_pitch: (value) => `朗读音高 ${Number(value).toFixed(2)}`,
  font_scale: (value) => `字号 ${Math.round(Number(value) * 100)}%`,
  auto_advance_delay: (value) => `自动翻行等待 ${Number(value).toFixed(1)} 秒`,
};

function updateSetting(key, value) {
  if (key === "voice_rate" || key === "voice_pitch" || key === "font_scale" || key === "auto_advance_delay") {
    value = Number(value);
  }
  if (key === "speak_translation" && value && (state.settings.translation_target || "off") === "off") {
    toast("请先选择翻译方向，再开启朗读译文。", { tone: "warn", iconName: "info" });
    syncSettingsUI();
    return;
  }
  state.settings = { ...state.settings, [key]: value };
  if (key === "reading_mode") {
    state.settings.auto_advance = value !== "manual";
    pendingSettings.auto_advance = state.settings.auto_advance;
    if (value === "manual") clearTimeout(autoTimer);
    applyPreferences();
  }
  if (key === "auto_advance" && !value) {
    clearTimeout(autoTimer);
  }
  if (key === "screen_reader_mode" && value) {
    stopSpeech();
    screenReaderSay("已切换到读屏模式。应用朗读已关闭，交给系统读屏播报。");
  }
  if (key === "voice_enabled" && !value) stopSpeech();
  if (
    key === "theme" ||
    key === "font_scale" ||
    key === "high_contrast" ||
    key === "reading_mode" ||
    key === "text_script"
  ) {
    applyPreferences();
  }
  if (key === "interaction_mode") renderWelcome();
  if (["text_script", "translation_target", "speak_translation"].includes(key)) {
    readingDisplay = null;
    readingDisplayKey = "";
    if (currentRoute === "reading" && state.current?.page) {
      stopSpeech();
      void refreshReadingText();
    }
  }
  pendingSettings[key] = value;
  flushSettings();
  syncSettingsUI();
  const label = SETTING_LABELS[key]?.(value);
  if (label) toast(label, { duration: 1800, iconName: "check" });
  if (voice.screenReaderMode() && label) screenReaderSay(label);
  if (key === "auto_advance" && value && currentRoute === "reading" && !speechPlaying) {
    void speakCurrent();
  }
}

async function refreshReadingText() {
  if (currentRoute !== "reading" || !state.current?.page) return;
  await prepareReadingText({ force: true });
  renderReading();
  updateReadingUI();
}

function syncSettingsUI() {
  const settings = state.settings;
  $$("[data-setting]").forEach((node) => {
    const key = node.dataset.setting;
    const value = settings[key];
    if (node.getAttribute("role") === "switch") {
      node.setAttribute("aria-checked", String(Boolean(value)));
    } else if (node.type === "range") {
      if (document.activeElement !== node) node.value = String(value);
    } else if (node.tagName === "SELECT") {
      if (document.activeElement !== node) node.value = String(value);
    }
  });
  $$("[data-setting-group]").forEach((group) => {
    const key = group.dataset.settingGroup;
    for (const button of group.querySelectorAll("button[data-value]")) {
      button.setAttribute("aria-checked", String(button.dataset.value === String(settings[key])));
    }
  });
  const rate = $("#voiceRateOut");
  if (rate) rate.textContent = formatRate(settings.voice_rate);
  const pitch = $("#voicePitchOut");
  if (pitch) pitch.textContent = Number(settings.voice_pitch || 1).toFixed(2);
  const font = $("#fontScaleOut");
  if (font) font.textContent = `${Math.round(Number(settings.font_scale || 1) * 100)}%`;
  const delay = $("#autoDelayOut");
  if (delay) delay.textContent = `${Number(settings.auto_advance_delay || 2.5).toFixed(1)} 秒`;
  const speed = $("#speedValue");
  if (speed) speed.textContent = formatRate(settings.voice_rate);
  const speakTranslation = $('[data-setting="speak_translation"]');
  if (speakTranslation) {
    const enabled = (settings.translation_target || "off") !== "off";
    speakTranslation.disabled = !enabled;
    speakTranslation.setAttribute("aria-disabled", String(!enabled));
    speakTranslation.title = enabled ? "" : "先选择翻译方向";
  }
  const name = $("#readerName");
  if (name && document.activeElement !== name) name.value = state.profile.name || "";
  const tokenField = $("#tokenInput");
  if (tokenField && document.activeElement !== tokenField) {
    let saved = "";
    try {
      saved = localStorage.getItem("paperpal.token") || "";
    } catch {
      saved = "";
    }
    tokenField.value = saved;
  }
  const version = $("#aboutVersion");
  if (version) version.textContent = state.server.version || "1.0.0";
  const ocr = $("#aboutOcr");
  if (ocr) {
    ocr.textContent = state.offline
      ? "离线，连接后可用"
      : state.server.ocr_ready
        ? "RapidOCR · 本机就绪"
        : "RapidOCR · 首次扫描时加载";
  }
  const summary = $("#deviceSummary");
  if (summary) {
    const status = input.status();
    const parts = [];
    if (bleSnapshot.connected) parts.push(bleSnapshot.name || "蓝牙已连接");
    if (status.media.enabled) parts.push("耳机按键已启用");
    if (status.keyboard) parts.push("键盘已识别");
    if (status.gamepad.seen) parts.push(status.gamepad.name || "手柄已连接");
    summary.textContent = parts.length ? parts.join(" · ") : "连接蓝牙翻页器、键盘或手柄";
  }
  const phoneSummary = $("#phoneSummary");
  if (phoneSummary) {
    phoneSummary.textContent =
      location.protocol === "https:" ? "扫码打开；相机与主屏幕安装可用" : "扫码打开；相机需要 HTTPS 启动";
  }
  const secure = $("#aboutSecure");
  if (secure) {
    secure.textContent =
      location.protocol === "https:"
        ? "HTTPS · 相机可用"
        : location.hostname === "localhost" || location.hostname === "127.0.0.1"
          ? "本机 HTTP · 相机可用"
          : "HTTP · 相机不可用";
  }
  const exportBtn = $("#exportBtn");
  if (exportBtn) exportBtn.disabled = false;
  const importBtn = $("#importBtn");
  if (importBtn) importBtn.disabled = state.offline;
}

async function saveReaderName() {
  const field = $("#readerName");
  const value = field?.value.trim() || "我";
  try {
    await saveName(value);
    if (field) field.value = value;
    toast("称呼已保存。");
    setAssistant("语音助手", `你好，${state.profile.name || "我"}。`);
  } catch (error) {
    handleActionError(error, "保存称呼");
  }
}

async function exportBackup() {
  try {
    const { text, filename } = await exportData();
    const blob = new Blob([text], { type: "application/json" });
    const name = filename || "paperpal-backup.json";
    // 手机（iOS Safari）没有下载文件夹，优先走系统分享面板，才能存到“文件”App。
    if (typeof File === "function" && navigator.canShare) {
      try {
        const file = new File([blob], name, { type: "application/json" });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: "纸伴备份", text: "纸伴数据备份" });
          toast("备份已交给系统保存。", { iconName: "download" });
          announce("备份已通过系统分享保存。");
          return;
        }
      } catch (error) {
        if (error?.name === "AbortError") return; // 用户主动取消
        console.warn("share", error);
      }
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast(state.offline ? "已导出本机缓存。" : "备份已导出。", { iconName: "download" });
    announce("备份已导出到下载文件夹。");
  } catch (error) {
    handleActionError(error, "导出备份");
  }
}

async function importBackupFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    if (!payload || !Array.isArray(payload.books)) throw new Error("这不是纸伴的备份文件。");
    const modeSelect = el(
      "select",
      { "aria-label": "导入方式" },
      el("option", { value: "merge", text: "合并到现有书架（推荐）" }),
      el("option", { value: "replace", text: "替换现有全部数据" })
    );
    const bookCount = payload.books.length;
    const noteCount = Array.isArray(payload.notes) ? payload.notes.length : 0;
    const body = el(
      "div",
      { class: "dialog-fields" },
      el(
        "p",
        {
          text: `备份包含 ${bookCount} 本书、${noteCount} 条批注。备份中的页面图片不会导入，但文字和批注会恢复。`,
        }
      ),
      el("label", {}, "导入方式", modeSelect)
    );
    const mode = await openDialog({
      title: "导入备份",
      body,
      confirmText: "开始导入",
      getValue: () => modeSelect.value,
    });
    if (!mode) return;
    const result = await importData(payload, mode);
    const imported = result?.imported || {};
    toast(`已导入 ${imported.books || 0} 本书、${imported.pages || 0} 页、${imported.notes || 0} 条批注。`);
    announce(
      `导入完成。${imported.books || 0} 本书，${imported.notes || 0} 条批注。`,
      { interrupt: true }
    );
    if (mode === "replace") {
      clearCurrent();
      annotation = null;
      navigate("welcome");
    } else {
      renderRoute(currentRoute);
    }
  } catch (error) {
    handleActionError(error, "导入备份");
  }
}

async function clearEverything() {
  const ok = await confirmDialog(
    "清除所有数据？",
    "书架、扫描的书页文字和全部批注都会被删除。设置会保留。建议先导出备份。",
    { confirmText: "全部清除", tone: "danger" }
  );
  if (!ok) return;
  try {
    await clearAllData();
    toast("所有数据已清除。");
    announce("所有数据已清除。");
    navigate("welcome");
  } catch (error) {
    handleActionError(error, "清除数据");
  }
}

/* -------------------------------------------------------------------------- */
/* 设备                                                                        */
/* -------------------------------------------------------------------------- */

function updateDeviceUI() {
  const status = input.status();
  const keyboardStatus = $("#keyboardStatus");
  const keyboardHint = $("#keyboardHint");
  const keyboardDot = $("#keyboardDot");
  if (keyboardStatus) {
    keyboardStatus.textContent = status.keyboard ? "键盘已识别" : "等待键盘输入";
  }
  if (keyboardHint) {
    keyboardHint.textContent = status.keyboard
      ? "方向键、空格都已可用；长按可以连续翻行。"
      : "方向键 ← →、空格，或任意按键都会被识别。";
  }
  keyboardDot?.classList.toggle("is-on", status.keyboard);
  const gamepadStatus = $("#gamepadStatus");
  const gamepadDot = $("#gamepadDot");
  const gamepadLabel = $("#gamepadName");
  if (gamepadStatus) {
    gamepadStatus.textContent = status.gamepad.seen ? "手柄已连接" : "未检测到手柄";
  }
  if (gamepadLabel) {
    gamepadLabel.textContent = status.gamepad.seen
      ? status.gamepad.name || "已识别标准游戏手柄"
      : "支持标准游戏手柄与部分蓝牙遥控器。";
  }
  gamepadDot?.classList.toggle("is-on", status.gamepad.seen);
  updateMediaUI(status);
  updateBluetoothUI();
  renderInputLog();
  renderDeviceRegistry();
  const guideTitle = $("#pairGuideTitle");
  if (guideTitle) {
    guideTitle.textContent = status.platform.ios
      ? "系统配对：iPhone 上这样连耳机 / 翻页器"
      : "系统配对：耳机 / 翻页器这样连";
  }
  const summary = $("#deviceSummary");
  if (summary) {
    const saved = devices.list();
    const parts = [];
    if (saved.length) parts.push(saved[0].nickname);
    if (status.media.enabled) parts.push("耳机按键已启用");
    if (status.keyboard) parts.push("键盘已识别");
    if (status.gamepad.seen) parts.push(status.gamepad.name || "手柄已连接");
    summary.textContent = parts.length ? parts.join(" · ") : "连接蓝牙翻页器、键盘或手柄";
  }
}

function updateMediaUI(status = input.status()) {
  const enabled = Boolean(status.media.enabled);
  const supported = Boolean(status.media.supported);
  const stateEl = $("#mediaState");
  const hint = $("#mediaHint");
  const dot = $("#mediaDot");
  const note = $("#mediaNote");
  const enableBtn = $("#mediaEnableBtn");
  const disableBtn = $("#mediaDisableBtn");
  if (stateEl) {
    stateEl.textContent = enabled
      ? status.media.playing
        ? "耳机按键已启用 · 正在播放"
        : "耳机按键已启用"
      : supported
        ? "耳机按键未启用"
        : "这个浏览器不支持耳机媒体键";
  }
  if (hint) {
    hint.textContent = supported
      ? "蓝牙耳机的播放 / 暂停键、上一首 / 下一首键可以控制朗读。"
      : "可以改用蓝牙键盘、蓝牙翻页器或系统读屏来操作。";
  }
  if (note && enabled) {
    note.textContent = "已启用：耳机按键会发送到纸伴。如果按了没反应，先在控制中心确认看到“纸伴”。";
  }
  dot?.classList.toggle("is-on", enabled);
  if (enableBtn) enableBtn.hidden = enabled || !supported;
  if (disableBtn) disableBtn.hidden = !enabled;
}

function renderInputLog() {
  const list = $("#inputLog");
  const last = $("#lastKey");
  const entries = input.entries();
  if (!list) return;
  list.replaceChildren();
  if (!entries.length) {
    if (last) last.textContent = "尚未收到按键";
    list.append(el("li", { class: "input-log-empty", text: "按一下蓝牙设备上的按键，这里会显示收到什么。" }));
    return;
  }
  if (last) {
    last.textContent = `${entries[0].source}：${entries[0].label}`;
  }
  entries.forEach((entry, index) => {
    const time = new Date(entry.at);
    const stamp = `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}:${String(time.getSeconds()).padStart(2, "0")}`;
    list.append(
      el(
        "li",
        {
          class: `input-log-item${index === 0 ? " is-latest" : ""}`,
          dataset: { source: entry.source },
        },
        el("span", { class: "log-source", text: entry.source }),
        el("span", { class: "log-label", text: entry.label }),
        entry.detail ? el("span", { class: "log-detail", text: entry.detail }) : null,
        el("time", { class: "log-time", text: stamp, datetime: time.toISOString() })
      )
    );
  });
}

function initializeInput() {
  input.attach({
    onAction: (action, source, label) => handleInputAction(action, source, label),
    onEvent: () => {
      if (currentRoute === "devices") {
        updateDeviceUI();
        const latest = input.entries()[0];
        if (latest) announce(`${latest.source}：${latest.label}`, { interrupt: true });
      } else {
        updateMediaUI();
      }
    },
  });
  updateDeviceUI();
}

/** 把"真实收到的按键"登记成带昵称的设备。 */
function noteDevice(kind, name = "", source = "") {
  let result;
  try {
    result = devices.upsert({ kind, name, source });
  } catch {
    return null;
  }
  renderDeviceRegistry();
  const device = result.device;
  if (result.created) {
    // 只在设备页或"正在配对"时出声，避免阅读过程中打断朗读
    const shouldTell = currentRoute === "devices" || Boolean(pairingWatch);
    const extra = pairingWatch ? "配对成功，" : "";
    if (shouldTell) {
      announce(`${extra}已识别到${device.nickname}。可以在设备页给它改个名字。`, {
        interrupt: true,
      });
      toast(`${extra}已识别：${device.nickname}`, {
        iconName: devices.KIND_ICONS[kind] || "bluetooth",
      });
    }
    pairingWatch = 0;
    const hint = $("#pairingHint");
    if (hint) hint.textContent = `已登记：${device.nickname}。按“改名”可以换成你习惯的叫法。`;
  }
  return device;
}

function deviceKindFor(source, label = "") {
  if (source === "media") return "headphone";
  if (source === "gamepad") return "gamepad";
  if (source === "ble") return "ble";
  if (source === "hold") return "remote";
  if (/Page Up|Page Down|耳机|媒体/.test(String(label))) return "remote";
  return "keyboard";
}

function relativeTime(timestamp) {
  if (!timestamp) return "刚刚";
  const seconds = Math.max(1, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function renderDeviceRegistry() {
  const list = $("#deviceList");
  const empty = $("#deviceEmpty");
  if (!list) return;
  const items = devices.list();
  list.replaceChildren();
  if (empty) empty.hidden = items.length > 0;
  items.forEach((device) => {
    list.append(
      el(
        "li",
        { class: "device-item", dataset: { id: device.id } },
        el("span", { class: "device-item-icon" }, icon(devices.KIND_ICONS[device.kind] || "bluetooth")),
        el(
          "span",
          { class: "device-item-copy" },
          el("strong", { text: device.nickname }),
          el("span", {
            text: `${devices.KIND_LABELS[device.kind] || "设备"} · ${relativeTime(device.lastSeen)}`,
          })
        ),
        el("button", {
          class: "btn btn--ghost btn--sm",
          type: "button",
          dataset: { action: "device-rename", id: device.id },
          text: "改名",
        }),
        el("button", {
          class: "btn btn--ghost btn--sm",
          type: "button",
          dataset: { action: "device-remove", id: device.id },
          text: "移除",
        })
      )
    );
  });
}

async function renameDevice(id) {
  const device = devices.get(id);
  if (!device) return;
  const field = el("input", { class: "input", type: "text", maxlength: "40", value: device.nickname });
  const value = await openDialog({
    title: "给设备改名",
    body: el(
      "div",
      { class: "stack" },
      el("p", { text: "这个名字会出现在所有提示里，例如“我的耳机”。" }),
      field
    ),
    confirmText: "保存",
    getValue: () => field.value.trim(),
  });
  if (!value) return;
  const updated = devices.rename(id, value);
  renderDeviceRegistry();
  if (updated) {
    toast(`已改名为：${updated.nickname}`, { iconName: "check" });
    announce(`设备已改名为${updated.nickname}。`);
  }
}

function removeDevice(id) {
  const device = devices.get(id);
  devices.remove(id);
  renderDeviceRegistry();
  toast(device ? `已移除：${device.nickname}` : "已移除设备。", { iconName: "trash" });
}

function handleInputAction(action, source, label = "") {
  // 先登记设备：只要真的收到按键，就说明这个设备能用
  if (source && source !== "button") {
    noteDevice(deviceKindFor(source, label), "", source);
  }
  if (state.settings.haptics && ["next", "prev", "toggle", "note"].includes(action)) {
    vibrate(action === "toggle" ? 18 : 10);
  }
  if (action === "repeat") {
    repeatHint();
    return;
  }
  if (action === "faster" || action === "slower") {
    const delta = action === "faster" ? 0.1 : -0.1;
    const rate = clamp(Number(state.settings.voice_rate || 1) + delta, 0.5, 2);
    updateSetting("voice_rate", Math.round(rate * 100) / 100);
    announce(`朗读速度 ${rate.toFixed(1)} 倍。`);
    return;
  }
  if (action === "stop") {
    stopSpeech();
    return;
  }
  if (action === "pageNext") {
    void goToAdjacentPage(1);
    return;
  }
  if (action === "pagePrev") {
    void goToAdjacentPage(-1);
    return;
  }
  if (currentRoute === "devices") {
    // 测试台只负责"听见按键"，不执行会跳页的动作，避免测到一半被打断
    if (action === "back") {
      navigate("settings");
      return;
    }
    const label = input.ACTION_LABELS[action] || action;
    const hasPage = Boolean(state.current);
    toast(
      hasPage ? `收到：${label}` : `收到：${label}。先在阅读页打开一页书，再回来试一次。`,
      { iconName: "keyboard", duration: 3000 }
    );
    announce(`收到 ${label}`, { interrupt: true });
    return;
  }
  if (currentRoute !== "reading" && !state.current) {
    if (action === "back") returnToPrevious();
    return;
  }
  if (action === "next") moveLine(1);
  else if (action === "prev") moveLine(-1);
  else if (action === "toggle") togglePlay();
  else if (action === "note") openAnnotate();
  else if (action === "back") returnToPrevious();
}


function updateBluetoothUI() {
  const status = $("#bleState");
  const hint = $("#bleHint");
  const dot = $("#bleDot");
  const detail = $("#bleDetail");
  const connectBtn = $("#bleConnectBtn");
  const disconnectBtn = $("#bleDisconnectBtn");
  const learnBtn = $("#bleLearnBtn");
  const note = $("#bleNote");
  if (!status) return;
  const supported = bluetooth.supported();
  bleSnapshot.supported = supported;
  // iPhone / iPad 没有 Web Bluetooth：整张卡片收起来，只留一句说明和耳机 / 键盘方案
  const card = $("#bleCard");
  if (card) card.hidden = !supported;
  const name = bluetooth.savedName() || bleSnapshot.name;
  if (!supported) {
    status.textContent = name ? `上次设备：${name}` : "此浏览器不支持网页蓝牙";
    if (hint) {
      hint.textContent =
        "iPhone / iPad 请把翻页器作为系统蓝牙键盘配对；网页无法读取它的昵称。";
    }
    if (note) {
      note.textContent =
        "iOS Safari 不提供 Web Bluetooth。蓝牙键盘按键、手柄和屏幕按钮仍可使用；手柄昵称会显示在上方。";
    }
  } else if (bleSnapshot.connected) {
    status.textContent = bleSnapshot.name || "已连接蓝牙设备";
    if (hint) hint.textContent = "已连接，可以显示设备昵称、电量并学习翻页按键。";
    if (note) note.textContent = "如果按键没有反应，点“学习按键”，按一下遥控器，再选择对应动作。";
  } else {
    status.textContent = name ? `上次设备：${name}` : "蓝牙未连接";
    if (hint) hint.textContent = "连接支持 Web Bluetooth 的翻页器或遥控器。";
    if (note) {
      note.textContent = bleSnapshot.knownNames?.length
        ? `浏览器记住过：${bleSnapshot.knownNames.join("、")}`
        : "连接后才会显示设备昵称和电量；需要浏览器支持 Web Bluetooth。";
    }
  }
  dot?.classList.toggle("is-on", Boolean(bleSnapshot.connected));
  if (detail) detail.hidden = !bleSnapshot.connected;
  const registered = devices.latest("ble");
  const displayName =
    bluetooth.savedName() || bleSnapshot.name || registered?.nickname || "—";
  if ($("#bleName")) $("#bleName").textContent = displayName;
  if ($("#bleBattery")) {
    $("#bleBattery").textContent =
      bleSnapshot.battery === null || bleSnapshot.battery === undefined
        ? "—"
        : `${bleSnapshot.battery}%`;
  }
  if ($("#bleLearned")) $("#bleLearned").textContent = String(Object.keys(bleMap).length);
  const nicknameInput = $("#bleNickname");
  if (nicknameInput && document.activeElement !== nicknameInput) {
    nicknameInput.value = bluetooth.savedName() || bleSnapshot.name || "";
  }
  if (connectBtn) connectBtn.hidden = !supported || Boolean(bleSnapshot.connected);
  if (disconnectBtn) disconnectBtn.hidden = !bleSnapshot.connected;
  if (learnBtn) learnBtn.hidden = !bleSnapshot.connected;
}

function loadBleMap() {
  try {
    const parsed = JSON.parse(localStorage.getItem("paperpal.bleMap.v1") || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveBleMap() {
  try {
    localStorage.setItem("paperpal.bleMap.v1", JSON.stringify(bleMap));
  } catch {
    /* 忽略存储失败 */
  }
}

async function initializeBluetooth() {
  bleSnapshot = bluetooth.snapshot();
  updateBluetoothUI();
  try {
    const names = await bluetooth.loadKnownNames();
    bleSnapshot.knownNames = names;
    updateBluetoothUI();
  } catch {
    /* 忽略 */
  }
}

async function connectBluetooth() {
  try {
    const snapshot = await bluetooth.connect({
      onState: (next) => {
        bleSnapshot = next;
        updateBluetoothUI();
      },
      onNotify: (bytes) => {
        void handleBluetoothValue(bytes);
      },
    });
    if (!snapshot) return; // 用户取消
    bleSnapshot = snapshot;
    updateBluetoothUI();
    noteDevice("ble", snapshot.name || "", "web-bluetooth");
    toast(`蓝牙已连接：${snapshot.name || "未命名设备"}`, { iconName: "bluetooth" });
  } catch (error) {
    const message =
      error?.name === "NotFoundError"
        ? "没有选择蓝牙设备。"
        : error?.message || "蓝牙连接失败，请确认设备已开启并靠近电脑。";
    toast(message, { tone: "warn", iconName: "bluetooth", duration: 3600 });
    updateBluetoothUI();
  }
}

async function disconnectBluetooth() {
  await bluetooth.disconnect();
  bleSnapshot = bluetooth.snapshot();
  updateBluetoothUI();
  toast("蓝牙已断开。", { iconName: "bluetooth" });
}

async function handleBluetoothValue(bytes) {
  const key = bytes.join(",");
  if (bleLearning) {
    await learnBluetoothKey(key);
    return;
  }
  const action =
    bleMap[key] ||
    (bytes.length === 1 && bytes[0] === 1
      ? "next"
      : bytes.length === 1 && bytes[0] === 2
        ? "previous"
        : bytes.length === 1 && bytes[0] === 3
          ? "toggle"
          : "");
  if (!action) {
    const hint = $("#bleHint");
    if (hint) hint.textContent = `收到按键数据 ${key}，点“学习按键”绑定动作。`;
    return;
  }
  performBluetoothAction(action);
}

async function learnBluetoothKey(key) {
  bleLearning = false;
  const select = el(
    "select",
    { id: "bleActionSelect", class: "input" },
    el("option", { value: "next", text: "下一行" }),
    el("option", { value: "previous", text: "上一行" }),
    el("option", { value: "toggle", text: "暂停 / 继续" }),
    el("option", { value: "note", text: "添加批注" })
  );
  const action = await openDialog({
    title: "学习蓝牙按键",
    body: el(
      "div",
      { class: "stack" },
      el("p", { text: `捕获到按键：${key}。要绑定哪个动作？` }),
      select
    ),
    confirmText: "绑定",
    getValue: () => select.value,
  });
  if (!action) {
    toast("没有绑定按键。", { tone: "warn", iconName: "info" });
    return;
  }
  bleMap[key] = action;
  saveBleMap();
  updateBluetoothUI();
  toast(`已绑定：${key} → ${select.selectedOptions[0]?.textContent || action}`, {
    iconName: "check",
  });
}

function performBluetoothAction(action) {
  if (currentRoute !== "reading") {
    toast("请先打开阅读页，再使用蓝牙翻页按键。", { iconName: "bluetooth" });
    return;
  }
  if (action === "next") moveLine(1);
  else if (action === "previous") moveLine(-1);
  else if (action === "toggle") togglePlay();
  else if (action === "note") openAnnotate();
}

async function enableMediaControls() {
  const result = await input.enableMediaControls();
  updateMediaUI();
  if (result.ok) {
    toast("耳机按键已启用，用耳机上的按键试试。", { iconName: "headphones" });
    announce("耳机按键已启用。播放暂停键可以暂停或继续，下一首键读下一行。", { interrupt: true });
  } else {
    toast(result.reason || "耳机按键启用失败。", { tone: "warn", iconName: "headphones", duration: 5200 });
    announce(result.reason || "耳机按键启用失败，可以改用键盘或翻页器。", { interrupt: true });
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* 手机连接                                                                    */
/* -------------------------------------------------------------------------- */

async function applyPhoneInfo(info) {
  phoneInfo = info;
  const qrBox = $("#phoneQr");
  const urlEl = $("#phoneUrl");
  const status = $("#phoneStatus");
  const steps = $("#phoneSteps");
  const checks = $("#phoneChecks");
  const primary = info?.primary_url || location.origin;
  const isLocalHttp =
    location.protocol !== "https:" && ["localhost", "127.0.0.1"].includes(location.hostname);
  if (urlEl) urlEl.textContent = primary;
  if (qrBox) {
    qrBox.replaceChildren();
    if (isLocalHttp) {
      qrBox.append(
        el("p", {
          class: "fineprint",
          text: "本机模式下没有手机能用的二维码。请在电脑上双击「启动手机测试.bat」，那里会显示可扫的二维码。",
        })
      );
    } else if (info?.qr_svg) {
      qrBox.innerHTML = info.qr_svg;
      const svg = qrBox.querySelector("svg");
      if (svg) {
        svg.setAttribute("role", "img");
        svg.setAttribute("aria-label", `二维码：${primary}`);
        svg.removeAttribute("width");
        svg.removeAttribute("height");
      }
    } else {
      qrBox.append(
        el("p", {
          class: "fineprint",
          text: "二维码需要后端安装了 segno 依赖；可以先直接输入上面的网址。",
        })
      );
    }
  }
  const mode = info?.mode || (location.protocol === "https:" ? "lan" : "local");
  const secure = Boolean(info?.secure_context) || location.protocol === "https:";
  const modeEl = $("#phoneMode");
  if (modeEl) {
    modeEl.hidden = false;
    if (mode === "tunnel") {
      modeEl.className = "phone-mode is-tunnel";
      modeEl.textContent = "公网隧道已开启：手机用 4G/5G 或任意 Wi-Fi 都能打开，不需要安装证书。";
    } else if (mode === "lan" && secure) {
      modeEl.className = "phone-mode is-lan";
      modeEl.textContent = "局域网 HTTPS：手机和电脑在同一个 Wi-Fi，第一次需要安装一次证书。";
    } else if (mode === "lan") {
      modeEl.className = "phone-mode is-local";
      modeEl.textContent =
        "局域网 HTTP：可以阅读，但 iPhone 会禁止相机和麦克风。请用「启动手机测试.bat」或「启动手机隧道.bat」。";
    } else {
      modeEl.className = "phone-mode is-local";
      modeEl.textContent = "本机模式：手机打不开这个地址，请用「启动手机测试.bat」或「启动手机隧道.bat」。";
    }
  }
  const profileBtn = document.querySelector('[data-action="install-profile"]');
  if (profileBtn) profileBtn.hidden = mode === "tunnel";
  const diagnosticBtn = $("#diagnosticBtn");
  if (diagnosticBtn) diagnosticBtn.hidden = !info?.diagnostic_url;
  if (status) {
    const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
    if (mode === "tunnel") {
      status.textContent =
        "这是公网 HTTPS 地址：相机、麦克风、离线缓存和“添加到主屏幕”都可用；隧道地址每次重启都会变。";
    } else if (location.protocol === "https:") {
      status.textContent = "当前是 HTTPS：相机、离线缓存和“添加到主屏幕”都能用。";
    } else if (isLocal) {
      status.textContent =
        "当前只是电脑本机（HTTP）模式，手机打不开这个地址。要手机测试，请在电脑上双击「启动手机测试.bat」，再用手机扫那里的二维码。";
    } else {
      status.textContent =
        "当前是 HTTP：可以阅读和写批注，但 iPhone 会禁止相机和安装。请用「启动手机测试.bat」以 HTTPS 启动。";
    }
  }
  if (steps) {
    steps.replaceChildren();
    const list =
      info?.steps ||
      [
        { title: "同一个 Wi-Fi", text: "让手机和电脑连同一个 Wi-Fi。" },
        { title: "扫码打开", text: `用手机相机扫描二维码，或输入 ${primary}` },
      ];
    list.forEach((step) => {
      steps.append(
        el(
          "li",
          {},
          el("span", { text: String(list.indexOf(step) + 1) }),
          el("div", {}, el("strong", { text: step.title }), el("p", { text: step.text }))
        )
      );
    });
  }
  if (checks) {
    checks.replaceChildren();
    const firewall = info?.access?.firewall;
    const firewallText = firewall?.skipped
      ? "隧道模式，无需放行"
      : firewall?.ok
        ? "已放行"
        : "未确认（手机可能一直转圈）";
    const modeText =
      mode === "tunnel" ? "公网隧道（HTTPS）" : location.protocol === "https:" ? "局域网 HTTPS" : "HTTP（相机不可用）";
    const rows = [
      ["连接方式", modeText],
      ["手机访问", primary],
      ["局域网 IP", info?.lan_ip || "未检测到"],
      ["网络自检", info?.diagnostic_url || (mode === "tunnel" ? "隧道模式不需要" : "未启动")],
      ["防火墙", firewallText],
      ["证书指纹", info?.certificate?.fingerprint ? info.certificate.fingerprint.slice(0, 29) + "…" : "未生成"],
      ["访问令牌", info?.auth_required ? "已开启（手机也需要令牌）" : "未开启"],
    ];
    rows.forEach(([label, value]) => {
      checks.append(
        el("div", { class: "check-row" }, el("span", { text: label }), el("strong", { text: value }))
      );
    });
    const diagText = $("#phoneDiagText");
    if (diagText) {
      diagText.textContent = info?.diagnostic_url
        ? `用手机打开 ${info.diagnostic_url}：能看到“网络是通的”就说明防火墙和 Wi-Fi 没问题。`
        : "隧道模式下不需要自检，直接扫码即可。";
    }
  }
}

async function renderPhone() {
  const status = $("#phoneStatus");
  if (status) status.textContent = "正在读取本机服务信息…";
  let info = null;
  if (!state.offline) {
    try {
      info = await api.phoneInfo();
    } catch (error) {
      console.warn("phone", error);
    }
  }
  await applyPhoneInfo(info);
}

async function copyText(text, okMessage) {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      toast(okMessage || "已复制。", { iconName: "check" });
      return true;
    }
  } catch {
    /* 继续用兜底方案 */
  }
  try {
    const area = el("textarea", { class: "sr-only", text });
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
    toast(okMessage || "已复制。", { iconName: "check" });
    return true;
  } catch {
    toast("复制失败，可以手动记下网址。", { tone: "warn" });
    return false;
  }
}

async function copyPhoneUrl() {
  const url = phoneInfo?.primary_url || location.origin;
  await copyText(url, `已复制网址：${url}`);
  announce("网址已复制，可以发到手机上打开。");
}

function installProfile() {
  if (location.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(location.hostname)) {
    toast("证书安装需要在 HTTPS 模式下打开纸伴。", { tone: "warn", iconName: "info" });
    announce("请先用启动手机测试点 bat 以 HTTPS 启动纸伴，再回来安装证书。");
    return;
  }
  window.location.href = "/paperpal.mobileconfig";
  announce("正在下载证书描述文件。下载完成后请在设置里安装，并打开完全信任。");
}

async function copyTroubleshoot() {
  const lines = [
    "纸伴 · 手机与蓝牙排障清单",
    `访问地址：${phoneInfo?.primary_url || location.origin}`,
    "1. 手机和电脑必须在同一个 Wi-Fi（不要一个连 Wi-Fi 一个连热点）。",
    "2. 电脑上如果开了 VPN / 代理（例如 Clash 的 TUN 模式），先关掉再试。",
    "3. Windows 防火墙要放行纸伴使用的端口（8443）。",
    "4. iPhone 相机需要 HTTPS；装好“纸伴本机证书”并打开完全信任。",
    "5. 蓝牙耳机：先在系统里连上耳机，再回纸伴点“启用耳机按键”。",
    "6. 按耳机键没反应时，看设备测试台有没有记录，并确认控制中心显示“纸伴”。",
  ];
  await copyText(lines.join("\n"), "排障清单已复制。");
}

/* -------------------------------------------------------------------------- */
/* 设备配对                                                                    */
/* -------------------------------------------------------------------------- */

function startPairing() {
  pairingWatch = Date.now();
  const platform = input.platform();
  const message = platform.ios
    ? "现在按一下已经配对好的耳机或翻页器上的按键，比如播放暂停键，我会立刻登记它。"
    : "现在按一下设备上的按键，我会立刻登记它。";
  const hint = $("#pairingHint");
  if (hint) hint.textContent = message;
  toast(message, { iconName: "bluetooth", duration: 7000 });
  announce(message, { interrupt: true });
  window.setTimeout(() => {
    if (!pairingWatch) return;
    const still = $("#pairingHint");
    if (still) still.textContent = "还没有收到按键。检查设备是否已配对、是否开机，再按一次。";
    announce("还没有收到按键。检查设备是否已配对并开机，再按一次。", { interrupt: true });
    pairingWatch = 0;
  }, 22000);
}

/* -------------------------------------------------------------------------- */
/* 连续自动扫描                                                                */
/* -------------------------------------------------------------------------- */

const AUTO_PREF_KEY = "paperpal.autoScan.v1";
let autoStatusSpokenAt = 0;

function autoPrefs() {
  try {
    return JSON.parse(localStorage.getItem(AUTO_PREF_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveAutoPrefs(patch) {
  try {
    localStorage.setItem(AUTO_PREF_KEY, JSON.stringify({ ...autoPrefs(), ...patch }));
  } catch {
    /* 忽略 */
  }
}

function autoScanVideo() {
  if (!autoScanOn) return $("#camera");
  if (currentRoute === "reading") return $("#autoCamera");
  return $("#camera");
}

/** 把同一个相机流挂到当前需要取帧的 video 上（阅读页用隐藏的小窗）。 */
function attachCameraStream() {
  const target = autoScanVideo();
  if (!cameraStream || !target) return;
  if (target.srcObject !== cameraStream) {
    target.srcObject = cameraStream;
    target.play?.().catch(() => {});
  }
}

function setAutoUi(on) {
  const toggle = $("#autoScanToggle");
  if (toggle) {
    toggle.setAttribute("aria-checked", String(on));
    toggle.setAttribute("aria-label", on ? "关闭连续自动扫描" : "开启连续自动扫描");
  }
  const status = $("#autoScanStatus");
  if (status) status.hidden = !on;
  const badge = $("#autoBadge");
  if (badge) badge.hidden = !on;
  document.documentElement.dataset.autoScan = on ? "on" : "off";
}

function setAutoStatus(text, tone = "") {
  const node = $("#autoScanText");
  if (node && text) node.textContent = text;
  const badge = $("#autoBadgeText");
  if (badge && text) badge.textContent = text;
  if (!text || tone !== "warn") return;
  const now = Date.now();
  if (now - autoStatusSpokenAt < 9000) return;
  autoStatusSpokenAt = now;
  announce(text, { interrupt: false });
}

function currentScanLayout() {
  return $("#layoutGroup")?.querySelector('button[aria-checked="true"]')?.dataset.value || "none";
}

async function ensureAutoBook() {
  if (state.current?.bookId) return state.current.bookId;
  const selected = $("#bookSelect")?.value;
  if (selected) return selected;
  const first = state.books?.[0];
  if (first) return first.id;
  try {
    const book = await createBook("我的书");
    return book?.id || null;
  } catch (error) {
    handleActionError(error, "新建书籍");
    return null;
  }
}

async function toggleAutoScan() {
  if (autoScanOn) {
    stopAutoScan();
    return;
  }
  await startAutoScan();
}

async function startAutoScan() {
  if (autoScanOn) return;
  if (!window.isSecureContext) {
    const message = "自动扫描需要相机，请用 HTTPS 打开（启动手机测试.bat 或 启动手机隧道.bat）。";
    toast(message, { tone: "warn", iconName: "info", duration: 6000 });
    announce(message, { interrupt: true });
    return;
  }
  const bookId = await ensureAutoBook();
  if (!bookId) {
    toast("先选择或新建一本书。", { tone: "warn", iconName: "info" });
    return;
  }
  if (!cameraStream) {
    const ok = await startCamera();
    if (!ok) {
      announce("相机打不开，自动扫描需要相机画面。", { interrupt: true });
      return;
    }
  }
  autoScanOn = true;
  saveAutoPrefs({ on: true });
  setAutoUi(true);
  setAutoStatus("正在自动识别…");
  attachCameraStream();
  autoscan.start({
    getVideo: () => autoScanVideo(),
    getBookId: () => state.current?.bookId || bookId,
    getLayout: () => currentScanLayout(),
    getRotation: () => Number($("#rotationSelect")?.value || 0),
    onStatus: (text, tone) => setAutoStatus(text, tone),
    onError: (error) => {
      setAutoStatus(error?.message || "识别失败，稍后再试。", "warn");
    },
    onResult: (result) => {
      void handleAutoResult(result);
    },
  });
  announce(
    "自动扫描已开启。把书放好就行，我会自己识别；翻页以后会自动读新的一页。",
    { interrupt: true }
  );
  toast("自动扫描已开启，翻页就会自动读。", { iconName: "sparkle", duration: 4200 });
}

function stopAutoScan(message = "已停止自动扫描。") {
  if (!autoScanOn) return;
  autoscan.stop();
  autoScanOn = false;
  saveAutoPrefs({ on: false });
  setAutoUi(false);
  setAutoStatus("");
  const hidden = $("#autoCamera");
  if (hidden) hidden.srcObject = null;
  if (currentRoute !== "scan") stopCamera();
  toast(message, { iconName: "check" });
  announce(message);
}

async function handleAutoResult(result) {
  if (!autoScanOn || !result) return;
  const page = result.page;
  if (result.action === "empty" || !page) {
    setAutoStatus(result.message || "这一帧没看清，稍微调整一下光线。", "warn");
    return;
  }
  const bookId = page.book_id || state.current?.bookId;
  if (!bookId) return;
  autoScanLastAction = result.action;

  if (result.action === "same") {
    if (result.unchanged) {
      setAutoStatus(`第 ${page.page_number} 页 · 已看清`);
      return;
    }
    // 同一页但文字有更新：保留朗读位置
    const keep = currentLines()[state.current?.lineIndex || 0]?.text || "";
    const previousIndex = state.current?.lineIndex || 0;
    setCurrentPage(page, findBook(bookId));
    const lines = page.lines || [];
    let index = keep
      ? lines.findIndex((line) => String(line.text || "").trim() === keep.trim())
      : -1;
    if (index < 0) index = Math.min(previousIndex, Math.max(0, lines.length - 1));
    setLine(index);
    if (currentRoute === "reading") renderReading();
    setAutoStatus(`第 ${page.page_number} 页 · 内容已更新`);
    return;
  }

  // 翻页了：切到新的一页并自动朗读
  autoScanPage = page.page_number;
  const lineCount = (page.lines || []).length;
  try {
    await openPage(bookId, page.page_number, 0);
  } catch (error) {
    handleActionError(error, "切换到新的一页");
    return;
  }
  if (currentRoute !== "reading") {
    pendingAutoRead = true;
    navigate("reading");
  } else {
    await prepareReadingText({ force: true });
    renderReading();
    void speakCurrent();
  }
  setAutoStatus(`第 ${page.page_number} 页 · 共 ${lineCount} 行`);
  announce(`第 ${page.page_number} 页，${lineCount} 行，开始朗读。`, { interrupt: true });
}

/* -------------------------------------------------------------------------- */
/* 手机页辅助                                                                  */
/* -------------------------------------------------------------------------- */

function openDiagnostic() {
  const url = phoneInfo?.diagnostic_url;
  if (!url) {
    toast("当前没有诊断地址（隧道模式下不需要）。", { tone: "warn", iconName: "info" });
    return;
  }
  window.open(url, "_blank", "noopener");
  announce(`已打开网络自检页。用手机打开同一个地址，就能看到网络是否通。`);
}

function showTunnelHelp() {
  const text =
    "双击电脑上的「启动手机隧道.bat」。第一次会自动下载 cloudflared（约一分钟），之后会给你一个公网 HTTPS 地址和二维码。手机用 4G 或 5G 也能打开，不需要安装证书，也不受校园网隔离影响。";
  const body = el(
    "div",
    { class: "stack" },
    el("p", { text }),
    el("p", {
      class: "fineprint",
      text: "注意：隧道地址每次重启都会变，以电脑上的二维码为准；别人拿到地址也能访问，建议同时在设置里填访问令牌。",
    })
  );
  void openDialog({ title: "用公网隧道打开", body, confirmText: "知道了", cancelText: "关闭" });
  announce(text, { interrupt: true });
}

/* -------------------------------------------------------------------------- */
/* 自检                                                                        */
/* -------------------------------------------------------------------------- */

async function runOcrSelfTest() {
  const out = $("#diagnosticsOut");
  if (out) out.textContent = "正在用一张测试图片跑一次识别…";
  announce("正在自检识别引擎，第一次可能需要十几秒。", { interrupt: true });
  try {
    const result = await api.ocrSelfTest();
    if (result.ok) {
      const text = (result.lines || []).join(" / ");
      const message = `识别正常，用时 ${(Number(result.elapsed_ms || 0) / 1000).toFixed(1)} 秒。识别到：${text}`;
      if (out) out.textContent = message;
      toast(message, { iconName: "check", duration: 7000 });
      announce(message, { interrupt: true });
    } else {
      const message = `识别没有成功：${result.error || result.hint || "未知原因"}`;
      if (out) out.textContent = `${message}（提示：${result.hint || "检查依赖"}）`;
      toast(message, { tone: "error", duration: 9000 });
      announce(message, { interrupt: true });
    }
  } catch (error) {
    handleActionError(error, "识别自检");
  }
}

async function runDiagnostics() {
  const out = $("#diagnosticsOut");
  if (out) out.textContent = "正在收集环境信息…";
  try {
    const report = await api.diagnostics();
    const packages = report.packages || {};
    const missing = Object.entries(packages)
      .filter(([, version]) => !version)
      .map(([name]) => name);
    const lines = [
      `Python ${report.python || "?"} · ${report.platform || ""}`,
      `OCR：${report.ocr?.ready ? "已加载" : "尚未加载"}（${report.ocr?.engine || "rapidocr"}）`,
      `数据目录：${report.data_dir || "?"}`,
      `缺少依赖：${missing.length ? missing.join("、") : "无"}`,
      `HTTPS 证书：${report.https_certs?.exists ? "已生成" : "未生成（需要以 HTTPS 启动）"}`,
      `连接方式：${location.protocol === "https:" ? "HTTPS" : "HTTP"}`,
    ];
    const text = lines.join("；");
    const voiceInfo = voice.diagnose();
    const voiceLine = `语音：${voiceInfo.synthesis ? "可朗读" : "不可朗读"}，${voiceInfo.recognition ? "可识别" : "不能识别"}，${voiceInfo.voiceCount} 个声音${voiceInfo.chineseVoices[0] ? `（${voiceInfo.chineseVoices[0]}）` : ""}`;
    const full = `${text}；${voiceLine}`;
    if (out) out.textContent = full;
    toast("环境信息已收集，详情见下方。", { iconName: "info", duration: 5000 });
    announce(full, { interrupt: true });
  } catch (error) {
    handleActionError(error, "环境诊断");
  }
}

/** 局域网访问令牌：写入 localStorage，api.js 会自动附加到请求头。 */
async function saveAccessToken() {
  const field = $("#tokenInput");
  const value = field?.value.trim() || "";
  try {
    if (value) localStorage.setItem("paperpal.token", value);
    else localStorage.removeItem("paperpal.token");
  } catch {
    toast("浏览器不允许保存令牌。", { tone: "warn" });
    return;
  }
  toast(value ? "访问令牌已保存。" : "已清除访问令牌。", { iconName: "check" });
  announce(value ? "访问令牌已保存，正在重新连接。" : "已清除访问令牌。");
  try {
    await boot();
    applyPreferences();
    syncSettingsUI();
    renderRoute(currentRoute);
  } catch (error) {
    handleActionError(error, "重新连接");
  }
}


/* 语音指令                                                                    */
/* -------------------------------------------------------------------------- */

async function handleListenCommand() {
  if (listening) {
    stopListening();
    return;
  }
  if (!voice.recognitionSupported()) {
    toast("这个浏览器不支持语音指令，可以点按页面按钮。", { tone: "warn" });
    announce("这个浏览器不支持语音指令，可以用页面按钮。");
    return;
  }
  voice.stop();
  stopSpeech();
  listening = true;
  const button = $("#listenCommand");
  button.classList.add("is-listening");
  button.setAttribute("aria-label", "正在聆听，再次按下可停止");
  setAssistant("正在聆听…", `可以说：${voice.helpText(currentRoute)}`);
  try {
    const mic = await voice.ensureMic();
    if (!mic.ok) {
      listening = false;
      resetListenButton();
      toast(mic.reason, { tone: "warn", iconName: "mic", duration: 6000 });
      announce(mic.reason, { interrupt: true });
      return;
    }
    const { transcript } = await voice.listen({ timeout: 9000 });
    const command = voice.parseCommand(transcript);
    listening = false;
    resetListenButton();
    if (!command) {
      const message = `我听到了“${transcript}”，但还没学会这个指令。${voice.helpText(currentRoute)}`;
      announce(message, { interrupt: true, toastIt: true, tone: "warn" });
      return;
    }
    await runCommand(command, transcript);
  } catch (error) {
    listening = false;
    resetListenButton();
    const message = error.message || "没有听清，请再按一次麦克风。";
    toast(message, { tone: "warn", iconName: "mic" });
    announce(message, { interrupt: true });
  }
}

function resetListenButton() {
  const button = $("#listenCommand");
  button.classList.remove("is-listening");
  button.setAttribute("aria-label", "听我说：按下后说出语音指令");
}

function stopListening() {
  if (!listening) return;
  listening = false;
  resetListenButton();
}

async function runCommand(command, transcript = "") {
  const intent = command.intent;
  switch (intent) {
    case "home":
      navigate("welcome");
      announce("回到首页。");
      return;
    case "library":
      navigate("library");
      announce("打开书架。");
      return;
    case "notes":
      navigate("notes");
      announce("打开批注库。");
      return;
    case "settings":
      navigate("settings");
      announce("打开设置。");
      return;
    case "scan":
      if (currentRoute === "scan") {
        if (capturedBlob) await submitScan(capturedBlob);
        else await capturePhoto();
        return;
      }
      if (currentRoute === "reading" && state.current) {
        openScan(state.current.bookId, state.current.pageNumber + 1, { autoCamera: true });
        announce("准备扫描下一页。");
        return;
      }
      navigate("setup");
      announce("准备扫描。请把手机固定好。");
      return;
    case "scan-next":
      if (state.current) openScan(state.current.bookId, state.current.pageNumber + 1, { autoCamera: true });
      else navigate("setup");
      announce("准备扫描下一页。");
      return;
    case "yes":
      await handleYes();
      return;
    case "repeat":
      repeatHint();
      return;
    case "help":
      announce(voice.helpText(currentRoute), { interrupt: true, toastIt: true });
      return;
    case "back":
      if (/阅读/.test(transcript) && state.current) {
        navigate("reading");
        announce("回到阅读。");
        return;
      }
      returnToPrevious();
      return;
    case "mode-guided":
    case "mode-command":
      updateSetting("interaction_mode", intent === "mode-guided" ? "guided" : "command");
      announce(intent === "mode-guided" ? "已切换到语音引导。" : "已切换到语音指令。");
      return;
    case "faster":
    case "slower": {
      const step = intent === "faster" ? 0.1 : -0.1;
      const rate = clamp(Number(state.settings.voice_rate || 1) + step, 0.5, 2);
      updateSetting("voice_rate", Math.round(rate * 100) / 100);
      screenReaderSay(`朗读速度 ${rate.toFixed(1)} 倍。`);
      return;
    }
    case "demo":
      await startDemoReading();
      return;
    case "export":
      await exportBackup();
      return;
    default:
      break;
  }

  if (currentRoute === "reading") {
    if (intent === "next") {
      moveLine(1);
      return;
    }
    if (intent === "previous") {
      moveLine(-1);
      return;
    }
    if (intent === "play") {
      if (speechPaused) togglePlay();
      else if (!speechPlaying) void speakCurrent();
      return;
    }
    if (intent === "pause") {
      if (speechPlaying && !speechPaused) togglePlay();
      return;
    }
    if (intent === "stop") {
      stopSpeech();
      announce("已停止朗读。");
      return;
    }
    if (intent === "annotate") {
      openAnnotate();
      return;
    }
    if (intent === "next-page") {
      await goToAdjacentPage(1);
      return;
    }
    if (intent === "previous-page") {
      await goToAdjacentPage(-1);
      return;
    }
  }

  if (currentRoute === "annotate") {
    if (intent === "save") {
      await saveAnnotation();
      return;
    }
    if (intent === "cancel") {
      await cancelAnnotation();
      return;
    }
    if (intent === "line-scope") {
      setAnnotationScope("line");
      return;
    }
    if (intent === "page-scope") {
      setAnnotationScope("page");
      return;
    }
  }

  if (currentRoute === "review") {
    if (intent === "play" || intent === "yes") {
      await startReadingFromReview();
      return;
    }
    if (intent === "delete") {
      await deleteCurrentPage();
      return;
    }
  }

  if (currentRoute === "scan" && intent === "yes") {
    if (capturedBlob) await submitScan(capturedBlob);
    else await capturePhoto();
    return;
  }

  if (currentRoute === "setup" && intent === "yes") {
    openCameraFromSetup();
    return;
  }

  announce(`在当前页面还用不了“${command.label}”。${voice.helpText(currentRoute)}`, {
    interrupt: true,
    toastIt: true,
  });
}

async function handleYes() {
  if (currentRoute === "reading") {
    if (speechPaused) togglePlay();
    else if (!speechPlaying) void speakCurrent();
    return;
  }
  if (currentRoute === "setup") {
    openCameraFromSetup();
    return;
  }
  if (currentRoute === "scan") {
    if (capturedBlob) await submitScan(capturedBlob);
    else await capturePhoto();
    return;
  }
  if (currentRoute === "review") {
    await startReadingFromReview();
    return;
  }
  if (currentRoute === "annotate") {
    await saveAnnotation();
    return;
  }
  announce("好的。");
}

function returnToPrevious() {
  switch (currentRoute) {
    case "scan":
      navigate("setup");
      break;
    case "review":
      navigate("scan");
      break;
    case "reading":
      navigate("library");
      break;
    case "annotate":
      void cancelAnnotation();
      break;
    case "notes":
      navigate(state.current ? "reading" : "welcome");
      break;
    case "settings":
      navigate("welcome");
      break;
    case "devices":
      navigate("settings");
      break;
    default:
      navigate("welcome");
  }
}

function repeatHint() {
  switch (currentRoute) {
    case "welcome":
      announce("可以开始扫描新页面，继续上次阅读，或者打开书架。");
      break;
    case "setup":
      speakGuide();
      return;
    case "scan":
      announce("把书页放进取景框，按拍照并识别。也可以从相册选择照片。");
      break;
    case "reading": {
      const line = currentLines()[state.current?.lineIndex || 0];
      if (line) announce(`第 ${state.current.lineIndex + 1} 行：${line.text}`, { interrupt: true });
      else announce("这一页还没有可朗读的文字。");
      break;
    }
    case "annotate":
      announce(`正在记录批注。当前范围是${annotation?.scope === "page" ? "整页" : `第 ${annotation?.lineNumber} 行`}。`);
      break;
    default:
      announce("这个问题可以再说一次：重复提示。");
  }
}

/* -------------------------------------------------------------------------- */
/* 演示                                                                        */
/* -------------------------------------------------------------------------- */

async function startDemoReading() {
  try {
    const book = await ensureDemoBook();
    if (!book) {
      toast("演示书籍暂时不可用。", { tone: "warn" });
      return;
    }
    const pageNumber = book.last_page || 12;
    const current = await openPage(book.id, pageNumber, 0);
    if (!current) {
      toast("演示页还没有准备好。", { tone: "warn" });
      return;
    }
    pendingAutoRead = true;
    navigate("reading");
    announce("这是演示内容。可以按下一行、上一行，或添加批注。", { interrupt: true });
  } catch (error) {
    handleActionError(error, "打开演示");
  }
}

/* -------------------------------------------------------------------------- */
/* 动作分发                                                                    */
/* -------------------------------------------------------------------------- */

async function handleAction(action, element) {
  switch (action) {
    case "start-scan":
      navigate("setup");
      return;
    case "open-library":
      navigate("library");
      return;
    case "open-notes":
      navigate("notes");
      return;
    case "open-note":
      openAnnotate();
      return;
    case "back":
      returnToPrevious();
      return;
    case "add-book":
      await addBookDialog();
      return;
    case "demo-book":
      try {
        const book = await ensureDemoBook();
        if (book) {
          toast(`演示书籍《${book.title}》已加入书架。`);
          renderLibrary();
        }
      } catch (error) {
        handleActionError(error, "加入演示书籍");
      }
      return;
    case "demo-reading":
      await startDemoReading();
      return;
    case "open-camera":
      if (currentRoute === "setup") openCameraFromSetup();
      else await startCamera();
      return;
    case "repeat-hint":
      repeatHint();
      return;
    case "capture":
      if (capturedBlob) await submitScan(capturedBlob);
      else await capturePhoto();
      return;
    case "gallery":
      $("#galleryInput")?.click();
      return;
    case "retake":
      await retakePhoto();
      return;
    case "page-minus":
    case "page-plus": {
      const field = $("#pageNumber");
      if (!field) return;
      const next = Math.max(1, (Number(field.value) || 1) + (action === "page-plus" ? 1 : -1));
      field.value = String(next);
      return;
    }
    case "start-reading":
      await startReadingFromReview();
      return;
    case "rescan":
      await rescanCurrentPage();
      return;
    case "delete-page":
      await deleteCurrentPage();
      return;
    case "speak":
      togglePlay();
      return;
    case "previous":
      moveLine(-1);
      return;
    case "next":
      moveLine(1);
      return;
    case "speed-down":
    case "speed-up": {
      const delta = action === "speed-up" ? 0.1 : -0.1;
      const rate = clamp(Number(state.settings.voice_rate || 1) + delta, 0.5, 2);
      updateSetting("voice_rate", Math.round(rate * 100) / 100);
      screenReaderSay(`朗读速度 ${rate.toFixed(1)} 倍。`);
      return;
    }
    case "previous-page":
      await goToAdjacentPage(-1);
      return;
    case "next-page":
      await goToAdjacentPage(1);
      return;
    case "scan-next":
      if (state.current) openScan(state.current.bookId, state.current.pageNumber + 1, { autoCamera: true });
      else navigate("setup");
      return;
    case "back-reading":
      navigate(state.current ? "reading" : "welcome");
      return;
    case "listen-note":
      await startNoteDictation();
      return;
    case "save-note":
      await saveAnnotation();
      return;
    case "cancel-note":
      await cancelAnnotation();
      return;
    case "open-devices":
      navigate("devices");
      return;
    case "ble-connect":
      await connectBluetooth();
      return;
    case "ble-disconnect":
      await disconnectBluetooth();
      return;
    case "ble-learn":
      if (!bleSnapshot.connected) {
        toast("先连接蓝牙设备，再学习按键。", { tone: "warn", iconName: "bluetooth" });
        return;
      }
      bleLearning = true;
      toast("请按一下蓝牙遥控器的按键，然后选择对应动作。", {
        iconName: "bluetooth",
        duration: 5000,
      });
      return;
    case "ble-save-nickname": {
      const value = $("#bleNickname")?.value.trim() || "";
      if (!value) {
        toast("请输入设备昵称。", { tone: "warn", iconName: "bluetooth" });
        return;
      }
      bluetooth.saveName(value);
      bleSnapshot.lastName = value;
      updateBluetoothUI();
      toast(`设备昵称已保存：${value}`, { iconName: "check" });
      return;
    }
    case "save-name":
      await saveReaderName();
      return;
    case "export":
      await exportBackup();
      return;
    case "import":
      $("#importInput")?.click();
      return;
    case "clear-data":
      await clearEverything();
      return;
    case "test-prev":
      if (!state.current) {
        toast("先在阅读页打开一页书，再测试按键。", { tone: "warn", iconName: "info" });
        return;
      }
      moveLine(-1);
      return;
    case "test-next":
      if (!state.current) {
        toast("先在阅读页打开一页书，再测试按键。", { tone: "warn", iconName: "info" });
        return;
      }
      moveLine(1);
      return;
    case "test-toggle":
      if (!state.current) {
        toast("先在阅读页打开一页书，再测试按键。", { tone: "warn", iconName: "info" });
        return;
      }
      togglePlay();
      return;
    case "test-note":
      if (!state.current) {
        toast("先在阅读页打开一页书，再添加批注。", { tone: "warn", iconName: "info" });
        return;
      }
      openAnnotate();
      return;
    case "open-phone":
      navigate("phone");
      return;
    case "media-enable":
      await enableMediaControls();
      return;
    case "media-disable":
      input.disableMediaControls();
      updateMediaUI();
      toast("耳机按键已关闭。", { iconName: "headphones" });
      return;
    case "bench-clear":
      input.clearLog();
      renderInputLog();
      announce("按键记录已清空。");
      return;
    case "copy-phone-url":
      await copyPhoneUrl();
      return;
    case "install-profile":
      installProfile();
      return;
    case "copy-troubleshoot":
      await copyTroubleshoot();
      return;
    case "ocr-selftest":
      await runOcrSelfTest();
      return;
    case "run-diagnostics":
      await runDiagnostics();
      return;
    case "save-token":
      await saveAccessToken();
      return;
    case "start-pairing":
      startPairing();
      return;
    case "device-rename":
      await renameDevice(element?.dataset?.id || "");
      return;
    case "device-remove":
      removeDevice(element?.dataset?.id || "");
      return;
    case "clear-devices":
      devices.clear();
      renderDeviceRegistry();
      toast("设备列表已清空。", { iconName: "trash" });
      announce("设备列表已清空。");
      return;
    case "toggle-auto":
      await toggleAutoScan();
      return;
    case "start-auto-scan":
      navigate("scan");
      window.setTimeout(() => {
        void startAutoScan();
      }, 260);
      return;
    case "stop-auto":
      stopAutoScan("已停止自动扫描。");
      return;
    case "refresh-phone":
      await renderPhone();
      announce("已重新检测手机连接。");
      return;
    case "open-diagnostic":
      openDiagnostic();
      return;
    case "tunnel-help":
      showTunnelHelp();
      return;
    default:
      break;
  }
}

/* -------------------------------------------------------------------------- */
/* 事件绑定                                                                    */
/* -------------------------------------------------------------------------- */

function bindEvents() {
  document.addEventListener("click", (event) => {
    const actionElement = event.target.closest("[data-action]");
    if (actionElement) {
      if (actionElement.disabled) return;
      event.preventDefault();
      handleAction(actionElement.dataset.action, actionElement).catch((error) =>
        handleActionError(error, "操作")
      );
      return;
    }
    const mode = event.target.closest("[data-mode]");
    if (mode) {
      updateSetting("interaction_mode", mode.dataset.mode);
      window.setTimeout(() => {
        if (currentRoute === "welcome") navigate("setup");
      }, 140);
      return;
    }
    const scope = event.target.closest("#scopeGroup [data-value]");
    if (scope) {
      setAnnotationScope(scope.dataset.value);
      return;
    }
    const layout = event.target.closest("#layoutGroup [data-value]");
    if (layout) {
      setLayout(layout.dataset.value);
      return;
    }
    const settingSwitch = event.target.closest(".switch[data-setting]");
    if (settingSwitch) {
      const key = settingSwitch.dataset.setting;
      updateSetting(key, !state.settings[key]);
      return;
    }
    const settingGroup = event.target.closest("[data-setting-group] button[data-value]");
    if (settingGroup) {
      const group = settingGroup.closest("[data-setting-group]");
      const key = group.dataset.settingGroup;
      const value = settingGroup.dataset.value;
      if (
        key === "translation_target" &&
        value !== "off" &&
        !localStorage.getItem("paperpal.translationConsent.v1")
      ) {
        void (async () => {
          const ok = await confirmDialog(
            "开启在线翻译？",
            "译文由在线翻译服务生成，只会发送当前页的文字，不会上传图片、批注或整本书。需要联网；关闭翻译后不会发送。",
            { confirmText: "开启翻译", tone: "primary" }
          );
          if (!ok) {
            syncSettingsUI();
            return;
          }
          localStorage.setItem("paperpal.translationConsent.v1", "1");
          updateSetting(key, value);
        })();
        return;
      }
      updateSetting(key, value);
      return;
    }
    const noteFilter = event.target.closest("#noteFilter [data-value]");
    if (noteFilter) {
      notesScope = noteFilter.dataset.value;
      $$("#noteFilter button").forEach((button) => {
        button.setAttribute("aria-checked", String(button.dataset.value === notesScope));
      });
      renderNotes();
      return;
    }
    const routeButton = event.target.closest(".tabbar [data-route]");
    if (routeButton) {
      navigate(routeButton.dataset.route);
      return;
    }
    if (event.target.closest("#resumeCard")) {
      const entry = pickResume();
      if (entry) void openReading(entry.bookId, entry.pageNumber, entry.lineIndex, { speak: true });
      return;
    }
    if (event.target.closest("#helpBtn")) {
      repeatHint();
      return;
    }
    if (event.target.closest("#torchBtn")) {
      void toggleTorch();
      return;
    }
    if (event.target.closest("#devicePad")) {
      $("#devicePad")?.focus({ preventScroll: true });
    }
  });

  $("#listenCommand")?.addEventListener("click", (event) => {
    event.stopPropagation();
    void handleListenCommand();
  });
  $("#saveNameBtn")?.addEventListener("click", () => void saveReaderName());
  $("#readerName")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveReaderName();
    }
  });

  $("#librarySearch")?.addEventListener("input", (event) => {
    libraryQuery = event.target.value.trim();
    renderLibrary();
  });
  $("#bookSelect")?.addEventListener("change", () => {
    toggleNewBookFields();
    const select = $("#bookSelect");
    const book = findBook(select?.value || "");
    const page = $("#pageNumber");
    if (page && book) page.value = String(Math.max(1, (Number(book.last_page) || 0) + 1));
    if (book) localStorage.setItem(LAST_BOOK_KEY, book.id);
    updateScanSettingsSummary();
  });
  $("#pageNumber")?.addEventListener("change", (event) => {
    event.target.value = String(Math.max(1, Number(event.target.value) || 1));
    updateScanSettingsSummary();
  });
  $("#pageNumber")?.addEventListener("input", updateScanSettingsSummary);
  $("#newBookTitle")?.addEventListener("input", updateScanSettingsSummary);
  $("#scanForm")?.addEventListener("submit", (event) => event.preventDefault());
  $("#rotationSelect")?.addEventListener("change", (event) => {
    saveScanPrefs({ rotation: Number(event.target.value) || 0 });
  });
  $("#splitPosition")?.addEventListener("input", (event) => {
    saveScanPrefs({ splitPosition: Number(event.target.value) || 0.5 });
    updateSplitOutput();
    updateScanSettingsSummary();
  });
  $("#galleryInput")?.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setCapturedPhoto(file);
    setScanStatus("照片已选好", { percent: 0 });
    setScanMessage("正在准备识别所选照片…");
    void submitScan(file);
  });

  $("#annotationText")?.addEventListener("input", updateCharCount);
  $("#noteSearch")?.addEventListener("input", saveNotesSearch);
  $("#importInput")?.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void importBackupFile(file);
  });

  document.addEventListener("input", (event) => {
    const range = event.target.closest('input[type="range"][data-setting]');
    if (!range) return;
    const key = range.dataset.setting;
    const value = Number(range.value);
    state.settings = { ...state.settings, [key]: value };
    applyPreferences();
    const outputs = {
      voice_rate: () => {
        const node = $("#voiceRateOut");
        if (node) node.textContent = formatRate(value);
      },
      voice_pitch: () => {
        const node = $("#voicePitchOut");
        if (node) node.textContent = value.toFixed(2);
      },
      font_scale: () => {
        const node = $("#fontScaleOut");
        if (node) node.textContent = `${Math.round(value * 100)}%`;
      },
      auto_advance_delay: () => {
        const node = $("#autoDelayOut");
        if (node) node.textContent = `${value.toFixed(1)} 秒`;
      },
    };
    outputs[key]?.();
    pendingSettings[key] = value;
    flushSettings();
  });

  document.addEventListener("change", (event) => {
    const select = event.target.closest("select[data-setting]");
    if (select) updateSetting(select.dataset.setting, select.value);
  });

  window.addEventListener("hashchange", () => showRoute(parseRoute()));
  window.addEventListener("online", () => {
    toast("网络已恢复，正在同步…", { iconName: "refresh" });
    markOnline();
    updateOfflineBanner();
    updateServerChip();
    void flushOutbox().then(() => storeRefreshNotes());
  });
  window.addEventListener("offline", () => {
    markOffline();
    updateOfflineBanner();
    updateServerChip();
    toast("已进入离线模式，批注会先存在本机。", { tone: "warn", iconName: "wifi-off" });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      interruptedPlayback = speechPlaying && !speechPaused;
      persistProgressNow();
      flushReadingSession(false);
      if (speechPlaying) {
        playToken += 1;
        voice.stop();
        speechPlaying = false;
        speechPaused = false;
        clearTimeout(autoTimer);
        updatePlaybackUI();
        if (currentRoute === "reading") {
          setReadStatus(
            "已暂停，进度已保存",
            `来电或切到后台后已停在当前位置；回来后按朗读继续。`
          );
        }
      }
      void releaseWakeLock();
      return;
    }
    if (interruptedPlayback) {
      interruptedPlayback = false;
      if (currentRoute === "reading") {
        setReadStatus("已暂停，进度已保存", "按朗读，从这一行继续。");
      }
    }
    void syncWakeLock();
  });

  window.addEventListener("pageshow", () => {
    void syncWakeLock();
  });

  window.addEventListener("pagehide", () => {
    persistProgressNow();
    flushReadingSession(true);
    void releaseWakeLock();
    if (currentRoute === "reading" && state.backend && state.current && !localStorage.getItem("paperpal.token")) {
      const payload = {
        kind: "read",
        book_id: state.current.bookId,
        page_number: state.current.pageNumber,
        lines: 0,
        seconds: 1,
      };
      try {
        navigator.sendBeacon(
          "/api/v1/activity",
          new Blob([JSON.stringify(payload)], { type: "application/json" })
        );
      } catch {
        /* 忽略 */
      }
    }
  });

  const appBar = $(".app-bar");
  window.addEventListener(
    "scroll",
    () => {
      appBar?.classList.toggle("is-scrolled", window.scrollY > 8);
    },
    { passive: true }
  );

  subscribe((_, reason) => {
    updateOfflineBanner();
    updateServerChip();
    if (reason === "settings" || reason === "profile") {
      applyPreferences();
      syncSettingsUI();
      if (currentRoute === "welcome") renderWelcome();
      if (currentRoute === "reading") updatePlaybackUI();
    } else if (reason === "books") {
      if (currentRoute === "library") renderLibrary();
    } else if (reason === "notes") {
      if (currentRoute === "notes") renderNotes();
      if (currentRoute === "welcome") renderWelcome();
    } else if (reason === "page") {
      if (currentRoute === "reading") renderReading();
    } else if (reason === "bootstrap") {
      syncSettingsUI();
      if (currentRoute === "welcome") renderWelcome();
      if (currentRoute === "library") renderLibrary();
    } else if (reason === "offline") {
      if (currentRoute === "settings") syncSettingsUI();
      toast(
        pendingCount()
          ? `离线模式：${pendingCount()} 条改动会在联网后同步。`
          : "离线模式：批注会先存在本机。",
        { tone: "warn", iconName: "wifi-off", duration: 4200 }
      );
    } else if (reason === "online") {
      updateOfflineBanner();
      updateServerChip();
      if (currentRoute === "settings") syncSettingsUI();
      toast("已恢复连接，正在同步本机改动。", { iconName: "check" });
      void refreshStats();
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Service Worker 与视口                                                       */
/* -------------------------------------------------------------------------- */

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !location.protocol.startsWith("http")) return;
  const register = async () => {
    try {
      const registration = await navigator.serviceWorker.register("/sw.js");
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            toast("新版本已准备好，下次打开会自动更新。", { iconName: "refresh", duration: 5000 });
          }
        });
      });
    } catch (error) {
      console.warn("service worker", error);
    }
  };
  if (document.readyState === "complete") void register();
  else window.addEventListener("load", register, { once: true });
}

/* -------------------------------------------------------------------------- */

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    if (!initialized) {
      initialized = true;
      void init();
    }
  });
} else if (!initialized) {
  initialized = true;
  void init();
}

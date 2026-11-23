/* 轻量 UI 工具：DOM、图标、Toast、对话框、日期与读屏播报。 */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function icon(name, className = "icon") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

export function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

export function debounce(fn, wait = 250) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return wrapped;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function vibrate(pattern = 12) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch {
    /* 忽略不支持振动的设备 */
  }
}

/* -------------------------------------------------------------------------- */
/* Toast                                                                      */
/* -------------------------------------------------------------------------- */

let toastTimer = null;

export function toast(message, { tone = "", duration = 3400, iconName = "check" } = {}) {
  const node = $("#toast");
  if (!node) return;
  const text = $("#toastText");
  if (text) text.textContent = message;
  const use = node.querySelector("use");
  if (use) use.setAttribute("href", `#i-${iconName}`);
  node.classList.remove("toast--warn", "toast--error");
  if (tone === "warn") node.classList.add("toast--warn");
  if (tone === "error") node.classList.add("toast--error");
  node.hidden = false;
  requestAnimationFrame(() => node.classList.add("is-visible"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.classList.remove("is-visible");
    setTimeout(() => {
      if (!node.classList.contains("is-visible")) node.hidden = true;
    }, 260);
  }, duration);
}

/* -------------------------------------------------------------------------- */
/* 对话框                                                                      */
/* -------------------------------------------------------------------------- */

let activeDialogFinish = null;

export function openDialog({
  title = "确认",
  body = "",
  confirmText = "确认",
  cancelText = "取消",
  tone = "",
  getValue = null,
  onOpen = null,
} = {}) {
  const dialog = $("#dialog");
  if (!dialog) return Promise.resolve(null);
  if (activeDialogFinish) {
    const previous = activeDialogFinish;
    activeDialogFinish = null;
    previous(null);
  }
  if (dialog.open) dialog.close();

  const titleEl = $("#dialogTitle");
  const bodyEl = $("#dialogBody");
  const confirmBtn = $("#dialogConfirm");
  const cancelBtn = $("#dialogCancel");
  if (titleEl) titleEl.textContent = title;
  if (bodyEl) {
    bodyEl.replaceChildren();
    if (body instanceof Node) bodyEl.append(body);
    else if (Array.isArray(body)) {
      for (const item of body) {
        bodyEl.append(item instanceof Node ? item : document.createTextNode(String(item)));
      }
    } else if (body !== null && body !== undefined && body !== "") {
      bodyEl.append(document.createTextNode(String(body)));
    }
    if (typeof onOpen === "function") onOpen(bodyEl);
  }
  if (confirmBtn) {
    confirmBtn.textContent = confirmText;
    confirmBtn.className = tone === "danger" ? "btn btn--danger" : "btn btn--primary";
  }
  if (cancelBtn) cancelBtn.textContent = cancelText;

  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      confirmBtn?.removeEventListener("click", onConfirm);
      cancelBtn?.removeEventListener("click", onCancelClick);
      dialog.removeEventListener("cancel", onNativeCancel);
      dialog.removeEventListener("click", onBackdrop);
      activeDialogFinish = null;
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        if (dialog.open) dialog.close();
      } catch {
        /* 忽略关闭异常 */
      }
      resolve(value);
    };
    const onConfirm = () => finish(typeof getValue === "function" ? getValue() : true);
    const onCancelClick = () => finish(null);
    const onNativeCancel = (event) => {
      event.preventDefault();
      finish(null);
    };
    const onBackdrop = (event) => {
      if (event.target === dialog) finish(null);
    };
    activeDialogFinish = finish;
    confirmBtn?.addEventListener("click", onConfirm);
    cancelBtn?.addEventListener("click", onCancelClick);
    dialog.addEventListener("cancel", onNativeCancel);
    dialog.addEventListener("click", onBackdrop);
    try {
      dialog.showModal();
    } catch {
      finish(null);
      return;
    }
    requestAnimationFrame(() => {
      const focusable = bodyEl?.querySelector("input, textarea, select");
      (focusable || confirmBtn)?.focus();
    });
  });
}

export function confirmDialog(title, body, { confirmText = "确认", tone = "danger" } = {}) {
  return openDialog({ title, body, confirmText, cancelText: "取消", tone }).then((value) =>
    Boolean(value)
  );
}

/* -------------------------------------------------------------------------- */
/* 时间与数字                                                                  */
/* -------------------------------------------------------------------------- */

function asDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value) {
  const date = asDate(value);
  if (!date) return "";
  const now = new Date();
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return `今天 ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  ) {
    return `昨天 ${time}`;
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${time}`;
  }
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

export function pct(value, total) {
  if (!total) return 0;
  return clamp(Math.round((Number(value) / Number(total)) * 100), 0, 100);
}

/* -------------------------------------------------------------------------- */
/* 读屏播报                                                                    */
/* -------------------------------------------------------------------------- */

export function screenReaderSay(text) {
  const region = $("#srStatus");
  if (!region || !text) return;
  region.textContent = "";
  requestAnimationFrame(() => {
    region.textContent = text;
  });
}

export function scrollIntoViewSafe(node, options = { block: "center", behavior: "smooth" }) {
  if (!node || typeof node.scrollIntoView !== "function") return;
  try {
    node.scrollIntoView(options);
  } catch {
    node.scrollIntoView();
  }
}

export function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

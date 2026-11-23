/* PaperPal API 客户端：统一的错误、超时、上传进度与离线判定。 */

const BASE = "/api/v1";

export class ApiError extends Error {
  constructor(message, { status = 0, code = "error", network = false, timeout = false, payload = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.network = network;
    this.timeout = timeout;
    this.payload = payload;
  }
}

function token() {
  try {
    return localStorage.getItem("paperpal.token") || "";
  } catch {
    return "";
  }
}

function authHeaders(extra = {}) {
  const headers = { ...extra };
  const value = token();
  if (value) headers.Authorization = `Bearer ${value}`;
  return headers;
}

async function readPayload(response) {
  const type = response.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  try {
    return { error: await response.text() };
  } catch {
    return null;
  }
}

async function request(path, { method = "GET", body, timeout = 20000, headers = {} } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  const options = {
    method,
    headers: authHeaders(headers),
    signal: controller.signal,
    cache: "no-store",
  };
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof FormData || typeof body === "string") {
      options.body = body;
    } else {
      options.body = JSON.stringify(body);
      options.headers["Content-Type"] = "application/json";
    }
  }
  let response;
  try {
    response = await fetch(BASE + path, options);
  } catch (error) {
    clearTimeout(timer);
    if (timedOut) {
      throw new ApiError("请求超时了，请检查本机服务是否在运行。", { network: true, timeout: true });
    }
    throw new ApiError("连接不到本机服务。请确认后端已启动，或稍后重试。", { network: true });
  }
  clearTimeout(timer);
  const payload = await readPayload(response);
  if (!response.ok) {
    const message =
      (payload && (payload.error || payload.detail)) || `请求失败（${response.status}）。`;
    throw new ApiError(message, {
      status: response.status,
      code: (payload && payload.code) || `http_${response.status}`,
      payload,
    });
  }
  return payload;
}

export const api = {
  /* 健康检查不要求令牌，用于顶栏状态。 */
  async health() {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) throw new ApiError("服务状态不可用。", { status: response.status });
    return response.json();
  },

  bootstrap() {
    return request("/bootstrap", { timeout: 15000 });
  },

  getSettings() {
    return request("/settings");
  },

  transformText(lines, { script = "simplified", translation = "off" } = {}) {
    return request("/text/transform", {
      method: "POST",
      body: { lines, script, translation },
      timeout: 60000,
    });
  },

  updateSettings(patch) {
    return request("/settings", { method: "PUT", body: patch });
  },

  updateProfile(name) {
    return request("/profile", { method: "PATCH", body: { name } });
  },

  async getBooks() {
    const payload = await request("/books");
    return payload.books || [];
  },

  createBook(book) {
    return request("/books", { method: "POST", body: book });
  },

  updateBook(id, patch) {
    return request(`/books/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
  },

  deleteBook(id) {
    return request(`/books/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  getBook(id) {
    return request(`/books/${encodeURIComponent(id)}`);
  },

  ensureDemoBook() {
    return request("/demo-book", { method: "POST", timeout: 20000 });
  },

  getPage(pageId) {
    return request(`/pages/${encodeURIComponent(pageId)}`);
  },

  async getPageByNumber(bookId, pageNumber) {
    return request(
      `/books/${encodeURIComponent(bookId)}/pages/${Number(pageNumber)}`,
      { timeout: 15000 }
    );
  },

  deletePage(pageId) {
    return request(`/pages/${encodeURIComponent(pageId)}`, { method: "DELETE" });
  },

  /**
   * 扫描上传走 XHR，因为 fetch 读不到上传进度。
   */
  scanPage({ bookId, pageNumber, layout = "none", rotation = 0, splitPosition = 0.5, file, onProgress, timeout = 180000 }) {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        page_number: String(pageNumber),
        layout,
        rotation: String(rotation),
        split_position: String(splitPosition),
        mode: "auto",
        min_confidence: "0.4",
      });
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${BASE}/books/${encodeURIComponent(bookId)}/pages?${params.toString()}`);
      xhr.setRequestHeader("Content-Type", file.type || "image/jpeg");
      const tokenValue = token();
      if (tokenValue) xhr.setRequestHeader("Authorization", `Bearer ${tokenValue}`);
      xhr.responseType = "json";
      xhr.timeout = timeout;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) {
          onProgress({ phase: "upload", loaded: event.loaded, total: event.total });
        }
      };
      xhr.upload.onload = () => {
        if (onProgress) onProgress({ phase: "recognize" });
      };
      xhr.onload = () => {
        if (settled) return;
        const payload = xhr.response;
        if (xhr.status >= 200 && xhr.status < 300) {
          settled = true;
          resolve(payload);
          return;
        }
        const message =
          (payload && (payload.error || payload.detail)) ||
          `识别失败（${xhr.status}）。请换一张更清楚的照片。`;
        fail(
          new ApiError(message, {
            status: xhr.status,
            code: (payload && payload.code) || `http_${xhr.status}`,
            payload,
          })
        );
      };
      xhr.onerror = () =>
        fail(new ApiError("上传时连接中断。请确认服务在运行，再试一次。", { network: true }));
      xhr.ontimeout = () =>
        fail(new ApiError("识别时间过长。请缩小照片或稍后重试。", { timeout: true }));
      xhr.onabort = () => fail(new ApiError("已取消本次识别。", { code: "aborted" }));
      try {
        xhr.send(file);
      } catch (error) {
        fail(new ApiError(`无法读取照片：${error.message || "未知错误"}`, { network: true }));
      }
    });
  },

  async listNotes({ bookId = "", query = "", scope = "", limit = 500, offset = 0 } = {}) {
    const params = new URLSearchParams();
    if (bookId) params.set("book_id", bookId);
    if (query) params.set("q", query);
    if (scope) params.set("scope", scope);
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    return request(`/notes?${params.toString()}`);
  },

  createNote(note) {
    return request("/notes", { method: "POST", body: note });
  },

  updateNote(id, patch) {
    return request(`/notes/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
  },

  deleteNote(id) {
    return request(`/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  saveProgress(progress) {
    return request("/progress", { method: "PUT", body: progress, timeout: 10000 });
  },

  postActivity(activity) {
    return request("/activity", { method: "POST", body: activity, timeout: 10000 });
  },

  getStats(days = 14) {
    return request(`/stats?days=${Number(days)}`);
  },

  async exportAll() {
    const response = await fetch(`${BASE}/export`, {
      headers: authHeaders(),
      cache: "no-store",
    });
    if (!response.ok) {
      const payload = await readPayload(response);
      throw new ApiError((payload && payload.error) || "导出失败。", {
        status: response.status,
        payload,
      });
    }
    const disposition = response.headers.get("content-disposition") || "";
    const match = /filename="([^"]+)"/.exec(disposition);
    return {
      text: await response.text(),
      filename: match ? match[1] : "paperpal-backup.json",
    };
  },

  importAll(payload, mode = "merge") {
    return request(`/import?mode=${encodeURIComponent(mode)}`, {
      method: "POST",
      body: payload,
      timeout: 60000,
    });
  },

  clearAll() {
    return request("/data", { method: "DELETE", timeout: 30000 });
  },

  /* 手机接入信息：局域网地址、二维码、证书指纹与安装步骤。 */
  phoneInfo() {
    return request("/phone", { timeout: 15000 });
  },

  /* 环境快照：依赖、OCR、数据目录与证书。 */
  diagnostics() {
    return request("/diagnostics", { timeout: 30000 });
  },

  /* 用后端生成的测试图片跑一次真实 OCR。 */
  ocrSelfTest() {
    return request("/ocr/self-test", { method: "POST", timeout: 180000 });
  },

  /**
   * 免按键连续扫描：上传一帧，后端判断"同一页"还是"翻页了"。
   * 走 fetch（不需要上传进度），超时放宽到 90 秒。
   */
  async autoScan({ bookId, file, layout = "none", rotation = 0, pageNumber = null }) {
    const params = new URLSearchParams({
      layout,
      rotation: String(rotation),
      min_confidence: "0.4",
      max_side: "1280",
    });
    if (pageNumber) params.set("page_number", String(pageNumber));
    const response = await fetch(
      `${BASE}/books/${encodeURIComponent(bookId)}/auto-scan?${params.toString()}`,
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": file.type || "image/jpeg" }),
        body: file,
        cache: "no-store",
      }
    );
    const payload = await readPayload(response);
    if (!response.ok) {
      throw new ApiError((payload && (payload.error || payload.detail)) || "自动识别失败。", {
        status: response.status,
        code: (payload && payload.code) || `http_${response.status}`,
        payload,
      });
    }
    return payload;
  },
};

export function isNetworkError(error) {
  return Boolean(error && (error.network || error.timeout));
}

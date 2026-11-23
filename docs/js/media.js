/* 媒体会话桥：让蓝牙耳机的播放/暂停、上一首/下一首按键能控制朗读。

   浏览器只在页面有"正在播放的媒体"时才把耳机按键交给网页，所以这里维持一个
   无声的循环音轨占住媒体会话；用户点过"启用耳机按键"（一次手势）后即可生效。
   iPhone 上耳机按键会走系统"正在播放"，因此需要在控制中心里看到纸伴。 */

const SILENCE_SECONDS = 1;
let audio = null;
let objectUrl = "";
let handlers = {};
let metadata = { title: "纸伴", artist: "陪你读书", album: "" };
let playing = false;

export function supported() {
  return typeof navigator !== "undefined" && "mediaSession" in navigator && typeof window !== "undefined";
}

export function enabled() {
  return Boolean(audio);
}

export function snapshot() {
  return { supported: supported(), enabled: enabled(), playing };
}

function silenceTrack() {
  // 用程序生成 1 秒静音 WAV，避免额外请求，也避免某些浏览器对空音频的怪异处理。
  const sampleRate = 8000;
  const samples = sampleRate * SILENCE_SECONDS;
  const bytes = 44 + samples * 2;
  const buffer = new ArrayBuffer(bytes);
  const view = new DataView(buffer);
  const writeString = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  writeString(0, "RIFF");
  view.setUint32(4, bytes - 8, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples * 2, true);
  return new Blob([buffer], { type: "audio/wav" });
}

function applyMetadata() {
  if (!supported() || !window.MediaMetadata) return;
  try {
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: metadata.title || "纸伴",
      artist: metadata.artist || "陪你读书",
      album: metadata.album || "纸伴 PaperPal",
    });
  } catch {
    /* 忽略不支持的字段 */
  }
}

function bindAction(action, name) {
  if (!supported() || !navigator.mediaSession.setActionHandler) return;
  try {
    navigator.mediaSession.setActionHandler(action, () => {
      handlers.onAction?.(name, "media");
    });
  } catch {
    /* 该浏览器不支持这个动作，忽略 */
  }
}

function registerHandlers() {
  bindAction("play", "toggle");
  bindAction("pause", "toggle");
  bindAction("stop", "stop");
  bindAction("nexttrack", "next");
  bindAction("previoustrack", "prev");
  bindAction("seekforward", "next");
  bindAction("seekbackward", "prev");
}

/**
 * 启用耳机按键：必须在用户手势（点击）里调用。
 * 返回 { ok, reason }。
 */
export async function enable({ onAction } = {}) {
  if (!supported()) {
    return {
      ok: false,
      reason: "这个浏览器不支持媒体会话，耳机按键可能无法直接控制朗读。可以改用蓝牙键盘或翻页器。",
    };
  }
  if (onAction) handlers.onAction = onAction;
  if (!audio) {
    try {
      objectUrl = URL.createObjectURL(silenceTrack());
      audio = new Audio(objectUrl);
      audio.loop = true;
      audio.volume = 0;
      audio.setAttribute("playsinline", "");
      audio.setAttribute("aria-hidden", "true");
    } catch {
      return { ok: false, reason: "无法创建媒体音轨。" };
    }
  }
  try {
    await audio.play();
  } catch {
    return {
      ok: false,
      reason: "浏览器阻止了后台播放。请再点一次“启用耳机按键”，或检查是否处于静音/省电模式。",
    };
  }
  applyMetadata();
  registerHandlers();
  playing = true;
  return { ok: true, reason: "" };
}

export function setHandlers(next = {}) {
  handlers = { ...handlers, ...next };
  if (enabled()) registerHandlers();
}

/** 更新控制中心 / 锁屏上显示的书名、页号和进度。 */
export function updateNowPlaying({ title = "", artist = "", album = "", position = 0, duration = 0 } = {}) {
  metadata = { ...metadata, title, artist, album };
  if (!enabled()) return;
  applyMetadata();
  if (typeof navigator.mediaSession.setPositionState !== "function") return;
  if (!duration || !Number.isFinite(duration) || duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: Math.max(1, duration),
      playbackRate: 1,
      position: Math.max(0, Math.min(duration, position)),
    });
  } catch {
    /* 忽略非法区间 */
  }
}

export function setPlaying(next) {
  playing = Boolean(next);
  if (!enabled()) return;
  try {
    navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  } catch {
    /* 忽略 */
  }
  if (audio) {
    if (playing && audio.paused) audio.play().catch(() => {});
    if (!playing && !audio.paused) audio.pause();
  }
}

export function disable() {
  if (audio) {
    try {
      audio.pause();
    } catch {
      /* 忽略 */
    }
  }
  if (supported() && navigator.mediaSession.setActionHandler) {
    for (const action of ["play", "pause", "stop", "nexttrack", "previoustrack", "seekforward", "seekbackward"]) {
      try {
        navigator.mediaSession.setActionHandler(action, null);
      } catch {
        /* 忽略 */
      }
    }
  }
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = "";
  audio = null;
  playing = false;
}

export function lastErrorHint() {
  return "如果耳机按键没有反应：先用耳机播放任意音乐确认按键正常，再回到纸伴点“启用耳机按键”；iPhone 可以在控制中心里确认看到“纸伴”。";
}

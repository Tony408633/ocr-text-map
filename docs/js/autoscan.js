/* 连续自动扫描（免按键）：盲人用户把手机固定在书页上方后，不需要拍照。

   相机会一直取帧，本地先判断"画面清不清楚 / 和上一次相比有没有变化"，
   只有清晰且变化明显时才把这一帧发给后端识别，避免每一秒都跑一次 OCR。
   后端会回答"还是同一页"还是"翻页了"，前端据此更新阅读位置。 */

import { api } from "./api.js";

const SAMPLE_WIDTH = 48;
const SAMPLE_HEIGHT = 64;
const TICK_MS = 850;
const MIN_SEND_GAP = 1600;
const STILL_DISTANCE = 0.012;
const CHANGE_DISTANCE = 0.02;
const MIN_SHARPNESS = 10;
const MAX_SIDE = 1600;

let loop = null;

function readGray(video) {
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_WIDTH;
  canvas.height = SAMPLE_HEIGHT;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(video, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  const { data } = context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  const gray = new Float32Array(SAMPLE_WIDTH * SAMPLE_HEIGHT);
  for (let index = 0; index < gray.length; index += 1) {
    const offset = index * 4;
    gray[index] = data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
  }
  return gray;
}

function sharpnessOf(gray) {
  // 4 邻域拉普拉斯的方差：越大越清晰
  let sum = 0;
  let square = 0;
  let count = 0;
  for (let y = 1; y < SAMPLE_HEIGHT - 1; y += 1) {
    for (let x = 1; x < SAMPLE_WIDTH - 1; x += 1) {
      const index = y * SAMPLE_WIDTH + x;
      const value =
        -4 * gray[index] +
        gray[index - 1] +
        gray[index + 1] +
        gray[index - SAMPLE_WIDTH] +
        gray[index + SAMPLE_WIDTH];
      sum += value;
      square += value * value;
      count += 1;
    }
  }
  if (!count) return 0;
  const mean = sum / count;
  return square / count - mean * mean;
}

function distance(a, b) {
  if (!a || !b) return 1;
  let total = 0;
  for (let index = 0; index < a.length; index += 1) {
    total += Math.abs(a[index] - b[index]);
  }
  return total / a.length / 255;
}

function captureBlob(video) {
  return new Promise((resolve, reject) => {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) {
      reject(new Error("相机还没有画面。"));
      return;
    }
    const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext("2d");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("无法生成照片。"))),
      "image/jpeg",
      0.82
    );
  });
}

/**
 * 启动自动扫描循环。
 * @param {object} options
 * @param {() => HTMLVideoElement|null} options.getVideo
 * @param {() => string} options.getBookId
 * @param {() => string} options.getLayout
 * @param {() => number} options.getRotation
 * @param {(result) => void} options.onResult 后端返回结果（page/action/similarity）
 * @param {(text, tone) => void} options.onStatus 状态提示
 * @param {(error) => void} options.onError 出错
 */
export function start(options) {
  stop();
  loop = {
    options,
    timer: null,
    busy: false,
    lastGray: null,
    lastSentAt: 0,
    startedAt: Date.now(),
    frames: 0,
    sent: 0,
  };
  const tick = async () => {
    if (!loop) return;
    const state = loop;
    if (state.busy) return;
    const video = options.getVideo?.();
    if (!video || video.readyState < 2 || !video.videoWidth) return;

    let gray;
    try {
      gray = readGray(video);
    } catch {
      return;
    }
    state.frames += 1;
    const sharpness = sharpnessOf(gray);
    const moved = distance(state.lastGray, gray);
    const sinceSend = Date.now() - state.lastSentAt;
    const first = state.sent === 0;

    if (!first && sharpness < MIN_SHARPNESS) {
      options.onStatus?.("画面有点糊，往亮一点的地方挪一挪。", "warn");
      return;
    }
    if (!first && moved < STILL_DISTANCE && sinceSend < 6000) {
      return; // 画面没变化，跳过
    }
    if (!first && moved < CHANGE_DISTANCE && sinceSend < MIN_SEND_GAP) {
      return;
    }
    if (sinceSend < MIN_SEND_GAP) return;

    const bookId = options.getBookId?.();
    if (!bookId) {
      options.onStatus?.("先选一本书，再开始自动识别。", "warn");
      return;
    }

    state.busy = true;
    state.sent += 1;
    state.lastSentAt = Date.now();
    state.lastGray = gray;
    try {
      const blob = await captureBlob(video);
      const result = await api.autoScan({
        bookId,
        file: blob,
        layout: options.getLayout?.() || "none",
        rotation: options.getRotation?.() || 0,
      });
      if (!loop) return;
      options.onResult?.(result);
    } catch (error) {
      if (!loop) return;
      if (error?.code === "aborted") return;
      options.onError?.(error);
    } finally {
      if (loop) loop.busy = false;
    }
  };
  loop.timer = setInterval(tick, TICK_MS);
  setTimeout(tick, 600);
  return loop;
}

export function stop() {
  if (!loop) return;
  clearInterval(loop.timer);
  loop = null;
}

export function running() {
  return Boolean(loop);
}

export function stats() {
  if (!loop) return { running: false };
  return {
    running: true,
    frames: loop.frames,
    sent: loop.sent,
    busy: loop.busy,
    seconds: Math.round((Date.now() - loop.startedAt) / 1000),
  };
}

/** 画面稳定度（给界面上的"扫射"指示用）。 */
export function freshness() {
  if (!loop) return 0;
  return Math.max(0, 1 - (Date.now() - loop.lastSentAt) / 6000);
}

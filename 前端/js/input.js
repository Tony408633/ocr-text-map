/* 统一输入层：蓝牙耳机、蓝牙键盘 / 翻页器、游戏手柄、Web Bluetooth。

   盲人用户很难在屏幕上精确点按，所以所有输入都归到同一组"动作"上：

     上一行 / 下一行 / 暂停继续 / 批注 / 返回 / 重复提示 / 加快 / 放慢

   设备测试台会实时显示最近收到的输入，并用语音念出来，方便在没有专业工具时
   确认"手里的蓝牙设备到底有没有把按键送到纸伴"。 */

import * as media from "./media.js";

const MAX_LOG = 12;
const HOLD_DELAY = 620; // 长按多久开始连发
const HOLD_INTERVAL = 420; // 连发间隔

const listeners = { onAction: null, onEvent: null };

const state = {
  keyboard: false,
  gamepad: { seen: false, name: "" },
  media: { supported: false, enabled: false, playing: false, last: "" },
  log: [],
  heldAction: "",
};

let holdTimer = null;
let repeatTimer = null;
let pollTimer = null;
let gamepadPrevious = [];
let attached = false;
let nextLogId = 1;

/* -------------------------------------------------------------------------- */
/* 平台判断                                                                    */
/* -------------------------------------------------------------------------- */

export function platform() {
  const ua = navigator.userAgent || "";
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const android = /Android/i.test(ua);
  return {
    ios,
    android,
    desktop: !ios && !android,
    webBluetooth: Boolean(navigator.bluetooth),
    label: ios ? "iPhone / iPad" : android ? "Android" : "桌面浏览器",
  };
}

/* -------------------------------------------------------------------------- */
/* 事件记录（设备测试台）                                                       */
/* -------------------------------------------------------------------------- */

export function record({ source = "系统", label = "", detail = "" }) {
  const entry = {
    id: nextLogId++,
    at: Date.now(),
    source,
    label: String(label || ""),
    detail: String(detail || ""),
  };
  state.log.unshift(entry);
  if (state.log.length > MAX_LOG) state.log.length = MAX_LOG;
  listeners.onEvent?.(entry, [...state.log]);
  return entry;
}

export function entries() {
  return [...state.log];
}

export function clearLog() {
  state.log = [];
  listeners.onEvent?.(null, []);
}

/* -------------------------------------------------------------------------- */
/* 状态                                                                        */
/* -------------------------------------------------------------------------- */

export function status() {
  return {
    keyboard: state.keyboard,
    gamepad: { ...state.gamepad },
    media: { ...state.media, ...media.snapshot() },
    platform: platform(),
  };
}

function syncMedia() {
  state.media = { ...state.media, ...media.snapshot() };
  state.media.supported = media.supported();
}

/* -------------------------------------------------------------------------- */
/* 按键映射                                                                    */
/* -------------------------------------------------------------------------- */

const KEY_ACTIONS = {
  ArrowRight: "next",
  PageDown: "next",
  ArrowLeft: "prev",
  PageUp: "prev",
  " ": "toggle",
  Spacebar: "toggle",
  MediaPlayPause: "toggle",
  MediaPlay: "toggle",
  MediaPause: "toggle",
  MediaTrackNext: "next",
  MediaNextTrack: "next",
  MediaTrackPrevious: "prev",
  MediaPreviousTrack: "prev",
  MediaStop: "stop",
  n: "note",
  N: "note",
  m: "note",
  Escape: "back",
  Backspace: "back",
  r: "repeat",
  R: "repeat",
};

const KEY_LABELS = {
  ArrowRight: "→ 右方向键",
  ArrowLeft: "← 左方向键",
  ArrowUp: "↑ 上方向键",
  ArrowDown: "↓ 下方向键",
  " ": "空格键",
  Enter: "回车键",
  Escape: "Esc 键",
  Backspace: "退格键",
  PageUp: "Page Up",
  PageDown: "Page Down",
  MediaPlayPause: "耳机播放 / 暂停键",
  MediaPlay: "耳机播放键",
  MediaPause: "耳机暂停键",
  MediaTrackNext: "耳机下一首键",
  MediaTrackPrevious: "耳机上一首键",
  MediaStop: "耳机停止键",
};

export const ACTION_LABELS = {
  next: "下一行",
  prev: "上一行",
  toggle: "暂停 / 继续朗读",
  note: "添加批注",
  back: "返回",
  repeat: "重复提示",
  stop: "停止朗读",
  faster: "加快语速",
  slower: "放慢语速",
  pageNext: "下一页",
  pagePrev: "上一页",
};

export function describeKey(event) {
  const key = event.key || "";
  if (KEY_LABELS[key]) return KEY_LABELS[key];
  if (event.code && key.length === 1) return `按键 ${key.toUpperCase()}`;
  if (key.length === 1) return `按键 ${key.toUpperCase()}`;
  return `按键 ${key || event.code || "未知"}`;
}

function isMediaKey(key) {
  return typeof key === "string" && key.startsWith("Media");
}

function isTyping(target) {
  return (
    target instanceof Element &&
    Boolean(target.closest("input, textarea, select, [contenteditable='true']"))
  );
}

function onControl(target) {
  return target instanceof Element && Boolean(target.closest("button, a, summary, [role='button']"));
}

function dialogOpen() {
  const dialog = document.getElementById("dialog");
  return Boolean(dialog && dialog.open);
}

function emit(action, source, label) {
  if (!action) return;
  const text = label || ACTION_LABELS[action] || action;
  listeners.onAction?.(action, source, text);
}

function startHold(action) {
  clearHold();
  if (action !== "next" && action !== "prev") return;
  state.heldAction = action;
  holdTimer = setTimeout(() => {
    let count = 0;
    repeatTimer = setInterval(() => {
      count += 1;
      if (count > 120) {
        clearHold();
        return;
      }
      listeners.onAction?.(action, "hold", "长按");
    }, HOLD_INTERVAL);
  }, HOLD_DELAY);
}

function clearHold() {
  clearTimeout(holdTimer);
  clearInterval(repeatTimer);
  holdTimer = null;
  repeatTimer = null;
  state.heldAction = "";
}

/* -------------------------------------------------------------------------- */
/* 键盘与媒体键                                                                */
/* -------------------------------------------------------------------------- */

function handleKeydown(event) {
  if (dialogOpen()) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const typing = isTyping(event.target);
  if (typing) return;

  if (!state.keyboard) {
    state.keyboard = true;
    record({ source: "键盘", label: "检测到键盘输入", detail: "方向键和空格可以直接翻行" });
  }

  const key = event.key;
  const action = KEY_ACTIONS[key];
  const mediaKey = isMediaKey(key);
  const source = mediaKey ? "耳机 / 媒体键" : "键盘";

  if (document.body.dataset.inputBench === "on") {
    // 测试台：任何按键都要显示出来（包括没有映射的）
    record({
      source,
      label: describeKey(event),
      detail: action ? `→ ${ACTION_LABELS[action] || action}` : "（这个键还没有绑定动作）",
    });
  } else if (action) {
    record({ source, label: describeKey(event), detail: `→ ${ACTION_LABELS[action] || action}` });
  }

  if (!action) return;
  // 只有空格要让给聚焦中的按钮；媒体键（耳机播放/暂停）必须照常交给纸伴
  const spaceOnControl = onControl(event.target) && (key === " " || key === "Spacebar");
  if (spaceOnControl) return;
  event.preventDefault();
  if (state.heldAction !== action) startHold(action);
  emit(action, source, `${describeKey(event)}（${ACTION_LABELS[action] || action}）`);
}

function handleKeyup(event) {
  const action = KEY_ACTIONS[event.key];
  if (action && state.heldAction === action) clearHold();
}

/* -------------------------------------------------------------------------- */
/* 游戏手柄                                                                    */
/* -------------------------------------------------------------------------- */

const PAD_LABELS = {
  0: "A / × 键",
  1: "B / ○ 键",
  2: "X / □ 键",
  3: "Y / △ 键",
  4: "L1",
  5: "R1",
  12: "十字键 ↑",
  13: "十字键 ↓",
  14: "十字键 ←",
  15: "十字键 →",
};

function padAction(index) {
  if (index === 14 || index === 4 || index === 12) return "prev";
  if (index === 15 || index === 5 || index === 13) return "next";
  if (index === 0 || index === 3) return "toggle";
  if (index === 1) return "back";
  if (index === 2) return "note";
  return "";
}

function pollGamepads() {
  if (!navigator.getGamepads) return;
  let pads = [];
  try {
    pads = Array.from(navigator.getGamepads()).filter(Boolean);
  } catch {
    pads = [];
  }
  if (!pads.length) {
    if (state.gamepad.seen) {
      state.gamepad = { seen: false, name: "" };
      gamepadPrevious = [];
      listeners.onEvent?.(null, entries());
    }
    return;
  }
  const pad = pads[0];
  if (!state.gamepad.seen) {
    state.gamepad = { seen: true, name: String(pad.id || "").slice(0, 60) };
    record({ source: "手柄", label: "手柄已连接", detail: state.gamepad.name });
  }
  const pressed = pad.buttons.map((button) => Boolean(button.pressed));
  for (let index = 0; index < pressed.length; index += 1) {
    if (!pressed[index] || gamepadPrevious[index]) continue;
    const action = padAction(index);
    const label = PAD_LABELS[index] || `按钮 ${index}`;
    record({
      source: "手柄",
      label,
      detail: action ? `→ ${ACTION_LABELS[action] || action}` : "（没有绑定动作）",
    });
    if (action) listeners.onAction?.(action, "gamepad", label);
  }
  gamepadPrevious = pressed;
}

function startGamepadPolling() {
  if (!navigator.getGamepads) return;
  window.addEventListener("gamepadconnected", (event) => {
    state.gamepad = { seen: true, name: String(event.gamepad?.id || "").slice(0, 60) };
    record({ source: "手柄", label: "手柄已连接", detail: state.gamepad.name });
  });
  window.addEventListener("gamepaddisconnected", () => {
    state.gamepad = { seen: false, name: "" };
    gamepadPrevious = [];
    record({ source: "手柄", label: "手柄已断开" });
  });
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.hidden) return;
    pollGamepads();
  }, 250);
}

/* -------------------------------------------------------------------------- */
/* 媒体会话（蓝牙耳机按键）                                                     */
/* -------------------------------------------------------------------------- */

export async function enableMediaControls() {
  const result = await media.enable({
    onAction: (action) => {
      state.media.last = action;
      record({ source: "耳机 / 媒体键", label: "媒体会话动作", detail: `→ ${ACTION_LABELS[action] || action}` });
      listeners.onAction?.(action, "media", "耳机按键");
    },
  });
  syncMedia();
  if (result.ok) {
    record({ source: "耳机 / 媒体键", label: "已启用耳机按键", detail: "播放 / 暂停、上一首 / 下一首键都能控制朗读" });
  } else {
    record({ source: "耳机 / 媒体键", label: "启用失败", detail: result.reason });
  }
  listeners.onEvent?.(null, entries());
  return result;
}

export function setNowPlaying(info) {
  syncMedia();
  media.updateNowPlaying(info);
}

export function setPlaying(next) {
  media.setPlaying(next);
  syncMedia();
}

export function disableMediaControls() {
  media.disable();
  syncMedia();
  record({ source: "耳机 / 媒体键", label: "已关闭耳机按键" });
  listeners.onEvent?.(null, entries());
}

export function mediaEnabled() {
  return media.enabled();
}

/* -------------------------------------------------------------------------- */
/* 绑定                                                                        */
/* -------------------------------------------------------------------------- */

export function attach(options = {}) {
  listeners.onAction = options.onAction || null;
  listeners.onEvent = options.onEvent || null;
  if (attached) return;
  attached = true;
  document.addEventListener("keydown", handleKeydown);
  document.addEventListener("keyup", handleKeyup);
  window.addEventListener("blur", clearHold);
  startGamepadPolling();
  syncMedia();
  record({ source: "系统", label: `${platform().label} 已就绪`, detail: "按键都会显示在这里" });
}

export function press(action, source = "按钮") {
  record({ source, label: ACTION_LABELS[action] || action });
  emit(action, source);
}

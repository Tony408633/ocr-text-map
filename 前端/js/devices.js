/* 设备登记簿：把"实际能用的输入设备"记下来，并给它起一个盲人听得懂的名字。

   浏览器的 Web Bluetooth 看不到蓝牙耳机、也看不到大部分翻页器（它们是系统 HID），
   所以纸伴不把"连接设备"当作前提，而是**按真实收到的按键/按键来源登记设备**：

     * 收到耳机媒体键 → 登记「蓝牙耳机」
     * 收到方向键/PageUp/PageDown → 登记「翻页器 / 键盘」
     * 手柄连上 → 登记「游戏手柄」，名字用系统上报的
     * Web Bluetooth 连上（安卓/桌面）→ 登记真实设备名

   界面上只显示昵称，不显示 UUID、MAC 或端口信息。 */

const STORAGE_KEY = "paperpal.devices.v2";

export const KIND_LABELS = {
  headphone: "蓝牙耳机",
  remote: "蓝牙翻页器 / 遥控器",
  keyboard: "蓝牙键盘",
  gamepad: "游戏手柄",
  ble: "蓝牙设备",
};

export const KIND_ICONS = {
  headphone: "headphones",
  remote: "keyboard",
  keyboard: "keyboard",
  gamepad: "gamepad",
  ble: "bluetooth",
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    cache = Array.isArray(parsed) ? parsed.filter((item) => item && item.id) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache || []));
  } catch {
    /* 存储满了就只在本次会话里生效 */
  }
}

function makeId() {
  return `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function defaultNickname(kind) {
  const base = KIND_LABELS[kind] || "蓝牙设备";
  const used = new Set(load().map((item) => item.nickname));
  if (!used.has(base)) return base;
  for (let index = 2; index < 20; index += 1) {
    const candidate = `${base} ${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base} ${Date.now() % 100}`;
}

export function list() {
  return [...load()].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}

export function get(id) {
  return load().find((item) => item.id === id) || null;
}

/** 登记（或更新）一个真实检测到的设备；返回 { device, created }。 */
export function upsert({ kind = "ble", name = "", source = "" } = {}) {
  const items = load();
  const cleanName = String(name || "").trim().slice(0, 60);
  let device = items.find(
    (item) => item.kind === kind && (cleanName ? item.name === cleanName : true)
  );
  const now = Date.now();
  if (device) {
    device.lastSeen = now;
    device.seen = (device.seen || 1) + 1;
    if (cleanName) device.name = cleanName;
    if (source) device.source = source;
    persist();
    return { device, created: false };
  }
  device = {
    id: makeId(),
    kind,
    name: cleanName,
    nickname: defaultNickname(kind),
    source,
    firstSeen: now,
    lastSeen: now,
    seen: 1,
  };
  items.push(device);
  persist();
  return { device, created: true };
}

export function rename(id, nickname) {
  const items = load();
  const device = items.find((item) => item.id === id);
  if (!device) return null;
  const clean = String(nickname || "").trim().slice(0, 40);
  if (!clean) return device;
  device.nickname = clean;
  persist();
  return device;
}

export function remove(id) {
  cache = load().filter((item) => item.id !== id);
  persist();
}

export function clear() {
  cache = [];
  persist();
}

/** 一类设备里最近使用的那一个（用于状态文案）。 */
export function latest(kind) {
  return list().find((item) => item.kind === kind) || null;
}

export function count() {
  return load().length;
}

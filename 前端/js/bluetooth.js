/* 纸伴 PaperPal — 可选的 Web Bluetooth 连接。
   iOS Safari 不支持 Web Bluetooth；那里使用系统蓝牙键盘/手柄作为降级方案。 */

const STORAGE_KEY = "paperpal.bluetooth.v1";

let device = null;
let server = null;
let connected = false;
let name = "";
let battery = null;
let callbacks = {};
let knownNames = [];

export function supported() {
  return typeof navigator !== "undefined" && Boolean(navigator.bluetooth);
}

export function snapshot() {
  return {
    supported: supported(),
    connected,
    name,
    battery,
    id: device?.id || "",
    knownNames: [...knownNames],
    lastName: savedName(),
  };
}

export function savedName() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}").name || "";
  } catch {
    return "";
  }
}

export function saveName(value) {
  const clean = String(value || "").trim().slice(0, 80);
  if (!clean) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ name: clean, at: Date.now() }));
  } catch {
    /* 忽略存储失败 */
  }
}

export async function loadKnownNames() {
  if (!supported() || !navigator.bluetooth.getDevices) return [];
  try {
    const devices = await navigator.bluetooth.getDevices();
    knownNames = devices.map((item) => item.name || "未命名蓝牙设备").filter(Boolean).slice(0, 8);
    return [...knownNames];
  } catch {
    return [];
  }
}

function emit() {
  callbacks.onState?.(snapshot());
}

function handleDisconnect() {
  connected = false;
  server = null;
  battery = null;
  emit();
}

async function readBattery() {
  try {
    const service = await server.getPrimaryService("battery_service");
    const characteristic = await service.getCharacteristic("battery_level");
    const value = await characteristic.readValue();
    battery = value.getUint8(0);
  } catch {
    battery = null;
  }
}

async function subscribeCharacteristics() {
  let services = [];
  try {
    services = await server.getPrimaryServices();
  } catch {
    services = [];
  }
  for (const service of services) {
    let characteristics = [];
    try {
      characteristics = await service.getCharacteristics();
    } catch {
      continue;
    }
    for (const characteristic of characteristics) {
      const properties = characteristic.properties || {};
      if (!properties.notify && !properties.indicate) continue;
      try {
        await characteristic.startNotifications();
      } catch {
        continue;
      }
      characteristic.addEventListener("characteristicvaluechanged", (event) => {
        const value = event.target?.value;
        if (!value) return;
        const bytes = Array.from(
          new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        );
        callbacks.onNotify?.(bytes);
      });
    }
  }
}

export async function connect(handlers = {}) {
  if (!supported()) {
    throw new Error("此浏览器不支持网页蓝牙。iPhone 请使用系统蓝牙键盘。");
  }
  callbacks = handlers;
  let picked;
  try {
    picked = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [
        "battery_service",
        "device_information",
        "human_interface_device",
        "generic_access",
      ],
    });
  } catch (error) {
    if (error?.name === "NotFoundError") return null; // 用户取消
    if (error?.name === "SecurityError") {
      picked = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: ["battery_service", "device_information"],
      });
    } else {
      throw error;
    }
  }
  if (!picked) return null;
  device = picked;
  name = device.name || "未命名蓝牙设备";
  device.addEventListener("gattserverdisconnected", handleDisconnect);
  try {
    server = await device.gatt.connect();
  } catch (error) {
    connected = false;
    throw new Error(`连接失败：${error?.message || "设备没有开放 GATT 服务"}`);
  }
  connected = true;
  battery = null;
  saveName(name);
  await readBattery();
  await subscribeCharacteristics();
  emit();
  return snapshot();
}

export async function disconnect() {
  try {
    if (device?.gatt?.connected) device.gatt.disconnect();
  } catch {
    /* 忽略 */
  }
  connected = false;
  server = null;
  battery = null;
  emit();
}

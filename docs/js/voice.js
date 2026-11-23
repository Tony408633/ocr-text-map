/* 语音：朗读、语音识别与中文指令解析。 */

const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
const Recognition =
  typeof window !== "undefined"
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null;

let settings = {
  voice_enabled: true,
  voice_rate: 1,
  voice_pitch: 1,
  screen_reader_mode: false,
  verbosity: "standard",
};
let voices = [];
let speakToken = 0;
let unlocked = false;
let keepAliveTimer = null;

/** iPhone / iPad 的 Safari 在长句朗读、切后台后更容易中断，需要额外保活。 */
const IOS_LIKE = (() => {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
})();

export function configure(next = {}) {
  settings = { ...settings, ...next };
}

export function voiceEnabled() {
  return Boolean(synth) && settings.voice_enabled && !settings.screen_reader_mode;
}

export function screenReaderMode() {
  return Boolean(settings.screen_reader_mode);
}

export function speechSupported() {
  return Boolean(synth);
}

export function recognitionSupported() {
  return Boolean(Recognition);
}

export function voiceCount() {
  return voices.length;
}

function loadVoices() {
  if (!synth) return;
  try {
    voices = synth.getVoices() || [];
  } catch {
    voices = [];
  }
}

if (synth) {
  loadVoices();
  synth.addEventListener?.("voiceschanged", loadVoices);
}

function pickVoice(lang = "zh-CN") {
  if (!voices.length) loadVoices();
  const prefix = String(lang || "zh-CN").slice(0, 2).toLowerCase();
  const matching = voices.filter((voice) =>
    new RegExp(`^${prefix}([-_]|$)`, "i").test(voice.lang || "")
  );
  if (!matching.length) return null;
  if (prefix === "en") {
    return (
      matching.find((voice) => voice.localService && /Samantha|Alex|Daniel|Google US English|Microsoft Aria/i.test(voice.name)) ||
      matching.find((voice) => voice.localService) ||
      matching[0]
    );
  }
  const preferred = matching.find(
    (voice) =>
      voice.localService &&
      /Tingting|Ting-Ting|Xiaoxiao|Huihui|Meijia|Mei-Jia|Yaoyao|Sinji|Sin-ji|Li-Mu|Lili|Google 普通话/i.test(
        voice.name
      )
  );
  return (
    preferred ||
    matching.find((voice) =>
      /Tingting|Ting-Ting|Xiaoxiao|Huihui|Meijia|Mei-Jia|Yaoyao|Sinji|Sin-ji|Li-Mu|Lili/i.test(voice.name)
    ) ||
    matching.find((voice) => voice.localService) ||
    matching[0]
  );
}

export function unlock() {
  if (!synth) return;
  try {
    const utterance = new SpeechSynthesisUtterance(" ");
    utterance.volume = 0;
    synth.speak(utterance);
    synth.resume?.();
    unlocked = true;
  } catch {
    /* iOS 可能在首次手势前拒绝，忽略即可 */
  }
}

export function isUnlocked() {
  return unlocked;
}

export function isIOS() {
  return IOS_LIKE;
}

/** 朗读中断的保活：iOS 在长句或无交互时会自己停下，定时 resume 能把它接上。 */
function startKeepAlive() {
  if (!IOS_LIKE || keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    if (!synth) return;
    try {
      if (synth.speaking) synth.resume();
    } catch {
      /* 忽略 */
    }
  }, 8000);
}

function stopKeepAlive() {
  if (!keepAliveTimer) return;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

/** 给“设置 → 语音自检”和排障用的语音环境快照。 */
export function diagnose() {
  loadVoices();
  const chinese = voices.filter((voice) => /^zh/i.test(voice.lang || ""));
  return {
    synthesis: Boolean(synth),
    recognition: Boolean(Recognition),
    ios: IOS_LIKE,
    unlocked,
    voiceCount: voices.length,
    chineseVoices: chinese.slice(0, 8).map((voice) => `${voice.name}（${voice.lang}）`),
    speaking: isSpeaking(),
    secureContext:
      typeof location !== "undefined" &&
      (location.protocol === "https:" || ["localhost", "127.0.0.1"].includes(location.hostname)),
  };
}

/** 检查麦克风权限；iOS 还要求 HTTPS 才允许录音。 */
export async function ensureMic() {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return { ok: true, checked: false };
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return { ok: true, checked: true };
  } catch (error) {
    const secure =
      typeof location !== "undefined" &&
      (location.protocol === "https:" || ["localhost", "127.0.0.1"].includes(location.hostname));
    return {
      ok: false,
      checked: true,
      reason: secure
        ? "没有麦克风权限。请在浏览器设置里允许麦克风，再按麦克风按钮。"
        : "手机浏览器只在 HTTPS 下允许麦克风。请用「启动手机测试.bat」以 HTTPS 打开纸伴。",
      error,
    };
  }
}


function splitLongText(text, limit = 160) {
  if (text.length <= limit) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = -1;
    for (let i = Math.min(limit, rest.length - 1); i > limit * 0.45; i -= 1) {
      if (/[。！？；，、,.!?;]/.test(rest[i])) {
        cut = i + 1;
        break;
      }
    }
    if (cut < 0) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}

function makeUtterance(text, { rate, pitch, lang = "zh-CN" } = {}) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  utterance.rate = Math.min(2, Math.max(0.5, Number(rate ?? settings.voice_rate) || 1));
  utterance.pitch = Math.min(2, Math.max(0.5, Number(pitch ?? settings.voice_pitch) || 1));
  const voice = pickVoice(lang);
  if (voice) utterance.voice = voice;
  return utterance;
}

/**
 * 朗读一段文字。返回 Promise，在读完、被打断或出错时结束。
 * interrupt=false 时会排在当前朗读之后。
 */
export function speak(text, options = {}) {
  const value = String(text || "").trim();
  if (!value) {
    options.onend?.();
    return Promise.resolve(false);
  }
  if (!synth || !settings.voice_enabled || settings.screen_reader_mode) {
    options.onstart?.();
    options.onend?.();
    return Promise.resolve(false);
  }
  const { interrupt = true, onstart, onend, onerror, rate, pitch, lang = "zh-CN" } = options;
  if (interrupt) {
    stop();
    speakToken += 1;
  }
  const token = speakToken;
  const parts = splitLongText(value, IOS_LIKE ? 80 : 160);
  return new Promise((resolve) => {
    let finished = false;
    let guard = null;
    const finish = (ok) => {
      if (finished) return;
      finished = true;
      clearTimeout(guard);
      stopKeepAlive();
      if (ok) onend?.();
      resolve(ok);
    };
    guard = setTimeout(() => {
      if (finished) return;
      try {
        synth.cancel();
      } catch {
        /* 忽略 */
      }
      finish(false);
    }, Math.min(120000, Math.max(12000, value.length * 300)));
    startKeepAlive();
    const build = (index) => {
      if (token !== speakToken) {
        finish(false);
        return;
      }
      if (index >= parts.length) {
        finish(true);
        return;
      }
      const utterance = makeUtterance(parts[index], { rate, pitch, lang });
      if (index === 0) utterance.onstart = () => onstart?.();
      utterance.onerror = (event) => {
        if (event.error === "interrupted" || event.error === "canceled") {
          finish(false);
          return;
        }
        onerror?.(event);
        finish(false);
      };
      utterance.onend = () => {
        if (token !== speakToken) {
          finish(false);
          return;
        }
        if (IOS_LIKE && index < parts.length - 1) {
          try {
            synth.resume();
          } catch {
            /* 忽略 */
          }
        }
        build(index + 1);
      };
      try {
        synth.speak(utterance);
      } catch (error) {
        onerror?.(error);
        finish(false);
      }
    };
    build(0);
  });
}

export function stop() {
  speakToken += 1;
  stopKeepAlive();
  if (!synth) return;
  try {
    synth.cancel();
  } catch {
    /* 忽略 */
  }
}

export function pauseSpeech() {
  if (!synth) return false;
  try {
    synth.pause();
    return synth.paused;
  } catch {
    return false;
  }
}

export function resumeSpeech() {
  if (!synth) return false;
  try {
    synth.resume();
    return !synth.paused;
  } catch {
    return false;
  }
}

export function isSpeaking() {
  return Boolean(synth && (synth.speaking || synth.pending));
}

export function isPaused() {
  return Boolean(synth && synth.paused);
}

/* -------------------------------------------------------------------------- */
/* 语音识别                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 单次识别。成功返回 { transcript, confidence }；失败抛出带 code 的 Error。
 */
export function listen({ lang = "zh-CN", interim = false, timeout = 12000, onInterim } = {}) {
  return new Promise((resolve, reject) => {
    if (!Recognition) {
      reject(Object.assign(new Error("当前浏览器不支持语音识别，请直接打字或使用按钮。"), { code: "unsupported" }));
      return;
    }
    let recognition;
    try {
      recognition = new Recognition();
    } catch (error) {
      reject(Object.assign(new Error("语音识别无法启动。"), { code: "start", cause: error }));
      return;
    }
    let settled = false;
    let transcript = "";
    let confidence = 0;
    let timer = null;

    const cleanup = () => {
      clearTimeout(timer);
      try {
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        recognition.abort();
      } catch {
        /* 忽略 */
      }
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ transcript: transcript.trim(), confidence });
    };
    const fail = (message, code) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(Object.assign(new Error(message), { code }));
    };

    recognition.lang = lang;
    recognition.interimResults = interim;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      let interimText = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result[0]?.transcript || "";
        if (result.isFinal) {
          transcript += text;
          confidence = result[0]?.confidence || 0;
        } else {
          interimText += text;
        }
      }
      if (interimText && onInterim) onInterim(interimText);
      if (transcript.trim()) {
        try {
          recognition.stop();
        } catch {
          /* 忽略 */
        }
      }
    };
    recognition.onerror = (event) => {
      const code = event.error || "unknown";
      const messages = {
        "not-allowed": "没有麦克风权限。请在浏览器设置中允许后，再按麦克风按钮。",
        "service-not-allowed": "这个浏览器不允许语音识别，请直接输入。",
        "no-speech": "没有听到声音，请靠近一点再说一次。",
        network: "语音识别需要网络，或在浏览器里不可用。可以直接打字。",
        aborted: "语音识别已取消。",
        "audio-capture": "没有找到麦克风。可以连接麦克风后重试。",
      };
      if (code === "aborted" && transcript.trim()) {
        succeed();
        return;
      }
      fail(messages[code] || "没有听清，请再试一次。", code);
    };
    recognition.onend = () => {
      if (transcript.trim()) succeed();
      else fail("没有听到内容，请再说一次。", "no-speech");
    };
    try {
      recognition.start();
    } catch (error) {
      fail("语音识别暂时无法启动，请稍后重试或直接输入。", "start");
      return;
    }
    timer = setTimeout(() => {
      if (transcript.trim()) succeed();
      else fail("等了一会儿没有听到声音，可以再按一次麦克风。", "timeout");
    }, timeout);
  });
}

/* -------------------------------------------------------------------------- */
/* 中文指令                                                                    */
/* -------------------------------------------------------------------------- */

const INTENTS = [
  { intent: "scan-next", label: "扫描下一页", patterns: [/扫描下一页/, /拍下一页/, /扫描下页/, /扫描新页/] },
  { intent: "next-page", label: "下一页", patterns: [/下一页/, /翻到下一页/, /翻页/] },
  { intent: "previous-page", label: "上一页", patterns: [/上一页/, /翻到上一页/] },
  { intent: "next", label: "下一行", patterns: [/下一行/, /下行/, /往下读/, /next/i] },
  { intent: "previous", label: "上一行", patterns: [/上一行/, /上行/, /往上读/, /previous/i] },
  { intent: "play", label: "朗读", patterns: [/开始朗读/, /继续朗读/, /朗读/, /继续读/, /继续播放/, /播放/, /读这行/, /读一下/, /^继续$/, /^读$/, /再读一遍/] },
  { intent: "pause", label: "暂停", patterns: [/暂停/, /停一下/, /先停/] },
  { intent: "stop", label: "停止", patterns: [/停止/, /安静/, /别读了/] },
  { intent: "annotate", label: "添加批注", patterns: [/添加批注/, /写批注/, /记笔记/, /记一下/, /添加笔记/] },
  { intent: "notes", label: "批注库", patterns: [/查找批注/, /我的批注/, /批注库/, /所有批注/, /打开批注/] },
  { intent: "mode-guided", label: "语音引导模式", patterns: [/引导模式/, /语音引导/] },
  { intent: "mode-command", label: "语音指令模式", patterns: [/指令模式/, /语音指令/] },
  { intent: "line-scope", label: "当前行", patterns: [/当前行/, /这一行/] },
  { intent: "page-scope", label: "整页", patterns: [/整页/, /这一页/] },
  { intent: "save", label: "保存", patterns: [/^保存$/, /确认保存/, /^确定$/] },
  { intent: "cancel", label: "取消", patterns: [/^取消$/, /算了/, /不要了/] },
  { intent: "repeat", label: "重复提示", patterns: [/重复提示/, /再说一次/, /再念一遍/, /重复/] },
  { intent: "help", label: "帮助", patterns: [/帮助/, /怎么用/, /能做什么/, /指令/] },
  { intent: "settings", label: "设置", patterns: [/设置/, /偏好/] },
  { intent: "library", label: "书架", patterns: [/书架/, /书库/, /我的书/, /回到书架/] },
  { intent: "home", label: "首页", patterns: [/首页/, /回家/, /主页面/, /返回首页/] },
  { intent: "scan", label: "扫描", patterns: [/开始扫描/, /扫描书页/, /扫描/, /拍照/, /拍一页/, /识别/] },
  { intent: "faster", label: "快一点", patterns: [/快一点/, /加快/, /语速快/] },
  { intent: "slower", label: "慢一点", patterns: [/慢一点/, /放慢/, /减速/] },
  { intent: "yes", label: "好了", patterns: [/^好了$/, /^好$/, /^可以$/, /^行$/, /没问题/, /准备好了/, /摆好了/, /继续吧/] },
  { intent: "back", label: "返回", patterns: [/^返回$/, /后退/, /回去/, /返回阅读/, /回到阅读/, /回到书页/] },
  { intent: "delete", label: "删除", patterns: [/删除/, /删掉/] },
  { intent: "export", label: "导出备份", patterns: [/导出/, /备份/] },
  { intent: "demo", label: "演示阅读", patterns: [/演示/, /示例/] },
];

export function normalizeCommand(text) {
  return String(text || "")
    .replace(/[，。！？、,.!?;；:："'“”‘’\s]/g, "")
    .toLowerCase();
}

export function parseCommand(text) {
  const normalized = normalizeCommand(text);
  if (!normalized) return null;
  let best = null;
  for (const entry of INTENTS) {
    for (const pattern of entry.patterns) {
      const match = pattern.exec(normalized);
      if (!match) continue;
      const score = match[0].length * 10 + (pattern.source.startsWith("^") ? 4 : 0);
      if (!best || score > best.score) {
        best = { intent: entry.intent, label: entry.label, score, matched: match[0] };
      }
    }
  }
  return best;
}

export function helpText(route) {
  switch (route) {
    case "setup":
      return "说“好了”，我会检查画面；说“重复提示”，我会再说一次摆放要求。";
    case "scan":
      return "说“拍照”或“识别”，我会拍下并识别；说“返回”回到上一页。";
    case "reading":
      return "可以说下一行、上一行、暂停、继续、快一点、慢一点、添加批注、下一页。";
    case "annotate":
      return "说完批注后说“保存”，或说“取消”放弃。也可以选择当前行或整页。";
    case "notes":
      return "可以说“回到阅读”，或直接点按批注听取、编辑和删除。";
    case "settings":
      return "设置页面可以用触控或系统读屏操作；说“返回阅读”回到阅读。";
    default:
      return "可以说“开始扫描”“打开书架”“查找批注”或“设置”。";
  }
}

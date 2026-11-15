// Stable compatibility identifiers: keep existing custom return keys and
// local preferences when upgrading from dsh-magic-shortcuts to dsh-shortcutter.
export const RETURN_ID = "magic-shortcuts.navigate";
export const STORAGE_KEY = "dsh.magic-shortcuts.v1";
export const COMMANDS = [
  { id: "sidebar", label: "切换侧栏", key: "s", group: "区域" },
  { id: "conversation", label: "回到对话", key: "c", group: "区域" },
  { id: "right", label: "切换工具面板", key: "r", group: "区域" },
  { id: "files", label: "切换文件", key: "e", group: "区域" },
  { id: "browser", label: "切换浏览器", key: "b", group: "区域" },
  { id: "terminal", label: "切换终端", key: "t", group: "区域" },
  { id: "enter", label: "进入当前内容", key: "i", group: "操作" },
  { id: "searchSessions", label: "搜索会话", key: "f", group: "操作" },
  { id: "newSession", label: "新建会话", key: "n c", group: "操作" },
  { id: "newBrowser", label: "新建浏览器", key: "n b", group: "操作" },
  { id: "newTerminal", label: "新建终端", key: "n t", group: "操作" },
  { id: "closeTab", label: "关闭当前标签 / 页面", key: "w", group: "操作" },
  { id: "fullscreen", label: "放大 / 恢复面板", key: "R", group: "操作" },
  { id: "previous", label: "上一个会话", key: "g b", group: "跳转" },
  { id: "nextTab", label: "下一个工具标签", key: "Tab", group: "跳转" },
  { id: "previousTab", label: "上一个工具标签", key: "Shift+Tab", group: "跳转" },
  { id: "plugins", label: "打开插件", key: "g e", group: "跳转" },
  { id: "schedules", label: "打开定时任务", key: "g a", group: "跳转" },
  { id: "settings", label: "打开 DSH 设置", key: "g s", group: "跳转" }
];
export function defaultConfig() {
  return { version: 6, autoNavigate: true, bindings: Object.fromEntries(COMMANDS.map(c => [c.id, c.key])) };
}
const FULLWIDTH_KEYS = { "？": "?", "【": "[", "】": "]", "「": "[", "」": "]" };
export function normalizeSequence(value) {
  return String(value).replace(/[？【】「」]/g, ch => FULLWIDTH_KEYS[ch])
    .replace(/⇧\s*tab|shift\s*\+\s*tab/gi, "Shift+Tab")
    .trim().split(/\s+/).map(k => {
      const lower = k.toLowerCase();
      return lower === "space" ? "Space" : lower === "tab" ? "Tab" : lower === "shift+tab" ? "Shift+Tab" : k;
    }).join(" ");
}
export function validateConfig(value) {
  if (!value || ![1, 2, 3, 4, 5, 6].includes(value.version) || typeof value.autoNavigate !== "boolean" || !value.bindings || typeof value.bindings !== "object" || Array.isArray(value.bindings)) return { error: "设置格式不受支持，已保留原始数据。" };
  if (value.version === 1) return migrateLegacyConfig(value);
  const config = defaultConfig(), used = new Map(), notes = [], missing = [];
  config.autoNavigate = value.autoNavigate;
  const reserved = value.version < 5 ? ["g", "?"] : ["g", "n", "?"];
  const supported = value.version === 2 ? /^(?:[a-zA-Z0-9]|g [a-zA-Z0-9?])$/
    : value.version < 5 ? /^(?:[a-zA-Z0-9\[\]]|g [a-zA-Z0-9?\[\]])$/
    : /^(?:[a-zA-Z0-9\[\]]|Tab|Shift\+Tab|(?:g|n) (?:[a-zA-Z0-9?\[\]]|Tab|Shift\+Tab))$/;
  for (const command of COMMANDS) {
    const binding = value.bindings[command.id];
    const canBackfill = binding === undefined && ((value.version === 2 && command.id === "closeTab")
      || (value.version < 4 && ["plugins", "schedules"].includes(command.id))
      || (value.version < 6 && command.id === "searchSessions"));
    if (canBackfill) { missing.push(command); continue; }
    if (typeof binding !== "string") return { error: `${command.label}缺少键位。` };
    const key = normalizeSequence(binding);
    if (reserved.includes(key)) return { error: "g、n 和 ? 保留给快捷提示菜单。" };
    if (key && !supported.test(key)) return { error: `${command.label}：请使用单个字母、数字、Tab、Shift+Tab，或 g / n 加一个键。Space 已不再用作前缀。` };
    if (key && used.has(key)) return { error: `${key} 同时分配给了「${used.get(key)}」和「${command.label}」。` };
    if (key) used.set(key, command.label);
    config.bindings[command.id] = key;
  }
  const moveDefault = (id, from, to, label) => {
    if (config.bindings[id] !== from) return;
    used.delete(from);
    if (used.has(to)) {
      config.bindings[id] = "";
      notes.push(`${to} 已有自定义用途，「${label}」暂未绑定`);
    } else {
      config.bindings[id] = to;
      used.set(to, label);
    }
  };
  // Only old defaults move. A v5 user can still deliberately assign [ / ] / B / T / g p,
  // and custom bindings or explicit unbinding always survive an upgrade.
  if (value.version === 2) {
    moveDefault("nextTab", "g t", "]", "下一个工具标签");
    moveDefault("previousTab", "g T", "[", "上一个工具标签");
  }
  if (value.version < 4) {
    moveDefault("previous", "g a", "g b", "上一个会话");
  }
  if (value.version < 5) {
    for (const c of COMMANDS) {
      if (c.id !== "newSession" && config.bindings[c.id] === "n") {
        used.delete("n");
        config.bindings[c.id] = "";
        notes.push(`「${c.label}」原 n 已改为新建前缀，可重新设置`);
      }
    }
    moveDefault("newSession", "n", "n c", "新建会话");
    moveDefault("newBrowser", "B", "n b", "新建浏览器");
    moveDefault("newTerminal", "T", "n t", "新建终端");
    moveDefault("nextTab", "]", "Tab", "下一个工具标签");
    moveDefault("previousTab", "[", "Shift+Tab", "上一个工具标签");
    moveDefault("plugins", "g p", "g e", "打开插件");
  }
  for (const command of missing) {
    if (used.has(command.key)) {
      config.bindings[command.id] = "";
      notes.push(`${command.key} 已有自定义用途，「${command.label}」暂未绑定`);
    } else {
      config.bindings[command.id] = command.key;
      used.set(command.key, command.label);
    }
  }
  return { config, ...(notes.length ? { notice: notes.join("；") } : {}) };
}
function migrateLegacyConfig(value) {
  const legacy = COMMANDS.filter(c => !["newBrowser", "newTerminal", "closeTab", "plugins", "schedules", "searchSessions"].includes(c.id)).concat([
    { id: "autoNav", label: "切换自动导航" }, { id: "help", label: "快捷键总览" }
  ]);
  const bindings = {}, used = new Set(), notes = [];
  // Validate the old schema before migrating. Never replace corrupt preferences
  // with defaults, or write storage merely because the plugin has been loaded.
  for (const command of legacy) {
    let key = value.bindings[command.id];
    if (command.id === "newSession" && key === undefined) {
      key = Object.values(value.bindings).some(k => typeof k === "string" && normalizeSequence(k) === "n") ? "" : "n";
    } else if (command.id === "previous" && value.bindings.previous === "g b") {
      // Keep explicit v1 custom g b intact; untouched v1 default was g a.
      key = "g b";
    }
    if (typeof key !== "string") return { error: `${command.label}缺少键位。` };
    key = normalizeSequence(key);
    if (key && (!/^(?:[a-zA-Z0-9]|(?:g|Space) [a-zA-Z0-9?])$/.test(key) || ["g", "?"].includes(key))) return { error: `${command.label}的旧键位无效，已保留原始数据。` };
    if (key && used.has(key)) return { error: `${key} 同时分配给了多个动作，已保留原始数据。` };
    if (key) used.add(key);
    if (["autoNav", "help"].includes(command.id)) continue;
    bindings[command.id] = key.startsWith("Space ") ? "" : key;
    if (key.startsWith("Space ") && !(command.id === "settings" && key === "Space s")) notes.push(`「${command.label}」原 Space 组合已取消，可重新设置`);
  }
  // Existing custom keys win over newly introduced defaults, including g s.
  const addDefault = (id, key) => {
    const occupied = Object.values(bindings).includes(key);
    bindings[id] = occupied ? "" : key;
    if (occupied) notes.push(`${key} 已有自定义用途，「${COMMANDS.find(c => c.id === id).label}」暂未绑定`);
  };
  if (normalizeSequence(value.bindings.settings) === "Space s") addDefault("settings", "g s");
  addDefault("newBrowser", "B"); addDefault("newTerminal", "T"); addDefault("closeTab", "w");
  const result = validateConfig({ version: 2, autoNavigate: value.autoNavigate, bindings });
  return result.error ? result : { ...result, notice: [...notes, result.notice].filter(Boolean).join("；") };
}
export function readConfig(raw) {
  if (raw === null) return { config: defaultConfig() };
  try { return validateConfig(JSON.parse(raw)); }
  catch { return { error: "快捷键设置无法读取，已保留原始数据。" }; }
}
export function tokenFromGesture(g) {
  if (g.code === "Escape") return "Escape";
  if (g.code === "Space") return "Space";
  if (g.code === "Tab") return g.shift ? "Shift+Tab" : "Tab";
  if (g.code === "Slash" && g.shift) return "?";
  if (g.code === "BracketLeft" && !g.shift) return "[";
  if (g.code === "BracketRight" && !g.shift) return "]";
  if (/^Key[A-Z]$/.test(g.code)) return g.shift ? g.code.slice(3) : g.code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(g.code) && !g.shift) return g.code.slice(5);
  return "";
}
export function resolveSequence(bindings, prefix, key) {
  if (key === "Escape") return { consume: true, prefix: "", dismiss: !prefix };
  if (!key) return { consume: false, prefix };
  if (prefix) {
    const command = COMMANDS.find(c => bindings[c.id] === `${prefix} ${key}`)?.id;
    if (!command && prefix === "g" && /^[1-9]$/.test(key)) return { consume: true, prefix: "", tabIndex: Number(key) - 1 };
    return { consume: true, prefix: "", command };
  }
  if (key === "g" || key === "n") return { consume: true, prefix: key };
  if (key === "?") return { consume: true, prefix: "", toggleHints: true };
  const command = COMMANDS.find(c => bindings[c.id] === key)?.id;
  return { consume: !!command, prefix: "", command };
}
export function cycleIndex(length, currentIndex, direction) {
  if (!length) return -1;
  return (Math.max(0, currentIndex) + direction + length) % length;
}

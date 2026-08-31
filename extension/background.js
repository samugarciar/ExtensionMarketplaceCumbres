/**
 * Service worker mínimo. Sin backend no hay peticiones que hacer, así que
 * sólo queda lo que un content script no puede: escribir en el icono de la
 * extensión y sembrar la configuración inicial al instalar.
 */

// Vacío a propósito: el copy es de cada negocio y se pega desde el popup, no
// se versiona aquí. Mientras esté vacío la extensión no responde nada, y el
// popup lo avisa. `onInstalled` sólo rellena claves que faltan, así que esto
// nunca pisa un copy ya configurado.
const DEFAULT_COPY = "";

const DEFAULTS = {
  enabled: false,
  replyCopy: DEFAULT_COPY,
  scanIntervalMs: 20000,
  activeHoursStart: 18,
  activeHoursEnd: 24,
  maxRepliesPerHour: 15,
  minSecondsBetweenReplies: 120,
  minPreReplyDelayMs: 12000,
  maxPreReplyDelayMs: 25000,
  verboseLogs: false
};

const MAX_LOG_ENTRIES = 50;

async function appendLog(entry) {
  const { eventLog = [] } = await chrome.storage.local.get("eventLog");
  eventLog.unshift({ at: new Date().toISOString(), ...entry });
  await chrome.storage.local.set({ eventLog: eventLog.slice(0, MAX_LOG_ENTRIES) });
}

/** El contador del icono es la única señal de vida sin abrir el popup. */
async function refreshBadge() {
  const { replyTimestamps = [] } = await chrome.storage.local.get("replyTimestamps");
  const startOfDay = new Date().setHours(0, 0, 0, 0);
  const today = replyTimestamps.filter((at) => at >= startOfDay).length;

  await chrome.action.setBadgeText({ text: today > 0 ? String(today) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#1a7f37" });
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.action !== "LOG") return false;

  appendLog(request.data)
    .then(refreshBadge)
    .then(() => sendResponse({ ok: true }))
    .catch(() => sendResponse({ ok: false }));

  return true; // mantiene abierto el canal asíncrono
});

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const missing = Object.fromEntries(
    Object.entries(DEFAULTS).filter(([key]) => current[key] === undefined)
  );
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);

  await appendLog({ level: "info", message: "Extensión instalada o actualizada" });
  await refreshBadge();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.replyTimestamps) refreshBadge();
});

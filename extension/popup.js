/** Panel de control. Todo el estado vive en chrome.storage.local. */

const DEFAULTS = {
  enabled: false,
  replyCopy: "",
  activeHoursStart: 18,
  activeHoursEnd: 24,
  maxRepliesPerHour: 15,
  minSecondsBetweenReplies: 120,
  minPreReplyDelayMs: 12000,
  maxPreReplyDelayMs: 25000,
  verboseLogs: false
};

// Campos que se muestran en segundos pero se guardan en milisegundos.
const SECOND_FIELDS = new Set(["minPreReplyDelayMs", "maxPreReplyDelayMs"]);
const NUMBER_FIELDS = [
  "activeHoursStart",
  "activeHoursEnd",
  "maxRepliesPerHour",
  "minSecondsBetweenReplies",
  "minPreReplyDelayMs",
  "maxPreReplyDelayMs"
];
const TEXT_FIELDS = ["replyCopy"];
const BOOL_FIELDS = ["enabled", "verboseLogs"];

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Carga y guardado
// ---------------------------------------------------------------------------

async function loadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const config = { ...DEFAULTS, ...stored };

  for (const field of TEXT_FIELDS) $(field).value = config[field] ?? "";
  for (const field of BOOL_FIELDS) $(field).checked = Boolean(config[field]);
  for (const field of NUMBER_FIELDS) {
    $(field).value = SECOND_FIELDS.has(field)
      ? Math.round(config[field] / 1000)
      : config[field];
  }

  renderStatus(config);
  renderCopyMeta(config.replyCopy);
  return config;
}

function readForm() {
  const config = {};
  for (const field of TEXT_FIELDS) config[field] = $(field).value;
  for (const field of BOOL_FIELDS) config[field] = $(field).checked;
  for (const field of NUMBER_FIELDS) {
    const raw = Number($(field).value);
    const value = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULTS[field];
    config[field] = SECOND_FIELDS.has(field) ? Math.round(value * 1000) : Math.round(value);
  }

  // Un mínimo mayor que el máximo rompería el cálculo de la espera aleatoria.
  if (config.minPreReplyDelayMs > config.maxPreReplyDelayMs) {
    [config.minPreReplyDelayMs, config.maxPreReplyDelayMs] =
      [config.maxPreReplyDelayMs, config.minPreReplyDelayMs];
  }
  return config;
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const config = readForm();
    await chrome.storage.local.set(config);
    renderStatus(config);
    renderCopyMeta(config.replyCopy);
    flashSaved();
  }, 350);
}

function flashSaved() {
  $("saveState").textContent = "Guardado ✓";
  setTimeout(() => {
    $("saveState").textContent = "Los cambios se guardan solos.";
  }, 1500);
}

// ---------------------------------------------------------------------------
// Presentación
// ---------------------------------------------------------------------------

function withinHours(config, now = new Date()) {
  const { activeHoursStart: start, activeHoursEnd: end } = config;
  const hour = now.getHours();
  if (start === end) return true;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

function renderStatus(config) {
  const status = $("status");

  if (!config.enabled) {
    status.textContent = "Apagado — no se responde nada";
    status.className = "status status--off";
    return;
  }
  if (!String(config.replyCopy || "").trim()) {
    status.textContent = "Encendido, pero falta el copy";
    status.className = "status status--warn";
    return;
  }
  if (!withinHours(config)) {
    status.textContent = `Encendido — fuera de horario (${config.activeHoursStart}:00–${config.activeHoursEnd}:00)`;
    status.className = "status status--warn";
    return;
  }
  status.textContent = "Encendido — respondiendo disponibilidad";
  status.className = "status status--on";
}

function renderCopyMeta(copy) {
  const text = String(copy || "");
  const trimmed = text.trim();
  const meta = $("copyMeta");

  if (!trimmed) {
    meta.textContent = "Sin copy: no se responderá nada.";
    return;
  }
  const hasLink = /https?:\/\/|wa\.me/i.test(trimmed);
  meta.textContent =
    `${trimmed.length} caracteres · ${trimmed.split("\n").length} líneas` +
    (hasLink ? " · incluye enlace ✓" : " · sin enlace ⚠");
}

async function renderStats() {
  const { replyTimestamps = [] } = await chrome.storage.local.get("replyTimestamps");
  const startOfDay = new Date().setHours(0, 0, 0, 0);
  const hourAgo = Date.now() - 60 * 60 * 1000;

  $("statToday").textContent = replyTimestamps.filter((at) => at >= startOfDay).length;
  $("statHour").textContent = replyTimestamps.filter((at) => at > hourAgo).length;
}

function renderLog(entries) {
  const list = $("log");
  list.replaceChildren();

  if (!entries?.length) {
    const empty = document.createElement("li");
    empty.className = "log__empty";
    empty.textContent = "Todavía no hay eventos.";
    list.append(empty);
    return;
  }

  for (const entry of entries.slice(0, 25)) {
    const item = document.createElement("li");
    item.dataset.level = entry.level || "info";

    const time = document.createElement("time");
    time.textContent = new Date(entry.at).toLocaleTimeString("es-CO", {
      hour: "2-digit",
      minute: "2-digit"
    });

    // textContent, no innerHTML: el mensaje incluye texto del DOM de Facebook.
    item.append(time, document.createTextNode(entry.message || ""));
    list.append(item);
  }
}

async function refreshLog() {
  const { eventLog = [] } = await chrome.storage.local.get("eventLog");
  renderLog(eventLog);
}

// ---------------------------------------------------------------------------
// Diagnóstico
// ---------------------------------------------------------------------------

async function diagnose() {
  const button = $("diagnoseBtn");
  const result = $("diagnoseResult");

  button.disabled = true;
  button.textContent = "Revisando…";
  result.hidden = false;
  result.className = "result";
  result.textContent = "Leyendo la lista…";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No hay pestaña activa.");

    const report = await chrome.tabs.sendMessage(tab.id, { action: "DIAGNOSE" });
    if (!report) throw new Error("Sin respuesta de la página.");

    // Un content script viejo responde con otra forma. Distinguirlo aquí evita
    // horas de depurar un comportamiento que ya estaba corregido en disco.
    if (!report.version || typeof report.resumen !== "string") {
      throw new Error(
        "La pestaña tiene una versión ANTIGUA del script. Recarga la página " +
          "con ⌘R (el content script sólo se sustituye al cargar la página, " +
          "no al recargar la extensión) y vuelve a entrar en la carpeta Marketplace."
      );
    }

    result.className = report.wouldReply > 0 ? "result result--ok" : "result";
    result.textContent = report.resumen;

    try {
      await navigator.clipboard.writeText(report.resumen);
      result.textContent += "\n\n📋 Copiado al portapapeles.";
    } catch {
      result.textContent += "\n\n(Selecciona el texto y cópialo.)";
    }
  } catch (err) {
    result.className = "result result--error";
    result.textContent =
      "No se pudo leer la lista. Abre https://www.facebook.com/messages en esta " +
      "pestaña, entra en la carpeta «Marketplace» y recárgala con ⌘R.\n\n" +
      `(${err.message})`;
  } finally {
    button.disabled = false;
    button.textContent = "Ver qué detecta";
  }
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  await renderStats();
  await refreshLog();

  for (const field of [...TEXT_FIELDS, ...NUMBER_FIELDS]) {
    $(field).addEventListener("input", scheduleSave);
  }
  for (const field of BOOL_FIELDS) {
    $(field).addEventListener("change", scheduleSave);
  }

  $("diagnoseBtn").addEventListener("click", diagnose);

  $("clearLogBtn").addEventListener("click", async () => {
    await chrome.storage.local.set({ eventLog: [] });
    await refreshLog();
  });

  $("forgetBtn").addEventListener("click", async () => {
    await chrome.storage.local.set({ handledThreads: {}, reviewedThreads: {} });
    await refreshLog();
    $("saveState").textContent = "Historial de hilos borrado";
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.eventLog) renderLog(changes.eventLog.newValue);
    if (changes.replyTimestamps) renderStats();
  });
});

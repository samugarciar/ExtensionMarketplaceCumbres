/**
 * Content script: recorre la bandeja, responde sólo las preguntas genéricas de
 * disponibilidad y no toca nada más.
 *
 * La regla que gobierna todo el archivo: **un hilo que no se va a responder no
 * se abre**. Clasificamos leyendo la vista previa de la lista; sólo entramos a
 * los hilos que ya sabemos que vamos a contestar. Así el resto se queda sin
 * leer de forma natural, sin necesidad de "marcar como no leído" ni de dejar
 * rastro de apertura.
 */

(() => {
  "use strict";

  // ======================================================================
  // Selectores frágiles — Facebook renombra clases, no roles ARIA.
  // Si algo deja de funcionar tras un rediseño, se parchea AQUÍ.
  // ======================================================================
  const SELECTORS = {
    threadLink: 'a[href*="/marketplace/t/"], a[href*="/messages/t/"], a[href*="/t/"]',
    textNode: '[dir="auto"]',
    textbox: '[role="textbox"][contenteditable="true"]',
    messageRow: '[role="row"]',
    main: '[role="main"]',
    button: '[aria-label][role="button"]'
  };

  const UNREAD_HINTS = ["no leído", "no leido", "sin leer", "unread", "mensaje nuevo"];
  const SEND_LABELS = ["enviar", "send", "presiona enter para enviar", "press enter to send"];
  const OUTGOING_HINTS = ["you sent", "tú enviaste", "tu enviaste", "enviaste", "has enviado"];

  // Líneas de la fila que son marca de tiempo, no el mensaje: "2 h", "ayer", "3 sept".
  const TIMESTAMP_RE =
    /^(·\s*)?(\d+\s*(m|min|h|hr|d|sem|a|y|w)\b|ayer|hoy|lun|mar|mié|mie|jue|vie|sáb|sab|dom|\d{1,2}\s+\w{3,4}\.?)$/i;

  const DEFAULTS = {
    enabled: false,
    replyCopy: "",
    scanIntervalMs: 20000,
    activeHoursStart: 18,
    activeHoursEnd: 24,
    maxRepliesPerHour: 15,
    minSecondsBetweenReplies: 120,
    minPreReplyDelayMs: 12000,
    maxPreReplyDelayMs: 25000,
    minCharDelayMs: 40,
    maxCharDelayMs: 110,
    verboseLogs: false
  };

  const LOG_PREFIX = "[LeadRouter]";
  let config = { ...DEFAULTS };
  let busy = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const log = (...args) => config.verboseLogs && console.log(LOG_PREFIX, ...args);
  const warn = (...args) => console.warn(LOG_PREFIX, ...args);

  // ======================================================================
  // Configuración y estado persistente
  // ======================================================================

  async function loadConfig() {
    const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
    config = { ...DEFAULTS, ...stored };
    return config;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key in DEFAULTS) config[key] = newValue;
    }
  });

  async function isHandled(threadId) {
    const { handledThreads = {} } = await chrome.storage.local.get("handledThreads");
    return Boolean(handledThreads[threadId]);
  }

  async function markHandled(threadId) {
    const { handledThreads = {} } = await chrome.storage.local.get("handledThreads");
    handledThreads[threadId] = Date.now();

    // Se conservan 30 días: suficiente para no repetir, sin crecer sin fin.
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const [id, at] of Object.entries(handledThreads)) {
      if (at < cutoff) delete handledThreads[id];
    }
    await chrome.storage.local.set({ handledThreads });
  }

  async function recentReplies() {
    const { replyTimestamps = [] } = await chrome.storage.local.get("replyTimestamps");
    const cutoff = Date.now() - 60 * 60 * 1000;
    return replyTimestamps.filter((at) => at > cutoff);
  }

  async function recordReply() {
    const recent = await recentReplies();
    recent.push(Date.now());
    await chrome.storage.local.set({ replyTimestamps: recent });
  }

  // ======================================================================
  // Puertas: horario y cupo
  // ======================================================================

  function withinActiveHours(now = new Date()) {
    const { activeHoursStart: start, activeHoursEnd: end } = config;
    const hour = now.getHours();
    if (start === end) return true; // configuración sin ventana: siempre activo
    return start < end ? hour >= start && hour < end : hour >= start || hour < end;
  }

  async function gateCheck() {
    if (!config.enabled) return { ok: false, reason: "Extensión apagada" };
    if (!config.replyCopy.trim()) return { ok: false, reason: "Falta el copy en el popup" };
    if (!withinActiveHours()) {
      return {
        ok: false,
        reason: `Fuera del horario (${config.activeHoursStart}:00–${config.activeHoursEnd}:00)`
      };
    }

    const recent = await recentReplies();
    if (recent.length >= config.maxRepliesPerHour) {
      return { ok: false, reason: `Cupo por hora alcanzado (${recent.length})` };
    }

    const last = recent.length ? Math.max(...recent) : 0;
    const elapsed = (Date.now() - last) / 1000;
    if (last && elapsed < config.minSecondsBetweenReplies) {
      return {
        ok: false,
        reason: `Espaciado mínimo: faltan ${Math.ceil(config.minSecondsBetweenReplies - elapsed)} s`
      };
    }

    return { ok: true };
  }

  // ======================================================================
  // Lectura de la bandeja
  // ======================================================================

  function threadIdFrom(href) {
    const match = (href || "").match(/\/t\/(\d+)/);
    return match ? match[1] : null;
  }

  function listRows() {
    const links = Array.from(document.querySelectorAll(SELECTORS.threadLink));
    const seen = new Set();
    const rows = [];

    for (const link of links) {
      const threadId = threadIdFrom(link.getAttribute("href"));
      if (!threadId || seen.has(threadId)) continue;
      seen.add(threadId);
      rows.push({ threadId, element: link });
    }
    return rows;
  }

  /**
   * ¿La fila está sin leer?
   *
   * Dos señales: la etiqueta ARIA (cuando existe) y el grosor de la fuente,
   * porque Messenger pone la vista previa en negrita mientras no se ha leído.
   */
  function isUnread(element) {
    const labels = [element, ...element.querySelectorAll("[aria-label]")]
      .map((node) => (node.getAttribute("aria-label") || "").toLowerCase())
      .join(" ");
    if (UNREAD_HINTS.some((hint) => labels.includes(hint))) return true;

    const textNodes = Array.from(element.querySelectorAll(SELECTORS.textNode));
    return textNodes.some((node) => {
      const weight = window.getComputedStyle(node).fontWeight;
      return Number(weight) >= 600 && (node.innerText || "").trim().length > 0;
    });
  }

  /** Todas las líneas de texto de la fila, sin marcas de tiempo. */
  function rowLines(element) {
    const fromNodes = Array.from(element.querySelectorAll(SELECTORS.textNode))
      .map((node) => (node.innerText || "").trim())
      .filter(Boolean);

    const lines = fromNodes.length
      ? fromNodes
      : (element.innerText || "").split("\n").map((line) => line.trim()).filter(Boolean);

    return lines.filter((line) => !TIMESTAMP_RE.test(line));
  }

  /**
   * ¿La vista previa es nuestra propia respuesta?
   *
   * En la bandeja, el último mensaje de un hilo ya contestado es el nuestro, y
   * su vista previa empieza igual que el copy. Compararla con el propio copy
   * es más fiable que confiar sólo en la marca de "sin leer".
   */
  function looksLikeOwnReply(preview) {
    const copy = (config.replyCopy || "").trim();
    if (!copy || !preview) return false;

    const normalize = (text) =>
      text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();

    const head = normalize(copy).slice(0, 25);
    return head.length >= 10 && normalize(preview).startsWith(head);
  }

  /**
   * La vista previa del mensaje es la última línea de la fila: antes van el
   * nombre del comprador y el título de la publicación.
   */
  function extractPreview(element) {
    const lines = rowLines(element);
    return lines.length ? lines[lines.length - 1] : "";
  }

  // ======================================================================
  // Lectura del hilo abierto (verificación antes de escribir)
  // ======================================================================

  function classifyDirection(row, containerRect) {
    const labels = [row, ...row.querySelectorAll("[aria-label]")]
      .map((node) => (node.getAttribute("aria-label") || "").toLowerCase())
      .join(" ");
    if (OUTGOING_HINTS.some((hint) => labels.includes(hint))) return "out";

    const rect = row.getBoundingClientRect();
    if (!rect.width || !containerRect.width) return "out";

    const offset = rect.left + rect.width / 2 - (containerRect.left + containerRect.width / 2);
    // Una burbuja centrada (separador de fecha) no permite decidir: se descarta.
    if (Math.abs(offset) < containerRect.width * 0.08) return "out";
    return offset > 0 ? "out" : "in";
  }

  /** Texto del último mensaje entrante del hilo abierto, o null. */
  function lastIncomingMessage() {
    const main = document.querySelector(SELECTORS.main);
    if (!main) return null;

    const containerRect = main.getBoundingClientRect();
    const rows = Array.from(main.querySelectorAll(SELECTORS.messageRow)).filter(
      (row) => (row.innerText || "").trim()
    );
    if (!rows.length) return null;

    const last = rows[rows.length - 1];
    if (classifyDirection(last, containerRect) !== "in") return null;

    const bubble = Array.from(last.querySelectorAll(SELECTORS.textNode)).find((node) =>
      (node.innerText || "").trim()
    );
    return ((bubble || last).innerText || "").trim();
  }

  function alreadyAnswered() {
    const main = document.querySelector(SELECTORS.main);
    if (!main) return false;

    const containerRect = main.getBoundingClientRect();
    return Array.from(main.querySelectorAll(SELECTORS.messageRow)).some(
      (row) =>
        classifyDirection(row, containerRect) === "out" &&
        /wa\.me\/|api\.whatsapp\.com/i.test(row.innerText || "")
    );
  }

  // ======================================================================
  // Escritura
  // ======================================================================

  async function waitFor(predicate, timeoutMs = 8000, stepMs = 250) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await sleep(stepMs);
    }
    return null;
  }

  function findTextbox() {
    return (
      Array.from(document.querySelectorAll(SELECTORS.textbox))
        .reverse()
        .find((box) => box.offsetParent !== null) || null
    );
  }

  function findSendButton() {
    return (
      Array.from(document.querySelectorAll(SELECTORS.button)).find((button) => {
        const label = (button.getAttribute("aria-label") || "").toLowerCase();
        return SEND_LABELS.some((candidate) => label === candidate || label.startsWith(candidate));
      }) || null
    );
  }

  async function humanType(textbox, text) {
    textbox.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);

    for (const char of text) {
      if (char === "\n") {
        // insertText con "\n" puede enviar el mensaje a medias en Lexical.
        document.execCommand("insertLineBreak", false, null);
        await sleep(rand(200, 420));
        continue;
      }
      document.execCommand("insertText", false, char);
      let delay = rand(config.minCharDelayMs, config.maxCharDelayMs);
      if (".,!?:".includes(char)) delay += rand(120, 320);
      await sleep(delay);
    }
  }

  async function submit(textbox) {
    await sleep(rand(700, 1600));

    const button = findSendButton();
    if (button) {
      button.click();
    } else {
      const options = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      textbox.dispatchEvent(new KeyboardEvent("keydown", options));
      textbox.dispatchEvent(new KeyboardEvent("keyup", options));
    }

    // El editor se vacía cuando el mensaje sale de verdad.
    return Boolean(await waitFor(() => (textbox.innerText || "").trim() === "", 4000, 300));
  }

  // ======================================================================
  // Orquestación
  // ======================================================================

  async function report(level, message) {
    await chrome.runtime.sendMessage({ action: "LOG", data: { level, message } }).catch(() => {});
  }

  async function replyToThread(candidate) {
    const { threadId, element, preview } = candidate;

    log(`Abriendo el hilo ${threadId}…`);
    element.click();

    const textbox = await waitFor(findTextbox, 10000);
    if (!textbox) {
      await report("error", `No se pudo abrir el editor del hilo ${threadId}`);
      return false;
    }

    // Verificación con el texto completo: la vista previa pudo omitir algo.
    const fullText = lastIncomingMessage();
    if (fullText) {
      const verdict = LeadClassifier.classify(fullText);
      if (!verdict.autoReply) {
        await report(
          "warn",
          `El hilo ${threadId} se abrió pero el mensaje completo no es genérico ` +
            `(${verdict.reason}). Respóndelo tú; ya figura como leído.`
        );
        return false;
      }
    }

    if (alreadyAnswered()) {
      await report("info", `El hilo ${threadId} ya tenía respuesta con enlace de WhatsApp`);
      await markHandled(threadId);
      return false;
    }

    // Pausa antes de escribir: no se responde en el mismo segundo en que se abre.
    await sleep(rand(config.minPreReplyDelayMs, config.maxPreReplyDelayMs));

    await humanType(textbox, config.replyCopy.trim());
    const delivered = await submit(textbox);

    if (delivered) {
      await markHandled(threadId);
      await recordReply();
      await report("sent", `Respondido: "${preview.slice(0, 60)}"`);
      return true;
    }

    await report("error", `El hilo ${threadId} no se envió: el editor no se vació`);
    return false;
  }

  async function scan() {
    if (busy) return;

    const gate = await gateCheck();
    if (!gate.ok) {
      log("Sin actuar:", gate.reason);
      return;
    }

    busy = true;
    try {
      for (const row of listRows()) {
        if (!isUnread(row.element)) continue;
        if (await isHandled(row.threadId)) continue;

        const preview = extractPreview(row.element);

        if (looksLikeOwnReply(preview)) {
          log(`Hilo ${row.threadId}: el último mensaje es nuestro`);
          continue;
        }

        const verdict = LeadClassifier.classify(preview);

        if (!verdict.autoReply) {
          // No se abre. Se queda sin leer, esperándote en la bandeja.
          log(`Hilo ${row.threadId} para ti: ${verdict.reason}`);
          continue;
        }

        await replyToThread({ ...row, preview });
        return; // uno por pasada: el cupo y el espaciado mandan
      }
    } catch (err) {
      warn("Fallo recorriendo la bandeja:", err);
      await report("error", err.message);
    } finally {
      busy = false;
    }
  }

  // ======================================================================
  // Diagnóstico — qué ve la extensión en TU bandeja
  //
  // Cuando `listRows()` no encuentra nada, esto dice POR QUÉ: prueba una
  // batería de selectores candidatos y, a partir del texto de un mensaje
  // visible, sube por los ancestros describiendo la estructura real.
  // ======================================================================

  const PROBE_SELECTORS = [
    'a[href*="/marketplace/t/"]',
    'a[href*="/messages/t/"]',
    'a[href*="/t/"]',
    'a[role="link"]',
    '[role="row"]',
    '[role="listitem"]',
    '[role="gridcell"]',
    '[role="grid"]',
    '[role="article"]',
    '[role="button"][tabindex]',
    '[data-virtualized]'
  ];

  /** Texto que delata una fila de conversación en la lista. */
  const PROBE_NEEDLE = /disponible|inmueble se encuentra/i;

  function describe(node) {
    if (!node || node === document.body) return null;
    const role = node.getAttribute?.("role") || "";
    const href = node.getAttribute?.("href") || "";
    const label = (node.getAttribute?.("aria-label") || "").slice(0, 45);
    return {
      tag: node.tagName?.toLowerCase(),
      role,
      href: href.slice(0, 70),
      label,
      hermanos: node.parentElement ? node.parentElement.childElementCount : 0,
      tieneImg: Boolean(node.querySelector?.("img")),
      lineas: ((node.innerText || "").match(/\n/g) || []).length + 1
    };
  }

  /** El nodo de texto más profundo que contiene la vista previa de un mensaje. */
  function findPreviewNode() {
    const all = Array.from(document.querySelectorAll(SELECTORS.textNode));
    return (
      all.find(
        (node) =>
          PROBE_NEEDLE.test(node.innerText || "") &&
          !Array.from(node.children).some((child) => PROBE_NEEDLE.test(child.innerText || ""))
      ) || null
    );
  }

  function probeStructure() {
    const seed = findPreviewNode();
    if (!seed) return { encontrado: false, ancestros: [] };

    const ancestros = [];
    let node = seed;
    for (let level = 0; level < 12 && node && node !== document.body; level += 1) {
      ancestros.push({ nivel: level, ...describe(node) });
      node = node.parentElement;
    }
    return { encontrado: true, texto: (seed.innerText || "").slice(0, 80), ancestros };
  }

  function diagnose() {
    const conteos = {};
    for (const selector of PROBE_SELECTORS) {
      try {
        conteos[selector] = document.querySelectorAll(selector).length;
      } catch {
        conteos[selector] = "selector inválido";
      }
    }

    const rows = listRows();
    const detalle = rows.map((row) => {
      const preview = extractPreview(row.element);
      const verdict = LeadClassifier.classify(preview);
      const propio = looksLikeOwnReply(preview);
      return {
        hilo: row.threadId,
        sinLeer: isUnread(row.element),
        lineas: rowLines(row.element),
        preview,
        autoResponde: verdict.autoReply && !propio,
        motivo: propio ? "El último mensaje es nuestro" : verdict.reason
      };
    });

    const estructura = probeStructure();

    console.log(`${LOG_PREFIX} ── SONDA DEL DOM ──`);
    console.log("URL:", window.location.href);
    console.table(conteos);
    if (estructura.encontrado) {
      console.log("Texto semilla:", estructura.texto);
      console.table(estructura.ancestros);
    } else {
      console.warn("No se encontró ningún nodo con texto de mensaje.");
    }
    if (detalle.length) console.table(detalle);

    // Resumen compacto: es lo que se muestra en el popup para copiar y pegar.
    const resumen = [
      `URL: ${window.location.pathname}`,
      `Filas detectadas por listRows(): ${rows.length}`,
      "",
      "Selectores candidatos:",
      ...PROBE_SELECTORS.map((selector) => `  ${conteos[selector]}\t${selector}`),
      ""
    ];

    if (estructura.encontrado) {
      resumen.push(`Semilla: "${estructura.texto}"`, "Ancestros (nivel · tag · role · hermanos · img · líneas):");
      for (const a of estructura.ancestros) {
        resumen.push(
          `  ${a.nivel} · ${a.tag}${a.role ? ` [${a.role}]` : ""}` +
            `${a.href ? ` href=${a.href}` : ""}${a.label ? ` label="${a.label}"` : ""}` +
            ` · ${a.hermanos} herm · ${a.tieneImg ? "img" : "—"} · ${a.lineas} líneas`
        );
      }
    } else {
      resumen.push("No se encontró texto de mensaje en la página.");
    }

    return {
      total: rows.length,
      unread: detalle.filter((item) => item.sinLeer).length,
      wouldReply: detalle.filter((item) => item.sinLeer && item.autoResponde).length,
      resumen: resumen.join("\n"),
      conteos,
      estructura,
      detalle
    };
  }

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request?.action === "DIAGNOSE") {
      sendResponse(diagnose());
      return true;
    }
    return false;
  });

  // ======================================================================
  // Arranque
  // ======================================================================

  loadConfig().then(() => {
    setInterval(scan, config.scanIntervalMs);
    scan();
    console.log(
      `${LOG_PREFIX} activo. Estado: ${config.enabled ? "ENCENDIDO" : "apagado"}. ` +
        "Usa el botón de diagnóstico del popup para ver qué detecta."
    );
  });
})();

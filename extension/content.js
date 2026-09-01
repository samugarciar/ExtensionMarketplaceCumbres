/**
 * Content script: atiende la carpeta Marketplace de Messenger.
 *
 * Regla única: si el mensaje es SÓLO una pregunta de disponibilidad, se
 * responde con el copy. Cualquier otra cosa se queda sin leer, esperando.
 *
 * Por qué Messenger y no la bandeja de Marketplace (facebook.com/marketplace/
 * inbox), verificado contra ambas interfaces:
 *
 *   - Allí la vista previa oculta el texto del comprador tras "X te envió un
 *     mensaje sobre tu publicación" en la mitad de los leads. Aquí siempre se
 *     ve el mensaje completo.
 *   - Allí no hay identificador de hilo en el DOM. Aquí está en el href.
 *   - Allí el estado "no leído" no es detectable. Aquí es el texto
 *     "Mensaje no leído:".
 *   - Allí no existe "marcar como no leído" en ningún menú. Aquí sí.
 *   - Allí las conversaciones se abren en ventanas flotantes que se cierran
 *     solas al abrir otra, lo que llegó a romper un envío a medias. Aquí hay un
 *     único panel estable.
 */

(() => {
  "use strict";

  // ======================================================================
  // Selectores frágiles — Facebook renombra clases, no roles ni aria-labels.
  // Si algo deja de funcionar tras un rediseño, se parchea AQUÍ.
  // ======================================================================
  const SELECTORS = {
    threadLink: 'a[href*="/t/"]',
    rowMenuButton: '[aria-label^="Más opciones para"], [aria-label^="More options for"]',
    menuItem: '[role="menuitem"]',
    textbox: '[role="textbox"][contenteditable="true"]',
    conversation: '[aria-label^="Mensajes de la conversación"], [aria-label^="Messages in conversation"]',
    button: '[aria-label][role="button"]'
  };

  /** Marca de no leído dentro de la fila. */
  const UNREAD = /mensaje no le[íi]do|unread message/i;

  /** "A las 2:11 pm, Alannys: ¿Sigue estando disponible este artículo?" */
  const MSG_LABEL = /^A las .+?,\s*([^:]+):\s*([\s\S]*)$/;

  /** Facebook nombra al emisor propio como "Tú". */
  const OWN_SENDER = /^(t[úu]|you)$/i;

  /** Opción del menú de fila que devuelve la conversación a no leída. */
  const MARK_UNREAD = /marcar como no le[íi]do|mark as unread/i;

  /**
   * El compositor no tiene botón "Enviar": sólo "Enviar un clip de voz" y
   * "Enviar un Me gusta". Emparejar por prefijo mandaría una nota de voz, así
   * que la comparación es exacta.
   */
  const SEND_EXACT = ["enviar", "send"];

  /** Líneas de la fila que no son el mensaje. */
  const TIME_LINE = /^(·|\d{1,2}:\d{2}\s*(a\.?\s?m\.?|p\.?\s?m\.?)?|\d+\s*(m|min|h|d|sem|a)\b.*|ayer|hoy|activo ahora|lun|mar|mié|mie|jue|vie|sáb|sab|dom)$/i;

  const LOG_PREFIX = "[LeadRouter]";

  /**
   * Versión del content script. Súbela en cada cambio de comportamiento.
   *
   * Los content scripts sobreviven a la recarga de la extensión hasta que se
   * recarga la PÁGINA, así que es fácil creer que corre código nuevo cuando no.
   * Ya pasó dos veces; con esto se ve de un vistazo en el popup y la consola.
   */
  const VERSION = "messenger-4";
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
    verboseLogs: false
  };

  let config = { ...DEFAULTS };
  let busy = false;

  /** Hilos ya anunciados en el log esta sesión: evita repetir cada 20 s. */
  const yaAnunciados = new Set();

  /**
   * Fallos de mecánica por hilo (panel que no abre, foco que no se recupera).
   * No dicen nada sobre el mensaje del comprador, así que no pueden condenar el
   * hilo: se reintenta. En memoria a propósito — recargar da borrón y cuenta nueva.
   */
  const fallosTecnicos = new Map();
  const MAX_FALLOS_TECNICOS = 3;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const log = (...args) => config.verboseLogs && console.log(LOG_PREFIX, ...args);
  const warn = (...args) => console.warn(LOG_PREFIX, ...args);
  const normLabel = (text) => (text || "").toLowerCase().replace(/\s+/g, " ").trim();

  async function report(level, message) {
    // A la consola siempre: es lo único observable sin abrir el popup.
    console.log(`${LOG_PREFIX} [${level}] ${message}`);
    await chrome.runtime.sendMessage({ action: "LOG", data: { level, message } }).catch(() => {});
  }

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

  async function readMap(clave) {
    const data = await chrome.storage.local.get(clave);
    return data[clave] || {};
  }

  async function writeMap(clave, mapa) {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const [id, info] of Object.entries(mapa)) {
      const at = typeof info === "number" ? info : info?.at || 0;
      if (at < cutoff) delete mapa[id];
    }
    await chrome.storage.local.set({ [clave]: mapa });
  }

  const isHandled = async (id) => Boolean((await readMap("handledThreads"))[id]);
  const isReviewed = async (id) => Boolean((await readMap("reviewedThreads"))[id]);

  async function markHandled(id) {
    const mapa = await readMap("handledThreads");
    mapa[id] = Date.now();
    await writeMap("handledThreads", mapa);
  }

  async function markReviewed(id, motivo) {
    const mapa = await readMap("reviewedThreads");
    mapa[id] = { at: Date.now(), motivo };
    await writeMap("reviewedThreads", mapa);
  }

  async function recentReplies() {
    const { replyTimestamps = [] } = await chrome.storage.local.get("replyTimestamps");
    return replyTimestamps.filter((at) => at > Date.now() - 60 * 60 * 1000);
  }

  async function recordReply() {
    const recientes = await recentReplies();
    recientes.push(Date.now());
    await chrome.storage.local.set({ replyTimestamps: recientes });
  }

  // ======================================================================
  // Puertas: horario y cupo
  // ======================================================================

  function withinActiveHours(now = new Date()) {
    const { activeHoursStart: start, activeHoursEnd: end } = config;
    const hour = now.getHours();
    if (start === end) return true;
    return start < end ? hour >= start && hour < end : hour >= start || hour < end;
  }

  /**
   * ¿Está la pestaña visible?
   *
   * Chrome aplica "intensive throttling" a las pestañas ocultas: pasados ~5
   * minutos, sus temporizadores se limitan a uno por minuto. Como todo aquí se
   * apoya en temporizadores, en segundo plano una espera de 4 s puede tardar un
   * minuto y los tiempos de espera vencen antes de tiempo. Es la causa de que
   * unas veces funcione y otras no.
   *
   * Mejor no empezar que empezar y quedarse a medias.
   */
  const tabVisible = () => document.visibilityState === "visible";

  async function gateCheck() {
    if (!config.enabled) return { ok: false, reason: "Extensión apagada" };
    if (!tabVisible()) {
      return { ok: false, reason: "Pestaña en segundo plano (Chrome ralentiza los temporizadores)" };
    }
    if (!String(config.replyCopy || "").trim()) {
      return { ok: false, reason: "Falta el copy en el popup" };
    }
    if (!withinActiveHours()) {
      return {
        ok: false,
        reason: `Fuera del horario (${config.activeHoursStart}:00–${config.activeHoursEnd}:00)`
      };
    }

    const recientes = await recentReplies();
    if (recientes.length >= config.maxRepliesPerHour) {
      return { ok: false, reason: `Cupo por hora alcanzado (${recientes.length})` };
    }

    const ultimo = recientes.length ? Math.max(...recientes) : 0;
    const transcurrido = (Date.now() - ultimo) / 1000;
    if (ultimo && transcurrido < config.minSecondsBetweenReplies) {
      return {
        ok: false,
        reason: `Espaciado mínimo: faltan ${Math.ceil(config.minSecondsBetweenReplies - transcurrido)} s`
      };
    }
    return { ok: true };
  }

  // ======================================================================
  // Lectura de la lista de conversaciones
  // ======================================================================

  function threadIdFrom(href) {
    const match = (href || "").match(/\/t\/(\d+)/);
    return match ? match[1] : null;
  }

  function textLines(element) {
    return (element.innerText || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /**
   * Descompone una fila de la carpeta Marketplace. Estructura verificada:
   *   [0] "Mateo · 3 habitaciones 2 baños Departamento/condominio"
   *   [1] "Mensaje no leído:"        (sólo si está sin leer)
   *   [2] "Mateo: Hola. ¿Sigue estando disponible?"
   *   [3] "·"
   *   [4] "4 min"
   */
  function parseRow(link) {
    const threadId = threadIdFrom(link.getAttribute("href"));
    if (!threadId) return null;

    const lineas = textLines(link);
    if (lineas.length < 2) return null;

    const titulo = lineas[0];
    // Los hilos de Marketplace se titulan "<comprador> · <inmueble>". Los chats
    // personales no llevan ese separador, y así quedan fuera sin tocarlos.
    if (!titulo.includes(" · ")) return null;

    const mensaje =
      lineas
        .slice(1)
        .find((linea) => !UNREAD.test(linea) && !TIME_LINE.test(linea)) || "";

    let contenedor = link;
    for (let i = 0; i < 6 && contenedor.parentElement; i += 1) {
      contenedor = contenedor.parentElement;
    }

    return {
      threadId,
      element: link,
      titulo,
      nombre: titulo.split(" · ")[0].trim(),
      mensaje,
      unread: UNREAD.test(link.innerText || ""),
      menuButton: contenedor.querySelector(SELECTORS.rowMenuButton)
    };
  }

  function listRows() {
    const filas = [];
    const vistos = new Set();
    for (const link of document.querySelectorAll(SELECTORS.threadLink)) {
      const fila = parseRow(link);
      if (!fila || vistos.has(fila.threadId)) continue;
      vistos.add(fila.threadId);
      filas.push(fila);
    }
    return filas;
  }

  /** ¿El último mensaje del hilo lo escribimos nosotros? */
  function isOwnReply(mensaje) {
    if (/^t[úu]\s*:/i.test(mensaje || "")) return true;

    const copy = String(config.replyCopy || "").trim();
    if (!copy || !mensaje) return false;

    const norm = (t) =>
      t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

    // La vista previa antepone "Tú: " o el nombre; se compara el cuerpo.
    const cuerpo = norm(mensaje).replace(/^[^:]{1,40}:\s*/, "");
    const cabeza = norm(copy).slice(0, 25);
    return cabeza.length >= 10 && cuerpo.startsWith(cabeza);
  }

  /** ¿Está abierta la carpeta Marketplace? Sin ella no hay hilos que leer. */
  function folderLooksClosed() {
    return (
      listRows().length === 0 &&
      [...document.querySelectorAll('[role="row"]')].some(
        (r) => /marketplace/i.test(r.innerText || "") && /mensajes? nuevos?/i.test(r.innerText || "")
      )
    );
  }

  // ======================================================================
  // Lectura de la conversación abierta
  // ======================================================================

  function findConversation(titulo) {
    const wanted = normLabel(titulo);
    return (
      [...document.querySelectorAll(SELECTORS.conversation)].find((win) =>
        normLabel(win.getAttribute("aria-label")).endsWith(wanted)
      ) || null
    );
  }

  function findTextboxFor(titulo) {
    const wanted = normLabel(titulo);
    const visibles = [...document.querySelectorAll(SELECTORS.textbox)].filter(
      (box) => box.offsetParent !== null
    );
    // Preferente: la caja que declara a qué conversación pertenece.
    const exacta = visibles.find((box) => normLabel(box.getAttribute("aria-label")).endsWith(wanted));
    // En Messenger hay un solo panel, así que una única caja visible es segura.
    return exacta || (visibles.length === 1 ? visibles[0] : null);
  }

  /** Mensajes del panel, en orden, con su emisor. */
  function readMessages(win) {
    const mensajes = [];
    const vistos = new Set();

    for (const el of win.querySelectorAll("[aria-label]")) {
      const match = (el.getAttribute("aria-label") || "").match(MSG_LABEL);
      if (!match) continue;

      const quien = match[1].trim();
      const texto = match[2].trim();
      if (!texto || /inici[óo] este chat/i.test(texto)) continue;

      const clave = `${quien}::${texto}`;
      if (vistos.has(clave)) continue;
      vistos.add(clave);

      mensajes.push({ quien, texto, propio: OWN_SENDER.test(quien) });
    }
    return mensajes;
  }

  function lastIncomingMessage(win) {
    const mensajes = readMessages(win);
    const ultimo = mensajes[mensajes.length - 1];
    return ultimo && !ultimo.propio ? ultimo.texto : null;
  }

  function alreadyAnswered(win) {
    return readMessages(win).some(
      (m) => m.propio && /wa\.me\/|api\.whatsapp\.com/i.test(m.texto)
    );
  }

  // ======================================================================
  // Devolver a "no leído"
  // ======================================================================

  async function closeAnyMenu() {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
    await sleep(300);
  }

  /**
   * Devuelve la conversación al estado "no leído".
   *
   * Es la razón de haber movido todo a Messenger: la bandeja de Marketplace no
   * ofrece esta acción en ninguno de sus menús.
   */
  async function markAsUnread(threadId, nombre) {
    let motivo = "motivo desconocido";
    let vistos = [];

    // Un menú abierto de antes convertiría el clic siguiente en un cierre.
    await closeAnyMenu();

    for (let intento = 1; intento <= 2; intento += 1) {
      const fila = listRows().find((r) => r.threadId === threadId);
      if (!fila) {
        motivo = "la fila ya no aparece en la lista";
        await sleep(700);
        continue;
      }
      if (!fila.menuButton) {
        motivo = "la fila no expone el botón «Más opciones»";
        await sleep(700);
        continue;
      }

      // Una fila fuera del viewport puede no responder al clic.
      try {
        fila.element.scrollIntoView({ block: "center" });
      } catch {
        /* da igual si no se puede */
      }
      await sleep(400);

      fila.menuButton.click();
      const opcion = await waitFor(
        () =>
          [...document.querySelectorAll(SELECTORS.menuItem)].find((x) =>
            MARK_UNREAD.test(x.innerText || "")
          ),
        6000
      );

      if (opcion) {
        opcion.click();
        await sleep(900);
        return true;
      }

      // Qué SÍ ofrecía el menú: con esto el próximo fallo se diagnostica solo.
      vistos = [...document.querySelectorAll(SELECTORS.menuItem)]
        .map((x) => (x.innerText || "").trim())
        .filter(Boolean)
        .slice(0, 6);
      motivo = vistos.length
        ? `el menú no ofreció "Marcar como no leído" (tenía: ${vistos.join(", ")})`
        : "el menú no llegó a abrirse";

      await closeAnyMenu();
      await sleep(600);
    }

    await report("warn", `${nombre}: no se pudo devolver a no leído — ${motivo}.`);
    return false;
  }

  // ======================================================================
  // Escritura
  // ======================================================================

  async function waitFor(predicate, timeoutMs = 10000, stepMs = 300) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await sleep(stepMs);
    }
    return null;
  }

  const sameText = (a, b) =>
    (a || "").replace(/ /g, " ").replace(/\s+/g, " ").trim() ===
    (b || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();

  /**
   * Cursor al FINAL. `focus()` por sí solo lo devuelve al principio, y entonces
   * lo que se escriba después se inserta delante de lo ya escrito. Ese fue el
   * fallo que mandó un mensaje mutilado a un comprador real.
   */
  function caretToEnd(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /**
   * Vacía el compositor y COMPRUEBA que quedó vacío.
   *
   * La versión anterior daba por hecho que `selectAll + delete` funcionaba, y
   * cuando no, dejaba medio copy como borrador visible en la bandeja.
   */
  async function clearComposer(textbox) {
    for (let intento = 0; intento < 3; intento += 1) {
      try {
        textbox.focus();
        const range = document.createRange();
        range.selectNodeContents(textbox);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand("delete", false, null);
        await sleep(200);
        if ((textbox.innerText || "").trim() === "") return true;
      } catch {
        return false;
      }
    }
    return (textbox.innerText || "").trim() === "";
  }

  async function ensureFocus(titulo) {
    for (let intento = 0; intento < 6; intento += 1) {
      const box = findTextboxFor(titulo);
      if (box && box.isConnected) {
        const enfocado = () =>
          document.activeElement === box || box.contains(document.activeElement);
        if (enfocado()) return box;
        box.focus();
        caretToEnd(box);
        await sleep(80);
        if (enfocado()) return box;
      }
      await sleep(200);
    }
    return null;
  }

  /**
   * Inserta el texto de una vez simulando un pegado.
   *
   * Escribir por trozos no funciona aquí: al empezar a teclear, Messenger
   * retira el panel de "respuesta rápida" y re-renderiza el compositor. Lexical
   * se reinicializa, `execCommand` deja de surtir efecto EN SILENCIO, y el
   * mensaje se queda congelado en los ~120 caracteres que hubiera en ese
   * instante. Ocurría siempre en el mismo punto, lo que delató la causa.
   *
   * Un pegado es atómico: Lexical lo procesa entero, con saltos de línea
   * incluidos, sin dejar ninguna ventana para que algo se interponga.
   */
  function pasteInto(textbox, text) {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    textbox.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })
    );
  }

  async function humanType(titulo, text) {
    const textbox = await ensureFocus(titulo);
    if (!textbox) return { ok: false, reason: "no se pudo enfocar el editor" };

    await clearComposer(textbox);
    await ensureFocus(titulo);
    pasteInto(textbox, text);

    // Lexical procesa el pegado de forma asíncrona.
    const listo = await waitFor(
      () => sameText(textbox.innerText || "", text),
      4000,
      200
    );

    if (!listo) {
      return {
        ok: false,
        reason: `el editor no aceptó el texto completo (${(textbox.innerText || "").length} de ${text.length})`,
        textbox
      };
    }

    // Una pausa breve antes de enviar: leerlo antes de darle a Enter.
    await sleep(rand(600, 1400));
    return { ok: true, textbox };
  }

  function findSendButton(win) {
    return (
      [...win.querySelectorAll(SELECTORS.button)].find((b) =>
        SEND_EXACT.includes(normLabel(b.getAttribute("aria-label")))
      ) || null
    );
  }

  async function submit(win, textbox) {
    await sleep(rand(700, 1600)); // relectura antes de enviar

    const boton = findSendButton(win);
    if (boton) {
      boton.click();
    } else {
      const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      textbox.dispatchEvent(new KeyboardEvent("keydown", opts));
      textbox.dispatchEvent(new KeyboardEvent("keyup", opts));
    }
    return Boolean(await waitFor(() => (textbox.innerText || "").trim() === "", 5000, 300));
  }

  // ======================================================================
  // Orquestación
  // ======================================================================

  async function technicalFailure(threadId, nombre, motivo) {
    const intentos = (fallosTecnicos.get(threadId) || 0) + 1;
    fallosTecnicos.set(threadId, intentos);

    if (intentos >= MAX_FALLOS_TECNICOS) {
      await markReviewed(threadId, `fallo técnico repetido: ${motivo}`);
      await report("error", `${nombre}: ${motivo} (${intentos} intentos). Se deja de reintentar.`);
    } else {
      await report("warn", `${nombre}: ${motivo}. Reintento ${intentos} de ${MAX_FALLOS_TECNICOS}.`);
    }
    return false;
  }

  async function replyToThread(row) {
    const { threadId, titulo, nombre } = row;

    // La pausa humana va ANTES de abrir: cuanto menos tiempo pase entre abrir
    // y escribir, menos ocasiones hay de que algo interrumpa.
    await sleep(rand(config.minPreReplyDelayMs, config.maxPreReplyDelayMs));

    const fresca = listRows().find((r) => r.threadId === threadId);
    if (!fresca) return technicalFailure(threadId, nombre, "la conversación desapareció de la lista");

    log(`Abriendo la conversación de ${nombre}…`);
    fresca.element.click();

    const win = await waitFor(() => findConversation(titulo), 12000);
    if (!win) return technicalFailure(threadId, nombre, "no se abrió la conversación");

    const textbox = await waitFor(() => findTextboxFor(titulo), 8000);
    if (!textbox) return technicalFailure(threadId, nombre, "no apareció el editor");

    if (alreadyAnswered(win)) {
      await markHandled(threadId);
      await report("info", `${nombre} ya tenía respuesta con enlace de WhatsApp.`);
      return false;
    }

    // Verificación con el texto completo del panel. La lista ya trae el mensaje
    // entero, así que casi siempre coincidirá; esto es la última red.
    const completo = lastIncomingMessage(win);
    if (!completo) {
      await markAsUnread(threadId, nombre);
      await markReviewed(threadId, "no se pudo leer el mensaje");
      await report("para-ti", `${nombre}: no se pudo leer el mensaje. Devuelto a no leído.`);
      return false;
    }

    const verdict = LeadClassifier.classify(completo);
    if (!verdict.autoReply) {
      const devuelto = await markAsUnread(threadId, nombre);
      await markReviewed(threadId, verdict.reason);
      await report(
        "para-ti",
        `${nombre}: "${completo.slice(0, 70)}" — ${verdict.reason}.` +
          (devuelto ? " Devuelto a no leído." : " NO se pudo devolver a no leído.")
      );
      return false;
    }

    const copy = String(config.replyCopy).trim();
    const typing = await humanType(titulo, copy);
    if (!typing.ok) {
      const limpio = typing.textbox ? await clearComposer(typing.textbox) : true;
      return technicalFailure(
        threadId,
        nombre,
        typing.reason + (limpio ? "" : " (⚠️ quedó un borrador, bórralo a mano)")
      );
    }

    // Nunca se envía algo que no sea EXACTAMENTE el copy.
    const compuesto = typing.textbox.innerText || "";
    if (!sameText(compuesto, copy)) {
      const limpio = await clearComposer(typing.textbox);
      await markReviewed(threadId, "el texto compuesto no coincidía con el copy");
      await report(
        "error",
        `${nombre}: el editor quedó con un texto distinto al copy ` +
          `(${compuesto.length} de ${copy.length} caracteres). Descartado sin enviar.` +
          (limpio ? "" : " ⚠️ Quedó un borrador en ese chat: bórralo a mano.")
      );
      return false;
    }

    // Se marca ANTES de enviar: un duplicado es peor que una respuesta perdida.
    await markHandled(threadId);
    const enviado = await submit(win, typing.textbox);

    if (enviado) {
      await recordReply();
      await report("sent", `Respondido a ${nombre}: "${completo.slice(0, 50)}"`);
      return true;
    }

    await report(
      "error",
      `${nombre}: se escribió el copy completo pero no se confirmó el envío. ` +
        "Revisa el chat: puede haber salido igualmente. No se reintentará."
    );
    return false;
  }

  let avisoCarpeta = 0;

  async function scan() {
    if (busy) return;

    const gate = await gateCheck();
    if (!gate.ok) {
      log("Sin actuar:", gate.reason);
      return;
    }

    if (folderLooksClosed()) {
      // Una vez cada cinco minutos: es una condición de operación, no un error
      // que se resuelva solo.
      if (Date.now() - avisoCarpeta > 300000) {
        avisoCarpeta = Date.now();
        await report("warn", "Abre la carpeta «Marketplace» en Messenger: sin ella no se ven los hilos.");
      }
      return;
    }

    busy = true;
    try {
      for (const row of listRows()) {
        if (!row.unread) continue;
        if (isOwnReply(row.mensaje)) continue;
        if (await isHandled(row.threadId)) continue;
        if (await isReviewed(row.threadId)) continue;

        const verdict = LeadClassifier.classify(row.mensaje);

        if (!verdict.autoReply) {
          // No se abre. Se queda sin leer, con su punto azul intacto.
          if (!yaAnunciados.has(row.threadId)) {
            yaAnunciados.add(row.threadId);
            log(`${row.nombre} para ti (sin abrir): ${verdict.reason}`);
          }
          continue;
        }

        await replyToThread(row);
        return; // uno por pasada: el cupo y el espaciado mandan
      }
    } catch (err) {
      warn("Fallo recorriendo la carpeta:", err);
      await report("error", err.message);
    } finally {
      busy = false;
    }
  }

  // ======================================================================
  // Diagnóstico
  // ======================================================================

  function diagnose() {
    const filas = listRows();
    const detalle = filas.map((row) => {
      const propio = isOwnReply(row.mensaje);
      const verdict = LeadClassifier.classify(row.mensaje);
      return {
        quien: row.nombre,
        sinLeer: row.unread,
        propio,
        responde: row.unread && !propio && verdict.autoReply,
        motivo: propio ? "el último mensaje es nuestro" : verdict.reason,
        menu: Boolean(row.menuButton),
        mensaje: row.mensaje.slice(0, 55)
      };
    });

    const pendientes = detalle.filter((d) => d.sinLeer && !d.propio);
    const resumen = [
      `Versión del script: ${VERSION}`,
      `Pestaña visible: ${tabVisible() ? "sí" : "NO — en segundo plano no responde"}`,
      `URL: ${location.pathname}`,
      `Carpeta Marketplace: ${folderLooksClosed() ? "CERRADA — ábrela" : "abierta"}`,
      `Conversaciones detectadas: ${filas.length}`,
      `  sin leer: ${detalle.filter((d) => d.sinLeer).length}` +
        ` · pendientes: ${pendientes.length}` +
        ` · se responderían: ${detalle.filter((d) => d.responde).length}`,
      `  con menú de "no leído": ${detalle.filter((d) => d.menu).length} de ${filas.length}`,
      "",
      ...pendientes.slice(0, 8).map((d) => `  ${d.responde ? "RESP" : "PARA-TI"} · ${d.quien} · ${d.mensaje}`)
    ];

    console.log(`${LOG_PREFIX} ── DIAGNÓSTICO ──`);
    console.table(detalle);

    return {
      version: VERSION,
      total: filas.length,
      unread: detalle.filter((d) => d.sinLeer).length,
      wouldReply: detalle.filter((d) => d.responde).length,
      resumen: resumen.join("\n"),
      detalle
    };
  }

  /**
   * Publica el estado en un atributo del <html>.
   *
   * El registro vive en chrome.storage, al que sólo llegan los contextos de la
   * extensión. Espejarlo en el DOM permite seguir el funcionamiento desde
   * fuera, sin abrir el popup y sin depender de la consola de una pestaña
   * concreta. El registro es compartido, así que refleja también lo que hacen
   * otras pestañas.
   */
  async function publishState() {
    try {
      const { eventLog = [] } = await chrome.storage.local.get("eventLog");
      const filas = listRows();
      document.documentElement.setAttribute(
        "data-leadrouter",
        JSON.stringify({
          version: VERSION,
          visible: tabVisible(),
          enabled: config.enabled,
          carpetaAbierta: !folderLooksClosed(),
          conversaciones: filas.length,
          sinLeer: filas.filter((r) => r.unread).length,
          ultimos: eventLog.slice(0, 12).map((e) => `${e.at?.slice(11, 19)} [${e.level}] ${e.message}`)
        })
      );
    } catch {
      /* la extensión pudo recargarse bajo los pies */
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.eventLog) publishState();
  });
  document.addEventListener("visibilitychange", publishState);
  setInterval(publishState, 5000);

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
      `${LOG_PREFIX} ${VERSION} activo en Messenger. Estado: ${config.enabled ? "ENCENDIDO" : "apagado"}. ` +
        "Recuerda abrir la carpeta «Marketplace»."
    );
  });
})();

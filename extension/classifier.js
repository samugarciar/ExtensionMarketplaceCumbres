/**
 * Decide si un mensaje entrante es una pregunta genérica de disponibilidad.
 *
 * Es la única decisión que toma el sistema, así que vive aislada del DOM y
 * tiene pruebas propias (`classifier.test.js`, se corre con `node --test`).
 *
 * El sesgo es deliberado: **ante la duda, va a tu bandeja**. Un mensaje
 * genérico que no se auto-responde te cuesta un minuto; una respuesta enlatada
 * a alguien que preguntaba el canon te cuesta el cliente.
 */

(function (root) {
  "use strict";

  // Longitud máxima de un "¿sigue disponible?" con saludo incluido.
  // Por encima de esto hay más contenido, y ese más lo respondes tú.
  const MAX_LENGTH = 90;

  // Facebook corta la vista previa de la bandeja. Si viene cortado, el mensaje
  // es más largo de lo que vemos: no lo clasificamos, no lo abrimos.
  const TRUNCATION_MARKERS = ["…", "..."];

  /** Saludos y cortesía: ruido que no cambia la intención. Se retiran antes de juzgar. */
  const FILLERS = [
    "buenos dias", "buenas tardes", "buenas noches", "buen dia",
    "cordial saludo", "que tal", "como estas", "como esta",
    "hola", "buenas", "hey", "saludos",
    "por favor", "porfa", "gracias", "muchas gracias",
    "senor", "senora", "disculpe", "perdon"
  ];

  /**
   * Núcleo de una pregunta de disponibilidad. Incluye el mensaje predefinido
   * que Marketplace ofrece con un toque, que es el caso masivo.
   */
  const AVAILABILITY_PATTERNS = [
    // "sigue disponible", y también "sigue ESTANDO disponible", que es como
    // Facebook redacta su mensaje predefinido: "¿Sigue estando disponible
    // este artículo?". Ese es el caso de mayor volumen con diferencia.
    /\b(sigue|siguen|sigo|esta|estan|continua)\s+(estando\s+|siendo\s+)?(aun\s+|todavia\s+)?disponible/,
    // "…disponible este artículo / el inmueble / el apartamento"
    /\bdisponible\s+(este|esta|el|la|los|las)\b/,
    // Anclado a propósito: sólo "disponible?" o "aún disponible?", no
    // cualquier frase que TERMINE en "disponible". Sin este ancla, la vista
    // previa de nuestra propia respuesta ("…el inmueble se encuentra
    // disponible") se clasificaba como pregunta entrante.
    /^(\S+\s+){0,2}disponible\s*\??$/,
    /^disponible\b/,
    /\baun\s+(esta|sigue|lo tienen|la tienen|lo tiene|la tiene)\b/,
    /\btodavia\s+(esta|sigue|lo tienen|la tienen|lo tiene|la tiene)\b/,
    /\b(lo|la)\s+(tienes|tiene|tienen)\s+(aun|todavia)\b/,
    /\bsigue\s+(en\s+)?(arriendo|venta|alquiler|renta)\b/,
    /\besta\s+libre\b/,
    /\bya\s+(se\s+)?(arrendo|vendio|alquilo)\b/,
    // Marketplace en inglés, por si el comprador tiene la interfaz en otro idioma.
    /\bis\s+this\s+(item\s+)?still\s+available\b/,
    /\bstill\s+available\b/
  ];

  /**
   * Si aparece cualquiera de estos, el mensaje pide algo concreto que el copy
   * fijo no responde. Va a tu bandeja sin tocarse.
   */
  const DISQUALIFIERS = [
    // Interrogativos: piden un dato específico, no un sí/no.
    "cuanto", "cuanta", "cuantos", "cuantas", "donde", "cuando",
    "cual", "cuales", "quien", "por que", "porque",

    // Dinero
    "precio", "vale", "valor", "canon", "arriendo mensual", "mensualidad",
    "administracion", "cuota", "deposito", "negociable", "rebaja", "descuento",
    "ultimo", "oferta", "credito", "subsidio", "financia", "financiacion",
    "banco", "leasing", "hipoteca", "millones", "pesos",

    // Ubicación
    "ubicacion", "ubicado", "direccion", "barrio", "sector", "zona",
    "queda", "localidad", "municipio", "cerca de", "mapa",

    // Características del inmueble
    "metros", "m2", "area", "habitacion", "habitaciones", "alcoba", "alcobas",
    "cuarto", "cuartos", "bano", "banos", "parqueadero", "garaje",
    "estrato", "piso", "ascensor", "balcon", "patio", "cocina",
    "amoblado", "remodelado", "antiguedad", "estado",

    // Trámites y visitas
    "visita", "visitar", "ver el", "verlo", "verla", "conocer",
    "cita", "agendar", "mostrar", "muestran", "horario", "disponibilidad de",
    "requisito", "requisitos", "papeles", "documento", "documentos",
    "fiador", "codeudor", "poliza", "contrato", "escritura",
    "mascota", "mascotas", "ninos",

    // Ya está negociando o pidiendo otro canal
    "whatsapp", "telefono", "celular", "numero", "correo", "email",
    "llamar", "llamame", "escribeme"
  ];

  /**
   * Aperturas afirmativas: quien empieza así está RESPONDIENDO, no preguntando.
   * Separa "¿está disponible?" (comprador) de "Sí, está disponible" (nosotros),
   * que de otro modo comparten el mismo patrón.
   */
  const AFFIRMATIVE_OPENER =
    /^(si|claro|por supuesto|efectivamente|correcto|asi es|listo|dale|buenas noticias)\b/;

  /** Minúsculas, sin tildes, sin emoji, espacios colapsados. */
  function normalize(text) {
    return (text || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}️]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Quita el prefijo "Nombre:" o "Tú:" que la bandeja antepone a la vista previa. */
  function stripSenderPrefix(text) {
    return (text || "").replace(/^[^:]{1,40}:\s*/, "");
  }

  function looksTruncated(text) {
    const trimmed = (text || "").trim();
    return TRUNCATION_MARKERS.some((marker) => trimmed.endsWith(marker));
  }

  function stripFillers(normalized) {
    let result = normalized;
    // Se repite porque "hola buenas tardes" son dos rellenos encadenados.
    for (let pass = 0; pass < 3; pass += 1) {
      for (const filler of FILLERS) {
        result = result.replace(new RegExp(`\\b${filler}\\b`, "g"), " ");
      }
      result = result.replace(/\s+/g, " ").trim();
    }
    return result.replace(/^[,.!?¡¿\s]+|[,.!?¡¿\s]+$/g, "").trim();
  }

  function findDisqualifier(normalized) {
    return DISQUALIFIERS.find((word) => normalized.includes(word)) || null;
  }

  /**
   * @param {string} rawText Texto del mensaje (o vista previa de la bandeja).
   * @returns {{autoReply: boolean, reason: string}}
   */
  function classify(rawText) {
    const withoutPrefix = stripSenderPrefix(rawText);

    if (!withoutPrefix.trim()) {
      return { autoReply: false, reason: "Mensaje vacío" };
    }

    if (looksTruncated(withoutPrefix)) {
      return {
        autoReply: false,
        reason: "La vista previa está cortada: el mensaje es más largo de lo que se ve"
      };
    }

    const normalized = normalize(withoutPrefix);

    if (normalized.length > MAX_LENGTH) {
      return { autoReply: false, reason: `Demasiado largo (${normalized.length} caracteres)` };
    }

    const disqualifier = findDisqualifier(normalized);
    if (disqualifier) {
      return { autoReply: false, reason: `Pregunta algo concreto: "${disqualifier}"` };
    }

    const core = stripFillers(normalized);
    if (!core) {
      return { autoReply: false, reason: "Sólo un saludo, sin pregunta" };
    }

    if (AFFIRMATIVE_OPENER.test(core)) {
      return { autoReply: false, reason: "Es una respuesta afirmativa, no una pregunta" };
    }

    const matched = AVAILABILITY_PATTERNS.some((pattern) => pattern.test(core));
    if (!matched) {
      return { autoReply: false, reason: "No es una pregunta de disponibilidad" };
    }

    return { autoReply: true, reason: "Pregunta genérica de disponibilidad" };
  }

  const api = { classify, normalize, stripFillers, stripSenderPrefix, looksTruncated, MAX_LENGTH };

  // Sirve tanto como content script (global) como para `node --test`.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.LeadClassifier = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

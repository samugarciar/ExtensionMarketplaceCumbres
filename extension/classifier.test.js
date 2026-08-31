/**
 * Pruebas del clasificador.  Ejecutar:  node --test extension/
 *
 * La mitad interesante es la segunda: los mensajes que NO deben auto-responderse.
 * Un falso positivo manda un copy enlatado a alguien que preguntaba otra cosa.
 */

const test = require("node:test");
const assert = require("node:assert");
const { classify } = require("./classifier.js");

const auto = (text) => classify(text).autoReply;
const why = (text) => classify(text).reason;

// ===========================================================================
// SÍ deben auto-responderse
// ===========================================================================

test("el mensaje predefinido de Marketplace", () => {
  // Este es el texto EXACTO que Facebook envía con un toque. Se verificó
  // contra la bandeja real: es el caso de mayor volumen y una versión previa
  // del clasificador lo rechazaba por exigir "sigue disponible" pegado.
  assert.ok(auto("¿Sigue estando disponible este artículo?"));
  assert.ok(auto("Sigue estando disponible este artículo?"));
  assert.ok(auto("¿Sigue estando disponible?"));
  assert.ok(auto("Is this item still available?"));

  assert.ok(auto("¿Sigue disponible?"));
  assert.ok(auto("Sigue disponible?"));
  assert.ok(auto("sigue disponible"));
});

test("el predefinido con una pregunta encima sigue yendo a la bandeja", () => {
  const casos = [
    "¿Sigue estando disponible este artículo? ¿Cuánto es el canon?",
    "¿Sigue estando disponible este artículo? ¿En qué barrio queda?",
    "¿Sigue estando disponible este artículo? ¿Cuántas habitaciones tiene?",
    "¿Sigue estando disponible este artículo? ¿Cuándo lo puedo ver?"
  ];
  for (const caso of casos) {
    assert.strictEqual(auto(caso), false, `NO debería auto-responder: ${caso}`);
  }
});

test("variantes con saludo", () => {
  const casos = [
    "Hola, ¿sigue disponible?",
    "Buenas tardes, sigue disponible?",
    "Hola! Buenas noches, ¿aún está disponible?",
    "Buenos días, ¿todavía está disponible?",
    "Hola, por favor, ¿sigue disponible?",
    "Cordial saludo, ¿sigue disponible el inmueble?"
  ];
  for (const caso of casos) {
    assert.ok(auto(caso), `debería auto-responder: ${caso}`);
  }
});

test("variantes de fraseo", () => {
  const casos = [
    "¿Está disponible?",
    "disponible?",
    "Aún lo tienen?",
    "¿Todavía lo tienen?",
    "sigue en arriendo?",
    "¿Sigue en venta?",
    "¿Está libre?",
    "Hola, ¿ya se arrendó?"
  ];
  for (const caso of casos) {
    assert.ok(auto(caso), `debería auto-responder: ${caso}`);
  }
});

test("con emoji y puntuación de más", () => {
  assert.ok(auto("Hola!! 😊 ¿sigue disponible???"));
  assert.ok(auto("buenas... sigue disponible ?"));
});

test("compradores con la interfaz en inglés", () => {
  assert.ok(auto("Is this still available?"));
  assert.ok(auto("Hi, still available?"));
});

test("la bandeja antepone el nombre del remitente", () => {
  assert.ok(auto("Carlos Ramírez: ¿Sigue disponible?"));
});

// ===========================================================================
// NO deben auto-responderse — aquí está el valor real
// ===========================================================================

test("preguntas por dinero van a la bandeja", () => {
  const casos = [
    "¿Sigue disponible? ¿Cuánto es el canon?",
    "Hola, ¿cuál es el precio?",
    "¿Está disponible? ¿El valor incluye administración?",
    "sigue disponible? es negociable?",
    "Buenas, ¿cuánto vale el arriendo?",
    "¿Aplica para subsidio de vivienda?"
  ];
  for (const caso of casos) {
    assert.strictEqual(auto(caso), false, `NO debería auto-responder: ${caso}`);
  }
});

test("preguntas por ubicación van a la bandeja", () => {
  const casos = [
    "¿Sigue disponible? ¿En qué barrio queda?",
    "Hola, ¿dónde está ubicado?",
    "¿Disponible? ¿Cuál es la dirección exacta?",
    "sigue disponible, en que sector es?"
  ];
  for (const caso of casos) {
    assert.strictEqual(auto(caso), false, `NO debería auto-responder: ${caso}`);
  }
});

test("preguntas por características del inmueble van a la bandeja", () => {
  const casos = [
    "¿Sigue disponible? ¿Cuántas habitaciones tiene?",
    "Hola, ¿de cuántos metros es?",
    "¿Disponible? ¿Qué estrato es?",
    "sigue disponible? tiene parqueadero?",
    "¿Está disponible? ¿Viene amoblado?",
    "Buenas, ¿en qué piso está?",
    "¿Sigue disponible? ¿Acepta mascotas?"
  ];
  for (const caso of casos) {
    assert.strictEqual(auto(caso), false, `NO debería auto-responder: ${caso}`);
  }
});

test("solicitudes de visita o trámites van a la bandeja", () => {
  const casos = [
    "¿Sigue disponible? ¿Cuándo lo puedo ver?",
    "Hola, quisiera agendar una visita",
    "¿Disponible? ¿Qué requisitos piden?",
    "sigue disponible? necesito fiador?",
    "¿Está disponible? ¿Me lo pueden mostrar el sábado?"
  ];
  for (const caso of casos) {
    assert.strictEqual(auto(caso), false, `NO debería auto-responder: ${caso}`);
  }
});

test("quien ya pide otro canal va a la bandeja", () => {
  assert.strictEqual(auto("¿Sigue disponible? Pásame tu WhatsApp"), false);
  assert.strictEqual(auto("Hola, ¿me puedes llamar al 3001234567?"), false);
});

test("nuestra propia respuesta nunca se confunde con una pregunta", () => {
  // La bandeja muestra el último mensaje del hilo. En los ya contestados, ese
  // último mensaje es el nuestro, y también contiene la palabra "disponible".
  const casos = [
    "Hola! Sí, el inmueble se encuentra disponible",
    "el inmueble se encuentra disponible",
    "Sí, el apartamento está disponible",
    "Claro que sí, sigue disponible",
    "Sí, sigue disponible 🙏"
  ];
  for (const caso of casos) {
    assert.strictEqual(auto(caso), false, `NO debería auto-responder: ${caso}`);
  }
});

test("un saludo suelto no es una pregunta", () => {
  for (const caso of ["Hola", "Buenas tardes", "Hola!", "Buenas 😊"]) {
    assert.strictEqual(auto(caso), false, `NO debería auto-responder: ${caso}`);
  }
});

test("mensajes sin relación con disponibilidad van a la bandeja", () => {
  const casos = [
    "Me interesa, ¿podemos hablar?",
    "Ya lo tomé, gracias",
    "¿Tienen otros inmuebles parecidos?",
    "Buenas, vi el anuncio en la página"
  ];
  for (const caso of casos) {
    assert.strictEqual(auto(caso), false, `NO debería auto-responder: ${caso}`);
  }
});

test("una vista previa cortada nunca se auto-responde", () => {
  // Aunque empiece igual que un caso válido: lo que no se ve puede cambiarlo todo.
  assert.strictEqual(auto("Hola, ¿sigue disponible? Quería saber si…"), false);
  assert.strictEqual(auto("¿Sigue disponible? También quería..."), false);
  assert.match(why("¿Sigue disponible? Quería saber si…"), /cortada/);
});

test("un mensaje largo va a la bandeja aunque mencione disponibilidad", () => {
  const largo =
    "Hola buenas tardes, estoy buscando algo para mudarme con mi familia " +
    "el próximo mes y vi que sigue disponible, me gustaría saber más";
  assert.strictEqual(auto(largo), false);
});

test("mensaje vacío o en blanco", () => {
  assert.strictEqual(auto(""), false);
  assert.strictEqual(auto("   "), false);
  assert.strictEqual(auto(null), false);
});

// ===========================================================================
// El motivo debe ser legible: se muestra en el registro del popup
// ===========================================================================

test("cada rechazo explica por qué", () => {
  assert.match(why("¿Cuánto vale?"), /concreto/);
  assert.match(why("Hola"), /saludo/);
  assert.match(why("Me interesa el inmueble"), /disponibilidad/);
});

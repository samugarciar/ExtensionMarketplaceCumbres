# FB Marketplace Lead Router

Extensión de Chrome que atiende la bandeja de Facebook Marketplace con una sola
regla:

> Si el mensaje es **sólo** una pregunta de disponibilidad, responde con tu copy.
> Cualquier otra cosa se queda **sin leer**, esperándote en la bandeja.

No hay servidor, ni base de datos, ni API key. Todo vive en la extensión.

---

## ⚠️ Antes de encenderla

Automatizar el inbox va contra los Términos de Servicio de Facebook. Meta detecta
automatización a nivel de sesión y de cuenta, no por la velocidad del tecleo, así
que **nada de aquí garantiza que la cuenta no sea restringida**. Usa una cuenta
de negocio cuya pérdida no te bloquee la operación.

La extensión llega apagada de fábrica y con límites conservadores (15/hora,
2 minutos entre mensajes, 18:00–00:00).

---

## Instalación

1. `chrome://extensions/` → activa **Modo de desarrollador**.
2. **Cargar descomprimida** → selecciona la carpeta `extension/`.
3. Abre el popup y **pega tu copy** en el recuadro. El campo trae un ejemplo
   de estructura como texto de fondo. Mientras esté vacío no se responde nada.
4. Abre <https://www.facebook.com/marketplace/inbox> con tu sesión iniciada.
5. Pulsa **Ver qué detecta** y comprueba que reconoce tus hilos *antes* de
   encender el interruptor.
6. Enciende.

Para que funcione desatendida:

```bash
./ops/start-24-7.sh start
```

Desactiva la suspensión del Mac y abre la bandeja en Chrome. Es lo único que
hace falta: **si Chrome se cierra o el equipo se duerme, no se responde nada.**

---

## Cómo decide

La decisión completa está en [`extension/classifier.js`](extension/classifier.js),
aislada del DOM y con pruebas propias. El sesgo es deliberado: **ante la duda, a
tu bandeja.** Un genérico que no se auto-responde te cuesta un minuto; un copy
enlatado a quien preguntaba el canon te cuesta el cliente.

Se auto-responde sólo si el mensaje cumple **todo**:

| Condición | Por qué |
|---|---|
| Coincide con un patrón de disponibilidad | `sigue disponible`, `aún lo tienen`, `¿está libre?`, el mensaje predefinido de Marketplace, y sus equivalentes en inglés |
| No menciona nada concreto | Precio, canon, administración, ubicación, metros, habitaciones, estrato, parqueadero, visitas, requisitos, fiador, mascotas… cualquiera de estos lo manda a tu bandeja |
| No lleva interrogativo específico | `cuánto`, `dónde`, `cuándo`, `cuál`, `cuántos` piden un dato, no un sí/no |
| Tiene menos de 90 caracteres | Por encima de eso hay más contenido del que el copy responde |
| La vista previa no está cortada | Si termina en `…`, el mensaje es más largo de lo que se ve: no se abre |

Ejemplos reales:

| Mensaje | Qué pasa |
|---|---|
| «¿Sigue disponible?» | ✅ Se responde |
| «Hola, buenas tardes, ¿aún está disponible?» | ✅ Se responde |
| «¿Sigue disponible? ¿Cuánto es el canon?» | ❌ Para ti |
| «¿Disponible? ¿Cuántas habitaciones tiene?» | ❌ Para ti |
| «¿Sigue disponible? ¿Cuándo lo puedo ver?» | ❌ Para ti |
| «Hola» | ❌ Para ti |

### Nunca abre un hilo que no va a responder

Clasifica leyendo la vista previa de la lista, sin entrar. Sólo abre los hilos
que ya sabe que va a contestar. Por eso el resto se queda sin leer de forma
natural — no hace falta "marcar como no leído" ni queda rastro de apertura.

El único caso en que abre un hilo y no responde: si al ver el mensaje completo
resulta que la vista previa se quedaba corta. Entonces no escribe nada y te lo
avisa en el registro del popup, porque ese hilo sí quedó marcado como leído.

### Ajustar el criterio

Las listas de patrones y descalificadores están al principio de
`classifier.js`, en castellano y comentadas. Si añades o quitas términos:

```bash
node --test extension/
```

17 grupos de pruebas, la mayoría dedicados a los mensajes que **no** deben
auto-responderse.

---

## Diagnóstico

El botón **Ver qué detecta** del popup recorre la bandeja abierta y te dice
cuántos hilos ve, cuántos están sin leer y a cuántos respondería ahora mismo.
El detalle por hilo — las líneas que leyó, cuál tomó como vista previa y por
qué decidió lo que decidió — va a la consola de la pestaña (F12 → Console).

Es la herramienta a usar cuando Facebook cambie el DOM. Todos los selectores
frágiles están en un único bloque `SELECTORS` al principio de
[`extension/content.js`](extension/content.js); se parchea ahí y en ningún otro
sitio.

---

## Problemas frecuentes

| Síntoma | Causa habitual |
|---|---|
| No responde nada | Interruptor apagado, fuera de horario, o el copy está vacío. El popup lo dice arriba. |
| «Ver qué detecta» falla | La pestaña activa no es la bandeja de Marketplace. Ábrela y recárgala. |
| Ve 0 hilos sin leer | Facebook cambió cómo marca lo no leído. Mira `UNREAD_HINTS` en `content.js`. |
| Ve los hilos pero no responde ninguno | La vista previa se está extrayendo mal. El diagnóstico muestra qué línea toma. |
| Escribe pero no envía | Cambió el botón de envío. Revisa `SEND_LABELS` en `content.js`. |
| Respondió algo que no debía | Añade el término a `DISQUALIFIERS` en `classifier.js` y añade el caso a las pruebas. |
| Quiero volver a responder un hilo | «Olvidar hilos ya respondidos», en Horario y límites. |

---

## Estructura

```
extension/
  classifier.js       La única decisión: ¿es genérico o es para ti?
  classifier.test.js  node --test, sin dependencias
  content.js          Recorre la bandeja, abre sólo lo que responde, escribe
  background.js       Contador del icono y valores por defecto
  popup.*             Copy, horario, límites, diagnóstico y registro
ops/
  start-24-7.sh       Anti-suspensión + abrir Chrome
  gen_icons.py        Regenera los iconos
```

# FB Marketplace Lead Router

Extensión de Chrome que atiende la carpeta **Marketplace de Messenger** con una
sola regla:

> Si el mensaje es **sólo** una pregunta de disponibilidad, responde con tu copy.
> Cualquier otra cosa se **devuelve a "no leído"** y te espera en la bandeja.

No hay servidor, ni base de datos, ni API key. Todo vive en la extensión.

---

## ⚠️ Antes de encenderla

Automatizar el inbox va contra los Términos de Servicio de Facebook. Meta detecta
automatización a nivel de sesión y de cuenta, no por la velocidad del tecleo, así
que **nada de aquí garantiza que la cuenta no sea restringida**. Usa una cuenta
de negocio cuya pérdida no te bloquee la operación.

Llega apagada de fábrica, con límites conservadores (15/hora, 2 minutos entre
mensajes, 18:00–00:00) y sin copy configurado.

---

## Instalación

1. `chrome://extensions/` → **Modo de desarrollador**.
2. **Cargar descomprimida** → carpeta `extension/`.
3. Abre el popup y **pega tu copy**. Mientras esté vacío no responde nada.
4. Abre <https://www.facebook.com/messages> y **haz clic en la carpeta
   «Marketplace»** de la lista de chats.
5. Pulsa **Ver qué detecta** con el interruptor apagado, y comprueba que
   reconoce tus hilos.
6. Enciende.

Para que funcione desatendida:

```bash
./ops/start-24-7.sh start
```

Desactiva la suspensión del Mac y abre Chrome. **Si Chrome se cierra, el equipo
se duerme o recargas la pestaña sin volver a entrar en la carpeta, deja de
responder.**

### Por qué hay que abrir la carpeta a mano

Messenger carga los hilos de Marketplace sólo al abrir esa carpeta, y no
responde a clics sintéticos ni a teclado — lo probé con ambos. Es una condición
de operación, del mismo tipo que mantener la sesión iniciada. Si se te olvida,
el registro del popup te lo recuerda.

---

## Cómo decide

La decisión está en [`extension/classifier.js`](extension/classifier.js), aislada
del DOM y con 20 grupos de pruebas propias. El sesgo es deliberado: **ante la
duda, a tu bandeja.** Un genérico sin auto-responder cuesta un minuto; un copy
enlatado a quien preguntaba el canon cuesta el cliente.

Se responde sólo si el mensaje cumple **todo**:

| Condición | Por qué |
|---|---|
| Coincide con un patrón de disponibilidad | `sigue disponible`, `¿sigue estando disponible este artículo?` (el predefinido de Facebook), `aún lo tienen`, y sus equivalentes en inglés |
| No menciona nada concreto | Canon, administración, ubicación, metros, habitaciones, estrato, parqueadero, visitas, requisitos, fiador, mascotas… cualquiera lo manda a tu bandeja |
| No lleva interrogativo específico | `cuánto`, `dónde`, `cuándo`, `cuál`, `cuántos` piden un dato, no un sí/no |
| No abre afirmando | `Sí…`, `Claro…` son respuestas, no preguntas: evita confundir tu propio mensaje con uno entrante |
| Menos de 90 caracteres | Por encima hay más contenido del que el copy responde |

Ejemplos reales de la bandeja de producción:

| Mensaje | Qué pasa |
|---|---|
| «¿Sigue estando disponible este artículo?» | ✅ Se responde |
| «Hola. ¿Sigue disponible?» | ✅ Se responde |
| «¿Sigue disponible? ¿Cuánto es el canon?» | ❌ Sigue sin leer |
| «Hola que requisitos se necesitan» | ❌ Sigue sin leer |
| «¿Sigue estando disponible? Y tiene parqueadero?» | ❌ Se abre, se lee y **se devuelve a no leído** |
| «Paola reaccionó 👍 a tu mensaje» | ❌ Sigue sin leer |

### Sólo abre lo que va a responder

Clasifica leyendo la vista previa de la lista, que en Messenger trae el mensaje
completo. Los que no son genéricos **no se abren**: conservan su punto azul.

Si al abrir uno el texto completo resulta no ser genérico (raro, pero es la
última red), no escribe nada y usa **«Marcar como no leído»** para devolverlo a
tu bandeja.

---

## Ajustar el criterio

Los patrones y descalificadores están al principio de `classifier.js`, en
castellano y comentados. Tras tocarlos:

```bash
node --test extension/
```

Las pruebas incluyen los casos reales que fallaron en producción, para que no
vuelvan a colarse.

---

## Diagnóstico

**Ver qué detecta** recorre la lista y te dice cuántos hilos ve, cuántos sin
leer, a cuántos respondería y si la carpeta está abierta. El detalle por hilo va
a la consola de la pestaña (F12 → Console), y `report()` vuelca cada decisión
de envío ahí también.

Todos los selectores frágiles están en un único bloque `SELECTORS` al principio
de [`extension/content.js`](extension/content.js).

---

## Problemas frecuentes

| Síntoma | Causa habitual |
|---|---|
| «Abre la carpeta Marketplace» en el registro | Recargaste la pestaña y la carpeta volvió a colapsarse. |
| Ve 0 conversaciones | Estás en la lista general, no dentro de la carpeta. |
| No responde nada | Interruptor apagado, fuera de horario, o falta el copy. El popup lo dice arriba. |
| «Descartado sin enviar» | El editor quedó con un texto distinto al copy. La red de seguridad hizo su trabajo; se reintenta. |
| «No se pudo devolver a no leído» | Cambió el menú de fila. Revisa `MARK_UNREAD` en `content.js`. |
| Respondió algo que no debía | Añade el término a `DISQUALIFIERS` en `classifier.js` y añade el caso a las pruebas. |
| Quiero reprocesar un hilo | «Olvidar hilos ya respondidos», en Horario y límites. |

---

## Estructura

```
extension/
  classifier.js       La única decisión: ¿es genérico o es para ti?
  classifier.test.js  node --test, sin dependencias
  content.js          Recorre la carpeta, abre sólo lo que responde, escribe,
                      y devuelve a no leído lo que no
  background.js       Contador del icono y valores por defecto
  popup.*             Copy, horario, límites, diagnóstico y registro
ops/
  start-24-7.sh       Anti-suspensión + abrir Chrome
  gen_icons.py        Regenera los iconos
```

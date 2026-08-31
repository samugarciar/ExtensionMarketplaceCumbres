#!/usr/bin/env bash
#
# Deja el Mac listo para atender la bandeja sin supervisión.
#
#   ./ops/start-24-7.sh start    # anti-suspensión + Chrome en la bandeja
#   ./ops/start-24-7.sh status
#   ./ops/start-24-7.sh stop
#
# No hay servidor que arrancar: toda la lógica vive en la extensión. Lo único
# que hace falta es que Chrome siga abierto y que el equipo no se duerma.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$PROJECT_DIR/.run"
PID_FILE="$RUN_DIR/caffeinate.pid"
INBOX_URL="https://www.facebook.com/messages"

mkdir -p "$RUN_DIR"

ok()   { printf '\033[0;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m!\033[0m %s\n' "$*"; }
fail() { printf '\033[0;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

caffeinate_running() {
  [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

case "${1:-start}" in
  start)
    if caffeinate_running; then
      ok "La anti-suspensión ya estaba activa."
    else
      # -d pantalla, -i inactividad, -m disco, -s mientras haya corriente.
      # Si el Mac se duerme, Chrome deja de ejecutar la extensión.
      caffeinate -dims & echo $! > "$PID_FILE"
      ok "Suspensión desactivada (PID $(cat "$PID_FILE"))."
    fi

    open -a "Google Chrome" "$INBOX_URL" 2>/dev/null \
      && ok "Messenger abierto en Chrome." \
      || warn "No se pudo abrir Chrome. Ábrelo a mano en $INBOX_URL"

    echo
    ok "Listo. Ahora, en Messenger:"
    echo "     1. Clic en la carpeta «Marketplace» de la lista de chats."
    echo "     2. Abre el popup de la extensión y enciende el interruptor."
    warn "Chrome debe quedarse abierto, DENTRO de la carpeta y con la sesión iniciada."
    ;;

  stop)
    if caffeinate_running; then
      kill "$(cat "$PID_FILE")" && ok "Anti-suspensión detenida."
    else
      warn "La anti-suspensión no estaba activa."
    fi
    rm -f "$PID_FILE"
    ;;

  status)
    caffeinate_running \
      && ok "Anti-suspensión: activa" \
      || warn "Anti-suspensión: inactiva (el equipo puede dormirse y dejar de responder)"

    pgrep -xq "Google Chrome" \
      && ok "Chrome: abierto" \
      || warn "Chrome: cerrado — la extensión no está corriendo"
    ;;

  *) fail "Uso: $0 {start|stop|status}" ;;
esac

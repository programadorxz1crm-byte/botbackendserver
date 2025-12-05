#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

REPO_URL="${REPO_URL:-}"
if [ -z "$REPO_URL" ]; then
  echo "[ERROR] Debes pasar REPO_URL, ej.: REPO_URL=https://github.com/programadorxz1crm-byte/botbackendserver.git bash scripts/termux-install.sh"
  exit 1
fi

echo "[+] Actualizando paquetes..."
pkg update -y && pkg upgrade -y
pkg install -y git nodejs curl

WORKDIR="$(basename "$REPO_URL" .git)"
if [ ! -d "$WORKDIR" ]; then
  echo "[+] Clonando repo: $REPO_URL"
  git clone "$REPO_URL"
fi

cd "$WORKDIR"

if [ -f "index.js" ] && [ -f "package.json" ]; then
  SERVER_DIR="."
elif [ -d "botemprendemoisesmoises-main" ] && [ -f "botemprendemoisesmoises-main/index.js" ]; then
  SERVER_DIR="botemprendemoisesmoises-main"
else
  echo "[ERROR] No encuentro index.js/ package.json del servidor"
  exit 1
fi

cd "$SERVER_DIR"

echo "[+] Instalando dependencias NPM..."
npm install --no-audit --no-fund

if [ ! -f ".env" ]; then
  echo "[+] Creando .env desde .env.example"
  cp .env.example .env
  if [ -n "${ADMIN_NOTIFY_PHONE:-}" ]; then
    sed -i "s/^ADMIN_NOTIFY_PHONE=.*/ADMIN_NOTIFY_PHONE=${ADMIN_NOTIFY_PHONE}/" .env || true
  fi
fi

PORT_LINE="$(grep '^PORT=' .env || true)"
if [ -z "$PORT_LINE" ]; then echo "PORT=3000" >> .env; fi

echo "[+] Iniciando servidor en segundo plano (nohup)..."
nohup node index.js > server.log 2>&1 & echo $! > .pid
sleep 1

echo "[OK] Backend iniciado. PID: $(cat .pid)"
echo "- Puerto: ${PORT:-3000}"
echo "- Log: $(pwd)/server.log"
echo "Usa 'tail -f server.log' para ver logs, 'kill $(cat .pid)' para detener."
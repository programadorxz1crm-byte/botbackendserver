# BotBackendServer (WhatsApp Web)

Backend Node.js con Express y [Baileys](https://github.com/WhiskeySockets/Baileys) para emparejar vía QR o código de emparejamiento y enviar mensajes y medios.

## Endpoints

- `GET /status` — estado de la sesión
- `GET /session/qr` — QR actual como `dataUrl` (PNG)
- `POST /session/pairing { phone }` — solicita código de emparejamiento (E.164) y lo devuelve
- `POST /messages/text { to, text }` — envía texto
- `POST /messages/media` — `multipart/form-data` con `file`; body `{ to, type, caption }` donde `type` ∈ `image|video|audio|document`
- `POST /messages/contact { to, name, phone }` — envía vCard
- `POST /messages/location { to, lat, lng, name }` — envía ubicación
- `POST /trigger` — webhook simple para Tasker/n8n

### Puente para AutoResponderWA y Tasker

- `ALL /bridge/:client/send-text` — acepta `GET` o `POST` con `{ to, text }`. `:client` puede ser `tasker` o `autoresponderwa` (solo informativo).
- `ALL /bridge/:client/send-media` — acepta `GET` o `POST` con `{ to, type, url, caption }`. Descarga el archivo de `url` y lo envía. `type` ∈ `image|video|audio|document`.
- `GET /bridge/:client/ping` — verificación rápida, responde `{ ok, ready }`.

Seguridad opcional: establece `BRIDGE_KEY` en `.env` y envía en el header `x-bridge-key` o parámetro `?key=`.

WebSocket: conectar al mismo host (`/`) y recibes eventos `{ type, ... }` como `qr`, `pairing_code`, `incoming`, `status`.

### IA (ChatGPT / Gemini)
- `GET /ai/config` — ver configuración actual.
- `POST /ai/config` — actualizar configuración `{ provider, systemPrompt, openaiApiKey, openaiModel, googleApiKey, geminiModel, temperature }`.
- `POST /ai/memory/add { text }` — agrega conocimiento a memoria persistente.
- `GET /ai/memory` — lista de memoria.
- `POST /ai/reply { to, text }` — genera respuesta con IA y la envía a `to`.

Autorrespuesta automática: establece `AUTOREPLY_ENABLED=true` en `.env` para que el bot responda automáticamente a mensajes entrantes.

## Instalación en VPS

```bash
cd server
npm install
cp .env.example .env
# edita .env según necesites
node index.js
```

Para servicio permanente: usa `pm2`, `systemd` o `screen`.

## Integración con AutoResponderWA

1. Abre AutoResponderWA en el teléfono Android.
2. Crea una regla o acción y añade una acción de tipo "HTTP Request" (o Webhook si tu versión lo soporta).
3. Configura la URL a tu servidor:
   - Texto: `https://TU_DOMINIO/bridge/autoresponderwa/send-text?to=%contact%&text=%message%&key=TU_CLAVE`
   - Media: `https://TU_DOMINIO/bridge/autoresponderwa/send-media?to=%contact%&type=image&url=URL_IMAGEN&caption=Opcional&key=TU_CLAVE`
   - Reemplaza `TU_DOMINIO` y `TU_CLAVE` (si usas `BRIDGE_KEY`).
4. Guarda y prueba: cuando se dispare la regla, el servidor enviará el mensaje/medio al contacto.

## Integración con Tasker

1. En Tasker, crea un Perfil (evento) que dispare tu flujo.
2. En Tarea, añade una acción `HTTP Request` (Método `GET` o `POST`).
3. Configura:
   - Texto (POST): URL `https://TU_DOMINIO/bridge/tasker/send-text`, Body JSON: `{ "to": "52155...", "text": "Hola desde Tasker" }`, Headers: `Content-Type: application/json` y opcional `x-bridge-key: TU_CLAVE`.
   - Media (GET): `https://TU_DOMINIO/bridge/tasker/send-media?to=52155...&type=document&url=https://ejemplo.com/archivo.pdf&caption=Adjunto&key=TU_CLAVE`.
4. Ejecuta la tarea para verificar.

## Consejos

- Si necesitas enviar archivos locales del teléfono, súbelos primero a un almacenamiento accesible (Drive con enlace directo, S3, servidor propio) y usa la URL en `send-media`.
- Para integraciones avanzadas, conecta también `N8N_WEBHOOK_URL` para procesar mensajes entrantes en n8n.

## Termux (Android) — despliegue rápido

1. Instala dependencias en Termux:
   - `pkg update && pkg upgrade`
   - `pkg install git nodejs`
2. Clona tu repositorio (tras subirlo a GitHub):
   - `git clone https://github.com/programadorxz1crm-byte/botemprendemoisesmoises.git`
   - `cd pawacell/server`
3. Prepara entorno:
   - `npm install`
   - `cp .env.example .env` y edita claves (`OPENAI_API_KEY` o `GOOGLE_API_KEY`, `LLM_PROVIDER`, `BRIDGE_KEY`, etc.)
4. Ejecuta:
   - `termux-wake-lock` (opcional para evitar suspensión)
  - `node index.js` (o `PORT=3001 node index.js`)
5. Mantener vivo (opcional): usa `tmux` o `screen` para sesiones persistentes.

## Subir a GitHub — comandos básicos (botbackendserver)

En el directorio raíz del backend (esta carpeta):

```bash
echo "# botbackendserver" >> README.md
git init
git add README.md
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/programadorxz1crm-byte/botbackendserver.git
git push -u origin main
```

Después de subir, cualquier usuario podrá clonar e instalar en Termux con el one‑liner de abajo.

## Notas importantes
Creado Por Moises Romero #emprendeconmoises #moisesromero #z1 #crm #bot #whatsapp  mi numero whatsapp +584241278885
- Esta API usa WhatsApp Web y puede infringir los Términos de Servicio de WhatsApp. Úsalo bajo tu responsabilidad.
- Para producción y cumplimiento, considera WhatsApp Business API oficial.
- Los números (`to`, `phone`) deben estar en formato E.164 (incluye código de país), por ejemplo `5215512345678`.

## APK (Android) — app de gestión
- En `mobile/` está una app mínima (Expo) para gestionar el backend:
  - Ajustes: URL del backend y Bridge Key
  - Sesión: estado, QR y solicitud de código de emparejamiento
  - Reglas: listar y crear reglas básicas
  - IA: proveedor, temperatura y prompt del sistema
  - Pruebas: enviar mensajes de texto
- Para ejecutarla:
  - `cd mobile && npm install && npm run start`
  - En Android: `npm run android` (requiere entorno de Android/Expo)

## Termux — script automático (one‑liner)
Tras subir el repo a GitHub, puedes instalar y arrancar el backend con:

```bash
curl -fsSL https://raw.githubusercontent.com/programadorxz1crm-byte/botbackendserver/main/scripts/termux-install.sh \
  | REPO_URL=https://github.com/programadorxz1crm-byte/botbackendserver.git ADMIN_NOTIFY_PHONE=52155XXXXXXX bash
```

O, si ya tienes el repo clonado en Termux:

```bash
REPO_URL=https://github.com/programadorxz1crm-byte/botbackendserver.git bash scripts/termux-install.sh
```

El script:
- Instala `git`, `nodejs` y `curl`
- Clona el repo y detecta el directorio del servidor
- Copia `.env.example` a `.env`; usa `ADMIN_NOTIFY_PHONE` si se pasó
- Arranca `node index.js` en segundo plano con `nohup` y guarda logs en `server.log`

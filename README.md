# Mensajes ML - Agrobolder

Mini aplicación local para ver los mensajes post-venta que los clientes mandan por
Mercado Libre: cliente, fecha, publicación relacionada, la pregunta y la respuesta
(si ya se contestó).

## Uso

```bash
npm install   # solo la primera vez
npm start
```

Abre http://localhost:3000 en el navegador. La app sincroniza sola con Mercado Libre
cada `SYNC_INTERVAL_MS` (2 minutos por defecto) mientras el servidor esté corriendo,
así que normalmente no hace falta tocar nada. El botón **Sincronizar** sigue
disponible para forzar una actualización inmediata. Las sincronizaciones son
rápidas porque el nombre del cliente y la publicación quedan guardados en caché
(`data/messages-cache.json`).

Puedes buscar por cliente/producto y filtrar por estado (Pendiente/Respondido) con
los controles de arriba. Haz clic en una fila para ver la conversación completa.

## Agente de borradores (IA)

En la pestaña **"Borradores IA"** se muestra, para cada pregunta pendiente, una
respuesta sugerida generada por Google Gemini a partir del historial de la
conversación — incluyendo las fotos que haya mandado el cliente (el agente las
descarga de Mercado Libre y las analiza, hasta las últimas 4 más recientes por
borrador). **El agente nunca publica nada en Mercado Libre** — solo la ves ahí,
la copias con el botón "Copiar" y la pegas tú mismo donde corresponda si te
convence. Puedes pedir otra sugerencia con "Regenerar".

Para activarlo, agrega tu API key de Google AI Studio en `.env`:

```
GEMINI_API_KEY=tu_api_key
GEMINI_MODEL=gemini-2.5-flash   # opcional, puedes cambiar el modelo
```

Si dejas `GEMINI_API_KEY` vacío, el resto de la app (sync y visor de mensajes)
sigue funcionando normal; simplemente no se generan borradores.

## Seguridad de las credenciales

El archivo `.env` contiene las credenciales de tu app de Mercado Libre
(`ML_CLIENT_ID`, `ML_CLIENT_SECRET`, `ML_REFRESH_TOKEN`). **Nunca subas este
archivo ni `data/token-store.json` a un repositorio o los compartas** — ya están
excluidos en `.gitignore`.

Mercado Libre rota el `refresh_token` cada vez que se usa. La app guarda
automáticamente el token más reciente en `data/token-store.json`, así que no hay
que tocar el `.env` manualmente después de la primera vez.

⚠️ El archivo JSON del workflow de n8n que compartiste (`Mensajes Vendedor ML -
Agrobolder (2).json`) tenía el `client_secret` y el `refresh_token` reales a la
vista. Ese `refresh_token` específico ya quedó invalidado (se usó para probar esta
app), pero evita compartir ese archivo tal cual con nadie más.

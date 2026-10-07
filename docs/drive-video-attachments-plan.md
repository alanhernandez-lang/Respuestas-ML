# Ver videos de Google Drive en el agente de IA (borrador, en pausa)

Estado: **En pausa a petición de Alan** (2026-09-01) — investigado y viable, pero no
se va a construir por ahora. Este documento deja la investigación por escrito para
retomarla más adelante sin repetir el trabajo.

## 1. Objetivo

Hoy el agente de IA (`lib/agent.js`) ya lee fotos y PDFs que el cliente adjunta
directo en el chat de Mercado Libre (se descargan y se le mandan a Gemini como
`inline_data`, ver `downloadThreadAttachments`/`buildContentParts`). Lo que falta:
a veces se le pide al cliente subir un video de la falla a Google Drive y compartir
la URL — ese link hoy el agente lo ve como texto plano, no puede abrir el video ni
ver su contenido.

## 2. Lo que ya se confirmó viable

- **Gemini entiende video de forma nativa.** El modelo que ya usa la app
  (`gemini-2.5-flash`) acepta video como `inline_data`, igual que ya hace hoy con
  fotos/PDFs — mismo mecanismo, sin cambios de modelo. Límite: <100MB inline (un
  video corto de una falla normalmente entra sin problema); para archivos más
  grandes existiría la File API de Gemini, pero probablemente no haga falta.
- **No hace falta ffmpeg ni sacar fotogramas a mano** — se manda el video completo
  y Gemini lo procesa directo.
- **Para archivos públicos de Drive ("Cualquiera con el enlace puede ver"), basta
  una API key de Google Cloud** (Drive API habilitada) — sin OAuth de usuario ni
  cuenta de servicio. Alan ya tiene acceso a un proyecto de Google Cloud
  ("Marvelsa Odoo", usado para BigQuery), así que generar esa API key ahí sería
  inmediato.

## 3. El punto que pidió Alan explícitamente

Si el cliente compartió el video más restringido (no "cualquiera con el enlace"),
la Drive API responde como si el archivo no existiera (404) — Google no distingue
"no existe" de "no tienes permiso", a propósito, para no confirmarle a alguien sin
acceso que el archivo sí existe.

Petición explícita de Alan: en ese caso, el agente **no debe fingir que no vio el
link ni inventar nada** — el borrador debe decirle al cliente algo como "no tengo
acceso para ver ese video, por favor ajusta los permisos para que cualquiera con
el enlace pueda verlo" en vez de quedarse callado sobre el intento.

## 4. Diseño (para cuando se retome)

1. Detectar links de Drive en el texto de los mensajes del cliente (patrones tipo
   `drive.google.com/file/d/ID`, `drive.google.com/open?id=ID`, `drive.google.com/uc?id=ID`)
   y extraer el file ID.
2. Antes de descargar nada, pedir metadata (`files.get?fields=name,mimeType,size`)
   con la API key — barato y ya revela si hay acceso o no.
3. Si la metadata falla (404/403): no descargar nada, pasarle a Gemini una nota en
   el prompt indicando "el cliente compartió un video de Drive pero no tenemos
   acceso — pídele que lo comparta como 'cualquiera con el enlace'", para que el
   borrador lo mencione tal como pidió Alan.
4. Si la metadata sí resuelve: revisar `mimeType` (debe ser un video soportado por
   Gemini) y `size` (<100MB) antes de bajar el archivo completo con
   `files.get?alt=media`.
5. Mandar el video descargado a Gemini exactamente como ya se hace con fotos/PDFs
   (mismo `buildContentParts`, ver `lib/agent.js`) — no requiere tocar esa función,
   solo alimentarla con un adjunto más.

## 5. Lo que falta para poder construirlo

- Una API key de Google Cloud con la **Google Drive API** habilitada (Alan la
  genera desde el proyecto de Google Cloud al que ya tiene acceso).
- Idealmente, un link real de Drive (uno ya recibido de un cliente, o uno de
  prueba compartido como "cualquiera con el enlace") para probar el flujo
  completo antes de dejarlo corriendo en producción.

Sin la API key no tiene caso escribir el código todavía — retomar este documento
cuando Alan decida seguirle.

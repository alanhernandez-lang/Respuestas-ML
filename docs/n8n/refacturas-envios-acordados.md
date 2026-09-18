# Workflow de n8n: Refacturas y Envíos Acordados (Odoo)

Ver [docs/odoo-refacturas-envios-automation-plan.md](../odoo-refacturas-envios-automation-plan.md)
para el contexto completo del proceso, qué se automatiza y qué NO se automatiza
(las validaciones humanas de Crédito y Cobranza / Tráfico siguen igual que hoy).

## Cómo usarlo

1. Copiá TODO el bloque JSON de abajo (desde `{` hasta el `}` final).
2. En n8n: **Add workflow** → menú `⋯` → **Import from Clipboard** (o `Ctrl/Cmd+V`
   directo sobre el canvas del editor).
3. Abrí el nodo **"LÉEME ANTES DE ACTIVAR"** (la nota amarilla) — trae el
   checklist de qué falta configurar antes de prender el Schedule Trigger:
   URL/secreto de la app, credencial de Odoo, y los 3 valores marcados
   `# PLACEHOLDER` dentro de los nodos de Odoo (dominio de búsqueda de la
   cotización, `activity_type_id`, `user_id` responsable).
4. Probalo primero con **"Execute workflow"** manual sobre 1-2 pedidos reales
   antes de activar el disparador programado.

## El JSON

```json
{
  "name": "Agrobolder ML - Refacturas y Envíos Acordados (Odoo)",
  "nodes": [
    {
      "id": "sticky-overview",
      "name": "LÉEME ANTES DE ACTIVAR",
      "type": "n8n-nodes-base.stickyNote",
      "typeVersion": 1,
      "position": [-680, -320],
      "parameters": {
        "content": "## Antes de activar este workflow\n\n1. Editá el nodo **Config** (abajo) con la URL real de tu app y el `CRON_SECRET` (mismo valor que ya está en las variables de entorno de Coolify — reutiliza ese secreto, no hace falta crear uno nuevo).\n2. Creá una credencial de Odoo (tipo **Odoo API**) con un usuario/API key DEDICADO para esta automatización (no las credenciales personales de nadie) y asignala en los 4 nodos Odoo.\n3. En cada nodo Odoo hay valores marcados `# PLACEHOLDER — confirmar`: el dominio para encontrar la cotización por número de pedido ML, el `activity_type_id`, y el `user_id` responsable (Contabilidad/Crédito y Cobranza para refacturas, Tráfico para envíos). Sin esto NO va a funcionar.\n4. Dejá el workflow **inactivo** y probalo primero con \"Execute workflow\" manual sobre 1-2 pedidos reales antes de prender el Schedule Trigger.\n5. Este workflow SOLO automatiza la planificación (meter los datos en Odoo). Las validaciones humanas de Crédito y Cobranza / Tráfico siguen exactamente igual que hoy — no se tocan.\n\nVer docs/odoo-refacturas-envios-automation-plan.md para el contexto completo.",
        "height": 460,
        "width": 460
      }
    },
    {
      "parameters": {
        "rule": {
          "interval": [{ "field": "minutes", "minutesInterval": 10 }]
        }
      },
      "id": "trigger-schedule",
      "name": "Cada 10 minutos",
      "type": "n8n-nodes-base.scheduleTrigger",
      "typeVersion": 1.2,
      "position": [-200, -60]
    },
    {
      "parameters": {
        "assignments": {
          "assignments": [
            {
              "id": "app-base-url",
              "name": "app_base_url",
              "type": "string",
              "value": "https://mensajes-post-venta-ml.coolify.marvelsa.com"
            },
            {
              "id": "app-secret",
              "name": "app_secret",
              "type": "string",
              "value": "PEGA_AQUI_EL_MISMO_CRON_SECRET_DE_COOLIFY"
            }
          ]
        },
        "options": {}
      },
      "id": "config-set",
      "name": "Config",
      "type": "n8n-nodes-base.set",
      "typeVersion": 3.4,
      "position": [20, -60]
    },

    {
      "id": "sticky-refacturas",
      "name": "Nota: rama Refacturas",
      "type": "n8n-nodes-base.stickyNote",
      "typeVersion": 1,
      "position": [220, -420],
      "parameters": {
        "content": "### Rama Refacturas\n\nRazón social, RFC, CP fiscal, Régimen fiscal, Forma de pago, Uso de CFDI.\n\nLa app YA hace la extracción con Gemini y solo entrega el pack cuando los 6 datos están completos — este workflow no tiene que validar eso, solo consumirlo.",
        "height": 200,
        "width": 320
      }
    },

    {
      "parameters": {
        "url": "={{ $json.app_base_url }}/api/automation/refacturas-pendientes",
        "sendQuery": true,
        "queryParameters": {
          "parameters": [{ "name": "secret", "value": "={{ $json.app_secret }}" }]
        },
        "options": {}
      },
      "id": "http-get-refacturas",
      "name": "GET refacturas pendientes",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [260, -60]
    },
    {
      "parameters": {
        "fieldToSplitOut": "pendientes",
        "options": {}
      },
      "id": "split-refacturas",
      "name": "Una por una (refactura)",
      "type": "n8n-nodes-base.splitOut",
      "typeVersion": 1,
      "position": [480, -60]
    },
    {
      "parameters": {
        "resource": "custom",
        "customResource": "sale.order",
        "operation": "getAll",
        "options": {
          "domain": "=[[\"name\", \"like\", $json.orderId]]  /* # PLACEHOLDER — confirmar con quien administra Odoo: ¿el pedido ML se busca por 'name' o por otro campo? (ver checklist punto 6 del plan) */",
          "limit": 1
        }
      },
      "id": "odoo-find-order-refactura",
      "name": "Buscar cotización por pedido ML",
      "type": "n8n-nodes-base.odoo",
      "typeVersion": 1,
      "position": [700, -60],
      "credentials": {
        "odooApi": { "id": "PLACEHOLDER", "name": "Odoo - Automatización (usuario dedicado)" }
      }
    },
    {
      "parameters": {
        "conditions": {
          "options": { "caseSensitive": true, "leftValue": "", "typeValidation": "loose" },
          "conditions": [
            {
              "id": "cond-found",
              "leftValue": "={{ $json.id }}",
              "rightValue": "",
              "operator": { "type": "string", "operation": "notEmpty" }
            }
          ],
          "combinator": "and"
        },
        "options": {}
      },
      "id": "if-order-found-refactura",
      "name": "¿Se encontró la cotización?",
      "type": "n8n-nodes-base.if",
      "typeVersion": 2.2,
      "position": [920, -60]
    },
    {
      "parameters": {
        "assignments": {
          "assignments": [
            {
              "id": "note-text",
              "name": "nota",
              "type": "string",
              "value": "=Datos fiscales recibidos por chat de Mercado Libre para refacturación:\nRazón social: {{ $('Una por una (refactura)').item.json.datos.razon_social }}\nRFC: {{ $('Una por una (refactura)').item.json.datos.rfc }}\nCódigo postal fiscal: {{ $('Una por una (refactura)').item.json.datos.codigo_postal }}\nRégimen fiscal: {{ $('Una por una (refactura)').item.json.datos.regimen_fiscal }}\nForma de pago: {{ $('Una por una (refactura)').item.json.datos.forma_pago }}\nUso de CFDI: {{ $('Una por una (refactura)').item.json.datos.uso_cfdi }}\n\nGenerado automáticamente — Crédito y Cobranza debe validar estos datos antes de facturar (no se toca ese paso)."
            },
            {
              "id": "order-record-id",
              "name": "order_record_id",
              "type": "number",
              "value": "={{ $json.id }}"
            }
          ]
        },
        "options": {}
      },
      "id": "set-note-refactura",
      "name": "Preparar nota (refactura)",
      "type": "n8n-nodes-base.set",
      "typeVersion": 3.4,
      "position": [1140, -140]
    },
    {
      "parameters": {
        "resource": "custom",
        "customResource": "mail.activity",
        "operation": "create",
        "fieldsUi": {
          "fieldValues": [
            { "fieldName": "res_model", "fieldValue": "sale.order" },
            { "fieldName": "res_id", "fieldValue": "={{ $json.order_record_id }}" },
            { "fieldName": "activity_type_id", "fieldValue": "1  /* # PLACEHOLDER — confirmar el id real del tipo de actividad \"Por hacer\"/\"To Do\" en tu Odoo */" },
            { "fieldName": "summary", "fieldValue": "Refactura pendiente — datos fiscales del cliente" },
            { "fieldName": "note", "fieldValue": "={{ $json.nota }}" },
            { "fieldName": "user_id", "fieldValue": "1  /* # PLACEHOLDER — id del usuario/equipo de Crédito y Cobranza responsable */" }
          ]
        }
      },
      "id": "odoo-create-activity-refactura",
      "name": "Crear planificación (Odoo Activity)",
      "type": "n8n-nodes-base.odoo",
      "typeVersion": 1,
      "position": [1360, -140],
      "credentials": {
        "odooApi": { "id": "PLACEHOLDER", "name": "Odoo - Automatización (usuario dedicado)" }
      }
    },
    {
      "parameters": {
        "method": "POST",
        "url": "={{ $('Config').item.json.app_base_url }}/api/automation/marcar-planificado",
        "sendQuery": true,
        "queryParameters": {
          "parameters": [{ "name": "secret", "value": "={{ $('Config').item.json.app_secret }}" }]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ { \"packId\": $('Una por una (refactura)').item.json.packId, \"categoria\": \"refactura\", \"odooActivityId\": $json.id } }}",
        "options": {}
      },
      "id": "http-post-marcar-refactura",
      "name": "Marcar planificado (refactura)",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [1580, -140]
    },
    {
      "parameters": {},
      "id": "noop-not-found-refactura",
      "name": "Cotización no encontrada (revisar a mano)",
      "type": "n8n-nodes-base.noOp",
      "typeVersion": 1,
      "position": [1140, 20]
    },

    {
      "id": "sticky-envios",
      "name": "Nota: rama Envíos acordados",
      "type": "n8n-nodes-base.stickyNote",
      "typeVersion": 1,
      "position": [220, 220],
      "parameters": {
        "content": "### Rama Envíos acordados con el comprador\n\nNombre, dirección completa (calle, número, colonia, CP, ciudad, estado), referencias de domicilio, teléfono.\n\nLa \"planificación\" aquí (según el proceso actual) queda en el campo Comentarios del pedido — como todavía no confirmamos el nombre técnico de ese campo, esta rama también usa una Actividad de Odoo, asignada a Tráfico, con los 4 datos en la nota.",
        "height": 220,
        "width": 340
      }
    },
    {
      "parameters": {
        "url": "={{ $json.app_base_url }}/api/automation/envios-acordados-pendientes",
        "sendQuery": true,
        "queryParameters": {
          "parameters": [{ "name": "secret", "value": "={{ $json.app_secret }}" }]
        },
        "options": {}
      },
      "id": "http-get-envios",
      "name": "GET envíos acordados pendientes",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [260, 360]
    },
    {
      "parameters": {
        "fieldToSplitOut": "pendientes",
        "options": {}
      },
      "id": "split-envios",
      "name": "Uno por uno (envío)",
      "type": "n8n-nodes-base.splitOut",
      "typeVersion": 1,
      "position": [480, 360]
    },
    {
      "parameters": {
        "resource": "custom",
        "customResource": "sale.order",
        "operation": "getAll",
        "options": {
          "domain": "=[[\"name\", \"like\", $json.orderId]]  /* # PLACEHOLDER — mismo campo a confirmar que en la rama de refacturas */",
          "limit": 1
        }
      },
      "id": "odoo-find-order-envio",
      "name": "Buscar cotización por pedido ML ",
      "type": "n8n-nodes-base.odoo",
      "typeVersion": 1,
      "position": [700, 360],
      "credentials": {
        "odooApi": { "id": "PLACEHOLDER", "name": "Odoo - Automatización (usuario dedicado)" }
      }
    },
    {
      "parameters": {
        "conditions": {
          "options": { "caseSensitive": true, "leftValue": "", "typeValidation": "loose" },
          "conditions": [
            {
              "id": "cond-found-envio",
              "leftValue": "={{ $json.id }}",
              "rightValue": "",
              "operator": { "type": "string", "operation": "notEmpty" }
            }
          ],
          "combinator": "and"
        },
        "options": {}
      },
      "id": "if-order-found-envio",
      "name": "¿Se encontró la cotización? ",
      "type": "n8n-nodes-base.if",
      "typeVersion": 2.2,
      "position": [920, 360]
    },
    {
      "parameters": {
        "assignments": {
          "assignments": [
            {
              "id": "note-text-envio",
              "name": "nota",
              "type": "string",
              "value": "=Datos de envío acordado recibidos por chat de Mercado Libre:\nNombre: {{ $('Uno por uno (envío)').item.json.datos.nombre }}\nDirección completa: {{ $('Uno por uno (envío)').item.json.datos.direccion_completa }}\nReferencias de domicilio: {{ $('Uno por uno (envío)').item.json.datos.referencias_domicilio }}\nTeléfono: {{ $('Uno por uno (envío)').item.json.datos.telefono }}\n\nGenerado automáticamente — Tráfico debe validar si el envío a esta dirección es viable antes de continuar (no se toca ese paso)."
            },
            {
              "id": "order-record-id-envio",
              "name": "order_record_id",
              "type": "number",
              "value": "={{ $json.id }}"
            }
          ]
        },
        "options": {}
      },
      "id": "set-note-envio",
      "name": "Preparar nota (envío)",
      "type": "n8n-nodes-base.set",
      "typeVersion": 3.4,
      "position": [1140, 280]
    },
    {
      "parameters": {
        "resource": "custom",
        "customResource": "mail.activity",
        "operation": "create",
        "fieldsUi": {
          "fieldValues": [
            { "fieldName": "res_model", "fieldValue": "sale.order" },
            { "fieldName": "res_id", "fieldValue": "={{ $json.order_record_id }}" },
            { "fieldName": "activity_type_id", "fieldValue": "1  /* # PLACEHOLDER — mismo id que en la rama de refacturas, o el que corresponda */" },
            { "fieldName": "summary", "fieldValue": "Envío acordado pendiente — validar viabilidad" },
            { "fieldName": "note", "fieldValue": "={{ $json.nota }}" },
            { "fieldName": "user_id", "fieldValue": "1  /* # PLACEHOLDER — id del usuario/equipo de Tráfico (ej. Angel Samuel Gonzalez Vargas) */" }
          ]
        }
      },
      "id": "odoo-create-activity-envio",
      "name": "Crear planificación (Odoo Activity) ",
      "type": "n8n-nodes-base.odoo",
      "typeVersion": 1,
      "position": [1360, 280],
      "credentials": {
        "odooApi": { "id": "PLACEHOLDER", "name": "Odoo - Automatización (usuario dedicado)" }
      }
    },
    {
      "parameters": {
        "method": "POST",
        "url": "={{ $('Config').item.json.app_base_url }}/api/automation/marcar-planificado",
        "sendQuery": true,
        "queryParameters": {
          "parameters": [{ "name": "secret", "value": "={{ $('Config').item.json.app_secret }}" }]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ { \"packId\": $('Uno por uno (envío)').item.json.packId, \"categoria\": \"envio_acordado\", \"odooActivityId\": $json.id } }}",
        "options": {}
      },
      "id": "http-post-marcar-envio",
      "name": "Marcar planificado (envío)",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [1580, 280]
    },
    {
      "parameters": {},
      "id": "noop-not-found-envio",
      "name": "Cotización no encontrada (revisar a mano) ",
      "type": "n8n-nodes-base.noOp",
      "typeVersion": 1,
      "position": [1140, 440]
    }
  ],
  "connections": {
    "Cada 10 minutos": { "main": [[{ "node": "Config", "type": "main", "index": 0 }]] },
    "Config": {
      "main": [
        [
          { "node": "GET refacturas pendientes", "type": "main", "index": 0 },
          { "node": "GET envíos acordados pendientes", "type": "main", "index": 0 }
        ]
      ]
    },

    "GET refacturas pendientes": { "main": [[{ "node": "Una por una (refactura)", "type": "main", "index": 0 }]] },
    "Una por una (refactura)": { "main": [[{ "node": "Buscar cotización por pedido ML", "type": "main", "index": 0 }]] },
    "Buscar cotización por pedido ML": { "main": [[{ "node": "¿Se encontró la cotización?", "type": "main", "index": 0 }]] },
    "¿Se encontró la cotización?": {
      "main": [
        [{ "node": "Preparar nota (refactura)", "type": "main", "index": 0 }],
        [{ "node": "Cotización no encontrada (revisar a mano)", "type": "main", "index": 0 }]
      ]
    },
    "Preparar nota (refactura)": { "main": [[{ "node": "Crear planificación (Odoo Activity)", "type": "main", "index": 0 }]] },
    "Crear planificación (Odoo Activity)": { "main": [[{ "node": "Marcar planificado (refactura)", "type": "main", "index": 0 }]] },

    "GET envíos acordados pendientes": { "main": [[{ "node": "Uno por uno (envío)", "type": "main", "index": 0 }]] },
    "Uno por uno (envío)": { "main": [[{ "node": "Buscar cotización por pedido ML ", "type": "main", "index": 0 }]] },
    "Buscar cotización por pedido ML ": { "main": [[{ "node": "¿Se encontró la cotización? ", "type": "main", "index": 0 }]] },
    "¿Se encontró la cotización? ": {
      "main": [
        [{ "node": "Preparar nota (envío)", "type": "main", "index": 0 }],
        [{ "node": "Cotización no encontrada (revisar a mano) ", "type": "main", "index": 0 }]
      ]
    },
    "Preparar nota (envío)": { "main": [[{ "node": "Crear planificación (Odoo Activity) ", "type": "main", "index": 0 }]] },
    "Crear planificación (Odoo Activity) ": { "main": [[{ "node": "Marcar planificado (envío)", "type": "main", "index": 0 }]] }
  },
  "active": false,
  "settings": { "executionOrder": "v1" },
  "pinData": {}
}
```

# OpenObserve logs MCP

Servidor MCP de solo lectura para consultar logs de OpenObserve por su API HTTP. Usa stdio y tres tools: `list_streams`, `get_stream_schema` y `search_logs`.

## Requisitos

Node.js 20 o superior.

## Variables de entorno

Las credenciales solo viven en el entorno del proceso. No van en el código ni en este repositorio.

- `OPENOBSERVE_URL`
- `OPENOBSERVE_ORG`
- `OPENOBSERVE_USER`
- `OPENOBSERVE_PASSWORD`

`.env.example` trae la URL y la organización. Copia ese archivo a `.env` y completa usuario y contraseña solo si vas a probar el proceso en local.

## Cómo correrlo

```bash
npm install
npm run build
npm start
```

`npm start` ejecuta `node dist/index.js` y espera que las variables ya estén definidas. Para una prueba local con archivo `.env`:

```bash
node --env-file=.env dist/index.js
```

## Cursor

Añade este bloque a `~/.cursor/mcp.json`. Sustituye `correo` y `contraseña` por las credenciales reales. Esas variables quedan en ese archivo, fuera del repositorio.

```json
{
  "mcpServers": {
    "openobserve-logs": {
      "command": "node",
      "args": ["C:\\PERSONAL\\MCP\\openobserve\\dist\\index.js"],
      "env": {
        "OPENOBSERVE_URL": "https://telemetry.astra-consulting.cloud",
        "OPENOBSERVE_ORG": "default",
        "OPENOBSERVE_USER": "correo",
        "OPENOBSERVE_PASSWORD": "contraseña"
      }
    }
  }
}
```

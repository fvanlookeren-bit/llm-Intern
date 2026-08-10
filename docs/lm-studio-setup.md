# Setup del host local (LM Studio o Bionic)

> **Host recomendado: LM Studio.** **Bionic** (Element Labs) es un derivado que a
> nivel de integración funciona igual sin cambiar nada (mismo home `~/.lmstudio`,
> mismo `mcp.json`, mismo puerto 1234, mismos endpoints, mismo CLI `lms`), pero en
> la versión 1.0.6 **no puede cargar modelos grandes**: un bug de AutoFit exige un
> contexto mínimo imposible y no responde a ninguna configuración. El mismo modelo
> carga bien en LM Studio en la misma máquina. Evidencia completa en el
> [README](../README.md#bionic-106-no-carga-modelos-grandes-bug-de-autofit).
> Donde esta guía dice "LM Studio", el bridge también acepta Bionic — pero para
> modelos grandes, usá LM Studio.

Requisitos antes de instalar el bridge:

1. [LM Studio](https://lmstudio.ai/) o [Bionic](https://elementlabs.ai/) instalado.
2. Al menos un modelo descargado (ver [`MODELS.md`](../MODELS.md) para recomendaciones).
3. El servidor local activado: en la app, pestaña **Developer** (ícono `</>`) →
   **Start Server**. Por defecto queda en `http://localhost:1234`.
4. Confirmá que responde:
   ```bash
   curl http://localhost:1234/v1/models
   ```

## Desactivar el "thinking"

Los modelos con razonamiento (Qwen3, algunos Gemma) piensan antes de responder —
lento y sin valor para tareas mecánicas de delegación. **No hay forma confiable de
apagarlo por API/REST**: LM Studio ignora `enable_thinking`, `chat_template_kwargs`,
y hasta el toggle de la UI cuando la request viene de REST/CLI en vez de la propia
UI de chat (limitación conocida — ver issues
[`lmstudio-bug-tracker#2057`](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/2057),
[`#1659`](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1659) y
[`docs#193`](https://github.com/lmstudio-ai/docs/issues/193)).

La única forma que funciona de verdad, por modelo:

1. En LM Studio, abrí el modelo en **My Models**.
2. Buscá la sección **Prompt Template** (Jinja).
3. Agregá esta línea al principio del template:
   ```jinja
   {%- set enable_thinking = false %}
   ```
4. Guardá. Si el modelo ya estaba cargado, recargalo para que tome el cambio.

Verificación rápida:

```bash
curl -s http://localhost:1234/v1/chat/completions -H "Content-Type: application/json" -d '{
  "model": "<tu-modelo>",
  "messages": [{"role":"user","content":"Decí solo la palabra OK, nada más."}],
  "max_tokens": 300
}' | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['usage']['completion_tokens_details'])"
```

Si `reasoning_tokens` da `0`, funcionó.

## Modelo por defecto + preset personalizado (opcional, avanzado)

`resolveModel()` en el bridge usa, en este orden: (1) el modelo pasado explícito por
parámetro, (2) el que ya esté cargado en memoria, (3) `LM_STUDIO_DEFAULT_MODEL` (o
`qwen/qwen3.6-35b-a3b` si no seteaste esa variable) — disparando su JIT-load.

Si querés que ese JIT-load arranque siempre con un preset propio (thinking off +
un system prompt fijo, por ejemplo), LM Studio guarda esa configuración por modelo en:

```
~/.lmstudio/.internal/user-concrete-model-default-config/<publisher>/<model-id>.json
```

Se genera automáticamente cuando guardás un preset desde la UI (**Chat** → panel
derecho → guardar preset → marcarlo como default de carga para ese modelo). No hace
falta tocar ese archivo a mano — es más simple crear el preset desde la UI una vez.

## MCPs para `lm_studio_agent`

`lm_studio_agent` conecta el modelo local, como cliente MCP, a los servers que le
pases — la misma fuente de verdad que usa la propia app de LM Studio:
`~/.lmstudio/mcp.json`. Copiá [`templates/mcp.example.json`](../templates/mcp.example.json)
ahí y adaptalo a tus propios MCPs (rutas locales, URLs, API keys). **No subas ese
archivo a ningún repo público** — va a tener tus credenciales.

Formato: cada entrada es `"nombre": {"command": ..., "args": [...]}` (proceso local
stdio) o `"nombre": {"url": "...", "headers": {...}}` (servidor HTTP remoto).

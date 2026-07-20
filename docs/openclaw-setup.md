# Setup para OpenClaw (agente `main`)

Cómo darle al agente `main` de OpenClaw acceso al intern, con el protocolo
**intern-first**: el `main` corre en un modelo de pago y actúa como **supervisor** —
exprime al intern (LM Studio local, gratis) como doer por defecto y solo interviene
para corregir o terminar. Es el inverso del setup de Claude Code / Codex, donde el
modelo grande es el doer y el intern la excepción.

> Prerrequisito: LM Studio corriendo con el servidor local activo y al menos un
> modelo descargado. Ver [`lm-studio-setup.md`](lm-studio-setup.md).

## 1. Compilar el bridge

```bash
cd <RUTA_DEL_REPO>      # p.ej. ~/dev/llm-Intern
npm install
npm run build           # genera dist/index.js
```

El bridge es un MCP server stdio estándar: cualquier host MCP puede lanzarlo. No
necesita nada específico de OpenClaw para funcionar.

## 2. Registrar el MCP en OpenClaw

OpenClaw lee sus MCP de `~/.openclaw/openclaw.json` en `mcp.servers` (no de
`~/.lmstudio/mcp.json`). Agregá el server `lm-studio` — ver
[`templates/openclaw-mcp.snippet.json`](../templates/openclaw-mcp.snippet.json)
para el bloque exacto:

```jsonc
// dentro de mcp.servers
"lm-studio": {
  "command": "node",
  "args": ["<RUTA_DEL_REPO>/dist/index.js"],
  "env": {
    "LM_STUDIO_BASE_URL": "http://127.0.0.1:1234/v1",
    "LM_STUDIO_DEFAULT_MODEL": "qwen/qwen3.6-35b-a3b"
  }
}
```

Hacé backup de `openclaw.json` antes de editarlo (`cp openclaw.json openclaw.json.bak`)
y reiniciá el gateway de OpenClaw para que cargue las tools nuevas.

### Toolbox del intern-agent (opcional pero recomendado)

`lm_studio_agent` da tools reales al intern. Por defecto lee `~/.lmstudio/mcp.json`.
Con la variable `INTERN_MCP_CONFIG` podés apuntarlo a un archivo **curado** — así el
intern recibe solo un subconjunto acotado de MCPs (menos tools = menos confusión para
el modelo local), sin tocar el toolbox de la app de LM Studio ni el fleet completo de
OpenClaw. Mismo formato: `{ "mcpServers": { "<nombre>": { url|command, ... } } }`.

## 3. Alcance por agente

El bloque de arriba deja `lm-studio` disponible según el perfil de tools de cada
agente. `main` usa `"tools": { "profile": "full" }`, así que ya lo ve. Si querés que
**solo** `main` (y no los subagents cliente) tenga el intern, usá el mecanismo de
allow/deny de tools por agente de tu versión de OpenClaw; el intern-first es un
protocolo de supervisor y tiene sentido sobre todo en `main`.

## 4. Instalar el protocolo intern-first

Pegá [`templates/openclaw.snippet.md`](../templates/openclaw.snippet.md) como una
sección de reglas duras en el `AGENTS.md` del workspace del agente `main`.
Reemplazá `<RUTA_DEL_REPO>`, `<TU_NOMBRE>` y `<WORKSPACE>`. Ese snippet es lo que
invierte el default: **delegar es la regla, hacerlo directo la excepción.**

> **Importante — no basta con pegarlo al final.** En un `AGENTS.md` largo (con
> muchas "reglas duras"), pegar el protocolo abajo **no cambia el comportamiento**:
> el modelo se ancla en las directivas del inicio del archivo y sigue resolviendo
> todo él mismo. Verificado en la práctica — con el protocolo solo al final, `main`
> generó lotes de contenido sin delegar. Hacen falta DOS cosas:
>
> 1. **Enmendá la línea/directiva de prioridad del inicio** para que ya incluya el
>    intern-first (p.ej. de "resolvé en el turno actual" a "resolvé en el turno,
>    pero el grueso mecánico lo hace el intern; tu modelo es para planificar,
>    revisar y corregir").
> 2. **Subí una regla dura compacta con trigger concreto** cerca del inicio, además
>    del protocolo completo abajo. Ejemplo de bloque para pegar arriba:
>
> ```markdown
> ## Intern-first (regla dura)
> - Trigger: si el output es mecánico/masivo — generar >8 items, borradores largos,
>   transformaciones repetitivas, resúmenes, boilerplate, extracción — NO lo
>   produzcas vos: delegá a `lm_studio_generate` (o `lm_studio_agent` si necesita
>   leer archivos/tools), después revisás y corregís.
> - Buscá la tool por tool-search (MCP `lm-studio`); si no aparece, `lm_studio_list_models`.
> - Hacerlo vos directo requiere una razón explícita en una línea.
> - Detalle completo: sección "El intern ... es tu doer por defecto" al final.
> ```

Iniciá el log de uso (ajustá la ruta a tu workspace):

```bash
cp templates/intern-usage-log.template.md <WORKSPACE>/memory/intern-usage-log.md
```

## 5. Verificar

```bash
node smoke-test.mjs
```

O desde una sesión con `main`: pedile algo mecánico y masivo ("resumí estos N
archivos") y confirmá que rutea al intern (`lm_studio_generate` / `lm_studio_agent`)
en vez de producirlo con su propio modelo, y que después revisa/corrige.

## Interacción con piezas existentes de OpenClaw

- **Guard / preload de LM Studio (si tenés uno):** garantizar que el modelo local
  esté cargado antes de una tanda grande. El intern usa lo que esté cargado; fijar
  el modelo antes evita un JIT-load a mitad de tarea o que quede cargado el modelo
  equivocado por otra sesión.
- **`autoUnload` / `idleUnloadMinutes`:** OpenClaw puede descargar el modelo entre
  llamadas. El intern hará JIT-load del default (`LM_STUDIO_DEFAULT_MODEL`) si no hay
  nada cargado — consistente, pero con latencia de carga en la primera llamada.
- **Subagents cliente vs. intern:** los subagents (`Agent` tool) llevan identidad y
  workspace de cliente y gate de cambios. El intern es una llamada directa sin ese
  overhead. Para grunt work genérico, exprimí el intern; para trabajo con contexto
  de cliente, usá el subagent correcto.

#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Ubica el CLI `lms` de LM Studio (necesario para lm_studio_load_model). Orden:
// LMS_PATH explícito → ~/.lmstudio/bin/lms → confiar en el PATH.
function resolveLmsBinary(): string {
  if (process.env.LMS_PATH) return process.env.LMS_PATH;
  const home = path.join(os.homedir(), ".lmstudio", "bin", "lms");
  if (fs.existsSync(home)) return home;
  return "lms";
}

const BASE_URL = process.env.LM_STUDIO_BASE_URL ?? "http://localhost:1234/v1";
const ORIGIN = BASE_URL.replace(/\/v1\/?$/, "");
const NATIVE_MODELS_URL = `${ORIGIN}/api/v0/models`;

// Modelo por defecto cuando no hay nada cargado en LM Studio. Si le asignás un
// preset propio como default de carga en LM Studio (~/.lmstudio/.internal/
// user-concrete-model-default-config/<model-id>.json — ver docs/lm-studio-setup.md),
// fijarlo acá (en vez de "el primero del catálogo") asegura que el JIT-load
// dispare siempre ese preset, no un modelo al azar sin esa config.
const DEFAULT_MODEL = process.env.LM_STUDIO_DEFAULT_MODEL ?? "qwen/qwen3.6-35b-a3b";

// --- Log de actividad: una línea JSON por invocación del intern. ---
//
// Por qué existe: algunos hosts no muestran las tools MCP por su nombre. OpenClaw,
// por ejemplo, con toolSearch activo invoca todo a través de un dispatcher genérico
// (`tool_call`), así que en su UI no se distingue "el intern trabajó" de cualquier
// otra tool. Este log es la fuente de verdad host-agnóstica: `tail -f` sobre él
// muestra en vivo qué delegaciones están pasando, sin importar quién llame.
//
// Nunca debe romper una tool: si el archivo no se puede escribir, se ignora.
// Desactivable con INTERN_ACTIVITY_LOG=off. Prompts truncados a propósito —
// es un registro de actividad, no un archivo de transcripciones.
const ACTIVITY_LOG_PATH =
  process.env.INTERN_ACTIVITY_LOG ?? path.join(os.homedir(), ".lmstudio", "intern-activity.jsonl");
const ACTIVITY_LOG_ENABLED = ACTIVITY_LOG_PATH.toLowerCase() !== "off";
const ACTIVITY_SNIPPET_MAX = 160;

function snippet(text: string | undefined, max = ACTIVITY_SNIPPET_MAX): string {
  if (!text) return "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function logActivity(entry: Record<string, unknown>): void {
  if (!ACTIVITY_LOG_ENABLED) return;
  try {
    fs.appendFileSync(
      ACTIVITY_LOG_PATH,
      `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`
    );
  } catch {
    // Silencioso a propósito: la observabilidad nunca debe tumbar la delegación.
  }
}

interface NativeModel {
  id: string;
  type?: string; // "llm" | "vlm" | "embeddings"
  state?: string; // "loaded" | "not-loaded"
}

async function fetchJson(url: string, init?: RequestInit) {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new Error(
      `No se pudo conectar a LM Studio en ${url}. ¿Está corriendo el servidor local? (${
        err instanceof Error ? err.message : String(err)
      })`
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LM Studio respondió ${res.status} ${res.statusText}: ${body}`);
  }
  return res.json();
}

async function lmFetch(path: string, init?: RequestInit) {
  return fetchJson(`${BASE_URL}${path}`, init);
}

async function listNativeModels(): Promise<NativeModel[]> {
  const data = (await fetchJson(NATIVE_MODELS_URL)) as { data?: NativeModel[] };
  return data.data ?? [];
}

// Prefiere un modelo ya cargado en memoria (state: "loaded") antes que dejar
// que LM Studio haga JIT-load del primero del catálogo — así se usa lo que
// el usuario ya tiene corriendo en la app, no un modelo al azar.
//
// /api/v0/models solo devuelve modelos REALMENTE locales a esta Mac (verificado:
// las filas con ícono de red "LM Link" que aparecen en la UI de LM Studio para
// modelos disponibles en otra instancia NO salen por esta API). Aun así, cuando
// alguien pasa 'model' explícito (ej. siguiendo la guía de selección del
// protocolo del intern) no hay que confiar ciegamente en el string — validar
// contra el catálogo real evita que LM Studio intente resolver un ID que no
// está local (typo, o un ID que solo existe vía LM Link) y falle.
async function resolveModel(model?: string): Promise<string> {
  const models = await listNativeModels();
  const localNonEmbedding = models.filter((m) => m.type !== "embeddings");

  if (model) {
    if (localNonEmbedding.some((m) => m.id === model)) return model;
    const available = localNonEmbedding.map((m) => m.id).join(", ") || "(ninguno)";
    throw new Error(
      `El modelo '${model}' no está entre los modelos locales de esta Mac (puede ser un ID inválido, o uno visible ` +
        `solo vía LM Link en la app pero no descargado acá). Modelos locales disponibles: ${available}`
    );
  }

  const loaded = localNonEmbedding.find((m) => m.state === "loaded");
  if (loaded) return loaded.id;

  // Nada cargado: preferir el default fijo (dispara JIT-load consistente con
  // su preset "mcps" ya aplicado) antes que "el primero del catálogo" al azar.
  if (localNonEmbedding.some((m) => m.id === DEFAULT_MODEL)) return DEFAULT_MODEL;

  const anyModel = localNonEmbedding[0];
  if (anyModel) return anyModel.id;

  throw new Error(
    "No hay ningún modelo cargado ni disponible en LM Studio. Cargá uno en la app o pasá el parámetro 'model' explícitamente."
  );
}

// --- Puente de tools reales: el intern conecta como CLIENTE MCP a los ---
// --- servidores definidos en ~/.lmstudio/mcp.json (misma fuente de   ---
// --- verdad que usa la app de LM Studio), descubre sus tools, se las ---
// --- pasa al modelo, y ejecuta lo que pida — un loop de agente real. ---

interface LmStudioMcpServerConfig {
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

// Toolbox del intern-agent (lm_studio_agent). Por defecto ~/.lmstudio/mcp.json —
// la misma fuente de verdad que usa la app de LM Studio. Se puede apuntar a otro
// archivo con INTERN_MCP_CONFIG para dar al intern un toolbox curado distinto del
// de la app (útil cuando el bridge lo lanza otro host — p.ej. OpenClaw — y querés
// que el intern tenga solo un subconjunto acotado de MCPs). El formato es el mismo:
// { "mcpServers": { "<nombre>": { url|command, ... } } }.
const LMSTUDIO_MCP_JSON =
  process.env.INTERN_MCP_CONFIG ?? path.join(os.homedir(), ".lmstudio", "mcp.json");

function loadLmStudioMcpConfig(): Record<string, LmStudioMcpServerConfig> {
  let raw: string;
  try {
    raw = fs.readFileSync(LMSTUDIO_MCP_JSON, "utf-8");
  } catch (err) {
    throw new Error(
      `No pude leer ${LMSTUDIO_MCP_JSON}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const parsed = JSON.parse(raw) as { mcpServers?: Record<string, LmStudioMcpServerConfig> };
  return parsed.mcpServers ?? {};
}

async function connectMcpServer(name: string, config: LmStudioMcpServerConfig): Promise<Client> {
  const client = new Client({ name: `mcp-lm-studio-agent-${name}`, version: "0.1.0" });
  if (config.url) {
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: config.headers ? { headers: config.headers } : undefined,
    });
    await client.connect(transport);
  } else if (config.command) {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) },
    });
    await client.connect(transport);
  } else {
    throw new Error(`El server "${name}" en mcp.json no tiene "url" ni "command".`);
  }
  return client;
}

// Nombre de tool visible al modelo: "<server>__<tool>" — evita colisiones
// entre servers que definan tools con el mismo nombre, y permite rutear
// cada tool_call de vuelta al cliente MCP correcto.
function prefixedToolName(serverName: string, toolName: string): string {
  return `${serverName}__${toolName}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

const server = new McpServer({ name: "lm-studio", version: "0.1.0" });

server.registerTool(
  "lm_studio_list_models",
  {
    title: "Listar modelos de LM Studio",
    description:
      "Lista los modelos del servidor local de LM Studio (http://localhost:1234) e indica cuáles están " +
      "actualmente cargados en memoria (state: loaded) vs solo disponibles para JIT-load.",
    inputSchema: {},
  },
  async () => {
    const models = await listNativeModels();
    if (!models.length) {
      return { content: [{ type: "text", text: "No hay modelos en LM Studio." }] };
    }
    const lines = models.map(
      (m) => `${m.id} [${m.state === "loaded" ? "cargado" : "no cargado"}]${m.type ? ` (${m.type})` : ""}`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.registerTool(
  "lm_studio_load_model",
  {
    title: "Cargar un modelo en LM Studio (con descarga exclusiva)",
    description:
      "Carga un modelo específico en LM Studio vía el CLI `lms`, opcionalmente descargando TODOS los demás " +
      "primero (exclusive=true, default). Resuelve de raíz el problema recurrente de 'modelo equivocado " +
      "cargado': llamá esto ANTES de una tanda de trabajo con un modelo concreto (ej. qwen3-coder-30b para " +
      "código) para garantizar que ese, y solo ese, esté en memoria — así lm_studio_generate/lm_studio_agent " +
      "no toman por error un modelo que quedó cargado de otra sesión. Requiere el CLI `lms` instalado " +
      "(viene con LM Studio; se busca en LMS_PATH, ~/.lmstudio/bin/lms, o el PATH). Devuelve el estado de " +
      "`lms ps` al terminar para que confirmes qué quedó cargado.",
    inputSchema: {
      model: z
        .string()
        .describe("ID del modelo a cargar (ver lm_studio_list_models para los IDs locales válidos)."),
      exclusive: z
        .boolean()
        .optional()
        .default(true)
        .describe("Si true (default), descarga todos los demás modelos antes de cargar este — deja solo este en memoria."),
      ttl: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Segundos de inactividad tras los cuales LM Studio descarga el modelo (auto-unload). Omitir = sin TTL."),
      context_length: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Longitud de contexto a usar al cargar. Omitir = default del modelo."),
    },
  },
  async ({ model, exclusive, ttl, context_length }) => {
    // Validar el ID contra el catálogo local antes de invocar lms (mismo criterio
    // que resolveModel para un 'model' explícito) — evita un lms load que falle o,
    // peor, matchee parcialmente otro modelo.
    const models = await listNativeModels();
    const localNonEmbedding = models.filter((m) => m.type !== "embeddings");
    if (!localNonEmbedding.some((m) => m.id === model)) {
      const available = localNonEmbedding.map((m) => m.id).join(", ") || "(ninguno)";
      return {
        content: [
          {
            type: "text",
            text: `El modelo '${model}' no está entre los modelos locales. Disponibles: ${available}`,
          },
        ],
        isError: true,
      };
    }

    const lms = resolveLmsBinary();
    const steps: string[] = [];
    try {
      if (exclusive) {
        await execFileAsync(lms, ["unload", "--all"]);
        steps.push("Descargados todos los modelos previos (unload --all).");
      }
      const loadArgs = ["load", model, "-y"];
      if (ttl !== undefined) loadArgs.push("--ttl", String(ttl));
      if (context_length !== undefined) loadArgs.push("--context-length", String(context_length));
      await execFileAsync(lms, loadArgs, { timeout: 300000 });
      steps.push(`Cargado '${model}'.`);
      logActivity({ tool: "lm_studio_load_model", model, exclusive, ok: true });

      const { stdout: ps } = await execFileAsync(lms, ["ps"]);
      return { content: [{ type: "text", text: `${steps.join("\n")}\n\nEstado actual (lms ps):\n${ps.trim()}` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const hint = /ENOENT|not found/i.test(msg)
        ? ` No se encontró el CLI 'lms'. Instalalo con LM Studio o seteá LMS_PATH al binario.`
        : "";
      return {
        content: [
          {
            type: "text",
            text: `${steps.join("\n")}${steps.length ? "\n" : ""}Falló al cargar '${model}': ${msg}.${hint}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "lm_studio_list_mcp_servers",
  {
    title: "Listar MCPs disponibles para lm_studio_agent",
    description:
      "Lista los nombres de servidor definidos en ~/.lmstudio/mcp.json — usar esos nombres en el parámetro " +
      "'mcp_servers' de lm_studio_agent. No verifica que cada uno esté vivo/alcanzable, solo lista lo que hay " +
      "configurado (url = servidor HTTP remoto; command = proceso local stdio).",
    inputSchema: {},
  },
  async () => {
    const servers = loadLmStudioMcpConfig();
    const names = Object.keys(servers);
    if (!names.length) {
      return { content: [{ type: "text", text: `No hay servers en ${LMSTUDIO_MCP_JSON}.` }] };
    }
    const lines = names.map((name) => {
      const cfg = servers[name];
      return cfg.url ? `${name} (url: ${cfg.url})` : `${name} (command: ${cfg.command})`;
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.registerTool(
  "lm_studio_generate",
  {
    title: "Delegar generación a LM Studio (local, gratis)",
    description:
      "Ejecuta un prompt en el modelo local de LM Studio, en vez de gastar tokens de Claude. Por defecto usa " +
      "el modelo que ya está cargado en memoria en la app; si no hay ninguno cargado, dispara JIT-load de " +
      `'${DEFAULT_MODEL}' (LM_STUDIO_DEFAULT_MODEL). Usar para trabajo ` +
      "mecánico o masivo: borradores largos, transformaciones repetitivas, resúmenes, reescritura de texto, " +
      "generación de boilerplate. No usar para tareas que requieran razonamiento complejo, uso de otras " +
      "herramientas, o alta precisión — para eso conviene que Claude lo haga directo. " +
      "Nota sobre modelos con 'thinking' (Qwen3, etc.): el server intenta desactivar el razonamiento " +
      "(chat_template_kwargs.enable_thinking=false) pero LM Studio actualmente IGNORA ese flag vía API/REST " +
      "para varios modelos (limitación conocida de LM Studio, no de esta tool) — el modelo puede seguir " +
      "'pensando' y tardar más de lo esperado. La única forma confiable de apagarlo es editar el Prompt " +
      "Template del modelo en la app de LM Studio y agregar '{%- set enable_thinking = false %}' al inicio.",
    inputSchema: {
      prompt: z.string().describe("El prompt / tarea a ejecutar en el modelo local."),
      system: z
        .string()
        .optional()
        .describe("Instrucción de sistema opcional (rol, formato de salida, restricciones)."),
      model: z
        .string()
        .optional()
        .describe(
          "ID del modelo a usar (ver lm_studio_list_models). Si se omite, se usa el modelo ya cargado en LM Studio."
        ),
      temperature: z.number().min(0).max(2).optional().default(0.7),
      max_tokens: z.number().int().positive().optional().default(2048),
      response_schema: z
        .record(z.any())
        .optional()
        .describe(
          "JSON Schema opcional. Si se pasa, LM Studio fuerza (grammar-constrained) que la respuesta sea JSON " +
            "válido contra ese schema — no depende de que el modelo 'obedezca' la instrucción en el prompt. " +
            "Usalo para extracción de datos donde necesitás campos exactos (ej. {tools_called, metrics, tool_errors})."
        ),
    },
  },
  async ({ prompt, system, model, temperature, max_tokens, response_schema }) => {
    const startedAt = Date.now();
    const messages = [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: prompt },
    ];
    const resolvedModel = await resolveModel(model);
    const data = (await lmFetch("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: resolvedModel,
        messages,
        temperature,
        max_tokens,
        // Best-effort: algunos backends de LM Studio (no todos) respetan esto
        // para desactivar el "thinking" de modelos tipo Qwen3. Ver nota en la
        // descripción de esta tool sobre la limitación conocida.
        chat_template_kwargs: { enable_thinking: false },
        ...(response_schema
          ? { response_format: { type: "json_schema", json_schema: { name: "response", strict: true, schema: response_schema } } }
          : {}),
      }),
    })) as {
      choices?: Array<{
        message?: { content?: string; reasoning_content?: string };
        finish_reason?: string;
      }>;
    };

    const choice = data.choices?.[0];
    const text = choice?.message?.content || choice?.message?.reasoning_content || "";
    if (!text) {
      const reason = choice?.finish_reason ? ` (finish_reason: ${choice.finish_reason})` : "";
      logActivity({
        tool: "lm_studio_generate",
        model: resolvedModel,
        ms: Date.now() - startedAt,
        ok: false,
        prompt: snippet(prompt),
        error: `sin contenido${reason}`,
      });
      return {
        content: [
          {
            type: "text",
            text: `LM Studio no devolvió contenido${reason}. Probá subir max_tokens (el modelo puede haber gastado el presupuesto pensando).`,
          },
        ],
        isError: true,
      };
    }
    logActivity({
      tool: "lm_studio_generate",
      model: resolvedModel,
      ms: Date.now() - startedAt,
      ok: true,
      prompt: snippet(prompt),
      chars: text.length,
    });
    return { content: [{ type: "text", text: text.trim() }] };
  }
);

interface OpenAiToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

server.registerTool(
  "lm_studio_agent",
  {
    title: "Delegar tarea CON tools reales a LM Studio (local, gratis)",
    description:
      "Como lm_studio_generate, pero el modelo local puede además llamar tools de MCPs reales — no es solo " +
      "texto/código, puede leer archivos, consultar tu base de conocimiento, APIs internas, etc. El bridge se conecta como cliente " +
      "MCP a los servers pedidos en 'mcp_servers' (nombres de ~/.lmstudio/mcp.json — ver " +
      "lm_studio_list_mcp_servers), le pasa sus tools al modelo, ejecuta lo que pida, y repite hasta que " +
      "termine (loop de agente real, no una sola llamada). Usar para investigación/exploración delegable: " +
      "'buscá en el vault X y resumime', 'leé estos archivos y armá un borrador'. Seguí sin usar para tareas " +
      "de alta precisión (bugs/vulnerabilidades, decisiones con impacto real) — el modelo local razona peor " +
      "sobre CUÁNDO y CÓMO usar cada tool, y sobre cuándo parar, que Claude. Verificá el resultado antes de " +
      "confiar en él (ver regla de costo en feedback_intern_delegation / ~/.codex/AGENTS.md). " +
      "La respuesta siempre incluye 'tool_trace' (qué tool se llamó, con qué args, y qué devolvió) — para " +
      "tareas de auditoría/extracción, verificá cada dato del texto contra el trace en vez de confiar en la " +
      "síntesis del modelo: puede redactar algo plausible con números que no vinieron de ninguna tool. Para " +
      "forzar formato exacto, usá 'response_schema'.",
    inputSchema: {
      prompt: z.string().describe("La tarea a ejecutar en el modelo local con acceso a tools."),
      mcp_servers: z
        .array(z.string())
        .min(1)
        .describe(
          "Nombres de servers de ~/.lmstudio/mcp.json a darle al modelo (ver lm_studio_list_mcp_servers). " +
            "Elegí el mínimo necesario para la tarea — cada server conectado agrega tools al contexto del modelo."
        ),
      system: z
        .string()
        .optional()
        .describe("Instrucción de sistema opcional (rol, formato de salida, restricciones)."),
      model: z
        .string()
        .optional()
        .describe(
          "ID del modelo a usar (ver lm_studio_list_models). Si se omite, se usa el modelo ya cargado en LM Studio."
        ),
      temperature: z
        .number()
        .min(0)
        .max(2)
        .optional()
        .default(0.3)
        .describe("Default más bajo que lm_studio_generate — tool-calling es más confiable con menos variación."),
      max_tokens: z.number().int().positive().optional().default(4096),
      max_iterations: z
        .number()
        .int()
        .positive()
        .max(30)
        .optional()
        .default(8)
        .describe("Tope de vueltas del loop (llamada al modelo + ejecución de tools) antes de cortar."),
      response_schema: z
        .record(z.any())
        .optional()
        .describe(
          "JSON Schema opcional. Si se pasa, después de que el modelo termine su exploración libre (con tools), " +
            "se hace UNA llamada extra sin tools que le pide reformatear su respuesta como JSON estricto contra " +
            "ese schema, basado SOLO en lo ya conversado — no se pasa junto con 'tools' porque en la práctica eso " +
            "hace que el modelo prefiera inventar un JSON plausible antes que llamar la tool (verificado empíricamente). " +
            "Devuelve el resultado en el campo 'structured' de la respuesta, junto a 'tool_trace' para auditar cada " +
            "número contra la tool que lo originó — no confíes en el texto libre para datos que necesitás verificar."
        ),
    },
  },
  async ({ prompt, mcp_servers, system, model, temperature, max_tokens, max_iterations, response_schema }, extra) => {
    const startedAt = Date.now();
    const progressToken = extra?._meta?.progressToken;
    const configs = loadLmStudioMcpConfig();
    const missing = mcp_servers.filter((name) => !(name in configs));
    if (missing.length) {
      const available = Object.keys(configs).join(", ") || "(ninguno configurado)";
      return {
        content: [
          {
            type: "text",
            text: `Server(s) no encontrados en ${LMSTUDIO_MCP_JSON}: ${missing.join(", ")}. Disponibles: ${available}`,
          },
        ],
        isError: true,
      };
    }

    const connected: Array<{ name: string; client: Client }> = [];
    const toolRouting = new Map<string, { client: Client; originalName: string }>();
    // biome-ignore lint: schema shape viene directo de cada MCP server, heterogéneo por diseño
    const openAiTools: any[] = [];

    try {
      for (const name of mcp_servers) {
        let client: Client;
        try {
          client = await connectMcpServer(name, configs[name]);
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `No pude conectar al server "${name}": ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }
        connected.push({ name, client });
        const { tools } = await client.listTools();
        for (const tool of tools) {
          const pname = prefixedToolName(name, tool.name);
          toolRouting.set(pname, { client, originalName: tool.name });
          openAiTools.push({
            type: "function",
            function: {
              name: pname,
              description: tool.description ?? "",
              parameters: tool.inputSchema ?? { type: "object", properties: {} },
            },
          });
        }
      }

      if (!openAiTools.length) {
        return {
          content: [{ type: "text", text: "Los servers conectados no exponen ninguna tool." }],
          isError: true,
        };
      }

      // biome-ignore lint: mensajes heterogéneos (system/user/assistant+tool_calls/tool)
      const messages: any[] = [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: prompt },
      ];
      const resolvedModel = await resolveModel(model);

      // Registro de auditoría: qué tool se llamó, con qué args, y qué devolvió
      // (truncado). Se devuelve siempre junto al texto final — el modelo local
      // puede redactar una síntesis plausible con números que nunca vinieron de
      // ninguna tool; con esto el caller puede verificar cada dato en vez de
      // confiar ciegamente en la prosa. Ver MODELS.md sobre este failure mode.
      const TRACE_RESULT_MAX_CHARS = 2000;
      const toolTrace: Array<{ tool: string; args: unknown; result: string; error: boolean }> = [];

      let finalText = "";
      let finishedEarly = false;
      for (let i = 0; i < max_iterations; i++) {
        if (progressToken !== undefined) {
          // Best-effort: solo evita el timeout del lado del cliente si ese
          // cliente pidió resetTimeoutOnProgress al llamar esta tool. No lo
          // controlamos nosotros, pero no cuesta nada emitirlo.
          await extra
            .sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: i + 1,
                total: max_iterations,
                message: `Iteración ${i + 1}/${max_iterations} del intern-agent`,
              },
            })
            .catch(() => {});
        }
        const data = (await lmFetch("/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: resolvedModel,
            messages,
            tools: openAiTools,
            tool_choice: "auto",
            temperature,
            max_tokens,
            chat_template_kwargs: { enable_thinking: false },
          }),
        })) as {
          choices?: Array<{
            message?: {
              content?: string | null;
              reasoning_content?: string;
              tool_calls?: OpenAiToolCall[];
            };
            finish_reason?: string;
          }>;
        };

        const message = data.choices?.[0]?.message;
        if (process.env.LM_AGENT_DEBUG) {
          console.error(`[agent-debug] iter=${i} RAW=${JSON.stringify(data.choices?.[0])}`);
        }
        if (!message) {
          finalText = "LM Studio no devolvió respuesta.";
          finishedEarly = true;
          break;
        }

        const toolCalls = message.tool_calls ?? [];
        if (!toolCalls.length) {
          // El modelo terminó (finish_reason stop/length) sin pedir más tools.
          // Puede venir vacío si gastó todo el budget "pensando" pese al flag
          // nothink — distinguir de "se acabaron las iteraciones" más abajo.
          finalText = message.content || message.reasoning_content || "";
          finishedEarly = true;
          break;
        }

        messages.push({ role: "assistant", content: message.content ?? "", tool_calls: toolCalls });

        for (const call of toolCalls) {
          const routing = toolRouting.get(call.function.name);
          let resultText: string;
          let args: Record<string, unknown> = {};
          let traceArgs: unknown = call.function.arguments;
          let isError = false;
          if (!routing) {
            resultText = `Error: tool "${call.function.name}" no reconocida entre las conectadas.`;
            isError = true;
          } else {
            let argsOk = true;
            try {
              args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
              traceArgs = args;
            } catch {
              resultText = `Error: argumentos inválidos (no es JSON): ${call.function.arguments}`;
              argsOk = false;
              isError = true;
            }
            if (argsOk) {
              try {
                // Timeout más generoso que el default del SDK (60s) — búsquedas
                // semánticas (obsidian-semantic) u otros MCPs pueden tardar más
                // en local sin que sea un cuelgue real.
                const result = await routing.client.callTool(
                  { name: routing.originalName, arguments: args },
                  undefined,
                  { timeout: 120000 }
                );
                const blocks = Array.isArray(result.content) ? result.content : [];
                resultText =
                  blocks
                    .map((block) => ("text" in block && typeof block.text === "string" ? block.text : JSON.stringify(block)))
                    .join("\n") || "(sin contenido)";
                isError = Boolean(result.isError);
              } catch (err) {
                resultText = `Error ejecutando la tool: ${err instanceof Error ? err.message : String(err)}`;
                isError = true;
              }
            } else {
              resultText = `Error: argumentos inválidos (no es JSON): ${call.function.arguments}`;
            }
          }
          if (process.env.LM_AGENT_DEBUG) {
            console.error(`[agent-debug] tool_result name=${call.function.name} -> ${resultText.slice(0, 300)}`);
          }
          toolTrace.push({
            tool: call.function.name,
            args: traceArgs,
            result:
              resultText.length > TRACE_RESULT_MAX_CHARS
                ? `${resultText.slice(0, TRACE_RESULT_MAX_CHARS)}… (truncado, ${resultText.length} chars totales)`
                : resultText,
            error: isError,
          });
          messages.push({ role: "tool", tool_call_id: call.id, content: resultText });
        }
      }

      if (!finishedEarly) {
        // El for terminó sus max_iterations vueltas y en la última seguía
        // pidiendo tools — ahí sí se agotó el presupuesto de verdad.
        logActivity({
          tool: "lm_studio_agent",
          model: resolvedModel,
          ms: Date.now() - startedAt,
          ok: false,
          prompt: snippet(prompt),
          mcp_servers,
          tool_calls: toolTrace.length,
          error: `sin respuesta final tras ${max_iterations} iteraciones`,
        });
        return {
          content: [
            {
              type: "text",
              text: `Se alcanzó el máximo de ${max_iterations} iteraciones sin respuesta final (el modelo seguía pidiendo tools). Subí max_iterations o simplificá la tarea.\n\ntool_trace: ${JSON.stringify(toolTrace, null, 2)}`,
            },
          ],
          isError: true,
        };
      }
      if (!finalText) {
        logActivity({
          tool: "lm_studio_agent",
          model: resolvedModel,
          ms: Date.now() - startedAt,
          ok: false,
          prompt: snippet(prompt),
          mcp_servers,
          tool_calls: toolTrace.length,
          error: "contenido final vacío",
        });
        return {
          content: [
            {
              type: "text",
              text: "El modelo terminó sin pedir más tools pero devolvió contenido vacío " +
                "(puede haber gastado el budget de tokens 'pensando' pese a nothink). Probá subir max_tokens.\n\n" +
                `tool_trace: ${JSON.stringify(toolTrace, null, 2)}`,
            },
          ],
          isError: true,
        };
      }

      // Si pidieron response_schema, hacer UNA llamada extra sin 'tools' para
      // forzar el formato — combinar response_format+tools en el loop hace que
      // el modelo prefiera inventar un JSON plausible antes que llamar la tool
      // pedida (verificado empíricamente), así que la constricción de schema se
      // aplica recién acá, sobre la conversación ya completa.
      let structured: unknown = null;
      let structuredError: string | null = null;
      if (response_schema) {
        try {
          const structuringMessages = [
            ...messages,
            { role: "assistant", content: finalText },
            {
              role: "user",
              content:
                "Reformateá tu respuesta anterior como JSON estricto contra el schema dado. Basate SOLO en los " +
                "datos que ya reuniste en esta conversación (tus propias tool calls de arriba) — si algo no lo " +
                "verificaste con una tool, no lo incluyas.",
            },
          ];
          const structData = (await lmFetch("/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: resolvedModel,
              messages: structuringMessages,
              temperature: 0,
              max_tokens,
              chat_template_kwargs: { enable_thinking: false },
              response_format: { type: "json_schema", json_schema: { name: "response", strict: true, schema: response_schema } },
            }),
          })) as { choices?: Array<{ message?: { content?: string } }> };
          const structText = structData.choices?.[0]?.message?.content ?? "";
          structured = structText ? JSON.parse(structText) : null;
        } catch (err) {
          structuredError = err instanceof Error ? err.message : String(err);
        }
      }

      logActivity({
        tool: "lm_studio_agent",
        model: resolvedModel,
        ms: Date.now() - startedAt,
        ok: true,
        prompt: snippet(prompt),
        mcp_servers,
        tool_calls: toolTrace.length,
        tools_used: [...new Set(toolTrace.map((t) => t.tool))],
        tool_errors: toolTrace.filter((t) => t.error).length,
        chars: finalText.length,
      });

      const envelope = {
        final_text: finalText.trim(),
        structured,
        ...(structuredError ? { structured_error: structuredError } : {}),
        tool_trace: toolTrace,
      };
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } finally {
      await Promise.all(connected.map(({ client }) => client.close().catch(() => {})));
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

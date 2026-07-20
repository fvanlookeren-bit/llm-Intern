<!--
  Pegá esto en el AGENTS.md del agente `main` de OpenClaw (el archivo de
  instrucciones del workspace del main), como una sección más de reglas duras.
  Reemplazá <RUTA_DEL_REPO>, <TU_NOMBRE> y <WORKSPACE> por tus valores reales.
  Ver docs/openclaw-setup.md para el resto de la instalación.

  DIFERENCIA CLAVE con CLAUDE.snippet.md / AGENTS.snippet.md:
  en Claude Code / Codex el modelo grande es el doer por defecto y el intern es
  la excepción. Acá es AL REVÉS — el `main` de OpenClaw (modelo de pago) es
  SUPERVISOR: exprime al intern como doer por defecto y solo interviene para
  corregir o terminar. Delegar es la regla, no la excepción.

  NOTA DE INSTALACIÓN (aprendida en la práctica): pegar esta sección al final de
  un AGENTS.md largo NO alcanza para cambiar el comportamiento — el modelo se
  ancla en las directivas del inicio del archivo. Para que el intern-first se
  active de verdad, además de pegar esto abajo, subí una regla dura compacta con
  trigger concreto CERCA DEL INICIO (ver docs/openclaw-setup.md, paso 4).
-->

## El intern (LM Studio local) es tu doer por defecto — vos supervisás

**Vos (`main`) corrés en un modelo de pago. El intern corre 100% local y gratis en
LM Studio.** Tu trabajo no es producir el grueso vos mismo: es **planificar,
repartir al intern, revisar y corregir/terminar**. Cada token tuyo que gastás
produciendo algo que el intern podía hacer en un primer pase es cuota de pago
quemada. Exprimí al intern; reservate para el juicio y el último tramo.

**Esto NO es delegar a un subagent OpenClaw.** El intern es el MCP `lm-studio`
(bridge en `<RUTA_DEL_REPO>`), una llamada directa y stateless al modelo local —
sin identidad, workspace ni overhead de agente. Los subagents cliente (vía el tool
`Agent`) son otra cosa: llevan contexto de cliente y gate de cambios. Para grunt
work genérico, exprimí el intern, no abras un subagent.

**1. Tools del intern** (MCP `lm-studio`) — elegí según la tarea:
- `lm_studio_generate` — solo texto/código, **sin tools**. Todo el contexto va en el
  prompt (datos, texto fuente, resultados de tus propias tool calls). El intern no
  puede ir a buscar nada él mismo acá.
- `lm_studio_agent` — el intern **con tools MCP reales** (toolbox en el archivo que
  apunte `INTERN_MCP_CONFIG`, o `~/.lmstudio/mcp.json`). Le pasás `mcp_servers` y
  corre un loop de agente: llama tools, lee, repite. Usá el mínimo de MCPs por
  llamada. Ideal para investigación/lectura delegable ("leé estos 12 archivos y
  armá un borrador", "buscá X y resumí").
- `lm_studio_list_models` / `lm_studio_list_mcp_servers` — ver qué hay antes de elegir.

> En OpenClaw las tools MCP se exponen por **tool-search**, no van todas en el system
> prompt. Si no ves las tools del intern al toque, buscalas por nombre (`lm_studio`)
> o corré `lm_studio_list_models` para forzar el descubrimiento.

**2. Ciclo de trabajo por defecto (invertido — intern-first):**
   1. **Planificá vos** (barato, es tu fuerte): descomponé el job en pasos y decidí
      cuáles son mecánicos/masivos/de bajo razonamiento.
   2. **Repartí al intern** todo lo mecánico/masivo: borradores, transformaciones
      repetitivas, resúmenes, reescrituras, boilerplate, extracción, primeras
      pasadas de research con `lm_studio_agent`.
   3. **Revisá y corregí** el output del intern. Acá sí gastás tu modelo: verificar,
      arreglar los errores, y **terminar el último tramo** que el intern no cierra
      bien (juicio fino, tono final, integración).
   4. Solo lo que el intern demostrablemente no puede lo producís vos de cero.

**3. Regla del "squeeze": antes de hacer un subtask vos, preguntate**
   *"¿puede el intern darme un primer pase que yo después corrijo en menos de lo que
   me costaría hacerlo de cero?"* Si sí → delegalo. El default es delegar; hacerlo
   directo requiere una razón explícita (decila en una línea). Esto es el inverso
   del umbral de Claude Code: acá la vara para NO delegar es alta.

**4. Cuándo SÍ lo hacés vos directo (excepciones acotadas):**
   - Alta precisión / impacto real e irreversible (bugs con consecuencias,
     vulnerabilidades, decisiones de arquitectura, acciones externas que no se
     deshacen). Ver [MODELS.md](../MODELS.md).
   - Acciones que requieren aprobación de <TU_NOMBRE>: esas las manejás vos, no el
     intern (el intern no aprueba ni ejecuta cambios destructivos/externos).
   - Después de que el intern falló **dos veces** el mismo subtask: primero
     **escalá de modelo** (punto 5), no directo a vos; si aún falla, cerralo vos.

**5. Selección de modelo — escalá el modelo antes de escalar a vos.** Ver
   [MODELS.md](../MODELS.md) para la tabla completa. El cómputo local es gratis, así
   que un modelo local más lento pero más capaz solo cuesta tiempo — probalo antes
   de asumir que el intern no puede y hacerlo vos. Pasás `model` explícito en la
   tool.

**6. Un solo modelo cargado a la vez en LM Studio** — `resolveModel()` prefiere "lo
   que ya esté cargado" antes que el default. Ojo con OpenClaw: `autoUnload=true` e
   `idleUnloadMinutes` pueden descargar el modelo entre llamadas, y los subagents
   cliente pueden dejar cargado *otro* modelo. Si el resultado del intern viene raro,
   verificá con `lm_studio_list_models` qué está realmente cargado. Antes de una
   tanda grande, considerá fijar el modelo con tu guard de LM Studio, si tenés uno.

**7. Puntuá y registrá cada uso — obligatorio.** Apenas el intern termina, puntualo
   (1-10: qué tan bien lo hizo vs. haberlo hecho vos) y agregá una fila al log:
   `<WORKSPACE>/memory/intern-usage-log.md` — formato en
   [`templates/intern-usage-log.template.md`](intern-usage-log.template.md),
   `Herramienta = OpenClaw/main`. Es el dato que dice qué modelo sirve para qué;
   sin esto no se puede afinar el squeeze.

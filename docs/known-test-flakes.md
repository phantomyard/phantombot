# Flakes y dependencias de orden conocidos en la suite de tests

Estado al 2026-09-21, rama `feat/decision-model-cli` (`53f295e`), Bun 1.x,
~5.220 tests / 317 archivos. Tres fallos observados en suite completa que
**pasan aislados de forma consistente**. Este documento registra el
diagnóstico completo para que quien los cace no empiece de cero.

Método de reproducción: `bun test` (suite completa, ~2 min) vs.
`bun test tests/<archivo>.test.ts` (aislado). Los tres fallan en suite
completa y pasan aislados — la diferencia es el estado compartido del
proceso: `bun test` corre todos los archivos **en un solo proceso**, así
que el entorno (`process.env`) y los singletons import-level son estado
global de facto entre archivos.

---

## 1. `runDoctor harness availability > json mode includes harness checks` — determinista, introducido por esta rama

**Síntoma.** Falla en TODA suite completa que incluya
`tests/cli-decision-model.test.ts` antes de `tests/cli-doctor.test.ts`
(bun descubre los archivos alfabéticamente, así que ese orden es el
normal). Reproduce al 100 % con solo dos archivos:

```bash
bun test tests/cli-decision-model.test.ts tests/cli-doctor.test.ts
# → (fail) json mode includes harness checks
```

**Error exacto** (el guard de aislamiento de `src/state.ts:120`):

```
error: refusing to write state.json outside test isolation: /home/hedgehog/.local/share/phantombot/state.json
    at assertNotLiveStateWrite (src/state.ts:120)
    at saveState (src/state.ts:130)
    at saveHarnessBins (src/state.ts:147)
    at async runDoctor (src/cli/doctor.ts:1241)
```

**Causa raíz (verificada por bisect).** Dos defectos se combinan:

1. **`tests/cli-decision-model.test.ts` (líneas 55–56, `afterEach`) borra
   `XDG_CONFIG_HOME` y `XDG_DATA_HOME` INCONDICIONALMENTE**, en vez de
   guardar y restaurar los valores que puso el preload
   (`tests/testEnvIsolation.ts` fija `XDG_DATA_HOME ??= <raíz de
   aislamiento>/xdg-data`). Al salir ese archivo, `XDG_DATA_HOME` queda
   DESSET en el proceso. Es exactamente el anti-patrón que el propio
   mensaje del guard prohíbe ("restore the saved value, do not delete
   it") y que `tests/cli-jev.test.ts` y `tests/config-jev.test.ts` sí
   respetan (guardan en `ENV_NAMES` y restauran).
2. **`os.homedir()` de Bun congela `$HOME` al arranque del proceso.**
   El preload pone `process.env.HOME = <home aislado>` DESPUÉS del
   arranque, y Bun lo ignora para `homedir()`:

   ```bash
   bun -e 'process.env.HOME="/tmp/xyz"; console.log(require("os").homedir())'
   # → /home/hedgehog   (¡NO /tmp/xyz!)
   HOME=/tmp/xyz bun -e 'console.log(require("os").homedir())'
   # → /tmp/xyz        (solo si viene desde exec)
   ```

   El aislamiento de HOME del preload protege a los procesos HIJO (todo
   spawn ve `$HOME` mutado), pero **no** a los llamadores in-process de
   `homedir()` (`xdgDataHome()` en `src/config.ts:1036` es uno).

**Cadena completa.** `XDG_DATA_HOME` borrado → `statePath()` cae al
default (`PHANTOMBOT_STATE` unset) → `homedir()/.local/share` = el home
REAL → el guard lo detecta fuera de `[raíz de aislamiento, tmpdir()]` y
lanza. El test de doctor tocado es el primero que llega a una ruta que
escribe estado (`runDoctor` → descubrimiento de bins de harness →
`saveHarnessBins`).

**Nota:** el mensaje del guard es impreciso — dice
"`PHANTOMBOT_STATE` pointing at the real host", pero `PHANTOMBOT_STATE`
no está seteado; lo que apunta al host real es la resolución por DEFAULT
(por el `homedir()` congelado). Vale corregir el texto cuando se cacen
estos flakes.

**Estado:** NO existe en `main` (suite completa limpia, 0 fail); lo
introdujo `9b364ee` con el archivo nuevo
`tests/cli-decision-model.test.ts`. **Al mergear esta rama, CI se pone
rojo de forma determinista** — hay que arreglarlo antes del merge.

**Fix propuesto:** en `tests/cli-decision-model.test.ts`, guardar
`XDG_CONFIG_HOME`/`XDG_DATA_HOME` en el `beforeEach` y restaurarlos en el
`afterEach` (patrón `SAVED_CONFIG` que el mismo archivo ya usa para
`PHANTOMBOT_CONFIG`, o el bucle `ENV_NAMES` de `cli-jev.test.ts`).

---

## 2. `logSources > the session source is honest that it is this process only` — intermitente, pre-existente

**Síntoma.** Falla solo en suite completa (observado 2 veces en la rama y
1 vez en la base de la rama); pasa aislado y en pares de archivos
(verificado 3×). En una suite completa sobre `main` no reprodujo — es
intermitente.

**Error exacto** (`tests/tui-log-sources.test.ts:198`):

```
expect(lines[0].msg).toContain("service")
```

**Causa raíz (mecanismo confirmado, disparador exacto sin confirmar).**

- El ring de la fuente `session` es el singleton GLOBAL del proceso:
  `src/tui/logBuffer.ts:108` (`export const logBuffer = new LogBuffer()`).
- `startTui` (`src/tui/index.tsx:256`) y el flujo standalone
  (`src/tui/standalone.tsx:257`) instalan
  `setLogSink((line) => logBuffer.push(line))` durante su ventana y lo
  restauran al salir — pero **el ring no tiene API de reset/clear**, así
  que cualquier línea logueada durante esas ventanas queda para el resto
  del proceso.
- El test espera la fila "honest" que `sessionSource().read()`
  (`src/tui/logSources.ts:387`) devuelve SOLO cuando el ring está VACÍO:
  *"this TUI process has logged nothing yet — the daemon's own log is the
  'service' source"*. Con el ring contaminado, `lines[0]` es una línea
  real de otro test → falla.
- El disparador exacto (qué test loguea dentro de una ventana de sink) no
  quedó identificado; es sensible al entorno (los warns de `loadConfig`
  dependen de la config del host y del env fugado), lo que explica la
  intermitencia.

**Fix propuesto (cualquiera):** exportar un `resetLogBufferForTesting()`
y llamarlo en el `beforeEach` del test; o hacer el test tolerante
(`expect(lines.some(l => l.msg.includes("service")))`) — aunque eso
debilita la aserción que #478 quería; o hacer que la fila "honest" se
independice del contenido del ring (p. ej. que `read` distinga
"vacío-al-abrir" de "vacío-ahora").

---

## 3. `refreshPersonaIndex > a changed file is picked up on the next call` — flake de granularidad de mtime, pre-existente

**Síntoma.** Intermitente (falló 3 de 5 suite-completas; 5/5 pass
aislado consecutivos). Independiente de la rama: el test y el código no
fueron tocados por ella.

**Error exacto** (`tests/lib-indexRefresh.test.ts:64`):

```
expect((await refreshPersonaIndex(...)).indexed).toBe(1)
// Expected: 1   Received: 0
```

**Causa raíz (confirmada leyendo el código).**

- El test escribe el archivo dos veces seguidas (`"x"` y `"x and more"`)
  y espera que el segundo `refreshPersonaIndex` lo re-indexe.
- `refreshStale` (`src/lib/memoryIndex.ts:765+`) decide "stale"
  comparando el `mtime_ms` grabado en la tabla `files` contra el mtime
  en disco. Si ambas escrituras caen dentro de la granularidad del reloj
  del filesystem (Linux puede cuantizar los mtimes; bajo carga la
  ventana se agranda), el segundo mtime IGUALA al primero → "no cambió"
  → `indexed = 0`. (El tamaño sí cambia, pero el chequeo de staleness es
  de mtime.)

**Fix propuesto:** en el test, forzar el mtime entre las dos escrituras
(`fs.utimes(p, new Date(Date.now() + 5))` tras la segunda escritura, o
un `await Bun.sleep(5)`) para que el test mida el comportamiento de
re-index y no la resolución del reloj del disco.

---

## Lección transversal

`bun test` corre la suite **en un solo proceso**: todo `process.env` que
un test muta sin guardar/restaurar (o borra en vez de restaurar) y todo
singleton import-level (`logBuffer`, cachés de tracking de vault) es
estado compartido con todos los archivos que corren después. El guard de
`src/state.ts` (invariante de aislamiento de 2026-09-01) convirtió esa
clase de fuga de "corrupción silenciosa del host" a "fallo ruidoso" —
correcto, pero el ruido aterriza en el test SIGUIENTE en el orden
alfabético, no en el que fuga. Al cazar un "flake", sospechar primero de
quien corre ANTES alfabéticamente y muta env/singletons sin restaurar.

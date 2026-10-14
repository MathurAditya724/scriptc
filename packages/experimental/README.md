# @scriptc/experimental

Experimental scriptc APIs. Each export has a Node.js implementation, so programs that use them run unchanged under Node.js.

## LifetimeRegion

Instances of `ProgramLifetime` classes (`@scriptc/types`) are never freed in scriptc builds. A `LifetimeRegion` gives a long-running program a way to free a whole generation of them at once, for example the previous program of a compiler's watch mode.

```ts
import { LifetimeRegion } from "@scriptc/experimental";

let previous: LifetimeRegion | undefined;
function rebuild(): Program {
  const region = new LifetimeRegion();
  const program = region.run(() => buildProgram());
  previous?.release();
  previous = region;
  return program;
}
```

- `run(fn)` calls `fn` with the region as the current region and returns its result. `ProgramLifetime` instances created during the call belong to the region; calls nest.
- Instances created outside every `run` call belong to the default region, which is never freed.
- Work that resumes after an `await` inside `fn` runs outside the region.
- `release()` requests that the region be freed. scriptc frees it once nothing outside the region refers to any of its instances; until then the region stays allocated. Later `run` calls on a released region allocate in the default region.
- A region that holds a published object (`@scriptc/threads`) is never freed.

Under Node.js, `run(fn)` returns `fn()` and `release()` does nothing.

In scriptc builds, `SCRIPTC_REGION_STATS=1` reports every release attempt on stderr.

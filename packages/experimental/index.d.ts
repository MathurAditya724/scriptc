/** An allocation context for ProgramLifetime instances (@scriptc/types).
 * In scriptc builds, instances created while `run` executes belong to the
 * region and are freed together once the region is released and nothing
 * outside it refers to them. Under Node.js, `run` calls its callback and
 * `release` does nothing. */
export declare class LifetimeRegion {
  constructor();
  /** Calls `fn` with this region as the current region and returns its
   * result. ProgramLifetime instances created during the call, outside
   * nested `run` calls of other regions, belong to this region. Work that
   * resumes after an `await` inside `fn` runs outside the region. */
  run<T>(fn: () => T): T;
  /** Requests that the region be freed. Its instances are freed once
   * nothing outside the region refers to any of them; until then the
   * region stays allocated. Later `run` calls allocate outside the region.
   * Never observable except through memory use. */
  release(): void;
}

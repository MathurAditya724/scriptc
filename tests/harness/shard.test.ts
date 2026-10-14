/* The partition function's contract: the union of the n shards is the whole
 * list with every item EXACTLY once (no drops, no duplicates), assignment
 * depends only on the item's key (list growth never moves an existing item),
 * and no spec means everything. differential/llvm-differential/npm/server
 * lean on these properties for CI sharding — see shard.ts. */
import { globSync } from "node:fs";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { balancedShardSelect, parseShardSpec, shardOf, shardSelect, shardSuffix } from "./shard.js";
import fixtureCosts from "./effect4-costs.json";
import effectCosts from "./effect-costs.json";

const corpusDir = join(import.meta.dirname, "../corpus");

// The default parameters read SCRIPTC_TEST_SHARD, and CI sets it job-wide —
// these tests must see a controlled environment, not the job's slice.
const ambient = process.env["SCRIPTC_TEST_SHARD"];
beforeAll(() => {
  delete process.env["SCRIPTC_TEST_SHARD"];
});
afterAll(() => {
  if (ambient !== undefined) process.env["SCRIPTC_TEST_SHARD"] = ambient;
});

describe("parseShardSpec", () => {
  test("unset and empty mean no sharding", () => {
    expect(parseShardSpec(undefined)).toBeUndefined();
    expect(parseShardSpec("")).toBeUndefined();
  });

  test("defaults to SCRIPTC_TEST_SHARD", () => {
    process.env["SCRIPTC_TEST_SHARD"] = "2/3";
    try {
      expect(parseShardSpec()).toEqual({ index: 2, count: 3 });
      expect(shardSuffix()).toBe(", shard 2/3");
    } finally {
      delete process.env["SCRIPTC_TEST_SHARD"];
    }
  });

  test("parses i/n", () => {
    expect(parseShardSpec("2/3")).toEqual({ index: 2, count: 3 });
    expect(parseShardSpec("1/1")).toEqual({ index: 1, count: 1 });
    expect(parseShardSpec("10/12")).toEqual({ index: 10, count: 12 });
  });

  test("throws on malformed and out-of-range specs", () => {
    for (const bad of ["0/3", "4/3", "1/0", "1-3", "a/b", "1/3 ", "-1/3", "1/", "/3"]) {
      expect(() => parseShardSpec(bad), bad).toThrow();
    }
  });
});

describe("shardSelect", () => {
  const keys = Array.from({ length: 1000 }, (_, i) => `program-${i}.ts`);

  test("no spec returns everything unchanged", () => {
    expect(shardSelect(keys, (k) => k, undefined)).toEqual(keys);
    expect(shardSelect(keys, (k) => k, { index: 1, count: 1 })).toEqual(keys);
  });

  test.for([2, 3, 4, 5, 7, 10])("the union of %i shards is every item exactly once", (n) => {
    const union = Array.from({ length: n }, (_, i) =>
      shardSelect(keys, (k) => k, { index: i + 1, count: n }),
    ).flat();
    expect(union.length).toBe(keys.length); // disjoint: no item counted twice
    expect([...union].sort()).toEqual([...keys].sort()); // complete: none dropped
  });

  test.for([3, 5, 6, 10])("the real corpus partitions completely under %i shards", (count) => {
    // The exact list differential.test.ts globs, keyed the same way.
    const files = ["ts", "js", "mjs", "cjs"]
      .flatMap((ext) => [
        ...globSync(join(corpusDir, `*.${ext}`)),
        ...globSync(join(corpusDir, `*/main.${ext}`)),
      ])
      .sort()
      .map((f) => f.slice(corpusDir.length + 1));
    expect(files.length).toBeGreaterThan(0);
    const union = Array.from({ length: count }, (_, i) =>
      shardSelect(files, (k) => k, { index: i + 1, count }),
    ).flat();
    expect(union.length).toBe(files.length);
    expect([...union].sort()).toEqual(files);
  });

  test("assignment is per-key: growing the list never moves an existing item", () => {
    const spec = { index: 2, count: 3 };
    const before = shardSelect(keys.slice(0, 400), (k) => k, spec);
    const after = shardSelect(keys, (k) => k, spec);
    expect(after.slice(0, before.length)).toEqual(before);
  });

  test("shardOf is deterministic and in range", () => {
    for (const k of keys.slice(0, 50)) {
      const s = shardOf(k, 3);
      expect(s).toBe(shardOf(k, 3));
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(3);
    }
  });
});

describe("shardSuffix", () => {
  test("names the shard under a spec, empty otherwise", () => {
    expect(shardSuffix({ index: 2, count: 3 })).toBe(", shard 2/3");
    expect(shardSuffix(undefined)).toBe("");
  });
});

describe("balancedShardSelect", () => {
  const costs: Record<string, number> = fixtureCosts;
  const fixtures = globSync(join(import.meta.dirname, "../fixtures/effect4/*.ts"))
    .filter((file) => !file.endsWith(".d.ts"))
    .map((file) => basename(file))
    .sort();
  const weight = (key: string) => costs[key] ?? 40;

  test.for([2, 3, 5, 8, 10, 12, 16])(
    "the published fixtures partition completely and independently of input order with %i shards",
    (count) => {
      const parts = Array.from({ length: count }, (_, index) =>
        balancedShardSelect(fixtures, (key) => key, weight, { index: index + 1, count }),
      );
      expect(parts.flat().sort()).toEqual(fixtures);
      expect(new Set(parts.flat()).size).toBe(fixtures.length);
      for (let index = 0; index < count; index++) {
        expect(
          balancedShardSelect([...fixtures].reverse(), (key) => key, weight, {
            index: index + 1,
            count,
          }).sort(),
        ).toEqual(parts[index]);
      }
    },
  );

  test("cost balancing reduces the longest recorded Effect 4 slice", () => {
    const keys = Object.keys(costs);
    const total = (slice: string[]) => slice.reduce((sum, key) => sum + weight(key), 0);
    const hashed = Array.from({ length: 10 }, (_, index) =>
      total(shardSelect(keys, (key) => key, { index: index + 1, count: 10 })),
    );
    const balanced = Array.from({ length: 10 }, (_, index) =>
      total(balancedShardSelect(keys, (key) => key, weight, { index: index + 1, count: 10 })),
    );
    expect(Math.max(...balanced)).toBeLessThan(Math.max(...hashed) * 0.8);
  });

  test.for([10, 12, 16])(
    "published Effect 3 fixtures also balance without dropping cases across %i shards",
    (count) => {
      const costs: Record<string, number> = effectCosts;
      const keys = globSync(join(import.meta.dirname, "../fixtures/effect/*.ts"))
        .map((file) => basename(file))
        .sort();
      const weight = (key: string) => costs[key] ?? 120;
      const parts = Array.from({ length: count }, (_, index) =>
        balancedShardSelect(keys, (key) => key, weight, { index: index + 1, count }),
      );
      expect(parts.flat().sort()).toEqual(keys);
      const total = (slice: string[]) => slice.reduce((sum, key) => sum + weight(key), 0);
      const hashed = Array.from({ length: 10 }, (_, index) =>
        total(shardSelect(keys, (key) => key, { index: index + 1, count: 10 })),
      );
      expect(Math.max(...parts.map(total))).toBeLessThan(Math.max(...hashed) * 0.8);
    },
  );

  test("new fixtures remain selected and local runs keep every fixture", () => {
    const keys = [...fixtures, "new-fixture.ts"];
    expect(balancedShardSelect(keys, (key) => key, weight, undefined)).toEqual(keys);
    expect(balancedShardSelect(keys, (key) => key, weight, { index: 1, count: 1 })).toEqual(keys);
    const parts = Array.from({ length: 3 }, (_, index) =>
      balancedShardSelect(keys, (key) => key, weight, { index: index + 1, count: 3 }),
    );
    expect(parts.flat().sort()).toEqual(keys.sort());
  });

  test("ambiguous keys and invalid costs throw instead of dropping fixtures", () => {
    const spec = { index: 1, count: 2 };
    expect(() =>
      balancedShardSelect(
        ["same", "same"],
        (key) => key,
        () => 1,
        spec,
      ),
    ).toThrow(/duplicate/);
    for (const weight of [0, -1, Infinity, NaN]) {
      expect(() =>
        balancedShardSelect(
          ["fixture"],
          (key) => key,
          () => weight,
          spec,
        ),
      ).toThrow(/weight/);
    }
  });
});

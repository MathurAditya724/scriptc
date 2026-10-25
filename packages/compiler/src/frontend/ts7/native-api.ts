import { Ts7Api } from "./api.js";
import { spawnNativeTs7Wire } from "./native-process.js";
import { Ts7RpcClient } from "./rpc-client.js";
import type { Ts7FileSystem } from "./rpc-filesystem.js";

/** The native driver supplies its installed TypeScript executable path.
 * Package discovery is separate from starting and owning a server. */
export function createNativeTs7Api(options: {
  executable: string;
  cwd: string;
  fs: Ts7FileSystem;
  collectTiming?: boolean;
}): Ts7Api {
  const timing = options.collectTiming ?? false;
  return new Ts7Api(
    new Ts7RpcClient(spawnNativeTs7Wire(options.executable, options.cwd, timing)),
    options.fs,
    timing,
  );
}

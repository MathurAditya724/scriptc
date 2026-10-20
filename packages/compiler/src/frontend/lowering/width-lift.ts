import type { IrType } from "../../ir/ir.js";

/** One step of the copy-reshape width relation (widthLiftPlan): how a
 * source-typed value enters a destination slot. Pure data — the plan half;
 * applyWidthLift is the build half. */
export type WidthLift =
  | { how: "copy" }
  | { how: "wrap"; tag: number }
  | { how: "discriminantWrap" }
  | { how: "discriminantRoute" }
  | { how: "retag" }
  | { how: "liftWrap"; tag: number; arm: IrType }
  | { how: "width" }
  | { how: "unionWidth" }
  | { how: "arr" }
  | { how: "tupleArr" }
  | { how: "emptyArr" }
  | { how: "objWidth" }
  | { how: "clsWidth" }
  | { how: "narrow" }
  | { how: "dynIn" }
  | { how: "upcast" }
  | { how: "funcAdapt" };

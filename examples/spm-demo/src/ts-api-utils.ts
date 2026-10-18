import { isCompilerOptionEnabled } from "ts-api-utils";

console.log(isCompilerOptionEnabled({ strict: true }, "strictNullChecks"));
console.log(isCompilerOptionEnabled({ strict: true, noImplicitAny: false }, "noImplicitAny"));

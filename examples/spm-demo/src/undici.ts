import { Headers } from "undici";

const headers = new Headers({ "x-demo": "1" });
console.log(headers.get("x-demo"));

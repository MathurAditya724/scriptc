import { parse } from "@typescript-eslint/typescript-estree";

const ast = parse("let answer: number = 40 + 2;", { range: false });
const decl = ast.body[0];
console.log(ast.type, decl?.type);

import type { AstNode, AstNodeList } from "./ast-node.js";
import { SyntaxKind } from "./enums.js";
import type {
  EndOfFile,
  EntityName,
  Identifier,
  PropertyAccessExpression,
  Statement,
  ThisExpression,
} from "./ast-types.generated.js";

export * from "./ast-types.generated.js";
export type Node = AstNode;
/** A node list. The type is the list class itself, not a structural shape:
 * native code represents a class and a record type differently. */
export type NodeArray<T extends Node> = AstNodeList<T>;
export type Path = string;
export type __String = string;
export interface TextRange {
  pos: number;
  end: number;
}
export interface ReadonlyTextRange {
  readonly pos: number;
  readonly end: number;
}
export interface LineAndCharacter {
  readonly line: number;
  readonly character: number;
}
export interface FileReference extends ReadonlyTextRange {
  readonly fileName: string;
  readonly resolutionMode: number;
  readonly preserve: boolean;
}

/** A source file is the validated root of an AstFile, with the same identity
 * and methods as every other node. Lists carry native array storage only. */
export interface SourceFile extends AstNode {
  readonly kind: SyntaxKind.SourceFile;
  readonly text: string;
  readonly statements: NodeArray<Statement>;
  readonly endOfFileToken: EndOfFile;
}

export interface PropertyAccessEntityNameExpression extends PropertyAccessExpression {
  readonly expression: EntityNameExpression;
  readonly name: Identifier;
}
export type EntityNameExpression = Identifier | PropertyAccessEntityNameExpression;
export type EntityNameOrEntityNameExpression = EntityName | EntityNameExpression;
export interface JsxTagNamePropertyAccess extends PropertyAccessExpression {
  readonly expression: Identifier | ThisExpression | JsxTagNamePropertyAccess;
}

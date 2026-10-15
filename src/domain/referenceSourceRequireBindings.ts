import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  semanticWriteSiteTarget,
  semanticWriteTargets,
  unwrapJavaScriptExpression,
} from "./javascript/javascriptAstValues.js";
import { analyzeParsedJavaScriptReferences } from "./javascript/javascriptSemanticAnalysis.js";
import {
  semanticBindingId,
  semanticScopeId,
} from "./javascript/javascriptSemanticState.js";
import { traverseJavaScriptAst } from "./javascript/javascriptSemanticTraversal.js";
import type { JavaScriptSemanticReference } from "./javascript/javascriptSemanticIr.js";
import {
  isExplicitModuleSourcePath,
  type ParsedJavaScriptSource,
} from "./javascript/javascriptSourceParser.js";

/**
 * Keep calls that resolve either to Node's CommonJS wrapper loader or to a
 * direct ESM `createRequire(import.meta.url)` binding. The shared lexical
 * analyzer supplies binding ownership; this boundary accounts for the two
 * Node loader bindings without evaluating arbitrary values.
 */
export const unshadowedReferenceSourceRequireCalls = (
  file: Pick<ParsedJavaScriptSource, "program">,
  path: string,
): ReadonlySet<t.CallExpression> => {
  const references = new Map(
    analyzeParsedJavaScriptReferences(file).map((reference) => [
      `${reference.location.start.line}:${reference.location.start.column}`,
      reference,
    ]),
  );
  const programRequireBinding = semanticBindingId(
    semanticScopeId("program", file.program),
    "require",
  );
  // Syntax alone cannot establish Node's runtime mode: `.js` depends on its
  // package scope, and `.ts` may be compiled with a CommonJS module target.
  // Keep unmarked paths runtime-unknown and preserve candidate require edges.
  const allowsUnboundRequire = !isExplicitModuleSourcePath(path);
  const hasTopLevelVarRequire =
    allowsUnboundRequire && hasUninitializedTopLevelVarRequire(file.program);
  const createRequireBinding = directCreateRequireBinding(
    file.program,
    references,
  );
  const requireLoaderWasWritten = [...references.values()].some(
    (reference) =>
      reference.name === "require" &&
      reference.role === "write" &&
      (reference.resolution === "unbound" ||
        reference.bindingId === programRequireBinding),
  );
  const isLoaderReference = (identifier: t.Identifier): boolean => {
    const start = identifier.loc?.start;
    const reference =
      start === undefined
        ? undefined
        : references.get(`${start.line}:${start.column}`);
    return (
      (allowsUnboundRequire && reference?.resolution === "unbound") ||
      (reference?.resolution === "resolved" &&
        reference.bindingId === programRequireBinding)
    );
  };
  const loaderMembersIntact = requireLoaderMembersIntact(
    file.program,
    isLoaderReference,
  );
  const calls = new Set<t.CallExpression>();

  traverseJavaScriptAst(file.program, {
    enter: (node, _parent, readAncestors) => {
      if (!t.isCallExpression(node)) return;
      const identifier = requireCalleeIdentifier(node.callee);
      const start = identifier?.loc?.start;
      if (start === undefined) return;
      if (
        readAncestors().some(
          (ancestor) =>
            t.isWithStatement(ancestor) && contains(ancestor.body, node),
        )
      )
        return;
      // `require.resolve` and `require.main` denote Node's members only
      // while no visible write or escape can have replaced them.
      if (!t.isIdentifier(node.callee) && !loaderMembersIntact) return;
      const reference = references.get(`${start.line}:${start.column}`);
      if (
        (allowsUnboundRequire &&
          !requireLoaderWasWritten &&
          reference?.resolution === "unbound") ||
        (((hasTopLevelVarRequire && !requireLoaderWasWritten) ||
          createRequireBinding) &&
          reference?.resolution === "resolved" &&
          reference.bindingId === programRequireBinding)
      )
        calls.add(node);
    },
  });
  return calls;
};

/**
 * Whether the loader's `resolve` and `main` members keep Node's identity. A
 * write to either member or to a computed member, or `require` used as a
 * value other than a call or member read (where a mutator or alias can
 * replace members), leaves that identity unknown.
 */
const requireLoaderMembersIntact = (
  program: t.Program,
  isLoaderReference: (identifier: t.Identifier) => boolean,
): boolean => {
  let intact = true;
  const isLoaderMemberTarget = (target: t.Node): boolean => {
    if (!t.isMemberExpression(target) && !t.isOptionalMemberExpression(target))
      return false;
    const object = unwrapJavaScriptExpression(target.object).node;
    if (!t.isIdentifier(object, { name: "require" })) return false;
    if (!isLoaderReference(object)) return false;
    const key = semanticStaticPropertyKey(target.property, target.computed);
    return key === null || key === "resolve" || key === "main";
  };
  traverseJavaScriptAst(program, {
    enter: (node, parent, readAncestors) => {
      if (!intact) return;
      const site = semanticWriteSiteTarget(node);
      if (site !== null) {
        for (const target of semanticWriteTargets(site))
          if (isLoaderMemberTarget(target)) intact = false;
        return;
      }
      if (
        !t.isIdentifier(node, { name: "require" }) ||
        parent === null ||
        !isLoaderReference(node)
      )
        return;
      // Inert parentheses and TypeScript wrappers do not change how the
      // loader value is used.
      let used: t.Node = node;
      let user: t.Node | undefined = parent;
      const read = readAncestors();
      const ancestors = read.at(-1) === parent ? read : [...read, parent];
      for (let index = ancestors.length - 1; index >= 0; index -= 1) {
        user = ancestors[index];
        if (
          user === undefined ||
          unwrapJavaScriptExpression(user).node !== node
        )
          break;
        used = user;
      }
      const usedAsLoader =
        ((t.isCallExpression(user) || t.isOptionalCallExpression(user)) &&
          user.callee === used) ||
        ((t.isMemberExpression(user) || t.isOptionalMemberExpression(user)) &&
          user.object === used) ||
        t.isUnaryExpression(user, { operator: "typeof" });
      if (!usedAsLoader) intact = false;
    },
  });
  return intact;
};

const contains = (container: t.Node, node: t.Node): boolean =>
  typeof container.start === "number" &&
  typeof container.end === "number" &&
  typeof node.start === "number" &&
  typeof node.end === "number" &&
  container.start <= node.start &&
  node.end <= container.end;

const hasUninitializedTopLevelVarRequire = (program: t.Program): boolean => {
  let found = false;
  let initialized = false;
  traverseJavaScriptAst(program, {
    enter: (node, _parent, readAncestors) => {
      if (!t.isVariableDeclaration(node, { kind: "var" })) return;
      if (
        readAncestors().some(
          (ancestor) => t.isFunction(ancestor) || t.isStaticBlock(ancestor),
        )
      )
        return;
      for (const declaration of node.declarations) {
        if (!Object.hasOwn(t.getBindingIdentifiers(declaration.id), "require"))
          continue;
        found = true;
        initialized ||= declaration.init !== null;
      }
    },
  });
  return found && !initialized;
};

const directCreateRequireBinding = (
  program: t.Program,
  references: ReadonlyMap<string, JavaScriptSemanticReference>,
): boolean => {
  const programScope = semanticScopeId("program", program);
  const importedNames = new Set<string>();
  for (const declaration of program.body) {
    if (
      !t.isImportDeclaration(declaration) ||
      (declaration.source.value !== "node:module" &&
        declaration.source.value !== "module")
    )
      continue;
    for (const specifier of declaration.specifiers) {
      if (
        t.isImportSpecifier(specifier) &&
        t.isIdentifier(specifier.imported, { name: "createRequire" })
      )
        importedNames.add(specifier.local.name);
    }
  }

  return program.body.some(
    (statement) =>
      t.isVariableDeclaration(statement, { kind: "const" }) &&
      statement.declarations.some((declaration) => {
        if (
          !t.isIdentifier(declaration.id, { name: "require" }) ||
          !t.isCallExpression(declaration.init) ||
          !t.isIdentifier(declaration.init.callee) ||
          !importedNames.has(declaration.init.callee.name) ||
          !isImportMetaUrl(declaration.init.arguments[0])
        )
          return false;
        const start = declaration.init.callee.loc?.start;
        if (start === undefined) return false;
        const reference = references.get(`${start.line}:${start.column}`);
        return (
          reference?.resolution === "resolved" &&
          reference.bindingId ===
            semanticBindingId(programScope, declaration.init.callee.name)
        );
      }),
  );
};

const isImportMetaUrl = (node: t.Node | undefined): boolean =>
  t.isMemberExpression(node) &&
  !node.computed &&
  t.isIdentifier(node.property, { name: "url" }) &&
  t.isMetaProperty(node.object) &&
  t.isIdentifier(node.object.meta, { name: "import" }) &&
  t.isIdentifier(node.object.property, { name: "meta" });

const requireCalleeIdentifier = (
  callee: t.Node | null | undefined,
): t.Identifier | undefined => {
  if (t.isIdentifier(callee, { name: "require" })) return callee;
  if (
    !t.isMemberExpression(callee) ||
    !t.isIdentifier(callee.object, { name: "require" }) ||
    ((!t.isIdentifier(callee.property) || callee.computed) &&
      !t.isStringLiteral(callee.property))
  )
    return undefined;
  const propertyName = t.isIdentifier(callee.property)
    ? callee.property.name
    : t.isStringLiteral(callee.property)
      ? callee.property.value
      : undefined;
  return propertyName === "resolve" || propertyName === "main"
    ? callee.object
    : undefined;
};

import { numberValue, recordValue } from "./CdpCaptureValues.js";
import {
  cdpSnapshotAttributesResolve,
  cdpSnapshotString,
  cdpSnapshotValueString,
} from "./CdpSnapshotStrings.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

interface DomSnapshotNodes {
  readonly nodeTypes: readonly (number | undefined)[];
  readonly nodeNames: readonly (number | undefined)[];
  readonly parents: readonly (number | undefined)[];
  readonly strings: readonly (string | undefined)[];
  readonly attributes: readonly unknown[];
}

interface XmlSvgLink {
  readonly svgElement: boolean;
  readonly xlinkHref: string | undefined;
}

interface DocumentSvgAncestry {
  readonly xml: boolean | undefined;
  readonly xmlLinks: Map<number, XmlSvgLink>;
}

export interface DomSvgNodeQuery {
  readonly backendNodeId: number;
  readonly nodeName: string;
}

/** Bind the browser's SVG flag to the exact snapshotted element. */
export const capturedSvgNodeKind = (
  query: DomSvgNodeQuery,
  result: unknown,
): boolean | undefined => {
  const node = recordValue(recordValue(result)?.node);
  if (
    node?.backendNodeId !== query.backendNodeId ||
    node.nodeName !== query.nodeName ||
    node.nodeType !== 1
  )
    return undefined;
  // CDP omits isSVG for non-SVG nodes. Other values are malformed, not false.
  return node.isSVG === undefined
    ? false
    : typeof node.isSVG === "boolean"
      ? node.isSVG
      : undefined;
};

interface DomSvgLink {
  readonly svgElement: boolean;
  readonly xmlDocument: boolean | undefined;
  readonly xlinkHref: string | undefined;
}

const numberArray = (value: unknown): readonly (number | undefined)[] =>
  Array.isArray(value)
    ? value.map((item) => {
        const number = numberValue(item);
        return number !== undefined && Number.isSafeInteger(number)
          ? number
          : undefined;
      })
    : [];

// DOMSnapshot has no namespace URI. HTML documents use uppercase `HTML` and
// the parser's local names. XML documents preserve prefixed names and xmlns
// declarations, including those on standalone SVG roots.
const xmlDocument = (nodes: DomSnapshotNodes): boolean | undefined => {
  const documentIndex = nodes.nodeTypes.findIndex((nodeType) => nodeType === 9);
  if (documentIndex < 0) return false;
  if (
    !validSvgSourceNode(nodes, documentIndex) ||
    nodes.parents[documentIndex] !== -1
  )
    return undefined;
  for (let index = 0; index < nodes.nodeTypes.length; index += 1) {
    if (nodes.nodeTypes[index] !== 1) continue;
    if (nodes.parents[index] !== documentIndex) continue;
    const name = cdpSnapshotString(nodes.strings, nodes.nodeNames[index]);
    if (name === undefined || !validSvgSourceNode(nodes, index))
      return undefined;
    if (name === "HTML") return false;
    if (name === "html" || name.includes(":")) return true;
    // Explicit namespaces also identify standalone SVG and other XML roots.
    // Namespace-free synthetic snapshots retain the legacy HTML behavior.
    const attributes = numberArray(nodes.attributes[index]);
    for (let offset = 0; offset + 1 < attributes.length; offset += 2) {
      const value = attributes[offset];
      const attributeName = cdpSnapshotString(nodes.strings, value);
      if (attributeName === undefined) return undefined;
      if (xmlnsPrefix(attributeName) !== undefined) return true;
    }
    return false;
  }
  return false;
};

export const createDocumentSvgAncestry = (
  nodes: DomSnapshotNodes,
): DocumentSvgAncestry => {
  const xml = xmlDocument(nodes);
  return {
    xml,
    xmlLinks: xml === true ? resolveXmlElements(nodes) : new Map(),
  };
};

export const domSvgLink = (
  ancestry: DocumentSvgAncestry,
  index: number,
): DomSvgLink => {
  if (ancestry.xml === false) {
    return {
      svgElement: false,
      xmlDocument: false,
      xlinkHref: undefined,
    };
  }
  if (ancestry.xml === undefined) {
    return {
      svgElement: false,
      xmlDocument: undefined,
      xlinkHref: undefined,
    };
  }
  const resolved = ancestry.xmlLinks.get(index);
  if (resolved === undefined) {
    return {
      svgElement: false,
      xmlDocument: undefined,
      xlinkHref: undefined,
    };
  }
  return {
    svgElement: resolved.svgElement,
    xmlDocument: true,
    xlinkHref: resolved.xlinkHref,
  };
};

interface NamespaceRestore {
  readonly prefix: string;
  readonly previous: string | undefined;
}

type XmlWalkStep =
  | { readonly node: number }
  | { readonly restore: readonly NamespaceRestore[] };

// Walk parent-before-child with one mutable namespace environment. Restore
// declarations on exit so siblings retain their own scope. Only declarations
// on the active path are retained, rather than cumulative maps at every node.
const resolveXmlElements = (
  nodes: DomSnapshotNodes,
): Map<number, XmlSvgLink> => {
  const children = new Map<number, number[]>();
  const pending: XmlWalkStep[] = [];
  for (let node = 0; node < nodes.nodeNames.length; node += 1) {
    const parent = nodes.parents[node];
    if (parent === undefined || parent < -1 || parent >= nodes.nodeNames.length)
      continue;
    if (parent < 0) pending.push({ node });
    else if (parent < nodes.nodeNames.length && parent !== node) {
      const siblings = children.get(parent);
      if (siblings === undefined) children.set(parent, [node]);
      else siblings.push(node);
    }
  }
  const bindings = new Map<string, string>();
  const resolved = new Map<number, XmlSvgLink>();
  while (pending.length > 0) {
    const step = pending.pop();
    if (step === undefined) break;
    if ("restore" in step) {
      for (const { prefix, previous } of step.restore) {
        if (previous === undefined) bindings.delete(prefix);
        else bindings.set(prefix, previous);
      }
      continue;
    }
    const { node } = step;
    if (!validSvgSourceNode(nodes, node)) continue;
    const attributes = numberArray(nodes.attributes[node]);
    const restore = applyDeclarations(bindings, attributes, nodes.strings);
    const svgElement =
      nodes.nodeTypes[node] === 1 &&
      elementNamespace(
        cdpSnapshotString(nodes.strings, nodes.nodeNames[node]),
        bindings,
      ) === SVG_NAMESPACE;
    resolved.set(node, {
      svgElement,
      xlinkHref: svgElement
        ? xlinkHrefValue(attributes, nodes.strings, bindings)
        : undefined,
    });
    pending.push({ restore });
    for (const child of children.get(node) ?? []) pending.push({ node: child });
  }
  // Cycles (including self-parents) and dangling chains cannot reach a root,
  // so remain unresolved instead of deriving URLs from an invalid ancestry.
  return resolved;
};

const applyDeclarations = (
  bindings: Map<string, string>,
  attributes: readonly (number | undefined)[],
  strings: readonly (string | undefined)[],
): readonly NamespaceRestore[] => {
  const restore: NamespaceRestore[] = [];
  const seen = new Set<string>();
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    const nameIndex = attributes[index];
    const valueIndex = attributes[index + 1];
    if (nameIndex === undefined || valueIndex === undefined) continue;
    const name = cdpSnapshotString(strings, nameIndex);
    const value = cdpSnapshotValueString(strings, valueIndex);
    if (name === undefined || value === undefined) continue;
    const prefix = xmlnsPrefix(name);
    if (prefix === undefined || seen.has(prefix)) continue;
    seen.add(prefix);
    restore.push({ prefix, previous: bindings.get(prefix) });
    if (value.length === 0) bindings.delete(prefix);
    else bindings.set(prefix, value);
  }
  return restore;
};

const xmlnsPrefix = (name: string | undefined): string | undefined => {
  if (name === undefined) return undefined;
  if (name === "xmlns") return "";
  if (!name.startsWith("xmlns:")) return undefined;
  const prefix = name.slice("xmlns:".length);
  if (prefix.length === 0 || prefix === "xmlns" || prefix.includes(":"))
    return undefined;
  return prefix;
};

const elementNamespace = (
  nodeName: string | undefined,
  bindings: ReadonlyMap<string, string>,
): string => {
  if (nodeName === undefined) return "";
  const colon = nodeName.indexOf(":");
  if (colon < 0) return bindings.get("") ?? "";
  const prefix = nodeName.slice(0, colon);
  const local = nodeName.slice(colon + 1);
  if (
    prefix.length === 0 ||
    local.length === 0 ||
    local.includes(":") ||
    prefix === "xmlns"
  )
    return "";
  return bindings.get(prefix) ?? "";
};

// First prefixed href bound to the XLink namespace. Duplicate names keep the
// earlier value. Plain href is applied by the caller and wins even when empty.
const xlinkHrefValue = (
  attributes: readonly (number | undefined)[],
  strings: readonly (string | undefined)[],
  bindings: ReadonlyMap<string, string>,
): string | undefined => {
  const seen = new Set<string>();
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    const nameIndex = attributes[index];
    const valueIndex = attributes[index + 1];
    if (nameIndex === undefined || valueIndex === undefined) continue;
    const name = cdpSnapshotString(strings, nameIndex);
    if (name === undefined) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const colon = name.indexOf(":");
    if (colon <= 0) continue;
    const prefix = name.slice(0, colon);
    const local = name.slice(colon + 1);
    if (local !== "href" || bindings.get(prefix) !== XLINK_NAMESPACE) continue;
    return cdpSnapshotValueString(strings, valueIndex);
  }
  return undefined;
};

const validSvgSourceNode = (
  nodes: DomSnapshotNodes,
  index: number,
): boolean => {
  if (
    nodes.nodeTypes[index] === undefined ||
    cdpSnapshotString(nodes.strings, nodes.nodeNames[index]) === undefined
  )
    return false;
  const rawAttributes = nodes.attributes[index];
  if (!Array.isArray(rawAttributes)) return false;
  const attributes = numberArray(rawAttributes);
  return (
    attributes.length === rawAttributes.length &&
    cdpSnapshotAttributesResolve(nodes.strings, attributes)
  );
};

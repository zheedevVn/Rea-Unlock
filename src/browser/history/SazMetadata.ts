import { DOMParser, ParseError, type Node } from "@xmldom/xmldom";
import { SaxesParser } from "saxes";
import type { JsonValue } from "../../domain/jsonValue.js";
import { WEB_NETWORK_CAPTURE_LIMITS } from "../../domain/webNetworkCapture.js";
import {
  decodeXmlPlistText,
  XmlPlistTextDecodeError,
} from "../../domain/propertyListXmlText.js";
import { CaptureFormatError } from "./CaptureFormatError.js";

/** Preserve XML node order, attribute names and text without interpreting producer-specific flags. */
export const decodeSazMetadata = (bytes: Buffer): JsonValue => {
  let xml: string;
  try {
    xml = decodeXmlPlistText(bytes);
  } catch (cause: unknown) {
    if (
      cause instanceof XmlPlistTextDecodeError &&
      cause.reason === "unsupported-encoding"
    )
      throw new CaptureFormatError(
        "unsupported",
        `SAZ metadata declares unsupported XML encoding ${cause.declaredEncoding}.`,
        "",
        cause,
      );
    if (
      cause instanceof XmlPlistTextDecodeError &&
      cause.reason === "encoding-mismatch"
    )
      throw new CaptureFormatError(
        "format",
        "SAZ metadata encoding declaration disagrees with its bytes.",
        "",
        cause,
      );
    throw new CaptureFormatError(
      "unsupported",
      "SAZ metadata must use UTF-8 or BOM-marked UTF-16.",
      "",
      cause,
    );
  }
  validateSazXml(xml);
  let parseFailed = false;
  let document: ReturnType<DOMParser["parseFromString"]>;
  try {
    document = new DOMParser({
      normalizeLineEndings: (source) => source,
      onError: (level, message) => {
        // The parser warns whenever the source contains U+FFFD. It is a legal
        // XML Char, and the fatal decoder above already rejected invalid
        // source bytes, so only that warning is not a well-formedness failure.
        if (
          level === "warning" &&
          message.startsWith("Unicode replacement character detected")
        )
          return;
        parseFailed = true;
      },
    }).parseFromString(xml, "application/xml");
  } catch (cause: unknown) {
    if (!(cause instanceof ParseError)) throw cause;
    throw new CaptureFormatError(
      "format",
      "SAZ metadata is not well-formed XML.",
    );
  }
  if (parseFailed)
    throw new CaptureFormatError(
      "format",
      "SAZ metadata is not well-formed XML.",
    );
  if (document.documentElement?.tagName !== "Session")
    throw new CaptureFormatError(
      "format",
      "SAZ metadata must have a Session document element.",
    );
  const visit = (node: Node, depth: number): JsonValue => {
    if (depth > WEB_NETWORK_CAPTURE_LIMITS.depth)
      throw new CaptureFormatError(
        "input-limit",
        "SAZ metadata exceeds the complete-evidence nesting budget.",
      );
    const children: JsonValue[] = [];
    for (let child = node.firstChild; child !== null; child = child.nextSibling)
      children.push(visit(child, depth + 1));
    const attributes: JsonValue[] = [];
    if (node.nodeType === 1) {
      const element = node as import("@xmldom/xmldom").Element;
      for (let i = 0; i < element.attributes.length; i++) {
        const attribute = element.attributes.item(i);
        if (attribute !== null)
          attributes.push({ name: attribute.name, value: attribute.value });
      }
    }
    return {
      name: node.nodeName,
      type: node.nodeType,
      value: node.nodeValue,
      attributes,
      children,
    };
  };
  return visit(document, 0);
};

/** Validate well-formedness before the DOM parser projects retained evidence. */
const validateSazXml = (xml: string): void => {
  const parser = new SaxesParser({
    defaultXMLVersion: "1.0",
    forceXMLVersion: true,
  });
  let hasDoctype = false;
  parser.on("doctype", () => {
    hasDoctype = true;
  });
  try {
    parser.write(xml).close();
  } catch {
    if (hasDoctype)
      throw new CaptureFormatError(
        "unsupported",
        "SAZ metadata DTDs are unsupported.",
      );
    throw new CaptureFormatError(
      "format",
      "SAZ metadata is not well-formed XML.",
    );
  }
  if (hasDoctype)
    throw new CaptureFormatError(
      "unsupported",
      "SAZ metadata DTDs are unsupported.",
    );
};

import type { ProxyPlugin, PluginContext } from "../types.ts";

function encodePrimitive(value: any): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    // Strings with commas, colons, newlines, or leading/trailing spaces need escaping
    if (/[,:"\n]/.test(value) || value !== value.trim()) {
      return JSON.stringify(value);
    }
    return value;
  }
  return String(value);
}

function isUniformFlatObjectArray(arr: any[]): boolean {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  if (!arr.every((v) => typeof v === "object" && v !== null && !Array.isArray(v))) return false;

  const firstKeys = Object.keys(arr[0]).sort();
  return arr.every((obj) => {
    const keys = Object.keys(obj).sort();
    if (keys.join(",") !== firstKeys.join(",")) return false;
    // All values must be primitives
    return Object.values(obj).every((val) => typeof val !== "object" || val === null);
  });
}

function encodeValueInObject(key: string, value: any, indent: number = 0): string[] {
  const nextIndentStr = " ".repeat(indent + 2);

  // Handle arrays
  if (Array.isArray(value)) {
    // Primitive array
    if (value.every((v) => typeof v !== "object" || v === null)) {
      const items = value.map(encodePrimitive).join(",");
      return [`${key}[${value.length}]: ${items}`];
    }

    // Check for uniform flat objects
    if (isUniformFlatObjectArray(value)) {
      const firstKeys = Object.keys(value[0]).sort();
      const lines = [`${key}[${value.length}]{${firstKeys.join(",")}}:`];
      for (const obj of value) {
        const row = firstKeys.map((k) => encodePrimitive(obj[k])).join(",");
        lines.push(nextIndentStr + row);
      }
      return lines;
    }

    // Non-uniform array of objects/mixed
    const lines = [`${key}[${value.length}]:`];
    for (const item of value) {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        // Nested object - render inline as nested block
        const encoded = encodeObject(item, indent + 2);
        const objLines = encoded.split("\n");
        lines.push(nextIndentStr + "- " + objLines[0]);
        for (let i = 1; i < objLines.length; i++) {
          lines.push(nextIndentStr + objLines[i]);
        }
      } else {
        lines.push(nextIndentStr + "- " + encodePrimitive(item));
      }
    }
    return lines;
  }

  // Handle nested objects
  if (typeof value === "object" && value !== null) {
    const lines = [`${key}:`];
    const encoded = encodeObject(value, indent + 2);
    const objLines = encoded.split("\n");
    for (const line of objLines) {
      lines.push(" ".repeat(indent + 2) + line);
    }
    return lines;
  }

  // Handle primitives
  return [`${key}: ${encodePrimitive(value)}`];
}

function encodeObject(obj: any, indent: number = 0): string {
  const indentStr = " ".repeat(indent);
  const lines: string[] = [];

  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    const encoded = encodeValueInObject(key, v, indent);
    lines.push(...encoded.map((line, i) => (i === 0 ? indentStr + line : line)));
  }

  return lines.join("\n");
}

export function encodeToon(value: unknown, indent?: number): string {
  const ind = indent ?? 0;

  // Handle non-objects at top level
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    // Primitives
    if (typeof value !== "object") {
      return encodePrimitive(value);
    }

    // Top-level arrays
    if (Array.isArray(value)) {
      // Primitive array
      if (value.every((v) => typeof v !== "object" || v === null)) {
        const items = value.map(encodePrimitive).join(",");
        return `[${value.length}]: ${items}`;
      }

      // Uniform object array
      if (isUniformFlatObjectArray(value)) {
        const firstKeys = Object.keys(value[0]).sort();
        const lines = [`[${value.length}]{${firstKeys.join(",")}}:`];
        const nextIndentStr = " ".repeat(ind + 2);
        for (const obj of value) {
          const row = firstKeys.map((k) => encodePrimitive(obj[k])).join(",");
          lines.push(nextIndentStr + row);
        }
        return lines.join("\n");
      }

      // Non-uniform array
      const lines = [`[${value.length}]:`];
      const nextIndentStr = " ".repeat(ind + 2);
      for (const item of value) {
        if (typeof item === "object" && item !== null && !Array.isArray(item)) {
          const encoded = encodeObject(item, ind + 2);
          const objLines = encoded.split("\n");
          lines.push(nextIndentStr + "- " + objLines[0]);
          for (let i = 1; i < objLines.length; i++) {
            lines.push(nextIndentStr + objLines[i]);
          }
        } else {
          lines.push(nextIndentStr + "- " + encodePrimitive(item));
        }
      }
      return lines.join("\n");
    }
  }

  // Top-level object
  return encodeObject(value, ind);
}

function replaceToonBlocks(text: string, minJsonChars: number): string {
  const jsonBlockRegex = /```json\n([\s\S]*?)\n```/g;
  return text.replace(jsonBlockRegex, (match, jsonContent) => {
    if (jsonContent.length < minJsonChars) {
      return match;
    }

    try {
      const parsed = JSON.parse(jsonContent);
      const toon = encodeToon(parsed);
      return `\`\`\`toon\n${toon}\n\`\`\``;
    } catch {
      // On parse failure, leave as-is
      return match;
    }
  });
}

export function toonPlugin(options?: { minJsonChars?: number }): ProxyPlugin {
  const minJsonChars = options?.minJsonChars ?? 300;

  return {
    name: "toon",
    onRequest(body: any, ctx: PluginContext): any {
      if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
        return body;
      }

      // Shallow clone body and messages
      const newBody = { ...body };
      let modified = false;

      const newMessages = body.messages.map((msg: any) => {
        if (!msg) return msg;

        let msgModified = false;

        // Handle string content
        if (typeof msg.content === "string") {
          const newContent = replaceToonBlocks(msg.content, minJsonChars);
          if (newContent !== msg.content) {
            msgModified = true;
            modified = true;
          }
          if (msgModified) {
            return { ...msg, content: newContent };
          }
        }

        // Handle array content (content blocks)
        if (Array.isArray(msg.content)) {
          let contentModified = false;
          const newContent = msg.content.map((block: any) => {
            if (
              block &&
              typeof block === "object" &&
              block.type === "text" &&
              typeof block.text === "string"
            ) {
              const newText = replaceToonBlocks(block.text, minJsonChars);
              if (newText !== block.text) {
                contentModified = true;
                modified = true;
                return { ...block, text: newText };
              }
            }
            return block;
          });
          if (contentModified) {
            return { ...msg, content: newContent };
          }
        }

        return msg;
      });

      if (modified) {
        newBody.messages = newMessages;
      }

      return newBody;
    },
  };
}

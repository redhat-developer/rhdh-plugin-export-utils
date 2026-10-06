/**
 * Zero-dependency Yarn Berry lockfile (SYML) parser and serializer.
 *
 * Designed for round-trip fidelity: parse → serialize produces output
 * identical to the input for unmodified content. Field and entry ordering
 * is preserved via JavaScript object insertion-order guarantees (ES2015+).
 *
 * Used by `generate-manifests` (read-only extraction), `protocol-resolution`
 * (block replacement, descriptor enrichment, value rewriting), `package-cleanup`
 * (block removal), and `validate` (structural comparison).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Lockfile = {
  preamble: string;
  blocks: LockfileBlock[];
};

export type LockfileBlock = {
  descriptors: string[];
  fields: { [name: string]: LockfileField };
};

export type LockfileField = ScalarField | MapField | NestedMapField;

export type ScalarField = { kind: "scalar"; raw: string };
export type MapField = { kind: "map"; entries: { [key: string]: string } };
export type NestedMapField = {
  kind: "nested-map";
  entries: { [key: string]: { [prop: string]: string } };
};

// ---------------------------------------------------------------------------
// String-based matchers — no regex captures, no `string | undefined`
//
// Each function uses indexOf + substring + trimStart/trim to parse SYML
// field lines. All return types are fully narrowed (`string`, not
// `string | undefined`), so no v8-ignore guards are needed.
// ---------------------------------------------------------------------------

/**
 * Match a 2-space scalar field: `  name: value`
 * Equivalent to `/^  ([^:]+):\s+(.+)$/`
 * Name cannot contain colons → first colon is the separator.
 */
function matchScalar(line: string): { name: string; raw: string } | null {
  const colonPos = line.indexOf(":", 2);
  if (colonPos === -1) return null;
  const name = line.substring(2, colonPos);
  if (name.length === 0) return null;
  const rest = line.substring(colonPos + 1);
  const raw = rest.trimStart();
  if (raw.length === 0 || rest.length === raw.length) return null;
  return { name, raw };
}

/**
 * Match a 2-space section header: `  name:` (with optional trailing whitespace)
 * Equivalent to `/^  ([^:]+):\s*$/`
 * Name cannot contain colons → first colon is the separator.
 */
function matchSectionHeader(line: string): string | null {
  const colonPos = line.indexOf(":", 2);
  if (colonPos === -1) return null;
  const name = line.substring(2, colonPos);
  if (name.length === 0) return null;
  const rest = line.substring(colonPos + 1);
  if (rest.trim().length !== 0) return null;
  return name;
}

/**
 * Match a 4-space map entry: `    key: value`
 * Equivalent to `/^\s{4}(.+?):\s+(.+)$/`
 * Key may contain colons (non-greedy) → try each colon left-to-right.
 */
function matchMapEntry(line: string): [key: string, value: string] | null {
  let colonPos = line.indexOf(":", 4);
  while (colonPos !== -1) {
    const rest = line.substring(colonPos + 1);
    const value = rest.trimStart();
    if (rest.length !== value.length && value.length > 0) {
      const key = line.substring(4, colonPos);
      if (key.length > 0) return [key, value];
    }
    colonPos = line.indexOf(":", colonPos + 1);
  }
  return null;
}

/**
 * Match a 4-space nested-map key header: `    key:` (with optional trailing ws)
 * Equivalent to `/^\s{4}(.+?):\s*$/`
 * Key may contain colons → try each colon left-to-right.
 */
function matchNestedKey(line: string): string | null {
  let colonPos = line.indexOf(":", 4);
  while (colonPos !== -1) {
    const rest = line.substring(colonPos + 1);
    if (rest.trim().length === 0) {
      const key = line.substring(4, colonPos);
      if (key.length > 0) return key;
    }
    colonPos = line.indexOf(":", colonPos + 1);
  }
  return null;
}

/**
 * Match a 6-space nested-map property: `      prop: value`
 * Equivalent to `/^\s{6}(.+?):\s+(.+)$/`
 * Prop may contain colons → try each colon left-to-right.
 */
function matchNestedProp(line: string): [prop: string, value: string] | null {
  let colonPos = line.indexOf(":", 6);
  while (colonPos !== -1) {
    const rest = line.substring(colonPos + 1);
    const value = rest.trimStart();
    if (rest.length !== value.length && value.length > 0) {
      const prop = line.substring(6, colonPos);
      if (prop.length > 0) return [prop, value];
    }
    colonPos = line.indexOf(":", colonPos + 1);
  }
  return null;
}

/**
 * Detect whether a 4-space line is a nested-map key header (e.g. `    react:`)
 * rather than a flat map entry (e.g. `    react: "npm:^18"`).
 * Equivalent to `/^\s{4}\S.*:\s*$/` — 4-space indent, non-space start, colon
 * at end with optional trailing whitespace.
 */
function isNestedMapHeader(line: string): boolean {
  if (!line.startsWith("    ") || line.charAt(4) === " ") return false;
  const colonPos = line.indexOf(":", 4);
  if (colonPos === -1) return false;
  return line.substring(colonPos + 1).trim().length === 0;
}

// ---------------------------------------------------------------------------
// Structured grouping types — typed fields instead of raw string[]
// ---------------------------------------------------------------------------

type BlockGroup = { descriptor: string; body: string[] };
type FieldGroup = { header: string; subLines: string[] };

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseLockfile(content: string): Lockfile {
  const lines = content.split("\n");

  const preambleEnd = findPreambleEnd(lines);
  const preamble = lines.slice(0, preambleEnd).join("\n");

  const blockLines = lines.slice(preambleEnd);
  const blocks = splitIntoBlockGroups(blockLines).map(parseBlockGroup);

  return { preamble, blocks };
}

/**
 * Find where the preamble ends (comment lines, blank lines, __metadata block).
 * Returns the index of the first non-preamble line.
 */
function findPreambleEnd(lines: string[]): number {
  let i = 0;
  for (const line of lines) {
    if (line.startsWith("#") || line === "") {
      i++;
    } else if (line.startsWith("__metadata:")) {
      i++; // the __metadata: line itself
      for (const metaLine of lines.slice(i)) {
        if (!metaLine.startsWith("  ")) break;
        i++;
      }
      break;
    } else {
      break;
    }
  }
  return i;
}

/**
 * Split lines into block groups, where each group starts with a descriptor
 * line (starts at column 0, ends with ":") and includes all following
 * indented (2+-space) body lines. Blank lines and 0-space non-descriptor
 * lines stop body collection — matching the original parser's strict
 * block-termination behavior.
 */
function splitIntoBlockGroups(lines: string[]): BlockGroup[] {
  const groups: BlockGroup[] = [];
  let current: BlockGroup | null = null;
  for (const line of lines) {
    if (!line.startsWith(" ") && !line.startsWith("#") && line.endsWith(":")) {
      current = { descriptor: line, body: [] };
      groups.push(current);
    } else if (current !== null && line.startsWith("  ")) {
      current.body.push(line);
    } else {
      current = null;
    }
  }
  return groups;
}

function parseBlockGroup(group: BlockGroup): LockfileBlock {
  const descriptors = parseDescriptors(group.descriptor.slice(0, -1));
  const fields = parseFields(group.body);
  return { descriptors, fields };
}

function parseDescriptors(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).split(", ");
  }
  return [trimmed];
}

/**
 * Group body lines by top-level field (2-space indent), then parse each
 * group into a LockfileField.
 */
function parseFields(bodyLines: string[]): { [name: string]: LockfileField } {
  const fields: { [name: string]: LockfileField } = {};

  for (const { header, subLines } of groupByField(bodyLines)) {
    const scalar = matchScalar(header);
    if (scalar) {
      fields[scalar.name] = { kind: "scalar", raw: scalar.raw };
      continue;
    }

    const sectionName = matchSectionHeader(header);
    if (sectionName && subLines.length > 0) {
      const isNested = subLines.some((l) => l.startsWith("      ") || isNestedMapHeader(l));
      if (isNested) {
        fields[sectionName] = parseNestedMapLines(subLines);
      } else {
        fields[sectionName] = parseMapLines(subLines);
      }
      continue;
    }
    if (sectionName) continue; // valid section header with no sub-content
    break; // unrecognized line — stop parsing (matches original behavior)
  }

  return fields;
}

/**
 * Group body lines so that each 2-space line starts a new group, and
 * deeper-indented lines (4+) are appended to the current group.
 * Returns structured objects with typed fields.
 */
function groupByField(lines: string[]): FieldGroup[] {
  const groups: FieldGroup[] = [];
  let current: FieldGroup | null = null;
  for (const line of lines) {
    if (line.startsWith("  ") && !line.startsWith("    ")) {
      current = { header: line, subLines: [] };
      groups.push(current);
    } else if (current !== null) {
      current.subLines.push(line);
    }
  }
  return groups;
}

function parseMapLines(lines: string[]): MapField {
  const entries: { [key: string]: string } = {};
  for (const line of lines) {
    const kv = matchMapEntry(line);
    if (kv) {
      entries[kv[0]] = kv[1];
    }
  }
  return { kind: "map", entries };
}

function parseNestedMapLines(lines: string[]): NestedMapField {
  const entries: { [key: string]: { [prop: string]: string } } = {};
  let currentEntry: { [prop: string]: string } | null = null;

  for (const line of lines) {
    if (line.startsWith("      ")) {
      if (currentEntry) {
        const pv = matchNestedProp(line);
        if (pv) {
          currentEntry[pv[0]] = pv[1];
        }
      }
      continue;
    }

    const key = matchNestedKey(line);
    if (key) {
      currentEntry = {};
      entries[key] = currentEntry;
    }
  }

  return { kind: "nested-map", entries };
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

export function serializeLockfile(lockfile: Lockfile): string {
  const parts: string[] = [];

  if (lockfile.preamble) {
    parts.push(lockfile.preamble);
  }

  for (const block of lockfile.blocks) {
    parts.push("", serializeBlock(block));
  }

  return parts.join("\n") + "\n";
}

export function serializeBlock(block: LockfileBlock): string {
  const descriptorLine = `"${block.descriptors.join(", ")}":`;
  const lines = [descriptorLine];

  for (const [name, field] of Object.entries(block.fields)) {
    switch (field.kind) {
      case "scalar":
        lines.push(`  ${name}: ${field.raw}`);
        break;
      case "map":
        lines.push(`  ${name}:`);
        for (const [key, value] of Object.entries(field.entries)) {
          lines.push(`    ${key}: ${value}`);
        }
        break;
      case "nested-map":
        lines.push(`  ${name}:`);
        for (const [key, props] of Object.entries(field.entries)) {
          lines.push(`    ${key}:`);
          for (const [prop, value] of Object.entries(props)) {
            lines.push(`      ${prop}: ${value}`);
          }
        }
        break;
      /* v8 ignore next 4 -- exhaustive switch; compile-time guarantee */
      default: {
        const exhaustiveCheck: never = field;
        return exhaustiveCheck;
      }
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Convenience accessors
// ---------------------------------------------------------------------------

export function getScalar(block: LockfileBlock, fieldName: string): string | undefined {
  const field = block.fields[fieldName];
  if (field?.kind !== "scalar") return undefined;
  return field.raw.replace(/^"|"$/g, "");
}

export function getMap(
  block: LockfileBlock,
  fieldName: string,
): { [key: string]: string } | undefined {
  const field = block.fields[fieldName];
  if (field?.kind !== "map") return undefined;
  return field.entries;
}

export function getNestedMap(
  block: LockfileBlock,
  fieldName: string,
): { [key: string]: { [prop: string]: string } } | undefined {
  const field = block.fields[fieldName];
  if (field?.kind !== "nested-map") return undefined;
  return field.entries;
}

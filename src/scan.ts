// Pure helpers (no vscode import) so they can be tested with plain node.

export type Group = 'instance' | 'process' | 'port' | 'constant' | 'type' | 'signal' | 'function';
export const GROUPS: Group[] = ['instance', 'process', 'port', 'constant', 'type', 'signal', 'function'];

// vscode.SymbolKind values
const K = { Namespace: 2, Class: 4, Method: 5, Constructor: 8, Enum: 9, Function: 11, Constant: 13, Array: 17, Struct: 22, TypeParameter: 25 };

// Blank out comments but keep offsets, so match positions still map to lines.
export function stripComments(text: string, vhdl: boolean): string {
  const re = vhdl ? /--.*|\/\*[\s\S]*?\*\//g : /\/\/.*|\/\*[\s\S]*?\*\//g;
  return text.replace(re, (m) => m.replace(/[^\n]/g, ' '));
}

export type Dir = 'in' | 'out' | 'inout';
export interface Decl { group: Group; name: string; offset: number; dir?: Dir }

// shortcut: regex scan, not a parser. Misses `parameter A=1, B=2` second names and macro-generated decls; upgrade to the LSP if verible ever reports them.
const SV: [Group, RegExp][] = [
  ['constant', /\b(?:localparam|parameter)\s+[^;=,)]*?\b(\w+)\s*=/g],
  ['function', /\btask\s+(?:(?:automatic|static)\s+)?(\w+)/g], // verible-ls omits tasks
  ['type', /\btypedef\b[^;{}]*(?:\{[^}]*\})?\s*(?<!\w)(\w+)\s*(?:\[[^\]]*\]\s*)?;/g],
];
const VHDL: [Group, RegExp][] = [
  ['constant', /\bconstant\s+(\w+)/gi],
  ['type', /\b(?:sub)?type\s+(\w+)/gi],
];

// Constants and types that the LSP does not report (verible-ls omits both).
export function scanDecls(cleanText: string, vhdl: boolean): Decl[] {
  const out: Decl[] = [];
  for (const [group, re] of vhdl ? VHDL : SV) {
    for (const m of cleanText.matchAll(re)) {
      out.push({ group, name: m[1], offset: m.index! + m[0].lastIndexOf(m[1]) });
    }
  }
  return out;
}

// SV `port` list of a module/interface header (text up to its first `;`). `base` = header offset in the file.
// Also `iface.modport name` ports, which carry no direction keyword.
// shortcut: only the first name after a direction keyword (`input logic a, b` misses b) and no modport-less interface ports (`axil_if s`); upgrade with a real parser.
const DIR: Record<string, Dir> = { input: 'in', output: 'out', inout: 'inout' };
const PORT_RX = [
  /\b(input|output|inout)\b(?:[^,()]|\([^()]*\))*?\b(\w+)\s*(?:\[[^\]]*\]\s*)*(?=\s*(?:,|\)|=|$))/g,
  /\b\w+\.\w+\s+(\w+)\s*(?:\[[^\]]*\]\s*)*(?=\s*(?:,|\)|$))/g, // interface port: direction lives in the modport, show as inout
];
export function scanPorts(header: string, base: number): Decl[] {
  return PORT_RX.flatMap((re) => [...header.matchAll(re)].map((m) => {
    const name = m[m.length - 1];
    return { group: 'port' as const, name, offset: base + m.index! + m[0].lastIndexOf(name), dir: DIR[m[1]] ?? 'inout' };
  }));
}

// vhdl_ls puts the mode in the name: "port 'clk' : in". buffer/linkage are shown as their closest direction.
export function vhdlPortDir(name: string): Dir | undefined {
  const m = /^port '[^']*' : (\w+)/.exec(name)?.[1].toLowerCase();
  return m === 'in' ? 'in' : m === 'out' || m === 'buffer' ? 'out' : m ? 'inout' : undefined;
}

// `interface`/`program` blocks, which verible-ls does not report as symbols (it returns their contents at top level).
// shortcut: no nesting, and `virtual interface x` would be mistaken for a declaration.
export function scanUnits(cleanText: string): { name: string; start: number; end: number }[] {
  return [...cleanText.matchAll(/\b(interface|program)\s+(?:automatic\s+)?(\w+)[\s\S]*?\bend\1\b/g)]
    .map((m) => ({ name: m[2], start: m.index!, end: m.index! + m[0].length }));
}

// Decide what an LSP child symbol is. `line` is its start line, `text` its range text (verible starts the range at the name).
// `name` is the raw LSP name: vhdl_ls decorates it ("port 'clk' : in") and uses kind Interface for ports/generics/aliases.
export function classify(kind: number, line: string, text: string, name: string): Group | 'scope' {
  if (/^port '/.test(name)) return 'port';
  if (/^generic '/.test(name)) return 'constant';
  if (/^loop parameter '/.test(name)) return 'scope'; // for/generate index, not a real constant: drop it (leaf, so nothing is flattened)
  if (/^(?:\w+ )?(?:sub)?type '/.test(name)) return 'type'; // vhdl_ls kinds vary by base type (enum/record/array/number), the prefix does not
  if (kind === K.Namespace) return /\b(always\w*|initial|final|process)\b/i.test(line) ? 'process' : 'scope'; // else a generate/block: flatten its children into the parent
  if (/^\s*\(/.test(text.slice(name.length)) || /:\s*(entity|component|configuration)\b|\bport\s+map\b/i.test(text)) return 'instance';
  switch (kind) {
    case K.Constant: return 'constant';
    case K.Function: case K.Method: case K.Constructor: return 'function';
    case K.Class: case K.Struct: case K.Enum: case K.Array: case K.TypeParameter: return 'type';
    default: return 'signal';
  }
}

// vhdl_ls decorates names: "signal 'clk'" -> clk, "function f[INTEGER return INTEGER]" -> f[INTEGER return INTEGER].
export const shown = (n: string): string =>
  n.replace(/^[^']*'([^']*)'.*$/, '$1').replace(/^(?:(?:pure|impure) )?(?:function|procedure) /, '');

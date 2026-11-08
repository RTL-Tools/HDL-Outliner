import * as vscode from 'vscode';
import * as path from 'node:path';
import { Dir, Group, GROUPS, classify, scanDecls, scanPorts, scanUnits, shown, stripComments, vhdlPortDir } from './scan';

interface Item { name: string; group: Group; pos: vscode.Position; dir?: Dir }
interface Unit { name: string; ranges: vscode.Range[]; pos: vscode.Position; items: Item[] }
type Node =
  | { t: 'unit'; uri: vscode.Uri; unit: Unit }
  | { t: 'group'; uri: vscode.Uri; unit: Unit; group: Group; items: Item[] }
  | { t: 'item'; uri: vscode.Uri; item: Item };

const LABEL: Record<Group, [string, string]> = {
  instance: ['Instances', 'circuit-board'],
  process: ['Processes', 'play'],
  port: ['Ports', 'plug'],
  constant: ['Constants', 'symbol-constant'],
  type: ['Types', 'symbol-struct'],
  signal: ['Signals', 'symbol-variable'],
  function: ['Functions', 'symbol-function'],
};
const DIR_ICON: Record<Dir, string> = { in: 'sign-in', out: 'sign-out', inout: 'arrow-swap' };
const LANGS = ['systemverilog', 'verilog', 'vhdl'];

const UNIT_KINDS = [1, 2, 3, 4, 5]; // Module, Namespace, Package, Class, Method (verible reports `module` as Method)

async function parse(uri: vscode.Uri): Promise<{ units: Unit[]; lsp: boolean }> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const vhdl = doc.languageId === 'vhdl';
  const clean = stripComments(doc.getText(), vhdl);
  // Whatever LSP is active for this language answers; no server is started by us.
  const syms = (await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', uri)) ?? [];
  // VS Code merges every provider registered for the language (e.g. an extension's own plus the LSP); units with the same name are merged below.
  // The command returns hybrid objects (a SymbolInformation carrying range + children), so `instanceof vscode.DocumentSymbol` is false: test the shape instead.
  const isDoc = (s: vscode.DocumentSymbol | vscode.SymbolInformation): s is vscode.DocumentSymbol => Array.isArray((s as vscode.DocumentSymbol).children);
  const all = syms.map((s) => (isDoc(s) ? s : new vscode.DocumentSymbol(s.name, '', s.kind, s.location.range, s.location.range)));

  const units: Unit[] = [];
  const unit = (name: string, range: vscode.Range, pos = range.start) => {
    const u = units.find((x) => x.name === name);
    if (!u) return units[units.push({ name, ranges: [range], pos, items: [] }) - 1];
    u.ranges.push(range); // e.g. a VHDL package and its body
    return u;
  };
  // vhdl_ls names: "entity 'x'", "package body 'x'" (merged into the package), "architecture 'rtl'" (the entity is only on the source line).
  const unitName = (s: vscode.DocumentSymbol) => {
    const a = /^\s*architecture\s+(\w+)\s+of\s+(\w+)/i.exec(doc.lineAt(s.range.start.line).text);
    return a ? `architecture ${a[1]} of ${a[2]}` : s.name.replace(/^package body /, 'package ').replace(/'/g, '');
  };
  const add = (u: Unit, i: Item) => { if (!u.items.some((x) => x.name === i.name && x.group === i.group)) u.items.push(i); };
  const collect = (kids: vscode.DocumentSymbol[], u: Unit) => {
    for (const c of kids) {
      if (c.name === u.name) continue; // the unit itself, reported again by a second provider; `module m (` would otherwise classify as an instance
      const g = classify(c.kind, doc.lineAt(c.range.start.line).text, doc.getText(c.range), c.name);
      if (g === 'scope') collect(c.children, u);
      else add(u, { name: shown(c.name), group: g, pos: c.selectionRange.start, dir: vhdlPortDir(c.name) });
    }
  };

  for (const s of all.filter((s) => UNIT_KINDS.includes(s.kind))) collect(s.children, unit(unitName(s), s.range, s.selectionRange.start));
  if (!vhdl) for (const x of scanUnits(clean)) unit(x.name, new vscode.Range(doc.positionAt(x.start), doc.positionAt(x.end)));

  let loose: Unit | undefined; // symbols/decls outside any unit
  const owner = (pos: vscode.Position) => units.find((x) => x.ranges.some((r) => r.contains(pos))) ?? (loose ??= { name: path.basename(uri.fsPath), ranges: [], pos: new vscode.Position(0, 0), items: [] });
  // verible-ls returns interface contents as top-level symbols.
  for (const s of all.filter((s) => !UNIT_KINDS.includes(s.kind))) collect([s], owner(s.range.start));

  // Fill what the LSP omits (constants, types, tasks, SV ports), de-duplicated by name.
  const decls = scanDecls(clean, vhdl);
  if (!vhdl) {
    for (const u of [...units]) {
      const s = doc.offsetAt(u.ranges[0].start), e = clean.indexOf(';', s);
      if (u.ranges[0].end.isAfter(u.ranges[0].start)) decls.push(...scanPorts(clean.slice(s, e < 0 ? undefined : e), s));
    }
  }
  for (const d of decls) { const pos = doc.positionAt(d.offset); add(owner(pos), { name: d.name, group: d.group, pos, dir: d.dir }); }
  if (loose) units.push(loose);
  units.forEach((u) => u.items.sort((a, b) => a.pos.line - b.pos.line));
  return { units, lsp: all.length > 0 };
}

class Outline implements vscode.TreeDataProvider<Node> {
  private ev = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.ev.event;
  private cache = new Map<string, { units: Unit[]; lsp: boolean }>();
  private last = new Map<string, { units: Unit[]; lsp: boolean }>(); // last result the LSP actually answered
  status: (msg?: string) => void = () => {}; // set by activate: drives the view's message line
  hidden: Set<string>;
  uri?: vscode.Uri; // last HDL file that was active; kept while a non-HDL editor has focus
  constructor(private state: vscode.Memento) { this.hidden = new Set(state.get<string[]>('hidden', [])); }

  refresh() { this.cache.clear(); this.ev.fire(); }
  invalidate(uri: vscode.Uri) { this.cache.delete(uri.toString()); this.ev.fire(); }
  setActive(doc?: vscode.TextDocument) {
    if (!doc || !LANGS.includes(doc.languageId) || doc.uri.toString() === this.uri?.toString()) return false;
    this.uri = doc.uri;
    this.ev.fire();
    return true;
  }
  async pickGroups() {
    const picks = await vscode.window.showQuickPick(
      GROUPS.map((g) => ({ label: LABEL[g][0], g, picked: !this.hidden.has(g) })),
      { canPickMany: true, title: 'Groups shown in HDL Outline' });
    if (!picks) return;
    this.hidden = new Set(GROUPS.filter((g) => !picks.some((p) => p.g === g)));
    await this.state.update('hidden', [...this.hidden]);
    this.ev.fire();
  }

  getTreeItem(n: Node): vscode.TreeItem {
    switch (n.t) {
      case 'unit': {
        const t = new vscode.TreeItem(n.unit.name, vscode.TreeItemCollapsibleState.Expanded);
        t.id = `${n.uri}#${n.unit.name}`;
        t.iconPath = new vscode.ThemeIcon('symbol-module');
        t.command = open(n.uri, n.unit.pos);
        return t;
      }
      case 'group': {
        const t = new vscode.TreeItem(`${LABEL[n.group][0]} (${n.items.length})`, vscode.TreeItemCollapsibleState.Expanded);
        t.id = `${n.uri}#${n.unit.name}:${n.group}`;
        t.iconPath = new vscode.ThemeIcon(LABEL[n.group][1]);
        return t;
      }
      case 'item': {
        const t = new vscode.TreeItem(n.item.name);
        t.iconPath = new vscode.ThemeIcon(n.item.dir ? DIR_ICON[n.item.dir] : LABEL[n.item.group][1]);
        t.description = n.item.dir;
        t.command = open(n.uri, n.item.pos);
        return t;
      }
    }
  }

  async getChildren(n?: Node): Promise<Node[]> {
    if (!n) {
      const uri = this.uri;
      if (!uri) return [];
      let r = this.cache.get(uri.toString());
      if (!r) {
        r = await parse(uri);
        const key = uri.toString();
        if (r.lsp) { this.last.set(key, r); this.cache.set(key, r); } // not cached without the LSP: it may just not be ready yet
        else r = this.last.get(key) ?? r; // mid-edit syntax errors make servers return nothing: keep the last good outline
      }
      this.status(r.lsp ? undefined : 'No symbols from a language server for this file (is it running?). Showing a text scan of constants, types, ports and tasks only.');
      return r.units.map((unit) => ({ t: 'unit', uri, unit }));
    }
    if (n.t === 'unit') {
      return GROUPS.filter((g) => !this.hidden.has(g))
        .map((group) => ({ t: 'group' as const, uri: n.uri, unit: n.unit, group, items: n.unit.items.filter((i) => i.group === group) }))
        .filter((g) => g.items.length);
    }
    if (n.t === 'group') return n.items.map((item) => ({ t: 'item', uri: n.uri, item }));
    return [];
  }
}

const open = (uri: vscode.Uri, pos: vscode.Position): vscode.Command =>
  ({ command: 'vscode.open', title: 'Open', arguments: [uri, { selection: new vscode.Range(pos, pos) }] });

export function activate(ctx: vscode.ExtensionContext) {
  const outline = new Outline(ctx.workspaceState);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const view = vscode.window.createTreeView('hdlOutline.tree', { treeDataProvider: outline });
  outline.status = (m) => (view.message = m);
  const show = (doc?: vscode.TextDocument) => outline.setActive(doc) && (view.description = path.basename(doc!.uri.fsPath));
  show(vscode.window.activeTextEditor?.document);
  ctx.subscriptions.push(
    view,
    vscode.window.onDidChangeActiveTextEditor((e) => show(e?.document)),
    vscode.commands.registerCommand('hdlOutline.refresh', () => outline.refresh()),
    vscode.commands.registerCommand('hdlOutline.filter', () => outline.pickGroups()),
    vscode.commands.registerCommand('hdlOutline.dump', async () => { // debug aid: what the language servers returned vs what the outline made of it
      const uri = outline.uri;
      if (!uri) return;
      const raw = (await vscode.commands.executeCommand<any[]>('vscode.executeDocumentSymbolProvider', uri)) ?? [];
      const slim = (s: any): any => ({ name: s.name, kind: s.kind, cls: s.constructor?.name, line: (s.range ?? s.location?.range)?.start?.line, children: (s.children ?? []).map(slim) });
      const r = await parse(uri);
      const content = JSON.stringify({ file: uri.fsPath, hiddenGroups: [...outline.hidden], raw: raw.map(slim), units: r.units.map((u) => ({ name: u.name, items: u.items.map((i) => `${i.group}:${i.name}`) })) }, null, 1);
      vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content }));
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== outline.uri?.toString()) return;
      clearTimeout(timer);
      timer = setTimeout(() => outline.invalidate(e.document.uri), 600);
    }),
    { dispose: () => clearTimeout(timer) },
  );
}

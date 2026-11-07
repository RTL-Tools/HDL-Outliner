// Host-level test: runs the compiled extension against a mocked VS Code API.
// The mock returns symbols shaped like the real executeDocumentSymbolProvider result: a SymbolInformation
// subclass (so `instanceof DocumentSymbol` is false) that also carries range + children. Regression for "units listed but empty".
const Module = require('module'), fs = require('fs'), path = require('path'), assert = require('assert');
const file = path.join(__dirname, 'fixtures/mini.vhd'), text = fs.readFileSync(file, 'utf8'), L = text.split('\n');
const off = (p) => L.slice(0, p.line).reduce((a, l) => a + l.length + 1, 0) + p.character;
class Position { constructor(l, c) { this.line = l; this.character = c; } isAfter(o) { return this.line > o.line || (this.line === o.line && this.character > o.character); } }
class Range {
  constructor(a, b, c, d) { if (typeof a === 'number') { this.start = new Position(a, b); this.end = new Position(c, d); } else { this.start = a; this.end = b; } }
  contains(p) { const q = p.start ? p : { start: p, end: p }; return !this.start.isAfter(q.start) && !q.end.isAfter(this.end); }
}
class DocumentSymbol { constructor(name, detail, kind, range, sel) { Object.assign(this, { name, detail, kind, range, selectionRange: sel, children: [] }); } }
class SymbolInformation {}
class MergedInfo extends SymbolInformation {}
const toR = (r) => new Range(r.start.line, r.start.character, r.end.line, r.end.character);
const conv = (s) => Object.assign(new MergedInfo(), { name: s.name, kind: s.kind - 1, location: { range: toR(s.range) }, range: toR(s.range), selectionRange: toR(s.selectionRange), children: (s.children || []).map(conv) });
const doc = {
  languageId: 'vhdl', uri: { fsPath: file, toString: () => 'file://' + file },
  getText: (r) => (r ? text.slice(off(r.start), off(r.end)) : text), lineAt: (n) => ({ text: L[n] }),
  positionAt(o) { let l = 0; while (o > L[l].length) { o -= L[l].length + 1; l++; } return new Position(l, o); }, offsetAt: off,
};
const handlers = {}; let dump;
const vscode = {
  Position, Range, DocumentSymbol, ThemeIcon: class {}, TreeItem: class {}, TreeItemCollapsibleState: {}, EventEmitter: class { constructor() { this.event = () => {}; } fire() {} },
  window: { activeTextEditor: { document: doc }, createTreeView: () => ({}), onDidChangeActiveTextEditor() {}, showTextDocument(d) { dump = d; } },
  commands: { registerCommand: (n, f) => ((handlers[n] = f), {}), executeCommand: async () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/mini.json'))).map(conv) },
  workspace: { openTextDocument: async (x) => (x && x.content ? { content: x.content } : doc), onDidSaveTextDocument() {} },
};
const load = Module._load; Module._load = function (r, ...a) { return r === 'vscode' ? vscode : load.call(this, r, ...a); };
require('../out/extension.js').activate({ subscriptions: [], workspaceState: { get: (k, d) => d, update: async () => {} } });
handlers['hdlOutline.dump']().then(() => {
  const units = JSON.parse(dump.content).units;
  assert.deepStrictEqual(units, [{ name: 'entity e', items: ['port:clk'] }, { name: 'architecture rtl of e', items: ['signal:s'] }]);
  console.log('parse tests ok');
}).catch((e) => { console.error(e); process.exit(1); });

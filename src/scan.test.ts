import * as assert from 'node:assert';
import { classify, scanDecls, scanPorts, scanUnits, shown, stripComments, vhdlPortDir } from './scan';

const sv = `
// localparam IGNORED = 1;
module m #(parameter int unsigned ADDR_W = 8, parameter DATA_W = 32) ();
  localparam logic [2047:0] c_sbox = {8'h00};
  localparam int unsigned PTR_W = $clog2(8);
  typedef enum logic [1:0] { S_IDLE, S_RUN } state_e;
  typedef logic [7:0] byte_t;
endmodule`;
const names = (t: string, v = false) => scanDecls(stripComments(t, v), v).map((d) => `${d.group}:${d.name}`);
assert.deepStrictEqual(names(sv), ['constant:ADDR_W', 'constant:DATA_W', 'constant:c_sbox', 'constant:PTR_W', 'type:state_e', 'type:byte_t']);

const vh = `-- constant IGNORED : integer := 1;
constant WIDTH : integer := 8;
type state_t is (idle, run);
subtype byte_t is std_logic_vector(7 downto 0);`;
assert.deepStrictEqual(names(vh, true), ['constant:WIDTH', 'type:state_t', 'type:byte_t']);

// offsets point at the name
const d = scanDecls(stripComments(sv, false), false).find((x) => x.name === 'byte_t')!;
assert.strictEqual(sv.slice(d.offset, d.offset + 6), 'byte_t');

// classify: kinds as verible reports them (Variable=12, Namespace=2)
assert.strictEqual(classify(12, 'aes_cipher u_aes_cipher (', 'u_aes_cipher (\n .clk(clk));', 'u_aes_cipher'), 'instance');
assert.strictEqual(classify(12, 'aes_sbox_bram #(N) u_sbox (', 'u_sbox (\n);', 'u_sbox'), 'instance');
assert.strictEqual(classify(12, 'logic [127:0] key_r;', 'key_r', 'key_r'), 'signal');
assert.strictEqual(classify(2, 'always_ff @(posedge clk) begin : p_x', 'p_x', 'p_x'), 'process');
assert.strictEqual(classify(2, 'for (genvar g = 0; g < 8; g++) begin : g_sbox', 'g_sbox', 'g_sbox'), 'scope');
assert.strictEqual(classify(11, 'function automatic logic f(input int i);', 'f', 'f'), 'function');
assert.strictEqual(classify(12, 'u1 : entity work.foo port map (', 'u1 : entity work.foo port map (', 'u1'), 'instance');
// tasks, ports, interface units
assert.deepStrictEqual(names('task automatic t(input int i); endtask\ntask tt; endtask'), ['function:t', 'function:tt']);
const hdr = 'module top #(parameter int N = 4) (\n input logic clk,\n output logic [$clog2(N)-1:0] q,\n input wire [N-1:0] d [2] = 0,\n bus_if.mst b\n)';
assert.deepStrictEqual(scanPorts(hdr, 0).map((d) => d.name), ['clk', 'q', 'd', 'b']);
assert.deepStrictEqual(scanPorts('module m (input logic clk,\n axil_if.slave  s_axil,\n axis_if.master m_axis\n)', 0).map((d) => d.name), ['clk', 's_axil', 'm_axis']);
assert.deepStrictEqual(scanPorts('package p', 0), []);
const ifc = scanUnits('interface bus_if #(parameter W=8)(input logic clk);\n logic d;\nendinterface\nmodule m; endmodule');
assert.deepStrictEqual(ifc.map((u) => u.name), ['bus_if']);

// vhdl_ls: decorated names, kind Interface(10) for ports/generics/aliases, Array(17) for subtype, Event(23) for signal
assert.strictEqual(classify(10, 'port (clk : in std_logic);', "port 'clk' : in", "port 'clk' : in"), 'port');
assert.strictEqual(classify(10, 'generic (W : integer := 8);', "generic 'W'", "generic 'W'"), 'constant');
assert.strictEqual(classify(10, 'alias al : std_logic is clk;', "alias 'al'", "object alias 'al'"), 'signal');
assert.strictEqual(classify(17, 'subtype byte_t is x;', 'subtype', "subtype 'byte_t'"), 'type');
assert.strictEqual(classify(23, 'signal s : state_t;', 's', "signal 's'"), 'signal');
assert.strictEqual(classify(2, 'main : process is', 'main', "process 'main'"), 'process');
assert.strictEqual(classify(2, 'g : if W > 4 generate', 'g', "generate 'g'"), 'scope');
assert.strictEqual(classify(1, 'u1 : comp port map (clk => clk);', 'u1 : comp port map (clk => clk);', "instance 'u1'"), 'instance');
// port directions
assert.deepStrictEqual(scanPorts(hdr, 0).map((d) => d.dir), ['in', 'out', 'in', 'inout']);
assert.deepStrictEqual(scanPorts('m (inout wire x, axil_if.slave s)', 0).map((d) => `${d.name}:${d.dir}`), ['x:inout', 's:inout']);
assert.strictEqual(vhdlPortDir("port 'clk' : in"), 'in');
assert.strictEqual(vhdlPortDir("port 'q' : out"), 'out');
assert.strictEqual(vhdlPortDir("port 'b' : inout"), 'inout');
assert.strictEqual(vhdlPortDir("signal 's'"), undefined);
// real vhdl_ls names/kinds from the AES VHDL branch
assert.strictEqual(classify(13, 'for g in 0 to 3 generate', "g", "loop parameter 'g'"), 'scope');
assert.strictEqual(classify(15, 'subtype t_idx is integer range 0 to 3;', 't_idx', "subtype 't_idx'"), 'type'); // Number kind
assert.strictEqual(classify(17, 'subtype t_b is x;', 't_b', "subtype 't_b'"), 'type'); // Array kind
assert.strictEqual(classify(22, 'type r is record', 'r', "record type 'r'"), 'type');
assert.strictEqual(classify(9, 'type s is (a, b);', 's', "type 's'"), 'type');
assert.strictEqual(shown("signal 'clk'"), 'clk');
assert.strictEqual(shown('function c_sbox_byte[NATURAL return STD_LOGIC_VECTOR]'), 'c_sbox_byte[NATURAL return STD_LOGIC_VECTOR]');
assert.strictEqual(shown('procedure read_x[A, B]'), 'read_x[A, B]');
assert.strictEqual(shown('plain_sv_name'), 'plain_sv_name');
console.log('scan tests ok');

# Changelog

## 0.1.2

- Publisher ID is now `HDL-Tools` (extension id `HDL-Tools.hdl-outliner`). Uninstall any earlier `fpga-james.hdl-outliner` build.
- Marketplace metadata: license, keywords, categories.
- Releases are tested, built and published to the Marketplace (trusted publishing) by a GitHub Actions workflow on `v*` tags.

## 0.1.1

- Fix: a module or entity was listed as an instance of itself when a second SystemVerilog provider (e.g. `eirikpre.systemverilog`) reported it under its own name.
- README: SystemVerilog and VHDL screenshots.

## 0.1.0

First release.

- Side-panel outline of the active SystemVerilog, Verilog or VHDL file, built from the active language server (verible-ls, vhdl_ls).
- Groups per module, entity, package or interface: Instances, Processes, Ports (with direction), Constants, Types, Signals, Functions.
- Filter button to hide groups; refresh button; click to jump to a symbol.
- Text scan fills what verible-ls omits: parameters, typedefs, tasks, ports and interface/program units.
- vhdl_ls support: decorated names cleaned up, package and body merged, loop parameters dropped, architectures shown as `rtl of entity`.
- Refreshes shortly after you stop typing and keeps the last good outline while the file has a syntax error.
- Message in the panel when no language server answers for a file.
- Debug command that dumps raw symbols next to the outline built from them.

Known limits are listed in the README.

# IDA Pro MCP playbook

Maps each analysis question to the exact IDA Pro MCP tool that answers it. Do not
guess which tool to reach for — this is the checklist. Work top-down: map the
binary first, then drill into what the technique files flag.

Before anything, confirm the tool is live and a binary is loaded:
`check_connection`, then `get_metadata` (module name, base, bitness).

## Phase 1 — map the binary

| Goal | Tool(s) |
|---|---|
| List every function, get the lay of the land | `list_functions` |
| Find entry points and exports | `get_entry_points` |
| See what the binary imports (reveals capabilities) | `list_imports` |
| Pull strings, filtered | `list_strings`, `list_strings_filter` |
| List globals (candidate sensitive values) | `list_globals`, `list_globals_filter` |
| Known struct/type definitions | `get_defined_structures`, `list_local_types` |

## Phase 2 — questions from the technique files

### "Where do sensitive values live?" (memory.md, aimbot-esp.md)
- `list_globals_filter` for names hinting at health/position/ammo/entity.
- `data_read_dword` / `data_read_qword` / `data_read_string` to inspect a
  candidate global's value.
- `get_xrefs_to` on the global — who reads and writes it. A value written in
  many places and validated in none is client-authoritative.
- `analyze_struct_detailed` / `get_struct_at_address` to map an entity struct
  once a field is found (the "structure analysis" step cheaters use).

### "Which functions are hookable?" (injection-hooking.md)
- `list_functions` filtered toward rendering, input, and `send`/`recv`.
- `get_xrefs_to` a target to see how reachable it is.
- `decompile_function` to confirm what it does before calling it a hook target.
- `get_callers` / `get_callees` to place it in the call graph.

### "Is this value validated client-side or server-side?" (all)
- `decompile_function` on the code that consumes the value.
- Follow `get_callees` — does it call a network send *before* acting (server
  decides) or act locally then report (client decides)? The latter is the
  finding that matters most.
- Trace with `get_callers` back toward the network layer or the input loop.

### "How fragile would a signature over this be?" (signature-scanning.md)
- `disassemble_function` on the target — inspect the prologue bytes.
- A short, unique, unobfuscated prologue = a stable signature = a weakness.
- Look for control-flow flattening / opaque predicates (their absence is the
  weakness to report).

### "Which timer does the update loop trust?" (speedhack-timing.md)
- `list_imports` for `QueryPerformanceCounter`, `timeGetTime`, `GetTickCount*`.
- `get_xrefs_to` the timing import — who reads it, and does a competitive value
  flow from it (`decompile_function` on the caller).

### "What protections already exist?" (injection-hooking.md, kernel.md)
- `list_imports` for anti-debug / integrity APIs (`IsDebuggerPresent`,
  `CheckRemoteDebuggerPresent`, `NtQueryInformationProcess`, crypto APIs).
- `list_strings_filter` for anti-cheat vendor strings, error messages,
  integrity-check text.

## Phase 3 — annotate as you go

When you confirm a finding, record it in IDA so the next pass is faster:
- `set_comment` at the address with the technique it enables.
- `rename_function` / `rename_global_variable` to something meaningful
  (`g_localPlayerHealth_clientAuthoritative`).
- `set_function_prototype` / `declare_c_type` when you recover a struct.

This makes the disassembly itself part of the growing knowledge, alongside
`library/`.

## Discipline

- **Verify, don't infer.** A finding is "confirmed" only if you read it in the
  decompilation or disassembly. "Likely by pattern" is a different claim — label
  it as such in the report.
- **Read before drilling.** `decompile_function` before declaring a function a
  hook target or a validator; the name and imports only suggest, the body
  confirms.
- Do not patch the binary (`patch_address_assembles`) as part of analysis unless
  the user explicitly asks for a lab PoC and the target is in scope. Analysis is
  read-first.

# `unwrap()` / `expect()` Audit — HyperCom Backend

> Scope: `src-tauri/src/**/*.rs`  
> Audit date: 2026-07-20  
> Policy: `unwrap()` / `expect()` are acceptable only for startup invariants and test assertions. Anything in a Tauri command, serial read loop, or library runtime path uses `?` / `map_err` / `ok_or_else`.

## Findings summary

- **Production runtime** hits before this audit: `2`
  - `src-tauri/src/lib.rs:50` `.expect("Failed to initialize app state")` — startup invariant
  - `src-tauri/src/lib.rs:157` `.expect("error while running tauri application")` — startup invariant
  - `src-tauri/src/logger/mod.rs:243` `.expect("writer just retrieved")` — **fixed** (removed `expect`)
- **Test code** hits: all acceptable (assertions / temp setup)
- **Result**: no remaining `unwrap()` / `expect()` in runtime command or I/O paths.

## Detail table

### Production runtime

| File | Line | Code | Disposition | Reason |
|------|------|------|-------------|--------|
| `src-tauri/src/lib.rs` | 50 | `.manage(AppState::new().expect("Failed to initialize app state"))` | Acceptable | App state init at process startup; failure means the binary cannot function, so immediate abort is correct. |
| `src-tauri/src/lib.rs` | 157 | `.run(tauri::generate_context!()).expect("error while running tauri application")` | Acceptable | Tauri event-loop startup failure; the application cannot recover, so immediate abort is correct. |
| `src-tauri/src/logger/mod.rs` | 243 | `.expect("writer just retrieved")` | **Fixed** | Replaced with `let Some(removed) = self.writers.remove(port_id) else { return Ok(()); };` to avoid a panic in the log-splitting runtime path. |

### Test code (acceptable)

All uses below are inside `#[cfg(test)]` modules or temporary directory helpers. They are used for assertions or to unwrap controlled test inputs, not production runtime.

| File | Lines | Count | Reason |
|------|-------|-------|--------|
| `src-tauri/src/config/mod.rs` | 179, 180, 190, 221, 222, 224, 239, 240, 242 | 9 | JSON round-trip / file persistence tests with temp paths and deterministic data. |
| `src-tauri/src/logger/mod.rs` | 358, 359, 363, 371, 372, 373, 374, 375, 385, 387, 388, 389, 390, 403, 424, 425, 435, 443, 444, 445, 447, 465, 466, 467, 468, 469, 470, 481, 484, 485, 486, 487, 503, 504, 511, 521, 523, 524, 525, 526 | 39 | Test setup for `LogManager` / `PortLogWriter` with temp directories. |
| `src-tauri/src/storage/mod.rs` | 542, 543, 555, 598, 599, 629, 630, 634, 635, 641, 676, 677, 706, 707, 708, 737, 738, 764, 767, 769, 777, 779, 780, 807, 833, 835, 847, 848 | 28 | SQLite in-memory test database setup and query assertions. |

## Notes

- `unwrap_or_default()` / `unwrap_or_else()` / `unwrap_or(...)` are not counted as "unwrap()" per the audit policy because they provide a defined fallback path.
- `std::sync::Mutex` poisoning is handled with `map_err` → `CommandError::Lock` in all Tauri commands; no `lock().unwrap()` remains in command or serial-loop paths.
- This audit file should be updated whenever a new `unwrap()` / `expect()` is introduced in backend runtime code.

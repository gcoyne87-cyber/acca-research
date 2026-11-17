# Racing Edge — Claude Code notes

## Trainer intel refresh routine

The master workbook always arrives as **`Racing_Edge_Master.xlsx`** in `C:\Users\Gary Coyne\Downloads\`.

Steps every refresh:

1. Copy `Downloads\Racing_Edge_Master.xlsx` → project root as `trainer-intel.xlsx` (overwrite).
2. Dry-run: `npx netlify dev:exec --context production "node scripts/import-trainer-intel.js --dry-run"`
   - Report: rows per tab, APPROVED total, any dropped/failed rows with IDs, trainer names.
   - **Stop and show the report** if there are validation failures, any unresolved trainer names, or total < 350.
3. If clean, run the real import (same command, no `--dry-run`). Show diff vs previous snapshot.
4. Copy `trainer-intel.xlsx` back to `C:\Users\Gary Coyne\OneDrive - Ecoiam\Desktop\trainer-intel.xlsx`.
5. Commit `trainer-intel.xlsx` + any changed scripts with message `Trainer intel refresh: YYYY-MM-DD`.
6. Do **not** push until told to.

**Rules:**
- APPROVED rows only — REVIEW and ARCHIVE are always skipped.
- `VALID_UNTIL` is deliberately unused; all rows are treated as open-ended. Staleness is handled by manual rewording at each refresh.
- Any non-schema tab (e.g. "Rubys Tips") is skipped cleanly via `SKIP_SHEETS` in the importer — never an error.
- The `--force` flag bypasses the half-count guard; only use it for deliberate reductions.

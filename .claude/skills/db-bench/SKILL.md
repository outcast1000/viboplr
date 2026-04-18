---
name: db-bench
description: "Run database search performance benchmarks (20k tracks, 100k history) and record results for comparison"
---

# Database Benchmark Skill

Runs the `bench_search_performance` test and presents results in the browser.

## Process

1. **Run the benchmark:**
   ```bash
   cd src-tauri && cargo test bench_search_performance -- --ignored --nocapture 2>&1
   ```

2. **Extract the JSON** between `--- BENCH_JSON_START ---` and `--- BENCH_JSON_END ---` markers from the output.

3. **Read metadata:**
   - App version from `src-tauri/Cargo.toml` (`version` field)
   - Git commit via `git rev-parse --short HEAD`
   - Current UTC timestamp

4. **Update `benchmarks/history.json`:** Read the existing array, append a new run object:
   ```json
   {
     "date": "2026-04-18T12:00:00Z",
     "version": "0.9.18",
     "commit": "abc1234",
     "results": [ ... extracted results ... ]
   }
   ```
   Write the updated array back.

5. **Generate the output HTML:** Read `benchmarks/index.html` (the template). Replace the literal text `__BENCH_DATA__` with the full contents of `benchmarks/history.json` (the entire array, JSON-encoded). Write the result to `benchmarks/report.html`.

6. **Open in browser:**
   ```bash
   open benchmarks/report.html
   ```

7. **Print a brief summary** of the results to the conversation (the human-readable table from the test output). If there was a previous run in history.json, include a comparison table showing deltas.

## Notes

- `benchmarks/index.html` is the template (checked into git) — it contains `__BENCH_DATA__` as a placeholder
- `benchmarks/report.html` is the generated output (should be in .gitignore) — it has the data inlined
- `benchmarks/history.json` is the persistent history of all runs (checked into git)
- The benchmark uses an in-memory SQLite database — not affected by disk I/O
- Results are from a debug build for consistency — relative comparisons are what matter

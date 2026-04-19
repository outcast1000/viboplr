# TODO

## Search: Evaluate Tantivy for fuzzy/typo-tolerant search

SQLite FTS5 lacks typo tolerance. Tantivy (Rust full-text search library, `tantivy = "0.22"`) could replace or supplement it:

- **FuzzyTermQuery** with Levenshtein automata for typo tolerance ("beethovn" -> "beethoven")
- **Stemming** ("running" -> "run")
- **BM25 ranking** out of the box
- **PhrasePrefixQuery** for search-as-you-type
- In-process (no server) — fits Tauri desktop architecture

### Integration approach

- SQLite stays as source of truth
- Tantivy index maintained in parallel, stored in profile directory
- Search queries go to Tantivy instead of / as fallback after FTS5
- Index rebuilt from SQLite if corrupted

### Tradeoffs

- Dual index maintenance (sync on add/remove/update)
- ~2-4MB binary size increase
- Index rebuild needed on schema changes
- Initial build takes a few seconds for large libraries

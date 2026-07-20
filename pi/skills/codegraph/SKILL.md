---
name: codegraph
description: >
  Use codegraph CLI to navigate and understand the codebase before making changes.
  Trigger this skill whenever Claude is about to: modify an existing function or type,
  refactor code, trace a bug across files, plan a feature that touches multiple modules,
  or needs to answer "where is X used?" / "what does Y call?" questions.
  Also trigger when the user asks about codebase structure, call graphs, impact analysis,
  or wants to find which tests are affected by a change.
  Prefer codegraph over manual grep/find for any cross-file symbol search — it's faster
  and returns semantic results (functions, types, imports) rather than raw text matches.
---

# codegraph Usage Guide

CodeGraph is a local static-analysis code intelligence tool. Prefer it over crawling files with `grep`/`find` when you need code structure, relevant source, call paths, impact, or affected tests.

## Core principle

Start non-trivial code work with CodeGraph. If a repo is not initialized, run `codegraph init`; otherwise `codegraph status` tells you if the index is ready. Modern CodeGraph auto-syncs when served to agents, but `codegraph sync` is still fine for a manual pre-flight.

## Command reference

### Index status / refresh

```bash
codegraph status          # Check freshness, file and symbol counts
codegraph init            # Initialize and index this project
codegraph sync            # Manual incremental sync
codegraph index           # Full re-index
codegraph upgrade --check # Check CodeGraph CLI version
```

### Main exploration tools

```bash
codegraph explore "<task or area>"       # Relevant source + call paths in one shot
codegraph explore "<task>" --max-files 8 # Limit included source files
codegraph node "<symbol>"                # One symbol with caller/callee trail
codegraph node --file src/foo.ts          # Read a file with symbol map + dependents
codegraph node --file src/foo.ts --offset 80 --limit 120
```

### Structure and symbol search

```bash
codegraph files                         # Indexed file tree
codegraph files --format flat --filter src
codegraph query "<keyword>"             # Search symbols by name
codegraph query "<keyword>" -k function # Kind filter
codegraph query "<keyword>" -l 20       # Result limit
```

### Call graph / impact

```bash
codegraph callers "<symbol>"   # What calls this symbol
codegraph callees "<symbol>"   # What this symbol calls
codegraph impact "<symbol>"    # Blast radius of changing it
codegraph affected src/foo.ts   # Tests likely affected by source files
```

## Workflow patterns

- **Before changing existing code:** `codegraph explore "<change>"`, then `codegraph impact "<shared symbol>"` if touching a shared function/type.
- **Bug tracing:** `codegraph query "<suspect>"`, then `codegraph node` / `callers` / `callees`.
- **After edits:** `codegraph affected <changed files>` to pick focused tests.

## Caveats

- Dynamic runtime calls can still be invisible.
- Use exact text search for literal errors, config keys, generated files, or things not indexed.
- `context` was removed from the CLI; use `explore` instead.

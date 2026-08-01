## CodeGraph Context-Finding Policy

Use the CodeGraph CLI (via the `codegraph` skill and Bash) as the primary code-navigation tool.

- For code exploration, semantic context, symbol lookup, call graphs, impact analysis, or affected-test discovery, prefer `codegraph` before shell `grep`, `rg`, `find`, or broad file listing.
- Start non-trivial code changes with `codegraph explore "<task>"`, then inspect exact files with Read.
- Before changing shared symbols, use `codegraph callers`, `codegraph callees`, or `codegraph impact`.
- After changing files, use `codegraph affected <files>` to choose focused tests.
- Still use exact text search for literal error messages, config keys, user-visible strings, or files that may not be indexed.

## Git policy

Never rebase, amend, force push, reset hard, delete commits, or otherwise rewrite commit history unless the user explicitly asks for that exact operation.

For GitHub and Git actions, prefer direct `git` and `gh` commands unless explicitly asked otherwise. This includes reading GitHub resources. To view or summarize an issue, pull request, comments, checks, or releases, use `gh`, such as `gh issue view <n> --json` or `gh api`. Never use WebFetch on a `github.com` URL because it scrapes server-rendered HTML and may silently omit dynamically loaded content such as comments, which can cause existing discussions to be incorrectly reported as empty.

Never create a pull request or post a comment on a pull request without the user's explicit approval. Always ask for confirmation immediately before performing either action.

Create pull requests as drafts by default after receiving approval to create them.


## Writing style

Do not hard-wrap prose paragraphs in Markdown.

Prefer explicit connective words over symbol-based connectives (`—`, `;`, `:`) when expressing a logical relation between clauses, such as cause, contrast, consequence, or elaboration. Name the relation in words (for example `because`, `so`, `but`, `which means`, `for example`) so the sentence structure survives being read aloud. This targets logical connectives only, so keep punctuation for genuinely structural uses such as a colon before a list.

When writing instructions, state defaults directly. Avoid redundant exception clauses such as `unless explicitly requested` when an instruction already establishes a default. Keep explicit exceptions when they define safety or permission boundaries.
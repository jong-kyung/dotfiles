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


# Writing style

Write prose as natural, complete sentences. Do not hard-wrap paragraphs in Markdown.

Prefer words and sentence structure over symbols or shorthand. When expressing cause, contrast, consequence, conditions, examples, or elaboration, state the relationship explicitly with words such as “because,” “but,” “so,” “therefore,” “which means,” and “for example.”

Avoid using em dashes, semicolons, slashes, arrows, ampersands, parentheses, or similar symbols when the same meaning can be expressed clearly in ordinary prose. Rewrite compressed expressions as complete sentences rather than joining ideas with symbols.

Use punctuation only when it serves a necessary grammatical or structural purpose. For example, commas and periods should separate clauses and sentences, while a colon may introduce a list when that structure is clearer than a full sentence.

When writing instructions, state the expected behavior directly and affirmatively. Avoid unnecessary qualifications, repeated conditions, and exception phrases such as “unless explicitly requested” when the default rule already communicates the intended behavior.

Prefer readable sentence flow over compactness. Do not sacrifice clarity merely to make the text shorter.

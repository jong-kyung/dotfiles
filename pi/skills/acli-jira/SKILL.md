---
name: acli-jira
description: >
  Use when working with Jira Cloud from the command line using Atlassian's
  official `acli` tool. Trigger on "create issue", "create ticket", "update
  issue", "transition issue", "search Jira", "JQL", "list projects", "create
  sprint", "Jira board", "add comment to ticket", "link issues", "bulk create
  issues", or any Jira Cloud operation from the terminal. Do NOT trigger for
  Jira Server/Data Center (acli is Cloud-only) or for Confluence, Bitbucket,
  or other Atlassian products.
---

# acli (Atlassian CLI) — Jira Cloud Workflow Guide

`acli` is Atlassian's official CLI for Jira Cloud. Installed as `acli` (check
with `acli --version`). Terminology note: a Jira **issue** is called a
**work item** (`workitem`) in acli.

## Contents

- [Behavior Guidelines](#behavior-guidelines)
- [Auth](#auth)
- [Core Workflows](#core-workflows)
- [JSON Patterns — Input & Output](#json-patterns--input--output)
- [Token-Efficient Reads](#token-efficient-reads)
- [Destructive Operations](#destructive-operations)
- [Limitations & Fallbacks](#limitations--fallbacks)
- [References Loading Guide](#references-loading-guide)

## Behavior Guidelines

1. **Always `--json` for programmatic output.** Never parse human-formatted
   tables with grep/awk. Every read, create, and edit command supports `--json`.
2. **Discover schema with `--generate-json` before mutating.** For
   `workitem create`, `workitem edit`, `create-bulk`, `project create`, and
   `link create`, run the command with `--generate-json` first to see the
   exact JSON structure expected — then fill it in and pass via `--from-json`.
3. **Use `--fields` to cap response size.** `workitem view` and
   `workitem search` default to sensible fields; request only what you need.
   Use `-description` to exclude heavy fields when you don't need them.
4. **Use `--paginate` + `--count` deliberately.** `--paginate` ignores
   `--limit` and fetches everything; use `--count` when you only need a total,
   not the rows.
5. **Confirm with `--yes` explicitly on destructive ops.** `delete`,
   bulk `edit`, bulk `transition`, bulk `assign`, and `create-bulk` all
   prompt interactively without `--yes`. In non-interactive contexts pass
   `--yes`, but only after the user has agreed to the scope.
6. **No `--dry-run` exists in acli.** Mitigate by: (a) previewing the target
   set via `workitem search --jql "<same jql>" --count --json` before running
   a bulk mutation with the same `--jql`, and (b) preferring `--key` over
   `--jql` when the set is small and known.
7. **Fall back to REST API via curl when acli lacks coverage.** acli only
   covers: workitem, project, board, sprint, field, filter, dashboard. For
   everything else (worklog, user, permission, webhook, attachment upload,
   etc.) use the Jira Cloud REST API — see [Limitations](#limitations--fallbacks).

## Auth

```bash
# Global OAuth login (preferred) — covers Jira + Confluence
acli auth login
acli auth status
acli auth switch          # Multiple accounts

# Jira-only login (if global OAuth is unavailable)
acli jira auth login
acli jira auth status
```

Auth persists across sessions. If a command returns 401, run
`acli auth status` first before assuming the command syntax is wrong.

## Core Workflows

### Work items (issues)

```bash
# View single issue — default fields are compact, use --fields to tailor
acli jira workitem view KEY-123 --json
acli jira workitem view KEY-123 --fields "summary,status,assignee,comment" --json
acli jira workitem view KEY-123 --fields "*all" --json   # everything
acli jira workitem view KEY-123 --fields "*navigable,-comment" --json

# Search with JQL — always use --json for parsing
acli jira workitem search --jql 'project = TEAM AND status = "In Progress"' --json
acli jira workitem search --jql 'assignee = currentUser()' --limit 50 --json
acli jira workitem search --jql 'project = TEAM' --count --json      # just a count
acli jira workitem search --jql 'project = TEAM' --paginate --json   # all pages

# Create from flags (simple case)
acli jira workitem create --project TEAM --type Task --summary "Short title" \
  --description "Longer body" --assignee @me --label "cli,auto" --json

# Create from JSON (complex fields, ADF descriptions, custom fields)
acli jira workitem create --generate-json > /tmp/new-issue.json
# …edit /tmp/new-issue.json…
acli jira workitem create --from-json /tmp/new-issue.json --json

# Edit by key(s)
acli jira workitem edit --key "KEY-1,KEY-2" --summary "New summary" --json

# Edit by JQL (bulk) — scope preview then commit
acli jira workitem search --jql 'project = TEAM AND labels = stale' --count --json
acli jira workitem edit --jql 'project = TEAM AND labels = stale' \
  --labels archived --remove-labels stale --yes --json

# Transition (status change)
acli jira workitem transition --key KEY-123 --status "In Progress" --json
acli jira workitem transition --jql 'assignee = @me AND status = "To Do"' \
  --status "In Progress" --yes --json

# Assign / unassign
acli jira workitem assign --key KEY-123 --assignee @me --json
acli jira workitem assign --key KEY-123 --remove-assignee --json
```

### Comments

```bash
# Add a comment (plain text or ADF JSON)
acli jira workitem comment create --key KEY-123 --body "Deploying now" --json

# Comment from file (useful for multi-line or ADF)
acli jira workitem comment create --key KEY-123 --body-file ./update.md --json

# List comments
acli jira workitem comment list --key KEY-123 --paginate --json
```

### Links

```bash
# Discover available link types first (output: "Blocks", "is blocked by", ...)
acli jira workitem link type --json

# Create a link between two issues
acli jira workitem link create --out KEY-123 --in KEY-456 --type Blocks --yes

# Bulk links from JSON/CSV
acli jira workitem link create --generate-json > /tmp/links.json
acli jira workitem link create --from-json /tmp/links.json --yes

# List links on an issue
acli jira workitem link list --key KEY-123 --json
```

### Bulk create

```bash
# Generate the expected JSON shape first — do NOT guess the structure
acli jira workitem create-bulk --generate-json > /tmp/issues.json
# …edit /tmp/issues.json (array of issues)…
acli jira workitem create-bulk --from-json /tmp/issues.json --yes

# Or CSV: summary,projectKey,issueType,description,label,parentIssueId,assignee
acli jira workitem create-bulk --from-csv ./issues.csv --yes
```

### Projects, boards, sprints, filters

```bash
# Projects
acli jira project list --paginate --json
acli jira project view --key TEAM --json
acli jira project create --generate-json > /tmp/project.json   # schema discovery
acli jira project create --from-json /tmp/project.json --json

# Boards
acli jira board search --project TEAM --type scrum --json
acli jira board get --id 42 --json
acli jira board list-sprints --id 42 --json

# Sprints
acli jira sprint create --board 42 --name "Sprint 24" --start 2026-04-20 --end 2026-05-04 --json
acli jira sprint view --id 100 --json
acli jira sprint list-workitems --id 100 --json

# Filters / dashboards
acli jira filter search --owner user@example.com --json
acli jira filter get --id 10001 --json
acli jira dashboard search --json
```

## JSON Patterns — Input & Output

### Schema discovery (acli's version of introspection)

`--generate-json` is how acli exposes write schemas. It prints an example JSON
structure with all available fields — including custom fields for the current
site — and is the safest way to build a `--from-json` payload.

```bash
acli jira workitem create --generate-json
acli jira workitem edit --generate-json
acli jira workitem create-bulk --generate-json
acli jira workitem link create --generate-json
acli jira project create --generate-json
```

Workflow: redirect to a file, edit the file, feed it back with `--from-json`.
This round-trips full fidelity (ADF descriptions, custom fields, parent
links, components, versions).

### Output parsing with `jq`

```bash
# Extract keys from a search
acli jira workitem search --jql 'project = TEAM' --fields key --json \
  | jq -r '.[].key'

# Find issues assigned to me that have no estimate
acli jira workitem search --jql 'assignee = currentUser()' \
  --fields 'key,summary,customfield_10016' --json \
  | jq '[.[] | select(.fields.customfield_10016 == null)]'

# Count by status
acli jira workitem search --jql 'project = TEAM' --fields status --json \
  | jq -r '[.[] | .fields.status.name] | group_by(.) | map({status: .[0], count: length})'
```

## Token-Efficient Reads

acli responses can be large. Use these together:

| Goal                           | Flags                                                         |
|--------------------------------|---------------------------------------------------------------|
| Just a count                   | `--count --json`                                              |
| Specific columns only          | `--fields "key,summary,status" --json`                        |
| Exclude heavy fields           | `--fields "*navigable,-description,-comment" --json`          |
| Fixed page size                | `--limit 50 --json`                                           |
| Full pagination (careful!)     | `--paginate --json`                                           |
| CSV for spreadsheet import     | `--csv`                                                       |

**Always prefer `--fields` over `*all`** for agent work. The default field set
on `workitem view` and `workitem search` is already trimmed; widen only when
you actually need a field.

## Destructive Operations

acli has no `--dry-run` flag. For any multi-issue mutation (`delete`, bulk
`edit`, bulk `transition`, bulk `assign`, `create-bulk`), follow this pattern:

```bash
# 1. Preview the target set
acli jira workitem search --jql '<JQL>' --fields key,summary,status --json

# 2. Verify the count matches expectation
acli jira workitem search --jql '<JQL>' --count --json

# 3. Get explicit user confirmation before mutating

# 4. Execute with --yes (required for non-interactive) and --ignore-errors
#    ONLY if partial success is acceptable; omit it to fail fast
acli jira workitem edit --jql '<JQL>' --labels new-label --yes --json
```

Never pass `--yes` on a destructive bulk command without the user having seen
the preview from step 1.

## Limitations & Fallbacks

acli only covers these Jira surfaces: `workitem`, `project`, `board`,
`sprint`, `field`, `filter`, `dashboard`, `workitem comment`,
`workitem link`, `workitem attachment (list/delete only)`,
`workitem watcher (list/remove only)`.

**Not covered by acli** (as of v1.3.x) — fall back to Jira Cloud REST API via
`curl`:

| Operation                                  | Jira Cloud REST endpoint (v3)                           |
|-------------------------------------------|--------------------------------------------------------|
| Upload an attachment                       | `POST /rest/api/3/issue/{key}/attachments`             |
| Worklogs (add/list/update/delete)          | `/rest/api/3/issue/{key}/worklog`                      |
| User search / get / group membership       | `/rest/api/3/user/search`, `/rest/api/3/user`          |
| Permissions, permission schemes            | `/rest/api/3/permissions`, `/rest/api/3/permissionscheme` |
| Webhooks                                   | `/rest/api/3/webhook`                                  |
| Workflows, screens, issue-type schemes     | `/rest/api/3/workflow`, `/rest/api/3/screens`, etc.    |
| Issue history / changelog                  | `/rest/api/3/issue/{key}?expand=changelog`             |
| Voting, add watcher                        | `/rest/api/3/issue/{key}/votes`, `/issue/{key}/watchers` |

For the curl fallback, use an API token (email + token via Basic auth):

```bash
# Set once (store in ~/.zshrc or a secrets manager, not in files you share)
export JIRA_BASE="https://<your-site>.atlassian.net"
export JIRA_EMAIL="you@example.com"
export JIRA_TOKEN="<api-token>"

# Example: upload attachment (acli cannot do this)
curl -s -u "$JIRA_EMAIL:$JIRA_TOKEN" \
  -H "X-Atlassian-Token: no-check" \
  -F "file=@./report.pdf" \
  "$JIRA_BASE/rest/api/3/issue/KEY-123/attachments" | jq
```

**API version note**: the reference doc shared was Jira Server/DC 9.17 REST
API. Jira **Cloud** uses a different base path (`/rest/api/3/`) and a slightly
different schema — especially for ADF descriptions, which are JSON documents,
not wiki markup. Always cross-check against
`developer.atlassian.com/cloud/jira/platform/rest/v3/` when the server doc
describes an endpoint that looks different from what you see in Cloud.

## References Loading Guide

| Situation                                       | Load                                                                 |
|-------------------------------------------------|----------------------------------------------------------------------|
| Complex JQL patterns, advanced search operators | `references/jql-cookbook.md`                                         |
| ADF document structure for descriptions/comments | `references/adf-cheatsheet.md`                                       |
| curl-based REST fallback recipes (Cloud v3)     | `references/rest-fallback.md`                                        |
| Mapping the shared Jira Server 9.17 doc to Cloud | Cross-reference `https://developer.atlassian.com/cloud/jira/platform/rest/v3/` |

# JQL Cookbook — Patterns for `acli jira workitem search --jql`

JQL strings go inside `--jql "<...>"`. Escape double quotes with `\"` or
wrap the whole value in single quotes (preferred in zsh).

## Scope by project / component / version

```jql
project = TEAM
project in (TEAM, INFRA)
project = TEAM AND component = "Payments"
project = TEAM AND fixVersion = "24.Q2"
```

## Scope by people

```jql
assignee = currentUser()
assignee = "user@example.com"
assignee in membersOf("team-platform")
reporter = currentUser() AND resolution = Unresolved
assignee is EMPTY
```

## Scope by status / workflow

```jql
status = "In Progress"
status in ("To Do", "In Progress")
status changed TO Done AFTER -7d
resolution = Unresolved
resolution = Done AND resolved > -30d
```

## Scope by time

```jql
created >= -14d
updated >= startOfWeek()
due <= endOfMonth()
duedate < now() AND resolution = Unresolved   # overdue
```

Relative time units: `-1h`, `-3d`, `-2w`, `-1M`, `-1y`. Functions:
`now()`, `startOfDay()`, `endOfWeek()`, `startOfMonth()`.

## Full-text & labels

```jql
summary ~ "login error"
text ~ "\"exact phrase\""
labels = bug
labels in (bug, regression)
labels is EMPTY
```

`~` is the fuzzy text match operator. `text` searches summary, description,
comments, and environment together.

## Parents, subtasks, epics

```jql
parent = KEY-100
"Epic Link" = KEY-100                   # classic projects
issueFunction in linkedIssuesOf("project = TEAM")
issuetype = Sub-task AND parent in (KEY-1, KEY-2)
```

## Sprint / board

```jql
sprint in openSprints()
sprint in closedSprints() AND project = TEAM
sprint = "Sprint 23"
```

## Custom fields

Custom fields are addressed as `cf[NNNNN]` or by name in quotes:

```jql
cf[10016] >= 5                          # Story points ≥ 5
"Story Points" >= 5
"Team" = "platform"
```

Find the numeric id with `acli jira field` in the Jira admin or by running
`acli jira workitem view KEY-X --fields "*all" --json | jq 'keys'`.

## Sorting and limiting

```jql
project = TEAM ORDER BY priority DESC, created ASC
```

acli's `--limit` caps the returned rows; JQL `ORDER BY` controls which rows
survive the cap.

## Useful composed queries

```bash
# My stale in-progress work
acli jira workitem search --jql \
  'assignee = currentUser() AND status = "In Progress" AND updated < -5d' --json

# Bugs opened this week with no assignee
acli jira workitem search --jql \
  'type = Bug AND created >= startOfWeek() AND assignee is EMPTY' --json

# Tickets I need to review (I'm on watchers list, not assignee)
acli jira workitem search --jql \
  'watcher = currentUser() AND assignee != currentUser() AND resolution = Unresolved' --json

# Anything blocked by a specific ticket
acli jira workitem search --jql 'issue in linkedIssues(KEY-100, "is blocked by")' --json
```

## Gotchas

- **Quotes in zsh**: prefer single quotes around the JQL; use `\"` only
  inside if the value itself needs double quotes.
- **Case sensitivity**: field names and functions are case-insensitive, but
  values (statuses, labels, user strings) are usually exact.
- **Reserved words**: if a label/component contains a JQL keyword, wrap it
  in double quotes (`labels = "in-progress"`).

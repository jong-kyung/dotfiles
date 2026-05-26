# Jira Cloud REST Fallback (curl) — For Gaps in acli

Use these recipes when acli doesn't cover the operation. All examples assume:

```bash
export JIRA_BASE="https://<site>.atlassian.net"
export JIRA_EMAIL="you@example.com"
export JIRA_TOKEN="<api-token-from-id.atlassian.com>"

# Shortcut
jira() {
  curl -s -u "$JIRA_EMAIL:$JIRA_TOKEN" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    "$JIRA_BASE$1" "${@:2}"
}
```

`jq` is assumed for post-processing.

## Token caveats

- **Never commit `JIRA_TOKEN` to a repo.** Keep it in `~/.zshrc`, a password
  manager, or a keyring; read it into the env just-in-time.
- API tokens are rotated from `id.atlassian.com` → *Security* →
  *Create and manage API tokens*.
- For most endpoints an API token with Basic auth is sufficient; OAuth 2.0
  (3LO) is only needed for apps installed on behalf of other users.

## Issue-level gaps

### Upload attachment

```bash
curl -s -u "$JIRA_EMAIL:$JIRA_TOKEN" \
  -H "X-Atlassian-Token: no-check" \
  -F "file=@./report.pdf" \
  "$JIRA_BASE/rest/api/3/issue/KEY-123/attachments" | jq
```

`X-Atlassian-Token: no-check` is required for multipart uploads.

### Get full changelog / history

```bash
jira "/rest/api/3/issue/KEY-123?expand=changelog" | jq '.changelog.histories'
```

### Worklogs

```bash
# List
jira "/rest/api/3/issue/KEY-123/worklog" | jq '.worklogs'

# Add
jira "/rest/api/3/issue/KEY-123/worklog" -X POST -d '{
  "timeSpent": "1h 30m",
  "comment": { "type": "doc", "version": 1,
    "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Debugging prod issue" }] }] }
}' | jq
```

### Add / remove watcher

```bash
# Add self as watcher
jira "/rest/api/3/issue/KEY-123/watchers" -X POST -d "\"$(jira /rest/api/3/myself | jq -r .accountId)\""

# Remove a watcher
jira "/rest/api/3/issue/KEY-123/watchers?accountId=<id>" -X DELETE
```

### Vote / unvote

```bash
jira "/rest/api/3/issue/KEY-123/votes" -X POST
jira "/rest/api/3/issue/KEY-123/votes" -X DELETE
```

## User operations

acli has no user commands. Common lookups:

```bash
# Find by email
jira "/rest/api/3/user/search?query=user@example.com" | jq '.[] | {accountId, displayName, emailAddress}'

# Myself
jira "/rest/api/3/myself" | jq

# Group members
jira "/rest/api/3/group/member?groupname=team-platform" | jq '.values[] | {accountId, displayName}'
```

## Permissions

```bash
# What permissions does the current user have on an issue?
jira "/rest/api/3/mypermissions?issueKey=KEY-123" | jq '.permissions | to_entries | map(select(.value.havePermission)) | map(.key)'

# Permission scheme for a project
jira "/rest/api/3/project/TEAM/permissionscheme" | jq
```

## Workflow / transitions

acli's `workitem transition --status` is fine for most cases, but to inspect
the allowed transitions (including transition IDs and screens):

```bash
jira "/rest/api/3/issue/KEY-123/transitions?expand=transitions.fields" | jq '.transitions[] | {id, name, to: .to.name}'
```

To force a transition with a specific transition ID (e.g., if two transitions
share the same status name):

```bash
jira "/rest/api/3/issue/KEY-123/transitions" -X POST -d '{ "transition": { "id": "31" } }'
```

## Webhooks

```bash
# List webhooks registered by the current app
jira "/rest/api/3/webhook" | jq

# Register (dynamic webhooks; OAuth app context required for some)
jira "/rest/api/3/webhook" -X POST -d '{
  "webhooks": [
    { "jqlFilter": "project = TEAM", "events": ["jira:issue_created", "jira:issue_updated"] }
  ],
  "url": "https://my-listener.example.com/jira"
}'
```

## Pagination pattern

Most list endpoints return `{startAt, maxResults, total, values: [...]}`.
Loop until `startAt + maxResults >= total`:

```bash
start=0
while : ; do
  page=$(jira "/rest/api/3/issue/KEY-123/worklog?startAt=$start&maxResults=100")
  echo "$page" | jq -c '.worklogs[]'
  total=$(echo "$page" | jq '.total')
  start=$((start + 100))
  [ "$start" -ge "$total" ] && break
done
```

## Server/DC 9.17 → Cloud v3 quick map

The shared Server doc and Cloud v3 share most paths but differ in:

| Area                  | Server 9.17                       | Cloud v3                                       |
|-----------------------|-----------------------------------|------------------------------------------------|
| Base                  | `/rest/api/2/`                    | `/rest/api/3/`                                 |
| Descriptions/comments | wiki markup (string)              | ADF (JSON document)                            |
| User identity         | `username`/`key`                  | `accountId` (GDPR — username removed)          |
| `/rest/api/2/search`  | Returns full issues inline        | Cloud v3 equivalent is `/search` but some newer endpoints split into `/search/jql` |
| Permissions           | `/rest/api/2/permissions`         | `/rest/api/3/permissions` (similar shape)      |

When an endpoint from the 9.17 doc doesn't behave the same on Cloud, check
`https://developer.atlassian.com/cloud/jira/platform/rest/v3/` for the
current contract.

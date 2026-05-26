# Atlassian Document Format (ADF) Cheatsheet

ADF is the JSON format Jira Cloud uses for rich-text fields (description,
comment body). Plain strings also work for simple text, but any formatting
(lists, code blocks, mentions, panels) must be ADF.

`acli` accepts both:

- `--description "plain string"` → sent as plain text
- `--description-file ./desc.json` → sent as-is (can be ADF JSON)
- `--from-json` on `workitem create/edit` → description field can be ADF

## Minimal ADF document

```json
{
  "version": 1,
  "type": "doc",
  "content": [
    { "type": "paragraph", "content": [{ "type": "text", "text": "Hello world" }] }
  ]
}
```

## Common building blocks

### Paragraph with mixed formatting

```json
{
  "type": "paragraph",
  "content": [
    { "type": "text", "text": "See " },
    { "type": "text", "text": "runbook", "marks": [{ "type": "link", "attrs": { "href": "https://example.com" } }] },
    { "type": "text", "text": " (owner: " },
    { "type": "text", "text": "bold part", "marks": [{ "type": "strong" }] },
    { "type": "text", "text": ")." }
  ]
}
```

Text marks: `strong`, `em`, `code`, `strike`, `underline`,
`link` (with `attrs.href`), `textColor`, `subsup`.

### Headings

```json
{ "type": "heading", "attrs": { "level": 2 }, "content": [{ "type": "text", "text": "Overview" }] }
```

### Bullet / ordered list

```json
{
  "type": "bulletList",
  "content": [
    { "type": "listItem", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "First" }] }] },
    { "type": "listItem", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Second" }] }] }
  ]
}
```

`orderedList` replaces `bulletList`; item structure is identical.

### Code block

```json
{
  "type": "codeBlock",
  "attrs": { "language": "bash" },
  "content": [{ "type": "text", "text": "acli jira workitem view KEY-1 --json" }]
}
```

### Inline mention

```json
{ "type": "mention", "attrs": { "id": "<accountId>", "text": "@Name" } }
```

`accountId` is the Atlassian account id, **not** the email. Get it via
`GET /rest/api/3/user/search?query=<email>`.

### Panel (info / warning / note / success / error)

```json
{
  "type": "panel",
  "attrs": { "panelType": "info" },
  "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Heads up" }] }]
}
```

### Table (simplified)

```json
{
  "type": "table",
  "content": [
    { "type": "tableRow", "content": [
      { "type": "tableHeader", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Col A" }] }] },
      { "type": "tableHeader", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Col B" }] }] }
    ]},
    { "type": "tableRow", "content": [
      { "type": "tableCell", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "1" }] }] },
      { "type": "tableCell", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "2" }] }] }
    ]}
  ]
}
```

## Practical recipe: build ADF from Markdown-ish input

When you only need paragraphs and bullets, build ADF directly in `jq`:

```bash
body=$(jq -n --arg p1 "Deploy completed." --arg p2 "Next: monitor error rate." '{
  version: 1,
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: $p1 }] },
    { type: "paragraph", content: [{ type: "text", text: $p2 }] }
  ]
}')

echo "$body" > /tmp/comment.json
acli jira workitem comment create --key KEY-123 --body-file /tmp/comment.json --json
```

## Rendering failures to watch for

- Pasted Markdown (`**bold**`, `- list`) is rendered literally, not as ADF.
- ADF rejects unknown marks/nodes silently in some clients — validate by
  viewing the issue in the browser after creation.
- `link` marks require `href` under `attrs`; a bare `text` with a URL is
  not auto-linked.
- Mentions require a valid `accountId`; a wrong id renders as `@Unknown`.

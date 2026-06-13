# Docs Request Recipes

Copyable `requests.json` templates. Replace placeholders (`DOC_ID`, `TAB_ID`, indices, revision IDs) with actual values from your document read.

## Replace all occurrences of text

```json
{
  "requests": [
    {
      "replaceAllText": {
        "replaceText": "new text",
        "containsText": { "text": "old text", "matchCase": true }
      }
    }
  ],
  "writeControl": { "requiredRevisionId": "REVISION_ID" }
}
```

For a specific tab, add `"tabsCriteria": [{"tabId": "TAB_ID"}]` inside the request.

## Delete a range of content

```json
{
  "requests": [
    {
      "deleteContentRange": {
        "range": { "startIndex": 100, "endIndex": 110, "tabId": "TAB_ID" }
      }
    }
  ],
  "writeControl": { "requiredRevisionId": "REVISION_ID" }
}
```

## Insert text at a position

```json
{
  "requests": [
    {
      "insertText": {
        "location": { "index": 100, "tabId": "TAB_ID" },
        "text": "inserted text"
      }
    }
  ],
  "writeControl": { "requiredRevisionId": "REVISION_ID" }
}
```

## Update text style on a range

```json
{
  "requests": [
    {
      "updateTextStyle": {
        "range": { "startIndex": 100, "endIndex": 110, "tabId": "TAB_ID" },
        "textStyle": { "bold": true },
        "fields": "bold"
      }
    }
  ],
  "writeControl": { "requiredRevisionId": "REVISION_ID" }
}
```

Fields you can set: `bold`, `italic`, `underline`, `strikethrough`, `fontSize`, `weightedFontFamily`, `foregroundColor`, `backgroundColor`, `link`.

## Update paragraph style (heading, alignment)

```json
{
  "requests": [
    {
      "updateParagraphStyle": {
        "range": { "startIndex": 100, "endIndex": 110, "tabId": "TAB_ID" },
        "paragraphStyle": { "namedStyleType": "HEADING_1" },
        "fields": "namedStyleType"
      }
    }
  ],
  "writeControl": { "requiredRevisionId": "REVISION_ID" }
}
```

Named style types: `NORMAL_TEXT`, `HEADING_1` through `HEADING_6`, `TITLE`, `SUBTITLE`.

## Create a blank document

```json
{
  "requests": [
    {
      "create": { "title": "My Document" }
    }
  ]
}
```

Call via `gws docs documents create --json '{"title":"My Document"}'`.

## Insert a page break

```json
{
  "requests": [
    {
      "insertPageBreak": {
        "location": { "index": 100, "tabId": "TAB_ID" }
      }
    }
  ],
  "writeControl": { "requiredRevisionId": "REVISION_ID" }
}
```

## Delete a paragraph (by its content range)

```json
{
  "requests": [
    {
      "deleteContentRange": {
        "range": {
          "startIndex": 100,
          "endIndex": 200,
          "tabId": "TAB_ID"
        }
      }
    }
  ],
  "writeControl": { "requiredRevisionId": "REVISION_ID" }
}
```

## Multiple edits in one batch (sorted backwards)

```json
{
  "requests": [
    { "deleteContentRange": { "range": { "startIndex": 500, "endIndex": 510 } } },
    { "insertText": { "location": { "index": 200 }, "text": "world" } },
    { "insertText": { "location": { "index": 100 }, "text": "hello " } }
  ],
  "writeControl": { "requiredRevisionId": "REVISION_ID" }
}
```

Always sort descending by startIndex so later edits do not shift earlier ones.

## Drive capabilities check (via gws)

```bash
gws drive files get --params '{"fileId":"DOC_ID","supportsAllDrives":true,"fields":"id,name,capabilities(canEdit,canComment)"}'
```

## WriteControl reference

```json
{
  "writeControl": {
    "requiredRevisionId": "REVISION_ID"
  }
}
```

- `requiredRevisionId`: Fails if the document changed since you read it. Safe default.
- `targetRevisionId`: Attempts to merge with collaborator changes. Use when concurrent edits are expected.

Capture the `revisionId` from `gws docs documents get` output.

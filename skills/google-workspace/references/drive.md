# Google Drive API Reference

Placeholder for future detailed Drive guidance.

For now, use the shared auth/profile workflow from `../SKILL.md` and direct REST calls to the Drive API.

Common first use in this skill is a file capability check before editing Google Docs:

```text
GET https://www.googleapis.com/drive/v3/files/{fileId}?supportsAllDrives=true&fields=id,name,mimeType,capabilities(canEdit,canComment,canCopy,canDownload,canShare),owners(emailAddress,displayName),ownedByMe,shared
```

Recommended scopes by task:

- Metadata/capability checks: `drive-metadata`
- File creation/copy/export/share management: consider `drive` or a narrower Drive scope appropriate to the task

Always enable the Google Drive API in the Google Cloud project before calling Drive endpoints.

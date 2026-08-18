import { basename, isAbsolute, relative, resolve, sep } from "node:path";

export interface OpenFile {
   filePath: string;
   workspaceFolder?: string;
   languageId: string;
   isActive: boolean;
   isDirty: boolean;
}

export function normalizePath(value: string): string {
   const normalized = resolve(value).replaceAll("\\", "/");
   return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isPathInside(parent: string, child: string): boolean {
   const normalizedParent = normalizePath(parent);
   const normalizedChild = normalizePath(child);
   if (normalizedParent === normalizedChild) return true;
   const childRelative = relative(normalizedParent, normalizedChild);
   return childRelative !== "" && !childRelative.startsWith("..") && !isAbsolute(childRelative);
}

export function workspaceMatchesCwd(workspaceFolders: readonly string[], cwd: string): boolean {
   return workspaceFolders.some((folder) => isPathInside(folder, cwd));
}

export function sortOpenFiles(files: readonly OpenFile[]): OpenFile[] {
   return files.toSorted((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      if (a.isDirty !== b.isDirty) return a.isDirty ? -1 : 1;
      return a.filePath.localeCompare(b.filePath);
   });
}

export function formatCompletionValue(input: {
   filePath: string;
   workspaceFolder?: string;
   range?: { start: number; end: number };
   quoted?: boolean;
}): string {
   const path = input.workspaceFolder
      ? relative(input.workspaceFolder, input.filePath).split(sep).join("/")
      : input.filePath.replaceAll("\\", "/");
   const safePath = path.startsWith("..") || isAbsolute(path) ? input.filePath.replaceAll("\\", "/") : path;
   const quoted = input.quoted || safePath.includes(" ") ? `@"${safePath}"` : `@${safePath}`;
   if (!input.range) return quoted;
   const start = input.range.start + 1;
   const end = input.range.end + 1;
   return `${quoted}#L${start}${start === end ? "" : `-L${end}`}`;
}

export function describeOpenFile(file: OpenFile): string {
   const state = [file.isActive ? "active" : "", file.isDirty ? "dirty" : ""].filter(Boolean).join(", ");
   return state ? `${basename(file.filePath)} (${state})` : basename(file.filePath);
}

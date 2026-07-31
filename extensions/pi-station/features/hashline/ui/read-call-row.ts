import type { Theme } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const READ_PATH_DISPLAY_WIDTH = 96;

function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortenPath(path: string): string {
   const home = homedir();
   if (path.startsWith(home)) {
      return `~${path.slice(home.length)}`;
   }
   return path;
}

function middleTruncatePath(path: string, maxWidth = READ_PATH_DISPLAY_WIDTH): string {
   if (visibleWidth(path) <= maxWidth) {
      return path;
   }

   const tailWidth = Math.max(16, Math.floor(maxWidth * 0.6));
   const headWidth = Math.max(8, maxWidth - tailWidth - 1);
   const head = truncateToWidth(path, headWidth, "", true);
   const tailSource = path.slice(-tailWidth * 2);
   const tail = truncateToWidth(
      tailSource.slice(Math.max(0, visibleWidth(tailSource) - tailWidth)),
      tailWidth,
      "",
      true
   );
   return `${head}…${tail}`;
}

function getReadPathArg(args: unknown): string {
   if (!isRecord(args)) {
      return "";
   }
   const path = args.file_path ?? args.path;
   return typeof path === "string" ? path : "";
}

function renderReadPath(rawPath: string, theme: Theme, cwd: string, maxWidth = READ_PATH_DISPLAY_WIDTH): string {
   if (!rawPath) {
      return theme.fg("toolOutput", "...");
   }

   const displayPath = middleTruncatePath(shortenPath(rawPath), maxWidth);
   const styledPath = theme.fg("accent", displayPath);
   if (!getCapabilities().hyperlinks) {
      return styledPath;
   }

   const absolutePath = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
   return hyperlink(styledPath, pathToFileURL(absolutePath).href);
}

function formatReadLineRange(args: unknown, theme: Theme): string {
   if (!isRecord(args)) {
      return "";
   }
   if (typeof args.offset !== "number" && typeof args.limit !== "number") {
      return "";
   }

   const startLine = typeof args.offset === "number" ? args.offset : 1;
   const endLine = typeof args.limit === "number" ? startLine + args.limit - 1 : "";
   return theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
}

export class ReadCallRow implements Component {
   constructor(
      private readonly args: unknown,
      private readonly theme: Theme,
      private readonly cwd: string
   ) {}

   render(width: number): string[] {
      const prefix = `${this.theme.fg("accent", "→")} ${this.theme.fg("toolTitle", this.theme.bold("Read"))} `;
      const lineInfo = formatReadLineRange(this.args, this.theme);
      const pathWidth = Math.max(8, width - visibleWidth(prefix) - visibleWidth(lineInfo));
      const pathDisplay = renderReadPath(getReadPathArg(this.args), this.theme, this.cwd, pathWidth);
      return [`${prefix}${pathDisplay}${lineInfo}`];
   }

   invalidate(): void {}
}

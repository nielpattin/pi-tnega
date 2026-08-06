import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

const LINK_MARKER = ".harbor-link.json";
const FALLBACK_LINK_ERRORS = new Set(["EACCES", "EINVAL", "ENOTSUP", "EPERM"]);

export type AgyAgentLinkMode = "symlink" | "copy";

export interface AgyAgentLinkResult {
   readonly agentName: string;
   readonly sourcePath: string;
   readonly destinationPath: string;
   readonly mode: AgyAgentLinkMode;
}

export interface AgyAgentLinkOptions {
   readonly agyAgentsRoot?: string;
   readonly createSymlink?: (sourcePath: string, destinationPath: string, type: "file") => void;
}

interface LinkMarker {
   readonly sourcePath?: unknown;
}

function defaultAgyAgentsRoot(): string {
   return path.join(homedir(), ".gemini", "config", "agents");
}

function canonicalPath(filePath: string): string {
   return path.normalize(path.resolve(filePath)).toLowerCase();
}

function readMarker(markerPath: string): LinkMarker | undefined {
   try {
      const value: unknown = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      return value && typeof value === "object" ? (value as LinkMarker) : undefined;
   } catch {
      return undefined;
   }
}

function markerMatchesSource(marker: LinkMarker | undefined, sourcePath: string): boolean {
   return typeof marker?.sourcePath === "string" && canonicalPath(marker.sourcePath) === canonicalPath(sourcePath);
}

function writeMarker(markerPath: string, sourcePath: string): void {
   fs.writeFileSync(
      markerPath,
      JSON.stringify({ version: 1, sourcePath: path.resolve(sourcePath) }, undefined, 2) + "\n",
      "utf8"
   );
}

function isFallbackLinkError(error: unknown): boolean {
   return (
      error !== null && typeof error === "object" && "code" in error && FALLBACK_LINK_ERRORS.has(String(error.code))
   );
}

function isSafeAgentName(name: string): boolean {
   return /^[a-zA-Z0-9_-]+$/.test(name);
}

function ensureSourceAgentName(sourcePath: string, agentName: string): void {
   const content = fs.readFileSync(sourcePath, "utf8");
   const newline = content.includes("\r\n") ? "\r\n" : "\n";
   const frontmatter = content.match(/^---(?:\r?\n)([\s\S]*?)(?:\r?\n)---(?:\r?\n|$)/);
   if (frontmatter) {
      const body = frontmatter[1];
      const nameLine = body.match(/^name\s*:\s*(.*)$/m);
      const normalizedBody = nameLine
         ? body.replace(/^name\s*:\s*.*$/m, `name: ${agentName}`)
         : `name: ${agentName}${newline}${body}`;
      if (nameLine?.[1]?.trim() === agentName) return;
      const closingStart = frontmatter[0].lastIndexOf("---");
      const suffix = content.slice(closingStart + 3);
      fs.writeFileSync(sourcePath, `---${newline}${normalizedBody}${newline}---${suffix}`, "utf8");
      return;
   }

   fs.writeFileSync(sourcePath, `---${newline}name: ${agentName}${newline}---${newline}${newline}${content}`, "utf8");
}

const AGY_SUPPORTED_FRONTMATTER_KEYS = new Set(["name", "description"]);

interface AgyAgentProjection {
   readonly content: string;
   readonly canSymlink: boolean;
}

function parseFrontmatterFields(frontmatter: string): Map<string, string> {
   const fields = new Map<string, string>();
   for (const line of frontmatter.split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (match) fields.set(match[1], match[2]);
   }
   return fields;
}

function parseYamlScalar(value: string): string {
   const trimmed = value.trim();
   if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      try {
         return JSON.parse(trimmed) as string;
      } catch {
         return trimmed.slice(1, -1);
      }
   }
   if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'");
   return trimmed;
}

function getAgyAgentProjection(sourcePath: string, agentName: string): AgyAgentProjection {
   const content = fs.readFileSync(sourcePath, "utf8");
   const newline = content.includes("\r\n") ? "\r\n" : "\n";
   const frontmatter = content.match(/^---(?:\r?\n)([\s\S]*?)(?:\r?\n)---(?:\r?\n|$)/);
   if (!frontmatter) {
      return {
         content: `---${newline}name: ${agentName}${newline}description: ${JSON.stringify(`Harbor agent ${agentName}`)}${newline}---${newline}${content}`,
         canSymlink: false
      };
   }

   const fields = parseFrontmatterFields(frontmatter[1]);
   const unsupportedKeys = [...fields.keys()].some((key) => !AGY_SUPPORTED_FRONTMATTER_KEYS.has(key));
   const description = fields.get("description");
   if (!unsupportedKeys && fields.get("name") && description) return { content, canSymlink: true };

   const body = content.slice(frontmatter[0].length);
   const descriptionValue = description ? parseYamlScalar(description) : `Harbor agent ${agentName}`;
   return {
      content: `---${newline}name: ${agentName}${newline}description: ${JSON.stringify(descriptionValue)}${newline}---${newline}${body}`,
      canSymlink: false
   };
}

/**
 * Make an Agy custom-agent path follow a Harbor/Pi agent file.
 *
 * Symlinks are preferred when the source frontmatter is valid for Agy. Pi
 * agent files usually contain extra Pi-only metadata, so those files use a
 * managed Agy-compatible projection that is refreshed before each Agy run.
 * Windows can also reject file symlink creation without Developer Mode or
 * elevation, which uses the same managed-copy fallback.
 */
export function ensureAgyAgentLink(
   agentName: string,
   sourcePath: string,
   options: AgyAgentLinkOptions = {}
): AgyAgentLinkResult {
   if (!isSafeAgentName(agentName)) {
      throw new Error(`Invalid Agy agent name "${agentName}".`);
   }

   const source = path.resolve(sourcePath);
   fs.statSync(source);
   ensureSourceAgentName(source, agentName);
   const sourceCanonical = fs.realpathSync.native(source);
   const projection = getAgyAgentProjection(source, agentName);
   const agentsRoot = options.agyAgentsRoot ?? defaultAgyAgentsRoot();
   const destinationDir = path.join(agentsRoot, agentName);
   const destination = path.join(destinationDir, "agent.md");
   const markerPath = path.join(destinationDir, LINK_MARKER);
   const marker = readMarker(markerPath);

   fs.mkdirSync(destinationDir, { recursive: true });

   const copyProjection = (): AgyAgentLinkResult => {
      fs.writeFileSync(destination, projection.content, "utf8");
      writeMarker(markerPath, sourceCanonical);
      return { agentName, sourcePath: source, destinationPath: destination, mode: "copy" };
   };
   const createSymlink = options.createSymlink ?? ((target, link, type) => fs.symlinkSync(target, link, type));
   const linkSource = (): AgyAgentLinkResult => {
      if (!projection.canSymlink) return copyProjection();
      try {
         createSymlink(source, destination, "file");
         writeMarker(markerPath, sourceCanonical);
         return { agentName, sourcePath: source, destinationPath: destination, mode: "symlink" };
      } catch (error) {
         if (!isFallbackLinkError(error)) throw error;
         return copyProjection();
      }
   };

   let destinationStats: fs.Stats | undefined;
   try {
      destinationStats = fs.lstatSync(destination);
   } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
   }

   if (destinationStats?.isSymbolicLink()) {
      let destinationTarget: string | undefined;
      try {
         destinationTarget = fs.realpathSync.native(destination);
      } catch {
         // A broken managed link can be safely replaced below.
      }
      if (destinationTarget && canonicalPath(destinationTarget) === canonicalPath(sourceCanonical)) {
         if (projection.canSymlink) {
            writeMarker(markerPath, sourceCanonical);
            return { agentName, sourcePath: source, destinationPath: destination, mode: "symlink" };
         }
         fs.unlinkSync(destination);
         return copyProjection();
      }
      if (!markerMatchesSource(marker, source)) {
         throw new Error(`Agy agent "${agentName}" already exists at ${destination} and is not Harbor-managed.`);
      }
      fs.unlinkSync(destination);
   } else if (destinationStats?.isFile()) {
      if (!markerMatchesSource(marker, source)) {
         const sameContent = fs.readFileSync(destination, "utf8") === projection.content;
         if (!sameContent) {
            throw new Error(`Agy agent "${agentName}" already exists at ${destination} and is not Harbor-managed.`);
         }
      }
      return copyProjection();
   } else if (destinationStats) {
      throw new Error(`Agy agent path ${destination} is not a file or symlink.`);
   }

   return linkSource();
}

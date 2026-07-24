#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const startMarker = "<!-- package-changelog-summary -->";
const endMarker = "<!-- /package-changelog-summary -->";
const rootChangelogPath = "CHANGELOG.md";

function packageDirs() {
   return readdirSync("packages", { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join("packages", entry.name));
}

function latestSection(changelog) {
   const heading = /^## \[?([^\]\n]+)\]?(?: - ([0-9]{4}-[0-9]{2}-[0-9]{2}))?\s*$/gm;
   let match;

   while ((match = heading.exec(changelog))) {
      if (match[1].toLowerCase() === "unreleased") continue;

      const start = match.index;
      const next = heading.exec(changelog);
      const end = next ? next.index : changelog.length;
      if (next) heading.lastIndex = next.index;

      const body = changelog.slice(start, end).trim();
      const cleaned = body.replace(/^All notable changes[\s\S]*?v2\.0\.0\.html\)\.\s*/m, "").trim();

      return {
         version: match[1],
         date: match[2],
         body: cleaned || body
      };
   }

   return undefined;
}

function summary() {
   const sections = [];

   for (const dir of packageDirs()) {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      const changelogPath = join(dir, "CHANGELOG.md");
      let section;

      try {
         section = latestSection(readFileSync(changelogPath, "utf8"));
      } catch {
         section = undefined;
      }

      sections.push(`### ${manifest.name}\n\n${section ? section.body : "No released changelog entry found."}\n`);
   }

   return sections.join("\n").trimEnd();
}

function update(content, generated) {
   const replacement = `${startMarker}\n${generated}\n\n${endMarker}`;

   if (!content.includes(startMarker) || !content.includes(endMarker)) {
      return `${content.trimEnd()}\n\n${replacement}\n`;
   }

   const start = content.indexOf(startMarker);
   const end = content.indexOf(endMarker, start);
   if (end === -1) {
      throw new Error(`missing end marker: ${endMarker}`);
   }

   return `${content.slice(0, start)}${replacement}${content.slice(end + endMarker.length)}`;
}

let current;
try {
   current = readFileSync(rootChangelogPath, "utf8");
} catch {
   current = "# Changelog\n\nThis file summarizes the latest package changelog entries.\n";
}

writeFileSync(rootChangelogPath, update(current, summary()));

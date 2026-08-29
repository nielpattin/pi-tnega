import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import type { ExtractedDocument } from "../domain.ts";

function createTurndownService(): TurndownService {
   const turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      hr: "---",
      bulletListMarker: "-"
   });

   // Remove script, style, noscript, etc.
   turndown.remove(["script", "style", "noscript", "iframe", "svg"]);

   return turndown;
}

export function extractHtmlContent(
   html: string,
   options: { readonly includeLinks?: boolean; readonly baseUrl?: string } = {}
): ExtractedDocument {
   const { document } = parseHTML(html);

   // Extract links if requested
   const links: string[] = [];
   if (options.includeLinks) {
      const anchorElements = document.querySelectorAll("a[href]");
      const seen = new Set<string>();
      for (const anchor of anchorElements) {
         const href = anchor.getAttribute("href");
         if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) {
            continue;
         }

         let resolvedHref = href;
         if (options.baseUrl) {
            try {
               resolvedHref = new URL(href, options.baseUrl).toString();
            } catch {}
         }

         if (!seen.has(resolvedHref)) {
            seen.add(resolvedHref);
            const anchorText = anchor.textContent?.trim() || "";
            links.push(anchorText ? `[${anchorText}](${resolvedHref})` : resolvedHref);
         }
      }
   }

   // Try Readability first
   const turndown = createTurndownService();
   try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reader = new Readability(document as any);
      const article = reader.parse();

      if (article && article.content) {
         const markdownContent = turndown.turndown(article.content).trim();
         return {
            title: article.title || document.title || undefined,
            byline: article.byline || undefined,
            excerpt: article.excerpt || undefined,
            content: markdownContent,
            links: links.length > 0 ? links : undefined
         };
      }
   } catch {}

   // Fallback: clean the document body and turn down to markdown
   const body = document.body;
   if (body) {
      const elementsToRemove = body.querySelectorAll(
         "script, style, noscript, nav, header, footer, aside, iframe, svg"
      );
      for (const el of elementsToRemove) {
         el.remove();
      }
      const rawMarkdown = turndown.turndown(body.innerHTML).trim();
      return {
         title: document.title || undefined,
         content: rawMarkdown || body.textContent?.trim() || "",
         links: links.length > 0 ? links : undefined
      };
   }

   return {
      title: document.title || undefined,
      content: document.textContent?.trim() || "",
      links: links.length > 0 ? links : undefined
   };
}

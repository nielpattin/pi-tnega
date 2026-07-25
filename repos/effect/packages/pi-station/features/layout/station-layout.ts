// Segment layout computation, pure functions that determine
// Which segments fit on the top bar vs secondary row.
// No extension state or TUI dependencies.

import { visibleWidth } from "@earendil-works/pi-tui";
import type { CustomStatusItem, SegmentContext, StatusLineSegmentId } from "../../types.ts";
import { renderSegment } from "../../segments.ts";
import { getSeparator } from "../../separators.ts";
import { DEFAULT_LAYOUT } from "../../default-layout.ts";
import { getFgAnsiCode } from "../../colors.ts";
import { ansi } from "../../colors.ts";
import { mergeSegmentsWithCustomItems } from "../../station-config.ts";

export interface LayoutResult {
   topContent: string;
   secondaryContent: string;
   tertiaryContent: string;
}

function renderSegmentWithWidth(
   segId: StatusLineSegmentId,
   ctx: SegmentContext
): { content: string; width: number; visible: boolean } {
   const rendered = renderSegment(segId, ctx);
   if (!rendered.visible || !rendered.content) {
      return { content: "", visible: false, width: 0 };
   }
   return { content: rendered.content, visible: true, width: visibleWidth(rendered.content) };
}

function buildContentFromParts(parts: string[]): string {
   if (parts.length === 0) {
      return "";
   }
   const separatorDef = getSeparator();
   const sepAnsi = getFgAnsiCode("sep");
   const sep = separatorDef.left;
   return parts.join(` ${sepAnsi}${sep}${ansi.reset} `) + ansi.reset;
}

/**
 * Responsive segment layout, fits segments into top bar and overflows to secondary row.
 */
export function computeResponsiveLayout(
   ctx: SegmentContext,
   availableWidth: number,
   customItems: CustomStatusItem[]
): LayoutResult {
   const separatorDef = getSeparator();
   const sepWidth = visibleWidth(separatorDef.left) + 2;

   const mergedSegments = mergeSegmentsWithCustomItems(DEFAULT_LAYOUT, customItems);
   const leftIds = mergedSegments.leftSegments;
   const rightIds = mergedSegments.rightSegments;
   const secondaryIds = mergedSegments.secondarySegments;
   const secondaryRightIds = mergedSegments.secondaryRightSegments;
   const tertiaryIds = mergedSegments.tertiarySegments;

   // Render left segments and right segments separately.
   const renderedLeft: { content: string; width: number }[] = [];
   for (const segId of leftIds) {
      const { content, width, visible } = renderSegmentWithWidth(segId, ctx);
      if (visible) {
         renderedLeft.push({ content, width });
      }
   }

   const renderedRight: { content: string; width: number }[] = [];
   for (const segId of rightIds) {
      const { content, width, visible } = renderSegmentWithWidth(segId, ctx);
      if (visible) {
         renderedRight.push({ content, width });
      }
   }

   const renderedSecondary: { content: string; width: number }[] = [];
   for (const segId of secondaryIds) {
      const { content, width, visible } = renderSegmentWithWidth(segId, ctx);
      if (visible) {
         renderedSecondary.push({ content, width });
      }
   }

   const renderedSecondaryRight: { content: string; width: number }[] = [];
   for (const segId of secondaryRightIds) {
      const { content, width, visible } = renderSegmentWithWidth(segId, ctx);
      if (visible) {
         renderedSecondaryRight.push({ content, width });
      }
   }

   const renderedTertiary: { content: string; width: number }[] = [];
   for (const segId of tertiaryIds) {
      const { content, width, visible } = renderSegmentWithWidth(segId, ctx);
      if (visible) {
         renderedTertiary.push({ content, width });
      }
   }

   if (
      renderedLeft.length === 0 &&
      renderedRight.length === 0 &&
      renderedSecondary.length === 0 &&
      renderedSecondaryRight.length === 0 &&
      renderedTertiary.length === 0
   ) {
      return { secondaryContent: "", tertiaryContent: "", topContent: "" };
   }

   // ── Top bar: left segments on the left, right segments on the right ──
   const baseOverhead = 2;

   // Build left content.
   let leftWidth = baseOverhead;
   const leftParts: string[] = [];
   for (const seg of renderedLeft) {
      const needed = seg.width + (leftParts.length > 0 ? sepWidth : 0);
      if (leftWidth + needed <= availableWidth) {
         leftParts.push(seg.content);
         leftWidth += needed;
      } else {
         break;
      }
   }

   // Build right content.
   let rightWidth = 0;
   const rightParts: string[] = [];
   for (const seg of renderedRight) {
      const needed = seg.width + (rightParts.length > 0 ? sepWidth : 0);
      if (rightWidth + needed + baseOverhead <= availableWidth - leftWidth) {
         rightParts.push(seg.content);
         rightWidth += needed;
      } else {
         break;
      }
   }

   // Assemble top bar: left content + padding + right content.
   const leftStr = buildContentFromParts(leftParts);
   const leftStrWidth = visibleWidth(leftStr);
   const rightStr = rightParts.length > 0 ? buildContentFromParts(rightParts) : "";
   const rightStrWidth = visibleWidth(rightStr);

   let topContent: string;
   if (rightStr && leftStrWidth + rightStrWidth <= availableWidth) {
      const padding = " ".repeat(availableWidth - leftStrWidth - rightStrWidth);
      topContent = leftStr + padding + rightStr.trimStart();
   } else {
      topContent = leftStr;
   }

   // ── Secondary row: left segments on left, right segments right-aligned ──
   let secondaryWidth = baseOverhead;
   const secondarySegments: string[] = [];
   for (const seg of renderedSecondary) {
      const needed = seg.width + (secondarySegments.length > 0 ? sepWidth : 0);
      if (secondaryWidth + needed <= availableWidth) {
         secondarySegments.push(seg.content);
         secondaryWidth += needed;
      } else {
         break;
      }
   }

   // Build secondary right content.
   let secondaryRightWidth = 0;
   const secondaryRightSegments: string[] = [];
   for (const seg of renderedSecondaryRight) {
      const needed = seg.width + (secondaryRightSegments.length > 0 ? sepWidth : 0);
      if (secondaryRightWidth + needed + baseOverhead <= availableWidth - secondaryWidth) {
         secondaryRightSegments.push(seg.content);
         secondaryRightWidth += needed;
      } else {
         break;
      }
   }

   // Assemble secondary row with right-alignment.
   const secLeftStr = buildContentFromParts(secondarySegments);
   const secLeftStrWidth = visibleWidth(secLeftStr);
   const secRightStr = secondaryRightSegments.length > 0 ? buildContentFromParts(secondaryRightSegments) : "";
   const secRightStrWidth = visibleWidth(secRightStr);

   let secondaryContent: string;
   if (secRightStr && secLeftStrWidth + secRightStrWidth <= availableWidth) {
      const padding = " ".repeat(availableWidth - secLeftStrWidth - secRightStrWidth);
      secondaryContent = secLeftStr + padding + secRightStr.trimStart();
   } else {
      secondaryContent = secLeftStr;
   }

   // ── Tertiary row ──
   let tertiaryWidth = baseOverhead;
   const tertiarySegments: string[] = [];

   for (const seg of renderedTertiary) {
      const needed = seg.width + (tertiarySegments.length > 0 ? sepWidth : 0);
      if (tertiaryWidth + needed <= availableWidth) {
         tertiarySegments.push(seg.content);
         tertiaryWidth += needed;
      } else {
         break;
      }
   }

   return {
      secondaryContent,
      tertiaryContent: buildContentFromParts(tertiarySegments),
      topContent
   };
}

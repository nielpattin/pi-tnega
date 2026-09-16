import type { Theme } from "@earendil-works/pi-coding-agent";
import { anchorRowRenderer } from "./hashline.js";
import type {
  ExternalToolAudit,
  ExternalToolRenderBody,
  ExternalToolRenderContext,
  ExternalToolRenderer,
} from "./types.js";

const renderers: ExternalToolRenderer[] = [anchorRowRenderer];

const rendererFor = (audit: ExternalToolAudit): ExternalToolRenderer | undefined =>
  renderers.find((renderer) => renderer.matches(audit));

export const externalToolCallDetail = (audit: ExternalToolAudit): string | undefined =>
  rendererFor(audit)?.callDetail?.(audit);

export const renderExternalToolBody = (
  audit: ExternalToolAudit,
  theme: Theme,
  context: ExternalToolRenderContext,
): ExternalToolRenderBody | undefined => rendererFor(audit)?.renderBody?.(audit, theme, context);

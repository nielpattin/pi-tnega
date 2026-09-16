import type { Theme } from "@earendil-works/pi-coding-agent";

export interface ExternalToolAudit {
  ref: string;
  provider?: string;
  tool?: string;
  success?: boolean;
  args?: Record<string, unknown>;
  result?: unknown;
}

export interface ExternalToolRenderContext {
  maxLines: number;
  expanded: boolean;
  invalidate?: () => void;
}

export interface ExternalToolRenderBody {
  lines: string[];
  hidden: number;
}

export interface ExternalToolRenderer {
  id: string;
  matches(audit: ExternalToolAudit): boolean;
  /** Return undefined for the default argument headline, or an empty string to suppress it. */
  callDetail?(audit: ExternalToolAudit): string | undefined;
  renderBody?(
    audit: ExternalToolAudit,
    theme: Theme,
    context: ExternalToolRenderContext,
  ): ExternalToolRenderBody | undefined;
}

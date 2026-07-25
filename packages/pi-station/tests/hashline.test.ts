import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { computeLineHash } from "../features/hashline/core/hashline.ts";
import { formatHashlineReadPreview } from "../features/hashline/read-tool.ts";
import { ReadCallRow } from "../features/hashline/ui/read-call-row.ts";

const theme = {
   bold: (text: string) => text,
   fg: (_token: string, text: string) => text,
};

describe("hashline read", () => {
   test("formats read output with line hashes", () => {
      const preview = formatHashlineReadPreview("alpha\nbeta\ngamma\n", { offset: 2, limit: 2 });

      expect(preview.text).toBe(`2#${computeLineHash(2, "beta")}:beta\n3#${computeLineHash(3, "gamma")}:gamma`);
   });

   test("renders long read paths on one width-aware row", () => {
      const row = new ReadCallRow(
         {
            path: "C:/Users/niel/.pi/agent/packages/pi-station/fixed-editor/terminal-split.ts",
            offset: 670,
            limit: 190,
         },
         theme as any,
         "C:/Users/niel/.pi/agent/packages/pi-station",
      );

      const rendered = row.render(60);

      expect(rendered).toHaveLength(1);
      expect(visibleWidth(rendered[0]!)).toBeLessThanOrEqual(60);
      expect(rendered[0]).toContain("→ Read ");
      expect(rendered[0]).toContain(":670-859");
   });
});

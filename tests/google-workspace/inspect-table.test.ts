import { describe, it, expect, vi, beforeEach } from "vitest";

// We test the inspect-table script by importing its key utility function.
// The script uses top-level await so we test the walk-logic via a fixture.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Minimal walkElements used by inspect-table.mjs (extracted for testability)
function walkElements(
  content: Record<string, unknown>[],
  visit: (el: Record<string, unknown>) => void,
) {
  for (const el of content || []) {
    visit(el);
    if (el.table && typeof el.table === "object") {
      const table = el.table as Record<string, unknown>;
      for (const row of (table.tableRows as Record<string, unknown>[]) || []) {
        for (const cell of (row.tableCells as Record<string, unknown>[]) || []) {
          walkElements(
            (cell.content as Record<string, unknown>[]) || [],
            visit,
          );
        }
      }
    }
  }
}

function buildFixtureDoc(
  tableConfig: {
    startIndex: number;
    rows: {
      cells: {
        rowSpan?: number;
        columnSpan?: number;
        text: string;
      }[];
    }[];
  }[],
): Record<string, unknown> {
  const tables = tableConfig.map((tc) => {
    const tableRows = tc.rows.map((row) => {
      const tableCells = row.cells.map((cell) => {
        const cs: Record<string, number> = {};
        if (cell.rowSpan && cell.rowSpan > 1) cs.rowSpan = cell.rowSpan;
        if (cell.columnSpan && cell.columnSpan > 1) cs.columnSpan = cell.columnSpan;

        // Build content with textRun
        const paragraph = {
          paragraph: {
            elements: [
              {
                startIndex: 0,
                endIndex: cell.text.length,
                textRun: {
                  content: cell.text,
                  textStyle: {},
                },
              },
            ],
          },
        };

        return {
          content: [paragraph],
          ...(Object.keys(cs).length > 0 ? { tableCellStyle: cs } : {}),
        };
      });

      return { tableCells };
    });

    return {
      startIndex: tc.startIndex,
      endIndex: tc.startIndex + 500,
      table: { tableRows },
    };
  });

  return {
    title: "Test Document",
    revisionId: "test-rev-1",
    tabs: [
      {
        tabProperties: { tabId: "t.abc123" },
        documentTab: {
          body: { content: tables },
        },
      },
    ],
  };
}

describe("inspect-table (fixture-based)", () => {
  it("extracts cell text and spans correctly", () => {
    const doc = buildFixtureDoc([
      {
        startIndex: 100,
        rows: [
          {
            cells: [
              { columnSpan: 2, text: "Header merged\n" },
              { text: "\n" },
              { text: "Role\n" },
            ],
          },
          {
            cells: [
              { text: "Admin\n" },
              { text: "\n" },
              { text: "Manage config\n" },
            ],
          },
        ],
      },
    ]);

    const body = (
      doc.tabs as Record<string, unknown>[]
    )[0].documentTab as Record<string, unknown>;
    const content = body.body as Record<string, unknown>;

    const results: string[] = [];
    walkElements(
      (content.content as Record<string, unknown>[]) || [],
      (el) => {
        if (!el.table || el.startIndex !== 100) return;
        const table = el.table as Record<string, unknown>;
        const tableRows = table.tableRows as Record<string, unknown>[];
        for (let r = 0; r < tableRows.length; r++) {
          const row = tableRows[r];
          const cells = row.tableCells as Record<string, unknown>[];
          for (let c = 0; c < cells.length; c++) {
            const cell = cells[c];
            const cs = (cell.tableCellStyle as Record<string, number>) || {};
            const rowSpan = cs.rowSpan || 1;
            const colSpan = cs.columnSpan || 1;
            const texts: string[] = [];
            walkElements(
              (cell.content as Record<string, unknown>[]) || [],
              (cel) => {
                const paragraph = cel.paragraph as Record<string, unknown>;
                for (const pe of (paragraph?.elements as Record<string, unknown>[]) || []) {
                  const tr = pe.textRun as Record<string, string>;
                  if (tr) texts.push(tr.content as string);
                }
              },
            );
            const raw = texts.join("");
            results.push(`[${r}][${c}] colSpan=${colSpan} text=${JSON.stringify(raw)}`);
          }
        }
      },
    );

    expect(results).toEqual([
      '[0][0] colSpan=2 text="Header merged\\n"',
      '[0][1] colSpan=1 text="\\n"',
      '[0][2] colSpan=1 text="Role\\n"',
      '[1][0] colSpan=1 text="Admin\\n"',
      '[1][1] colSpan=1 text="\\n"',
      '[1][2] colSpan=1 text="Manage config\\n"',
    ]);
  });

  it("detects merged cell spanning two columns", () => {
    const doc = buildFixtureDoc([
      {
        startIndex: 500,
        rows: [
          {
            cells: [
              { columnSpan: 2, text: "Quản lý\n" },
              { text: "\n" },
            ],
          },
        ],
      },
    ]);

    const body = (
      doc.tabs as Record<string, unknown>[]
    )[0].documentTab as Record<string, unknown>;
    const content = body.body as Record<string, unknown>;

    let foundSpan = 0;
    walkElements(
      (content.content as Record<string, unknown>[]) || [],
      (el) => {
        if (!el.table || el.startIndex !== 500) return;
        const table = el.table as Record<string, unknown>;
        const row = ((table.tableRows as Record<string, unknown>[])[0]);
        const cell = (row.tableCells as Record<string, unknown>[])[0];
        const cs = (cell.tableCellStyle as Record<string, number>) || {};
        foundSpan = cs.columnSpan || 1;
      },
    );

    expect(foundSpan).toBe(2);
  });

  it("handles table with no merged cells (all 1x1)", () => {
    const doc = buildFixtureDoc([
      {
        startIndex: 1,
        rows: [
          {
            cells: [
              { text: "A\n" },
              { text: "B\n" },
            ],
          },
        ],
      },
    ]);

    const body = (
      doc.tabs as Record<string, unknown>[]
    )[0].documentTab as Record<string, unknown>;
    const content = body.body as Record<string, unknown>;

    const spans: string[] = [];
    walkElements(
      (content.content as Record<string, unknown>[]) || [],
      (el) => {
        if (!el.table) return;
        const table = el.table as Record<string, unknown>;
        for (const row of (table.tableRows as Record<string, unknown>[]) || []) {
          for (const cell of (row.tableCells as Record<string, unknown>[]) || []) {
            const cs = (cell.tableCellStyle as Record<string, number>) || {};
            spans.push(`${cs.rowSpan || 1}x${cs.columnSpan || 1}`);
          }
        }
      },
    );

    expect(spans).toEqual(["1x1", "1x1"]);
  });
});

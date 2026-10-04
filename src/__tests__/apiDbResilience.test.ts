import { describe, it, expect } from "vitest";
import { rowToSummary, rowToTemplate, type TemplateRow } from "../../api/src/db";

// Regression coverage for the D1 list-endpoint resilience fix: a single row with
// malformed JSON in a JSON-array column (ports / slots / search_terms / auxiliary_data)
// must degrade to empty instead of throwing, otherwise it 500s the entire public
// library (GET /templates, /templates/summary). See api/src/db.ts parseJsonArray.

function makeRow(overrides: Partial<TemplateRow> = {}): TemplateRow {
  return {
    id: "t1",
    version: 1,
    device_type: "switch",
    category: "Network",
    label: "Test Switch",
    short_name: null,
    hostname: null,
    manufacturer: null,
    model_number: null,
    color: null,
    image_url: null,
    reference_url: null,
    search_terms: null,
    ports: "[]",
    slots: null,
    slot_family: null,
    power_draw_w: null,
    power_capacity_w: null,
    voltage: null,
    thermal_btuh: null,
    poe_budget_w: null,
    poe_draw_w: null,
    unit_cost: null,
    is_venue_provided: null,
    height_mm: null,
    width_mm: null,
    depth_mm: null,
    weight_kg: null,
    auxiliary_data: null,
    sort_order: 0,
    ...overrides,
  };
}

describe("db row serializers — malformed JSON resilience", () => {
  it("rowToSummary does not throw on comma-joined (non-JSON) search_terms", () => {
    const row = makeRow({ search_terms: "networking,switch,poe" });
    expect(() => rowToSummary(row)).not.toThrow();
    // Malformed → degrades to omitted/empty, not a crash.
    expect(rowToSummary(row).searchTerms ?? []).toEqual([]);
  });

  it("rowToSummary does not throw on malformed ports and reports portCount 0", () => {
    const row = makeRow({ ports: "not json at all" });
    expect(() => rowToSummary(row)).not.toThrow();
    const summary = rowToSummary(row);
    expect(summary.portCount).toBe(0);
    expect(summary.signalTypes).toEqual([]);
  });

  it("rowToSummary does not throw when ports is a valid array containing a null element", () => {
    // The subtler case: valid JSON, but an element is null → p.signalType would throw.
    const row = makeRow({ ports: "[null]" });
    expect(() => rowToSummary(row)).not.toThrow();
    expect(rowToSummary(row).portCount).toBe(0);
  });

  it("rowToSummary still parses well-formed ports/search_terms correctly", () => {
    const row = makeRow({
      ports: JSON.stringify([
        { signalType: "hdmi" },
        { signalType: "hdmi" },
        { signalType: "network" },
      ]),
      search_terms: JSON.stringify(["a", "b"]),
    });
    const summary = rowToSummary(row);
    expect(summary.portCount).toBe(3);
    expect(summary.signalTypes.sort()).toEqual(["hdmi", "network"]);
    expect(summary.searchTerms).toEqual(["a", "b"]);
  });

  it("rowToTemplate does not throw on malformed ports/slots/auxiliary_data", () => {
    const row = makeRow({
      ports: "{bad",
      slots: "also bad",
      auxiliary_data: "nope",
      search_terms: "x,y,z",
    });
    expect(() => rowToTemplate(row)).not.toThrow();
    const tpl = rowToTemplate(row);
    expect(tpl.ports).toEqual([]);
    // slots/auxiliaryData are conditionally spread; when the raw column is a
    // (malformed) non-null string they degrade to an empty array.
    expect(tpl.slots ?? []).toEqual([]);
  });

  it("rowToTemplate preserves well-formed data", () => {
    const ports = [{ signalType: "hdmi", direction: "input" }];
    const row = makeRow({ ports: JSON.stringify(ports) });
    expect(rowToTemplate(row).ports).toEqual(ports);
  });
});

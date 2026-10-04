// transformLabel is the single chokepoint for the display-case preference (#294) — every
// label type (device names, port labels, sections, slots, cards, rooms) goes through it.
//
// "Capitalize Words" used to only uppercase word-initials, so anything already in caps
// survived untouched: a room typed TECH TABLE stayed TECH TABLE. Plain title case would
// fix that and break AV labels instead (HDMI In 1 -> Hdmi In 1), so the mode is
// acronym-aware: known acronyms typed in caps are kept, everything else is title-cased,
// and lowercase is never promoted to uppercase.
//
// Room- and stub-level coverage lives in roomLabelCase.test.ts / stubLabelCase.test.ts;
// this file pins the transform itself.

import { describe, it, expect } from "vitest";
import { transformLabel } from "../labelCaseUtils";
import { CONNECTOR_LABELS, SIGNAL_LABELS, type LabelCaseMode } from "../types";

const cap = (t: string) => transformLabel(t, "capitalize");

describe("capitalize mode — the maintainer's reference table (#294)", () => {
  it.each([
    ["TECH TABLE", "Tech Table"],
    ["main Hall", "Main Hall"],
    ["HDMI In 1", "HDMI In 1"],
    ["SDI OUT 2", "SDI Out 2"],
    ["RJ45 ETHERNET", "RJ45 Ethernet"],
    ["EXTRON DTP 84", "Extron DTP 84"],
  ])("%s -> %s", (input, expected) => {
    expect(cap(input)).toBe(expected);
  });

  it("no longer lets all-caps input pass through unchanged", () => {
    // The actual bug report: every word-initial was already uppercase, so the old
    // /\b\w/ replace was a no-op on shouty input.
    expect(cap("TECH TABLE")).not.toBe("TECH TABLE");
  });
});

describe("capitalize mode never promotes lowercase to uppercase", () => {
  it.each([
    ["dsp rack", "Dsp Rack"],
    ["hdmi in", "Hdmi In"],
    ["foh position", "Foh Position"],
    ["usb hub", "Usb Hub"],
  ])("%s -> %s", (input, expected) => {
    // Promoting would be unpredictable and would wreck real words that collide with
    // acronyms (led, dip, pan). The transform only protects caps the user typed.
    expect(cap(input)).toBe(expected);
  });
});

describe("capitalize mode acronym handling", () => {
  it("keeps acronyms drawn from the connector and signal tables", () => {
    // These come from CONNECTOR_LABELS/SIGNAL_LABELS, not from a hand-written list.
    expect(cap("XLR PANEL")).toBe("XLR Panel");
    expect(cap("BNC PATCH")).toBe("BNC Patch");
    expect(cap("TOSLINK BREAKOUT")).toBe("TOSLINK Breakout");
    expect(cap("MADI SNAKE")).toBe("MADI Snake");
    expect(cap("USB EXTENDER")).toBe("USB Extender");
    expect(cap("DMX SPLITTER")).toBe("DMX Splitter");
  });

  it("keeps the hand-curated rack and trade acronyms", () => {
    expect(cap("DSP RACK")).toBe("DSP Rack");
    expect(cap("FOH IDF")).toBe("FOH IDF");
    expect(cap("UPS / PDU")).toBe("UPS / PDU");
    expect(cap("PTZ CAMERA")).toBe("PTZ Camera");
    expect(cap("LED WALL")).toBe("LED Wall");
  });

  it("title-cases all-caps words that are not acronyms", () => {
    expect(cap("PROJECTOR")).toBe("Projector");
    expect(cap("ETHERNET SWITCH")).toBe("Ethernet Switch");
    expect(cap("STAGE RIGHT")).toBe("Stage Right");
    // Brand names whose table entry is mixed-case are not acronyms, so they land on
    // their conventional spelling rather than staying shouty.
    expect(cap("DANTE PATCH")).toBe("Dante Patch");
  });

  it("derives the acronym list from the label tables rather than duplicating it", () => {
    // Spot-check the derivation rule against the tables themselves: an ALL-CAPS,
    // digit-free word of a connector/signal display name must survive capitalize mode.
    const derived = [...Object.values(CONNECTOR_LABELS), ...Object.values(SIGNAL_LABELS)]
      .flatMap((label) => label.match(/[A-Za-z0-9]+/g) ?? [])
      .filter((w) => w.length > 1 && !/[0-9]/.test(w) && w === w.toUpperCase());
    expect(derived.length).toBeGreaterThan(20);
    for (const word of derived) expect(cap(`${word} PANEL`)).toBe(`${word} Panel`);
  });

  it("is case-sensitive about what it protects — only ALL-CAPS words are candidates", () => {
    expect(cap("hdmi")).toBe("Hdmi");
    expect(cap("Hdmi")).toBe("Hdmi");
    expect(cap("HDMI")).toBe("HDMI");
  });

  it("does not treat a single letter as an acronym", () => {
    expect(cap("ROOM A")).toBe("Room A");
    expect(cap("a rack")).toBe("A Rack");
  });
});

describe("capitalize mode leaves words containing a digit alone", () => {
  it.each([
    ["RJ45", "RJ45"],
    ["4K SWITCHER", "4K Switcher"],
    ["XLR-3 PANEL", "XLR-3 Panel"],
    ["NEMA L21-30", "NEMA L21-30"],
    ["DTP 84", "DTP 84"],
    ["QSFP28 UPLINK", "QSFP28 Uplink"],
  ])("%s -> %s", (input, expected) => {
    // Part codes and model numbers must never be re-cased.
    expect(cap(input)).toBe(expected);
  });

  it("leaves a lowercase model number alone too, rather than half-casing it", () => {
    expect(cap("1080p feed")).toBe("1080p Feed");
    expect(cap("rack 2")).toBe("Rack 2");
  });
});

describe("capitalize mode keeps deliberate internal capitals", () => {
  // Chosen deviation from plain title case: a word with a capital after its first
  // character was typed that way on purpose, and AV vocabulary is full of them
  // (DisplayPort, HDBaseT, EtherCon, powerCON, speakON). Flattening those is the same
  // failure the acronym list exists to prevent. To title-case them instead, drop the
  // internal-capital branch in capitalizeWords.
  it.each([
    ["DisplayPort IN", "DisplayPort In"],
    ["HDBaseT RX", "HDBaseT RX"],
    ["powerCON true1", "powerCON true1"],
    ["iMac bay", "iMac Bay"],
    ["MacBook Pro", "MacBook Pro"],
    ["O'Brien HALL", "O'Brien Hall"],
  ])("%s -> %s", (input, expected) => {
    expect(cap(input)).toBe(expected);
  });
});

describe("capitalize mode and punctuation", () => {
  it("capitalizes after a hyphen but not after an apostrophe", () => {
    expect(cap("joe's bar")).toBe("Joe's Bar");
    expect(cap("JOE'S BAR")).toBe("Joe's Bar");
    expect(cap("stage-left wing")).toBe("Stage-Left Wing");
    expect(cap("HDMI-OUT")).toBe("HDMI-Out");
  });

  it("treats slashes, parentheses and quotes as separators and preserves them", () => {
    expect(cap("AUDIO/VIDEO RACK")).toBe("Audio/Video Rack");
    expect(cap("BOOTH (UPPER)")).toBe("Booth (Upper)");
    expect(cap('"THE PIT"')).toBe('"The Pit"');
    expect(cap("rack_room_2")).toBe("Rack_Room_2");
  });

  it("preserves whitespace exactly, including runs and edges", () => {
    expect(cap("  TECH   TABLE  ")).toBe("  Tech   Table  ");
    expect(cap("LINE 1\nLINE 2")).toBe("Line 1\nLine 2");
  });

  it("handles accented letters as letters, not separators", () => {
    expect(cap("SALÓN PRINCIPAL")).toBe("Salón Principal");
  });

  it("leaves strings with no letters alone", () => {
    expect(cap("--- / ---")).toBe("--- / ---");
    expect(cap("12 / 34")).toBe("12 / 34");
  });

  it("is idempotent — running it twice changes nothing", () => {
    for (const input of ["TECH TABLE", "HDMI In 1", "EXTRON DTP 84", "joe's bar", "iMac bay"]) {
      expect(cap(cap(input))).toBe(cap(input));
    }
  });
});

describe("transformLabel input guards", () => {
  const MODES: LabelCaseMode[] = ["as-typed", "uppercase", "lowercase", "capitalize"];

  it("returns an empty string for null and undefined in every mode", () => {
    for (const mode of MODES) {
      expect(transformLabel(null, mode)).toBe("");
      expect(transformLabel(undefined, mode)).toBe("");
    }
  });

  it("returns an empty string for empty and whitespace-only input", () => {
    for (const mode of MODES) {
      expect(transformLabel("", mode)).toBe("");
      expect(transformLabel("   ", mode)).toBe("   ");
    }
  });
});

describe("the other three modes are untouched by the capitalize fix", () => {
  const SAMPLES = [
    "TECH TABLE", "main Hall", "HDMI In 1", "SDI OUT 2", "RJ45 ETHERNET",
    "EXTRON DTP 84", "joe's bar", "DisplayPort", "powerCON", "  spaced  ", "4K",
  ];

  it("as-typed is the identity", () => {
    for (const s of SAMPLES) expect(transformLabel(s, "as-typed")).toBe(s);
  });

  it("uppercase is a plain toUpperCase — acronym rules do not leak into it", () => {
    for (const s of SAMPLES) expect(transformLabel(s, "uppercase")).toBe(s.toUpperCase());
  });

  it("lowercase is a plain toLowerCase — acronyms are not protected there", () => {
    for (const s of SAMPLES) expect(transformLabel(s, "lowercase")).toBe(s.toLowerCase());
    expect(transformLabel("HDMI In 1", "lowercase")).toBe("hdmi in 1");
  });

  it("an unknown mode falls through to as-typed", () => {
    expect(transformLabel("TECH TABLE", "bogus" as LabelCaseMode)).toBe("TECH TABLE");
  });
});

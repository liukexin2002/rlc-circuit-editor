import { describe, it, expect } from "vitest";
import {
  visibleSaveActions,
  SAVE_ACTION_LABELS,
  SAVE_ACTION_TITLES,
  type SaveActionState,
} from "../deviceEditorActions";

const base: SaveActionState = {
  templateId: undefined,
  isUserTemplate: false,
  hasLabeledPort: false,
  hasPreset: false,
  dirtyVsPreset: false,
  dirtyVsTemplate: false,
};

describe("visibleSaveActions", () => {
  it("always offers Save as User Template first (split-button primary)", () => {
    expect(visibleSaveActions(base)[0]).toBe("save-user-template");
    expect(
      visibleSaveActions({
        templateId: "tpl-1",
        isUserTemplate: true,
        hasLabeledPort: true,
        hasPreset: true,
        dirtyVsPreset: true,
        dirtyVsTemplate: true,
      })[0],
    ).toBe("save-user-template");
  });

  it("templateless device with no labeled ports gets only the primary action", () => {
    expect(visibleSaveActions(base)).toEqual(["save-user-template"]);
  });

  it("offers Submit to Community for a templateless device once a port is labeled", () => {
    expect(visibleSaveActions({ ...base, hasLabeledPort: true })).toEqual([
      "save-user-template",
      "submit-community",
    ]);
  });

  it("does not offer Submit to Community for an unmodified built-in template", () => {
    const actions = visibleSaveActions({ ...base, templateId: "tpl-1", hasLabeledPort: true });
    expect(actions).not.toContain("submit-community");
  });

  it("built-in template gets Update as Custom and Save as Preset", () => {
    expect(visibleSaveActions({ ...base, templateId: "tpl-1" })).toEqual([
      "save-user-template",
      "update-as-custom",
      "save-preset",
    ]);
  });

  it("user template gets Update User Template instead of the built-in pair", () => {
    const actions = visibleSaveActions({
      ...base,
      templateId: "tpl-1",
      isUserTemplate: true,
    });
    expect(actions).toContain("update-user-template");
    expect(actions).not.toContain("update-as-custom");
    expect(actions).not.toContain("save-preset");
  });

  it("offers Revert to Preset only when a preset exists and the editor is dirty against it", () => {
    expect(visibleSaveActions({ ...base, templateId: "tpl-1", hasPreset: true })).not.toContain("revert-preset");
    expect(visibleSaveActions({ ...base, templateId: "tpl-1", dirtyVsPreset: true })).not.toContain("revert-preset");
    expect(
      visibleSaveActions({ ...base, templateId: "tpl-1", hasPreset: true, dirtyVsPreset: true }),
    ).toContain("revert-preset");
  });

  it("offers Revert to Template only when dirty against the template", () => {
    expect(visibleSaveActions({ ...base, templateId: "tpl-1" })).not.toContain("revert-template");
    expect(visibleSaveActions({ ...base, templateId: "tpl-1", dirtyVsTemplate: true })).toContain("revert-template");
  });

  it("dirty built-in template with labeled ports and a dirty preset shows the full set", () => {
    expect(
      visibleSaveActions({
        templateId: "tpl-1",
        isUserTemplate: false,
        hasLabeledPort: true,
        hasPreset: true,
        dirtyVsPreset: true,
        dirtyVsTemplate: true,
      }),
    ).toEqual([
      "save-user-template",
      "submit-community",
      "update-as-custom",
      "save-preset",
      "revert-preset",
      "revert-template",
    ]);
  });

  it("every action id has a label and a tooltip", () => {
    const all = visibleSaveActions({
      templateId: "tpl-1",
      isUserTemplate: false,
      hasLabeledPort: true,
      hasPreset: true,
      dirtyVsPreset: true,
      dirtyVsTemplate: true,
    }).concat(
      visibleSaveActions({ ...base, templateId: "tpl-1", isUserTemplate: true, hasLabeledPort: true }),
    );
    for (const id of all) {
      expect(SAVE_ACTION_LABELS[id]).toBeTruthy();
      expect(SAVE_ACTION_TITLES[id]).toBeTruthy();
    }
  });
});

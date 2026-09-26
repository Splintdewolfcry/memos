import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { createInitialState, EditorProvider } from "@/components/MemoEditor/state";
import { EditorToolbar } from "@/components/MemoEditor/Toolbar/EditorToolbar";
import InsertMenu from "@/components/MemoEditor/Toolbar/InsertMenu";

vi.mock("@/utils/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/i18n")>()),
  useTranslate: () => (key: string) => key,
}));
vi.mock("@/hooks/useCurrentUser", () => ({ default: () => undefined }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ userGeneralSetting: undefined }) }));
vi.mock("@/contexts/SpaceContext", () => ({ useSpaceContext: () => ({ selectedSpaceName: undefined }) }));
vi.mock("@/components/map/useReverseGeocoding", () => ({ useReverseGeocoding: () => ({ data: undefined }) }));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

const viewToggles = {
  onToggleFocusMode: vi.fn(),
  isFormattingToolbarVisible: false,
  onToggleFormattingToolbar: vi.fn(),
};

/** `hosted` mirrors an editor whose presentation belongs to a host (the global composer). */
const renderMenu = (onInsertImages = vi.fn(), isSaving = false, hosted = false) =>
  render(
    <EditorProvider>
      <InsertMenu
        isSaving={isSaving}
        onLocationChange={vi.fn()}
        onInsertImages={onInsertImages}
        onInsertTaskList={vi.fn()}
        onAudioRecorderClick={vi.fn()}
        viewToggles={hosted ? undefined : viewToggles}
      />
    </EditorProvider>,
  );

describe("InsertMenu", () => {
  test("offers the to-do chip beside the overflow trigger, not inside the menu", () => {
    renderMenu();

    // The chip is a rail button, visible without opening anything.
    expect(screen.getByRole("button", { name: "editor.format.task-list" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "common.add" }));

    const menuItems = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(menuItems).toEqual([
      "editor.insert-menu.add-attachment",
      "editor.insert-menu.insert-image",
      "editor.audio-recorder.trigger",
      "editor.insert-menu.link-memo",
      "editor.insert-menu.add-location",
      "editor.focus-mode",
      "editor.formatting-toolbar",
    ]);
    // The verb moved out of the menu.
    expect(menuItems).not.toContain("editor.format.task-list");
  });

  test("drops the view toggles when a host owns the editor's presentation", () => {
    renderMenu(vi.fn(), false, true);

    fireEvent.click(screen.getByRole("button", { name: "common.add" }));

    const labels = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(labels).not.toContain("editor.focus-mode");
    expect(labels).not.toContain("editor.formatting-toolbar");
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });

  test("invokes onInsertTaskList when the to-do chip is clicked", () => {
    const onInsertTaskList = vi.fn();
    render(
      <EditorProvider>
        <InsertMenu
          onLocationChange={vi.fn()}
          onInsertImages={vi.fn()}
          onInsertTaskList={onInsertTaskList}
          onAudioRecorderClick={vi.fn()}
          viewToggles={viewToggles}
        />
      </EditorProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "editor.format.task-list" }));

    expect(onInsertTaskList).toHaveBeenCalledTimes(1);
  });

  test("disables the to-do chip and the overflow trigger while saving", () => {
    renderMenu(vi.fn(), true);

    expect(screen.getByRole("button", { name: "editor.format.task-list" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "common.add" })).toBeDisabled();
  });

  test("uses separate unrestricted and multi-image file inputs", () => {
    const onInsertImages = vi.fn();
    const { container } = renderMenu(onInsertImages);
    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]'));
    const attachmentInput = inputs.find((input) => input.accept === "");
    const inlineImageInput = inputs.find((input) => input.accept === "image/*");

    expect(attachmentInput).toBeDefined();
    expect(attachmentInput).toHaveAttribute("multiple");
    expect(inlineImageInput).toBeDefined();
    expect(inlineImageInput).toHaveAttribute("multiple");

    const image = new File(["image"], "photo.png", { type: "image/png" });
    fireEvent.change(inlineImageInput!, { target: { files: [image] } });
    expect(onInsertImages).toHaveBeenCalledWith([image]);
  });

  test("exposes a localized save-blocking reason from a focusable wrapper", () => {
    const state = createInitialState();
    state.content = "memo";
    state.ui.pendingInlineImageInsertions = 1;

    render(
      <EditorProvider initialEditorState={state}>
        <EditorToolbar
          onSave={vi.fn()}
          onAudioRecorderClick={vi.fn()}
          viewToggles={viewToggles}
          onInsertImages={vi.fn()}
          onInsertTaskList={vi.fn()}
        />
      </EditorProvider>,
    );

    expect(screen.getByRole("button", { name: "editor.save" })).toBeDisabled();
    expect(screen.getByLabelText("editor.validation.resolve-image-uploads")).toHaveAttribute("tabindex", "0");
  });
});
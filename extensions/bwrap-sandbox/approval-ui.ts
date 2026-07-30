import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text } from "@earendil-works/pi-tui";
import type { ApprovalSelector } from "./approval.ts";

export const selectApprovalOverlay: ApprovalSelector = async (
  ctx: ExtensionContext,
  message: string,
  choices: string[],
): Promise<string | undefined> => ctx.ui.custom<string | undefined>(
  (tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg("warning", text)));
    container.addChild(new Text(theme.fg("warning", theme.bold("Sandbox approval required")), 1, 0));
    container.addChild(new Text(message, 1, 1));
    const items = choices.map((choice) => ({ value: choice, label: choice }));
    const list = new SelectList(items, Math.min(items.length, 8), {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("warning", text),
    });
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(undefined);
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate · enter select · esc block"), 1, 0));
    container.addChild(new DynamicBorder((text: string) => theme.fg("warning", text)));
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput(data: string) {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  },
  {
    overlay: true,
    overlayOptions: { anchor: "center", width: "88%", maxHeight: "85%", margin: 1 },
  },
);

import {
  DynamicBorder,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  SelectList,
  Text,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import type { ApprovalSelector } from "./approval.ts";

const OVERLAY_HEIGHT_PERCENT = 85;
const OVERLAY_MARGIN = 1;

export class ApprovalOverlay implements Component {
  private readonly topBorder: DynamicBorder;
  private readonly title: Text;
  private readonly message: Text;
  private readonly list: SelectList;
  private readonly help: Text;
  private readonly bottomBorder: DynamicBorder;
  private scrollOffset = 0;
  private pageSize = 1;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    message: string,
    choices: string[],
    done: (result: string | undefined) => void,
  ) {
    this.topBorder = new DynamicBorder((text: string) => theme.fg("warning", text));
    this.title = new Text(theme.fg("warning", theme.bold("Sandbox approval required")), 1, 0);
    this.message = new Text(message, 1, 0);
    this.help = new Text(
      theme.fg("dim", "PgUp/PgDn scroll prompt · ↑↓ navigate · enter select · esc block"),
      1,
      0,
    );
    this.bottomBorder = new DynamicBorder((text: string) => theme.fg("warning", text));

    const items = choices.map((choice) => ({ value: choice, label: choice }));
    this.list = new SelectList(items, Math.min(items.length, 8), {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("warning", text),
    });
    this.list.onSelect = (item) => done(item.value);
    this.list.onCancel = () => done(undefined);
  }

  render(width: number): string[] {
    const maxHeight = Math.max(
      1,
      Math.min(
        Math.floor((this.tui.terminal.rows * OVERLAY_HEIGHT_PERCENT) / 100),
        this.tui.terminal.rows - (OVERLAY_MARGIN * 2),
      ),
    );
    const header = [
      ...this.topBorder.render(width),
      ...this.title.render(width),
    ];
    const listLines = this.list.render(width);
    const footer = [
      ...listLines,
      ...this.help.render(width),
      ...this.bottomBorder.render(width),
    ];
    const messageLines = this.message.render(width);
    const statusHeight = 1;
    this.pageSize = Math.max(1, maxHeight - header.length - footer.length - statusHeight);
    const maxOffset = Math.max(0, messageLines.length - this.pageSize);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);

    const visibleMessage = messageLines.slice(this.scrollOffset, this.scrollOffset + this.pageSize);
    const firstLine = messageLines.length === 0 ? 0 : this.scrollOffset + 1;
    const lastLine = Math.min(messageLines.length, this.scrollOffset + this.pageSize);
    const status = new Text(
      this.theme.fg("dim", `Prompt lines ${firstLine}–${lastLine} of ${messageLines.length}`),
      1,
      0,
    ).render(width);

    const lines = [...header, ...visibleMessage, ...status, ...footer];
    if (lines.length <= maxHeight) return lines;

    // On very short terminals, keep the controls instead of the prompt header.
    return lines.slice(-maxHeight);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.pageUp)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - this.pageSize);
    } else if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset += this.pageSize;
    } else {
      this.list.handleInput(data);
    }
    this.tui.requestRender();
  }

  invalidate(): void {
    this.topBorder.invalidate();
    this.title.invalidate();
    this.message.invalidate();
    this.list.invalidate();
    this.help.invalidate();
    this.bottomBorder.invalidate();
  }
}

export const selectApprovalOverlay: ApprovalSelector = async (
  ctx: ExtensionContext,
  message: string,
  choices: string[],
): Promise<string | undefined> => ctx.ui.custom<string | undefined>(
  (tui, theme, _keybindings, done) => new ApprovalOverlay(tui, theme, message, choices, done),
  {
    overlay: true,
    overlayOptions: {
      anchor: "center",
      width: "88%",
      maxHeight: `${OVERLAY_HEIGHT_PERCENT}%`,
      margin: OVERLAY_MARGIN,
    },
  },
);

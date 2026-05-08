import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { SelectList, truncateToWidth } from "@earendil-works/pi-tui";

export function overlaySelectListTheme(theme: Theme) {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("warning", text),
	};
}

export async function showSelectOverlay(
	ctx: any,
	title: string,
	hint: string,
	items: SelectItem[],
	maxVisible: number,
): Promise<SelectItem | null> {
	return (ctx.ui.custom as (factory: unknown, options: unknown) => Promise<SelectItem | null>)(
		(tui: any, theme: Theme, _keybindings: any, done: (result: SelectItem | null) => void) => {
			const selectList = new SelectList(items, maxVisible, overlaySelectListTheme(theme));
			const border = (text: string) => theme.fg("dim", text);
			const wrapRow = (text: string, innerWidth: number): string => {
				return `${border("│")}${truncateToWidth(text, innerWidth, "…", true)}${border("│")}`;
			};

			selectList.onSelect = (item) => done(item);
			selectList.onCancel = () => done(null);

			return {
				render: (width: number) => {
					const innerWidth = Math.max(1, width - 2);
					const lines: string[] = [];

					lines.push(border(`╭${"─".repeat(innerWidth)}╮`));
					lines.push(wrapRow(theme.fg("accent", theme.bold(title)), innerWidth));
					lines.push(border(`├${"─".repeat(innerWidth)}┤`));

					for (const line of selectList.render(innerWidth)) {
						lines.push(wrapRow(line, innerWidth));
					}

					lines.push(border(`├${"─".repeat(innerWidth)}┤`));
					lines.push(wrapRow(theme.fg("dim", hint), innerWidth));
					lines.push(border(`╰${"─".repeat(innerWidth)}╯`));

					return lines;
				},
				invalidate: () => selectList.invalidate(),
				handleInput: (data: string) => {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{
			overlay: true,
			overlayOptions: () => ({
				verticalAlign: "center",
				horizontalAlign: "center",
			}),
		},
	);
}

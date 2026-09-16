import {
  Key,
  type SettingItem,
  Container,
  SettingsList,
  Text,
  Spacer,
  matchesKey,
} from "@earendil-works/pi-tui";
import type { RaftConfigScope } from "../config.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "./dynamic-border.js";
import { settingsListTheme } from "./settings-submenus.js";

const SAVE_SCOPE_SHORTCUT = Key.ctrl("g");

export interface RaftSettingsComponentOptions {
  initialSaveScope?: RaftConfigScope;
  projectScopeAvailable?: boolean;
  onSaveScopeChange?: (scope: RaftConfigScope) => void;
  itemsForSaveScope?: (scope: RaftConfigScope) => SettingItem[];
}

export class RaftSettingsComponent extends Container {
  settingsList: SettingsList;
  private readonly theme: Theme;
  private readonly saveScopeText: Text;
  private readonly settingsListContainer: Container;
  private readonly projectScopeAvailable: boolean;
  private readonly onChange: (id: string, newValue: string) => void;
  private readonly onCancel: () => void;
  private readonly onSaveScopeChange: (scope: RaftConfigScope) => void;
  private readonly itemsForSaveScope: ((scope: RaftConfigScope) => SettingItem[]) | undefined;
  private saveScope: RaftConfigScope;

  constructor(
    theme: Theme,
    items: SettingItem[],
    onChange: (id: string, newValue: string) => void,
    onCancel: () => void,
    options: RaftSettingsComponentOptions = {},
  ) {
    super();
    this.theme = theme;
    this.projectScopeAvailable = options.projectScopeAvailable ?? true;
    this.saveScope =
      options.initialSaveScope === "project" && this.projectScopeAvailable ? "project" : "global";
    this.onChange = onChange;
    this.onCancel = onCancel;
    this.onSaveScopeChange = options.onSaveScopeChange ?? (() => {});
    this.itemsForSaveScope = options.itemsForSaveScope;
    this.addChild(new DynamicBorder((text) => theme.fg("border", text)));
    this.saveScopeText = new Text("", 1, 0);
    this.updateSaveScopeText();
    this.addChild(this.saveScopeText);
    this.addChild(new Spacer(1));
    this.settingsListContainer = new Container();
    this.settingsList = this.createSettingsList(items);
    this.settingsListContainer.addChild(this.settingsList);
    this.addChild(this.settingsListContainer);
    this.addChild(new DynamicBorder((text) => theme.fg("border", text)));
  }

  replaceItems(items: SettingItem[], selectItemId?: string): void {
    this.settingsListContainer.clear();
    this.settingsList = this.createSettingsList(items);
    if (selectItemId) {
      this.settingsList.selectItem(selectItemId);
    }
    this.settingsListContainer.addChild(this.settingsList);
  }

  handleInput(data: string): void {
    if (matchesKey(data, SAVE_SCOPE_SHORTCUT)) {
      if (!this.projectScopeAvailable) return;
      this.saveScope = this.saveScope === "project" ? "global" : "project";
      this.updateSaveScopeText();
      this.onSaveScopeChange(this.saveScope);
      const nextItems = this.itemsForSaveScope?.(this.saveScope);
      if (nextItems) {
        this.replaceItems(nextItems);
      }
      return;
    }
    this.settingsList.handleInput(data);
  }

  private createSettingsList(items: SettingItem[]): SettingsList {
    return new SettingsList(
      items,
      10,
      settingsListTheme(this.theme),
      this.onChange,
      this.onCancel,
      { enableSearch: true },
    );
  }

  private updateSaveScopeText(): void {
    const destination =
      this.saveScope === "project"
        ? "Project overrides (.pi/raft.json)"
        : "Global defaults (~/.pi/agent/raft.json)";
    const hint = !this.projectScopeAvailable
      ? " · project scope unavailable for untrusted projects"
      : this.saveScope === "global"
        ? " · Ctrl+G switches scope · project overrides may remain active here"
        : " · Ctrl+G switches scope";
    this.saveScopeText.setText(
      this.theme.fg("muted", "Editing: ") +
        this.theme.fg("accent", destination) +
        this.theme.fg("dim", hint),
    );
  }
}

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { RaftConfig } from "../config.js";
import type { ModelSource } from "./model-picker.js";

interface SettingsSectionOptions {
  modelSource: ModelSource;
  claudeModelSource?: ModelSource;
  extensionToolNames?: string[];
  activeModelKey?: string;
}

// Section builders receive editor data and callbacks, never the runtime state.
// Each builder picks its callbacks and only the options it actually consumes.
export interface SettingsSectionContext<
  Options extends keyof SettingsSectionOptions = keyof SettingsSectionOptions,
> {
  theme: Theme;
  config: RaftConfig;
  apply: (id: string, value: unknown) => void;
  persist: (id: string, value: string) => void;
  options: Pick<SettingsSectionOptions, Options>;
}

/** Pure deterministic compaction and configuration APIs. */
export {
   CONFIG_FILE_NAME,
   configPath,
   defaultConfig,
   loadConfig,
   parseConfig,
   type ConfigParseError,
   type CompactionConfig
} from "./config";
export * from "./core/compaction";

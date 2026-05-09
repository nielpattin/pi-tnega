import { VerboseReporter } from "vitest/node";
import colors from "yoctocolors";

export class PreciseVerboseReporter extends VerboseReporter {
   protected override getDurationPrefix(task: Parameters<VerboseReporter["getDurationPrefix"]>[0]): string {
      const duration = task.result?.duration;

      if (duration == null) {
         return "";
      }

      const color = duration > this.ctx.config.slowTestThreshold ? colors.yellow : colors.green;

      return color(` ${duration.toFixed(4)}${colors.dim("ms")}`);
   }
}

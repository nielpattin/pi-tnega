import { Type } from "typebox";

export const VibeSpawnParamsSchema = Type.Object({
   cli: Type.Union([Type.Literal("fast"), Type.Literal("good")]),
   prompt: Type.String({ description: "Instruction prompt for profile worker." }),
   name: Type.Optional(Type.String())
});

export const VibeSendParamsSchema = Type.Object({
   session: Type.String({ description: "Target session ID handle." }),
   message: Type.String({ description: "Follow-up message text." }),
   mode: Type.Optional(
      Type.Union([Type.Literal("steer"), Type.Literal("followUp")], {
         default: "followUp",
         description: "Control mode to deliver to the worker backend session."
      })
   )
});

export const VibeWaitParamsSchema = Type.Object({
   sessions: Type.Optional(Type.Array(Type.String())),
   timeout: Type.Optional(Type.Number())
});

export const VibeKillParamsSchema = Type.Object({
   session: Type.String({ description: "Session ID to cancel." })
});

export const VibeListParamsSchema = Type.Object({});

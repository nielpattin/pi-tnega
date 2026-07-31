import { Type, type Static } from "typebox";

const VibeSpawnOperationSchema = Type.Object({
   op: Type.Literal("spawn"),
   cli: Type.Union([Type.Literal("fast"), Type.Literal("good")], {
      description: "Vibe profile to use."
   }),
   prompt: Type.String({ description: "Instruction prompt for the profile worker." }),
   name: Type.Optional(Type.String({ description: "Optional display name for the worker." }))
});

const VibeSendOperationSchema = Type.Object({
   op: Type.Literal("send"),
   session: Type.String({ description: "Target session ID handle." }),
   message: Type.String({ description: "Follow-up message text." }),
   mode: Type.Optional(
      Type.Union([Type.Literal("steer"), Type.Literal("followUp")], {
         default: "followUp",
         description: "Control mode to deliver to the worker backend session."
      })
   )
});

const VibeWaitOperationSchema = Type.Object({
   op: Type.Literal("wait"),
   sessions: Type.Optional(Type.Array(Type.String(), { description: "Session IDs to wait for." })),
   timeout: Type.Optional(Type.Number({ description: "Maximum wait time in milliseconds." }))
});

const VibeKillOperationSchema = Type.Object({
   op: Type.Literal("kill"),
   session: Type.String({ description: "Session ID to cancel." })
});

const VibeListOperationSchema = Type.Object({
   op: Type.Literal("list")
});

/** Parameters for the single Vibe Director control tool. */
export const VibeToolParamsSchema = Type.Union(
   [
      VibeSpawnOperationSchema,
      VibeSendOperationSchema,
      VibeWaitOperationSchema,
      VibeKillOperationSchema,
      VibeListOperationSchema
   ],
   { type: "object" }
);

/** Parsed input accepted by the single Vibe Director control tool. */
export type VibeToolParams = Static<typeof VibeToolParamsSchema>;

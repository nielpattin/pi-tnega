import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GARBLED_PATTERNS = [
   "</arg_value>",
   "</arg_key>",
   "<arg_key>",
   "meter_bits",
   "DISPLAY",
   "pxn",
   "FIX?",
   "\u2591",
   "\u2593",
   "\udc90"
];

const THINKING_NOISE_PATTERN = /^[\d\s:.\-|]+$/;

export default function (pi: ExtensionAPI) {
   function isGarbledText(text: string): boolean {
      if (text.length < 5) return false;
      if (GARBLED_PATTERNS.some((p) => text.includes(p))) return true;
      if (text.includes("</think>") || text.includes("<think>")) return true;
      if (/https?:\/\/[\d.]+:\s*$/.test(text)) return true;
      const alphaNum = text.replace(/[^a-zA-Z0-9\s]/g, "").length;
      if (text.length > 50 && alphaNum / text.length < 0.3) return true;
      if (/[|/]{3,}/.test(text) && text.length < 200) return true;
      if (text.length < 30 && text.split(/\s+/).length <= 3) {
         const wordChars = text.replace(/[^a-zA-Z]/g, "").length;
         if (wordChars < text.length * 0.4) return true;
      }
      return false;
   }

   function isGarbledThinking(thinking: string): boolean {
      if (thinking.length < 10) return true;
      const lines = thinking.split("\n").filter((l) => l.trim());
      if (lines.length > 0 && THINKING_NOISE_PATTERN.test(lines[0])) return true;
      // Detect degraded thinking: starts normal then becomes number/quote noise
      // Check the last 30% of the text for excessive digits/quotes
      const tail = thinking.slice(Math.floor(thinking.length * 0.7));
      const digitCount = (tail.match(/\d/g) || []).length;
      if (tail.length > 50 && digitCount / tail.length > 0.4) return true;
      // Detect long runs of numbers with quotes: 55"56"57"58"59
      if (/\d["'`\]]{1,2}\d["'`\]]{1,2}\d["'`\]]{1,2}\d/.test(thinking)) return true;
      return false;
   }

   pi.on("message_end", async (event, ctx) => {
      if (event.message.role !== "assistant") return;
      if (event.message.model !== "@cf/zai-org/glm-5.2") return;

      const content = event.message.content;
      let garbled = false;

      for (const block of content) {
         if (block.type === "text" && isGarbledText(block.text)) {
            garbled = true;
            break;
         }
         if (block.type === "thinking" && isGarbledThinking(block.thinking)) {
            garbled = true;
            break;
         }
      }

      if (!garbled) return;

      // deliverAs: "steer" is REQUIRED when agent is streaming (which it is during message_end).
      // Without it, the call is silently ignored.
      pi.sendUserMessage(
         "Your previous response was corrupted/garbled. Please redo it — continue your work from the last clean state.",
         { deliverAs: "steer" }
      );
   });
}

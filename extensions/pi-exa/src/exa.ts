import ExaClient from "exa-js";

let exa: ExaClient | undefined;

export function resetExa() {
   exa = undefined;
}

// singleton for Exa API interface
export function getExa(apiKey: string | undefined) {
   if (!apiKey) {
      throw new Error("Missing Exa API key");
   }

   if (!exa) {
      exa = new ExaClient(apiKey);
   }

   return exa;
}

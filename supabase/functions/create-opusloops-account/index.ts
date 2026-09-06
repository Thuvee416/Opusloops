import { createOpusloopsAccountHandler } from "./handler.mjs";

Deno.serve(createOpusloopsAccountHandler({
  getEnv: (name) => Deno.env.get(name) || "",
  fetchImpl: fetch,
}));

/** Maps errors that reach the Express error handler to a safe HTTP response. Never leaks internals; bad client input is a 4xx, not a 500. */
export function errorResponse(err: any): { status: number; body: { error: string } } {
  if (err?.type === "entity.parse.failed") return { status: 400, body: { error: "invalid_json" } };
  if (err?.type === "entity.too.large") return { status: 413, body: { error: "too_large" } };
  if (err?.code === "57014") return { status: 503, body: { error: "timeout" } }; // Postgres statement_timeout / cancelled query
  if (err?.code === "53300" || err?.code === "57P03") return { status: 503, body: { error: "busy" } }; // too many connections / starting up
  return { status: 500, body: { error: "internal" } };
}
/** For `catch` blocks that turn a thrown business rule into a 409. Business rules throw `new Error("snake_case_code")`; those pass through.
 *  Anything else (a Postgres error with its constraint names, a TypeError) is rethrown so the error middleware logs it and the client sees only a generic 500. */
export function safeCode(e: any): string {
  if (e && typeof e.message === "string" && typeof e.code !== "string" && /^[a-z][A-Za-z0-9_]{0,60}$/.test(e.message)) return e.message;
  throw e;
}

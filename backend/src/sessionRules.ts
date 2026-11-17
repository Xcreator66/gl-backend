export type Role = "individual" | "collector" | "recycler" | "admin";
/** Decides a request from the role in the signed token vs the role in the DATABASE (null = account missing or deleted).
 *  stale -> 401 so the app signs in again and gets a token with the new role; forbidden -> 403.
 *  This is what stops a demoted collector or recycler from acting for the rest of a 12 h token. */
export function sessionVerdict(tokenRole: Role, dbRole: Role | null, allowed: readonly Role[]): "ok" | "gone" | "stale" | "forbidden" {
  if (!dbRole) return "gone";
  if (dbRole !== tokenRole) return "stale";
  return allowed.includes(dbRole) ? "ok" : "forbidden";
}

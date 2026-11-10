import type { Session } from "../models/session";

export function readSession(id: string): Session {
  return { id, expiresAt: 0 };
}

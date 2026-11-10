import { getSession } from "@app/services/session";
import type { Session } from "../models/session";

export function displaySession(id: string): Session {
  return getSession(id);
}

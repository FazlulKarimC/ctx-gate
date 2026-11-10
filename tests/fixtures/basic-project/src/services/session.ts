import { readSession } from "../db/session";

export function getSession(id: string) {
  return readSession(id);
}

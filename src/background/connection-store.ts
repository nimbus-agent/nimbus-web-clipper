import { storageGet, storageRemove, storageSet } from "../browser/storage.ts";
import type { Connection } from "../shared/types.ts";

const CONNECTION_KEY = "connection";

export function isConnection(v: unknown): v is Connection {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>)["origin"] === "string" &&
    typeof (v as Record<string, unknown>)["token"] === "string" &&
    typeof (v as Record<string, unknown>)["label"] === "string" &&
    typeof (v as Record<string, unknown>)["pairedAt"] === "number"
  );
}

export async function getConnection(): Promise<Connection | null> {
  const value = await storageGet(CONNECTION_KEY);
  return isConnection(value) ? value : null;
}

export async function setConnection(c: Connection): Promise<void> {
  await storageSet(CONNECTION_KEY, c);
}

export async function clearConnection(): Promise<void> {
  await storageRemove(CONNECTION_KEY);
}

import { z } from "zod";
import { Storage } from "../storage.js";

export const migrationStatusSchema = z.object({});

export function migrationStatus(storage: Storage) {
  return storage.getMigrationStatus();
}

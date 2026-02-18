import { z } from "zod";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { logEvent, truncate } from "../utils.js";
import { mutationSchema } from "./mutation.js";

export const adrCreateSchema = z.object({
  mutation: mutationSchema,
  title: z.string().min(1),
  status: z.string().min(1),
});

export function createAdr(input: z.infer<typeof adrCreateSchema>, repoRoot = process.cwd()) {
  const scriptPath = path.resolve(repoRoot, "scripts", "new_adr.py");
  const args = [scriptPath, "--title", input.title, "--status", input.status];
  const result = spawnSync("python3", args, {
    encoding: "utf8",
    cwd: repoRoot,
    maxBuffer: 1024 * 1024,
  });

  const stderr = truncate(result.stderr ?? "");
  const stdout = (result.stdout ?? "").trim();
  const ok = result.status === 0;
  logEvent("adr.create", { ok, status: result.status, stdout: truncate(stdout) });

  let createdPath: string | null = null;
  let updatedPath: string | null = null;
  if (stdout) {
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const createdMatch = line.match(/^Created:\s+(.+)$/i);
      if (createdMatch) {
        createdPath = createdMatch[1]?.trim() ?? null;
        continue;
      }
      const updatedMatch = line.match(/^Updated:\s+(.+)$/i);
      if (updatedMatch) {
        updatedPath = updatedMatch[1]?.trim() ?? null;
      }
    }
    if (!createdPath) {
      createdPath = lines[0] ?? null;
    }
  }

  return {
    path: createdPath ? path.resolve(createdPath) : null,
    index_path: updatedPath ? path.resolve(updatedPath) : undefined,
    ok,
    stderr_trunc: stderr || undefined,
  };
}

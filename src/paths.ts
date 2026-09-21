import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Resolve a path supplied by a user or tool according to Pi path conventions. */
export function resolveExtensionPath(rawPath: string, cwd: string): string {
  let value = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  if (value === "~") value = homedir();
  else if (value.startsWith("~/")) value = join(homedir(), value.slice(2));
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

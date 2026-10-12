import { stat } from "@modera/plugin-sdk/workspace-fs";
import { isRemotePath } from "@modera/plugin-sdk/workspace-path";
import { remoteTransport } from "@modera/plugin-sdk/workspace-transport";
import type { Stats } from "node:fs";

/** Transactional path identity is opt-in; browsing and scans only need SFTP attributes. */
export async function fileIdentity(path: string): Promise<Stats> {
  if (!isRemotePath(path)) return stat(path);
  return (await remoteTransport().file("statIdentity", [path])) as Stats;
}

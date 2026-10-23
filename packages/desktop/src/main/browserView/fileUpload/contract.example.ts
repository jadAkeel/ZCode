import type { IabFileChooser } from "./contract.js";

export async function chooseApprovedFile(
  chooser: IabFileChooser,
  click: () => Promise<void>,
  path: string,
  signal: AbortSignal,
): Promise<void> {
  const waiting = chooser.wait(3_000, signal);
  await chooser.ready();
  await click();
  const { id } = await waiting;
  await chooser.setFiles(id, [path], 120_000, signal);
}

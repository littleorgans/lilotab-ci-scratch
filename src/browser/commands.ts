// A command's raw shortcut from commands.getAll, for the worker and the pages to parse (05-events 2.4).

// The browser's own string; empty when the command is unbound (C-KEY-09).
export async function readShortcut(command: string): Promise<string> {
  const commands = await chrome.commands.getAll();
  return commands.find((c) => c.name === command)?.shortcut ?? '';
}

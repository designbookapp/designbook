/**
 * Opens the workbench in the user's browser. On macOS, if a Chromium-family
 * browser already has a tab on the designbook origin, that tab is refocused
 * instead of opening a duplicate (the react-dev-utils trick).
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Chromium-family apps that share the same AppleScript tab API. */
const CHROMIUM_APPS = [
  "Google Chrome",
  "Arc",
  "Brave Browser",
  "Microsoft Edge",
  "Chromium",
];

/**
 * The app name must be a literal in the `tell` so AppleScript can load that
 * app's scripting dictionary — a variable name fails to compile terms like
 * `active tab index`. Only names from CHROMIUM_APPS are interpolated.
 */
function refocusScript(app: string): string {
  return `
on run argv
  set targetUrl to item 1 of argv
  tell application "${app}"
    repeat with w in windows
      set tabIndex to 1
      repeat with t in tabs of w
        if (URL of t) starts with targetUrl then
          set active tab index of w to tabIndex
          set index of w to 1
          activate
          return "refocused"
        end if
        set tabIndex to tabIndex + 1
      end repeat
    end repeat
  end tell
  return "not-found"
end run
`;
}

async function runningChromiumApps(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("ps", ["cax", "-o", "command"]);
    return CHROMIUM_APPS.filter((app) => stdout.includes(app));
  } catch {
    return [];
  }
}

/** Refocuses an existing tab on the designbook origin; true when one was found. */
async function refocusExistingTab(url: string): Promise<boolean> {
  for (const app of await runningChromiumApps()) {
    try {
      const { stdout } = await execFileAsync("osascript", [
        "-e",
        refocusScript(app),
        url,
      ]);
      if (stdout.trim() === "refocused") return true;
    } catch {
      // Automation permission denied or the app quit mid-check — try the next.
    }
  }
  return false;
}

function systemOpenCommand(url: string): [string, string[]] {
  switch (process.platform) {
    case "darwin":
      return ["open", [url]];
    case "win32":
      return ["cmd", ["/c", "start", "", url]];
    default:
      return ["xdg-open", [url]];
  }
}

async function openBrowser(url: string): Promise<void> {
  if (process.platform === "darwin" && (await refocusExistingTab(url))) {
    return;
  }

  const [command, args] = systemOpenCommand(url);
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => {
    console.warn(`designbook: could not open a browser. Open ${url} manually.`);
  });
  child.unref();
}

export { openBrowser };

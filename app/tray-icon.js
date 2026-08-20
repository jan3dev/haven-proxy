// Tray icon: the Haven logomark, full-strength while the proxy runs and dimmed
// while it is stopped. The PNGs live in tray-icons.generated.js as base64 (run
// scripts/make-icons.mjs to rebuild them from build/haven-logomark.svg) so
// there are no asset-path or asar concerns.
import { nativeImage, nativeTheme } from "electron";
import { TRAY_ICONS } from "./tray-icons.generated.js";

const isMac = process.platform === "darwin";

export function trayIcon(running) {
  // macOS tints a template image to match the menu bar, so ship the black
  // glyph and let it invert itself. Elsewhere nothing tints for us: the tray
  // follows the system theme, so pick the contrasting glyph ourselves.
  const light = isMac ? false : nativeTheme.shouldUseDarkColors;
  const variant = light ? (running ? "whiteRunning" : "whiteStopped") : running ? "blackRunning" : "blackStopped";
  const png = TRAY_ICONS[variant];

  const image = nativeImage.createFromDataURL(`data:image/png;base64,${png[1]}`);
  image.addRepresentation({ scaleFactor: 2, dataURL: `data:image/png;base64,${png[2]}` });
  if (isMac) image.setTemplateImage(true);
  return image;
}

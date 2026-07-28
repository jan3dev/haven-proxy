// Placeholder tray icons: 32x32 PNGs generated programmatically (filled circle
// with an "H" cutout) — blue while the proxy runs, gray while stopped.
// Embedded as data URLs so there are no asset-path/asar concerns.
//
// Production TODO: replace with real branding — a multi-frame .ico (16/20/24/32)
// for crisp Windows DPI scaling, a macOS template image (monochrome, named
// *Template) so the menu bar tints it, and electron-builder win/mac icons for
// the executable itself.
import { nativeImage } from "electron";

const RUNNING_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA30lEQVR42tVXyw3DIAzNgRVYIUfvkV1YITt4FmZghs7QGXyhQnKrBKEUUsAu0rsEwnuAv8vybwOQLCBtgOQAaWc4/mZHkRomCYAUvyDwWtOLPG32rCDOkf5xv161v0Gcwzc/DSCtgPToQP5G2mttOXlP8qMIWyPADyD/PEeNwcXBcFeudmnt2frquYJ3mFun7ySgfAs1QaajgFCy/DhRQDx5BMfx2QK2ZutvCGRt3sAZbbaAXZUA8ScQN0JZNxQPRFpCsWwyEk/HKgoSFSWZeFGqoixX0Zioac1UNKcjxwuYqFEPjR94rQAAAABJRU5ErkJggg==";

const STOPPED_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA2ElEQVR42tVX2w3DIAzMByuwQnbJLqwQ6WZiBmbIDN2CCsmtGoRSkxrsIt1PINwBfi7Lvw0AHsAGIADYCYG++VGkjkgSgPwFidY6KfKy2YNBXKP8E3696niDuEbsfhoAK4BDgPyFstfac3JJ8k8RniMgDiB/PwfH4PJghCtXu7T2aj17ruEd7tbphQS0b4ETZAQFpJbl54kC8skjKI7PFrB1W39HIOvzBsposwXspgSoP4G6Eeq6oXogshKKdZORejo2UZCYKMnUi1ITZbmJxsRMa2aiOR05npSVykAPsHDHAAAAAElFTkSuQmCC";

export function trayIcon(running) {
  return nativeImage.createFromDataURL(
    `data:image/png;base64,${running ? RUNNING_PNG : STOPPED_PNG}`,
  );
}

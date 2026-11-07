import { readFileSync } from "node:fs";

/**
 * The admin UI is served both by the admin-gated plugin router at
 * `/plugins/signalk-p2p/admin` and as the Signal K webapp at
 * `/signalk-p2p-plugin/`. `public/index.html` is the single source.
 */
export const ADMIN_PAGE = readFileSync(
  new URL("../public/index.html", import.meta.url),
  "utf8",
);

// Copy the site's own modules into vendor/ so the deployed function runs the
// exact code the app runs. The deploy does this by itself (the predeploy hook
// in firebase.json); run `npm run sync` by hand before testing locally.
//
// vendor/ is generated and git-ignored. Never edit it — edit ../assets.

import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, '..', '..', 'assets');
const vendor = join(here, '..', 'vendor');

const FILES = [
  'pa-schedule.js',   // picks, paddles, GTFS trips, pull-ins
  'pa-resolve.js',    // patterns, assignments, vacation weeks, pay
  'pa-live.js'        // TransitView + detours (fetches directly off a page)
];

mkdirSync(vendor, { recursive: true });
for (const f of FILES) {
  copyFileSync(join(assets, f), join(vendor, f));
  console.log('vendor/' + f);
}
console.log('Synced ' + FILES.length + ' modules from assets/.');

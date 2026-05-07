const { notarize } = require('@electron/notarize');
const path = require('path');

exports.default = async function (context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  // Skip if Apple credentials are absent — local dev build, not a release.
  if (!process.env.APPLE_TEAM_ID || !process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD) {
    console.log('[notarize] APPLE_* env vars not set — skipping notarization (local dev build).');
    return;
  }

  console.log(`[notarize] notarizing ${appPath}…`);
  await notarize({
    appBundleId: 'com.capturingthe3rd.desktop-ash',
    appPath,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  });
  console.log('[notarize] done');
};

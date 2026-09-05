# Troubleshooting

## The app does not load

1. Confirm you opened [the production HTTPS URL](https://opusloops.com/).
2. Reload once while connected to the network.
3. Disable content blockers for the site temporarily.
4. Update the browser and retry.

## There is no sound

1. Tap **Play** once to satisfy the browser's audio-gesture requirement.
2. Raise the device's media volume and leave silent mode if the browser respects it.
3. Disconnect Bluetooth audio temporarily to rule out an unexpected output route.
4. Return to Opusloops after switching apps; playback intentionally pauses when the page moves to the background.
5. Close another page or app that may have exclusive audio focus, then retry.

## Installation is not offered

- On iPhone and iPad, use Safari's **Share → Add to Home Screen**.
- On Android, use the browser's **Install app** or **Add to Home screen** action.
- Wait for the first load to finish over HTTPS.
- The app still works in a normal tab when installation is unavailable.

## A local project disappeared

Browser storage can be removed by private browsing, site-data cleanup, storage pressure, browser reset, or PWA uninstall. If the project had synced to an account, sign in again while connected and let Opusloops restore it. Unsigned-in projects have no server copy. A downloaded WAV preserves the rendered sound but cannot restore an editable project.

## A project is not syncing

Confirm the header shows **Saved to account**, not **Offline — sync pending**. Reconnect, open the account sheet, and choose **Sync now**. Signing out hides account-scoped projects locally but does not delete their private server copies.

## I cannot create or recover an account

Account creation is invitation-only during early access, and each invitation works once for its assigned email. Direct public signup is disabled. Password-recovery email is not available until production email delivery is configured.

## Offline mode does not open

Reconnect and complete one full load, then reopen the installed app. A private tab or browser policy may prevent durable service-worker storage.

## Report a problem

Open an [Opusloops issue](https://github.com/Thuvee416/Opusloops/issues/new) with:

- Device and operating-system version
- Browser name and version
- Whether Opusloops was installed or opened in a tab
- Exact steps and the result you expected
- A screen recording or screenshot when it does not reveal private content

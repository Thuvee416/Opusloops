# Troubleshooting

## The app does not load

1. Confirm you opened [the production HTTPS URL](https://thuvee416.github.io/Opusloops/).
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

Browser storage can be removed by private browsing, site-data cleanup, storage pressure, browser reset, or PWA uninstall. The current release has no export or server-side copy, so a removed local project cannot be recovered through Opusloops.

## Offline mode does not open

Reconnect and complete one full load, then reopen the installed app. A private tab or browser policy may prevent durable service-worker storage.

## Report a problem

Open an [Opusloops issue](https://github.com/Thuvee416/Opusloops/issues/new) with:

- Device and operating-system version
- Browser name and version
- Whether Opusloops was installed or opened in a tab
- Exact steps and the result you expected
- A screen recording or screenshot when it does not reveal private content

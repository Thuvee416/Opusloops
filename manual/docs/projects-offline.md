# Projects and Offline Use

Opusloops is local first. Project state is stored by the browser on the current device; there is no automatic cloud account or sync service.

## Save locally

Step, tempo, key, name, refinement, mute, and mixer changes save automatically after a short delay. The header changes from **Saving…** to **Saved in browser**. The Studio save button writes immediately.

The **Projects** tab lists saved loops by name, tempo, key, and last-change date. Tap a project to open it. **New** starts another idea. The delete button asks for confirmation before removing a project.

Local storage is convenient, but it is controlled by the browser and operating system.

Private browsing, clearing site data, storage-pressure cleanup, or uninstalling the PWA can remove local projects.

!!! warning "No backup path in this release"
    The current mobile release does not provide project file export, import, cloud sync, or server-side recovery. Do not use it as the only copy of irreplaceable work. Clearing the site's data can permanently remove every saved project.

## Offline use

After one complete online load, the installed PWA can reopen its cached app shell without a connection. Existing local projects and the four Web Audio voices remain available.

The browser may need to reconnect before it discovers an application update. Offline availability is device- and browser-managed; installed mode does not create a separate backup of project data.

## Privacy

Projects remain in browser-managed storage on the device. Opusloops does not need microphone, contacts, location, or external AI-provider access for the core loop workflow.

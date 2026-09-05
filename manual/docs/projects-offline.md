# Projects and Offline Use

Opusloops is local first. Project state is stored by the browser immediately, so creating and playing a loop never waits for a network request. Signing in adds private account sync across devices.

## Save locally

Step, tempo, key, name, refinement, mute, and mixer changes save automatically after a short delay. The header moves through **Saving…**, **Saved on device**, and—when signed in—**Saved to account**. The Studio save button writes immediately.

The **Projects** tab lists saved loops by name, tempo, key, and last-change date. Tap a project to open it. **New** starts another idea. The delete button asks for confirmation before removing a project.

Local storage is convenient, but it is controlled by the browser and operating system. Use **Export four-bar WAV** in Studio to render a playable audio file. The WAV contains sound, not editable sequencer data.

Private browsing, clearing site data, storage-pressure cleanup, or uninstalling the PWA can remove local projects.

!!! warning "Sign in before relying on another device"
    Unsigned-in projects exist only in this browser. After signing in, explicitly move the waiting device loops into the account; they then sync privately. A WAV export cannot restore steps, tempo, or mix settings.

## Private account sync

Email and password sign-in stores each invited user's projects in the dedicated Opusloops Supabase project. Account creation is invitation-only during early access; direct public signup is disabled. The atomic sync service and database Row Level Security apply ownership checks to every project. Local caches are namespaced by account, so signing out hides that account's projects on the shared device.

Edits and deletions made offline are reconciled after reconnecting. A durable deletion marker prevents an older server copy from bringing a deleted project back.

Password recovery and email verification are not available until production email delivery is configured. Do not use an account password you cannot safely retain.

## Offline use

After one complete online load, the installed PWA can reopen its cached app shell without a connection. Existing local projects and the four Web Audio voices remain available.

The browser may need to reconnect before it discovers an application update. Offline availability is device- and browser-managed; installed mode does not create a separate backup of project data.

## Privacy

Projects remain in browser-managed storage on the device. For signed-in users, project parameters—but not rendered audio—also go to the dedicated Supabase service. Opusloops does not need microphone, contacts, location, or an external AI provider for the core loop workflow.

# Shared-link listening

The onboarding handoff is implemented in `ListeningPage`, `ListeningSheets`, and `ListeningLibrary`. `App` owns the existing audio engine throughout the flow. Open `/?listen=1` for the sample recording in the new layout. Incoming legacy `?read=<encoded-url>` links use this layout; new saved recordings use `?read=p_<recording-id>`.

`listeningRecords` stores an immutable text/voice snapshot, ownership, and link visibility. New private recordings have an owner capability kept in local storage. Sign-in associates the record with the authenticated account. A private sign-in callback carries the capability in the fragment so it is not sent as a referrer; the app moves it into storage and removes the fragment. Public reads never return that capability.

Narration for these records is scoped to the recording ID. All visitors to one publication join the same durable generation job. The audio HTTP route checks the current access setting for each segment request and supports byte ranges. Disabling link access stops new requests; bytes already downloaded cannot be withdrawn. Existing legacy narration caches are unchanged.

The marketing `/r/p_<id>` route loads public metadata from the recording service and then forwards to the app, as specified in the handoff. Set `PUBLIC_CONVEX_SITE_URL` for a marketing preview backed by a development deployment. New backend functions and the marketing route must be deployed before distributing production links.

After code generation, use `convex dev --once` to activate the functions on the configured development deployment. It regenerates `generated/auth.ts` without the existing `consumeOne` and `incrementOne` exports; preserve these exports until the generator is fixed upstream.

Tests cover preparation states, creation validation, dismissible sign-in, failed sharing, callback position, recording access/revocation, shared generation, and audio ranges. Screenshots are in `docs/onboarding`.

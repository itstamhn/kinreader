# Shared-link listening

The desktop revision follows frames 4a–4d in `design_handoff_onboarding_flow 2`. At 640px and wider, the full-width header surrounds a fluid 720px title/control column and 880px reading stage. Save and Share use centered 440px dialogs; Create uses a 560px column with an inline field and action. Below 640px, the mobile layout and bottom sheets remain. Desktop word clicks seek, Play keeps the controls visible, and Follow along enters the larger reading view. Pasting outside a field on the desktop creation page fills the URL without opening another clipboard flow.

The onboarding handoff is implemented in `ListeningPage`, `ListeningSheets`, and `ListeningLibrary`. `App` owns the existing audio engine throughout the flow. Open `/?listen=1` for the sample recording in the new layout. Incoming legacy `?read=<encoded-url>` links use this layout; new saved recordings use `?read=p_<recording-id>`.

`listeningRecords` stores an immutable text/voice snapshot, ownership, and link visibility. New private recordings have an owner capability kept in local storage. Sign-in associates the record with the authenticated account. A private sign-in callback carries the capability in the fragment so it is not sent as a referrer; the app moves it into storage and removes the fragment. Public reads never return that capability.

Narration for these records is scoped to the recording ID. Creation schedules one durable generation job. Visitors only retrieve saved sections; opening a recording cannot start or retry generation. The audio HTTP route checks the current access setting for each segment request and supports byte ranges. Disabling link access stops new requests; bytes already downloaded cannot be withdrawn. Existing legacy narration caches are unchanged.

The marketing `/r/p_<id>` route loads public metadata from the recording service and then forwards to the app, as specified in the handoff. Set `PUBLIC_CONVEX_SITE_URL` for a marketing preview backed by a development deployment. New backend functions and the marketing route must be deployed before distributing production links.

After code generation, use `convex dev --once` to activate the functions on the configured development deployment. It regenerates `generated/auth.ts` without the existing `consumeOne` and `incrementOne` exports; preserve these exports until the generator is fixed upstream.

Tests cover preparation states, creation validation, dismissible sign-in, failed sharing, callback position, recording access/revocation, shared generation, and audio ranges. Screenshots are in `docs/onboarding`.

## Durable creation

Every creation screen uses `ArticleCreationForm` and `useArticleCreation`. The create mutation reserves a private ID and schedules ingestion atomically. Signed-in library membership is saved in that transaction. Anonymous browsers retain the submission token before acknowledgement and remember the resulting record locally. Duplicate acknowledgements join the same record. Creating another article keeps existing playback running and offers an explicit Open action.

The server retrieves and checks the article, stores captured text separately from speech normalization, then schedules the existing section-based narration. Empty and blocked pages fail; uncertain candidates wait for owner approval or replacement text. A real HTML parser selects article/main content and excludes common page furniture. Body-only results require review. These deterministic checks cannot guarantee complete extraction from every website.

Record reads derive readiness from the existing audio job and its opening section. Owners can retry the failed stage or cancel preparation. Cancellation invalidates scheduled work and preserves completed sections; already-running provider requests may finish but cannot commit stale results. Old recordings remain readable, including their existing recording-scoped audio jobs. Legacy URL links prompt for Create audio rather than starting paid work from navigation.

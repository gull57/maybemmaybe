# Stories: setup (Realtime Database only)

Stories use only your Firebase Auth + Realtime Database. No Firebase Storage, Cloud Functions or paid plan is needed.

## Setup
1. Open Firebase console → Realtime Database → Rules.
2. Paste the full contents of `database.rules.json` (it already includes all your existing nodes), then Publish.

That is all. Reload the app.

## How it works
- Photos are compressed in the browser (max 1280px, JPEG, under about 900 KB). Videos must be 6 MB or less and 30 seconds or less. Camera clips record at a capped bitrate, up to 15 seconds.
- The file is stored as base64 text chunks in `storyMedia/{owner}/{storyId}/{n}`. The post itself is `stories/{owner}/{storyId}`.
- Expiry: `createdAt` is a server timestamp. The rules refuse to serve a post or its media 24 hours after `createdAt`, so expired content can't be fetched even with an old link.
- Privacy (friends, custom exclusions, private lists, blocks) is enforced in the rules for both the post and its media.
- Only the owner can read the viewer list. A viewer can only record their own view, once.
- Cleanup: with no server job available, each user's app deletes that user's own expired posts and media whenever it is open (on login and every 30 minutes). Expired data is already unreadable by everyone else.

## Limits and notes
- The free Spark plan allows 1 GB stored and 10 GB downloaded per month. Stories are the heaviest data in the app, so keep an eye on usage in the console.
- Posts from a user who never opens the app again stay in the database (unreadable) until they return.
- Uploaded videos are not transcoded, so larger videos are rejected. Use the in-app camera or trim first.
- GIF and HEIC are rejected.
- The rules trust `users/*/friends` and `blocked`, which any signed-in user can still write. Lock these down for real privacy.
- The rules were not run against the Firebase emulator. Test with two or three accounts after publishing.
- Voice notes are recorded for up to 2 minutes (3 MB maximum), stored as authenticated Realtime Database chunks under `voiceNoteMedia/{sender}/{messageId}`, and loaded only when played. The `voiceNoteMedia` rule is included in `database.rules.json`; publish the updated rules to enable sending and playback.

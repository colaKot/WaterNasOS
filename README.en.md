# WaterNasOS

> [简体中文](README.md) | **English**

WaterNasOS is a cross-platform NAS software that lets you remotely manage your photos, videos, music, books, and files. It also provides file sharing, Transmission downloads, Docker management, a remote terminal, multi-device folder sync, and more — with the same backend serving phone, desktop, TV, and web clients.

## Origin & License

> WaterNasOS is a **modified version** of [NasCabOS](https://github.com/nascab/NasCabOS), released and redistributed under the **GNU GPL v3.0**.
> The copyright of the original work belongs to Beijing Yunpiao Piao Technology Co., Ltd. (© 2025); the copyright of the additions and modifications in this repository belongs to **colaKot** (© 2026).
> Since **2026-10** this repository has applied the rename, feature changes and project-wide adjustments listed below to that work; the modifications are licensed under GPL-3.0 as well.
> The full license text and the original copyright notices are kept unmodified in [LICENSE](LICENSE). Network protocols, device fingerprints and encrypted data formats remain compatible.

## What This Version Changes

Everything changed relative to upstream is listed below: the earlier feature work comes first, followed by **Recent Updates** with the newest additions, and project-wide housekeeping last.

### Features

- **Multi-device folder sync**: a standalone Windows sync client (`sync_client`) plus a shared core package (`packages/nascab_sync_core`), so the desktop client and the standalone client run the same sync engine and transfer protocol. The backend gains a dedicated `/api/sync` namespace and two new tables (`tableSyncTask`, `tableSyncRecord`).
- **Sub-account permission system**: an app-level access policy (`appAccessGuard`) together with fine-grained path permissions, letting you restrict each user's accessible folders and operations (`/api/user/access-policy`). See `docs/子账号权限方案.md`.
- **Multi-library media support**: a new `video_library` entity allows separate movie / TV / photo / mixed libraries, each with its own "show on home" switch; image and mixed libraries get their own grid + full-screen browser. Existing rows are backfilled by `media_type` on upgrade.
- **Standalone Photos / Music clients**: `photo_client` and `music_client` build `NasCabPhoto.exe` / `NasCabMusic.exe`. They depend on the main client by path and add **zero duplicated business code** — `main.dart` is three lines that set a launch mode (`AppLaunchMode.photo` / `.music`), so each app boots straight into Photos or Music with its own icon and title.
- **Theme system**: 26 named color schemes selectable at runtime (Settings → Theme), plus a design-token layer (`app_tokens.dart`) that centralizes spacing / corner-radius / control sizes previously scattered as hard-coded numbers.
- **Content-level dedup for photo backup**: backup now compares size **and content MD5** against the NAS, so re-uploading an unchanged file is skipped instead of transferred again.

### Recent Updates

- **Browsing experience for photo / mixed media libraries**:
  - A new **sort menu** (Name / Taken / Viewed / Added, defaulting to name ascending), shared by photo and mixed libraries and **remembered per library**.
  - Name sorting now uses **natural order**: `(1) < (2) < (10) < (11)` instead of the textual `1, 10, 11, 2`. This adds a `natural_name` column (with index) to `image_index` / `video_index`, so sorting is served by a covering index.
  - Two interchangeable views — a **masonry waterfall** (hand-written with zero dependencies, laid out by each photo's real aspect ratio) and a **regular grid** — plus three library-level toggles: **folder hierarchy / flat library**, **cover art / thumbnail**, and **show file names**. All are persisted per library.
  - Full-screen viewer: previous/next buttons and keyboard arrow keys **wrap around**; in a mixed library, tapping a video goes **straight to the player**.
  - Thumbnails are **generated on demand** by a resident background worker rather than pre-generated in bulk.
- **Player and transcoding**:
  - **Selectable playback quality** (original / 4K / 1080p / 720p / 480p at several bitrates), with a per-library default.
  - **Audio loudness normalization** (per-library switch): optionally measure loudness during scanning and apply two-pass linear `loudnorm` at transcode time for more consistent output volume.
  - **Audio downmix** switch (off by default, preserving the source channel layout); videos with unsupported audio are now **audio-only transcoded** (`-c:v copy`) to avoid needless quality loss.
  - Media info cards show **4K / HDR10+ / Dolby Vision / Dolby Atmos** badges, read directly from ffprobe metadata without rescanning the library.
- **Per-user photo isolation**: a new `uid` owner dimension means **each user only sees their own photos and albums** (timeline, faces, places, albums, collections, trash and AI search all share one visibility check); the underlying indexes (thumbnails / faces / places / similar photos) remain global, with isolation applied only at the read layer.
- **AI and recognition**: the face-recognition model was switched to **EdgeFace**; photo search was enhanced; GPU paths for the footprint map and face processing were optimized.
- **TV clients**: a new playback-settings guide and persisted playback parameters.
- **UI**: app icon and home-screen icon assets refreshed across all clients.

### Project-wide

- **Renamed**: the project and every client display name is now **WaterNasOS** (WaterNasOSServer for the Windows server, WaterNasOS TV for the TV clients); the Flutter package name changed from `NasCabOS` to `WaterNasOS`.
- **Backward compatible**: application identifiers such as `applicationId`, the iOS Bundle ID and the HarmonyOS `bundleName` are **left unchanged**, so existing installs can upgrade in place; network protocols, device fingerprints and encrypted data formats are untouched.
- **Slimmed repository**: third-party runtime binaries (sftpgo, openlist, ffmpeg, ffprobe, rclone, transmission), AI models (`onnx_models`), CocoaPods trees and the geonames database are no longer bundled; run `tool/fetch_nascab_assets.py` to fetch them from the official manifest.
- **Contact & donations**: updated to the maintainer's QR code and email.

## Built-in Apps

Every feature in WaterNasOS is a **standalone app**: its own icon, its own page stack and its own
server-side API namespace, and on desktop it can be opened in a separate window apart from the
main shell. The default app list is served by the backend (`defaultApps` in
`electron_server/src/config/config.js`); users can hide or reorder apps in Settings.

| App | key | Description |
| --- | --- | --- |
| Files | `folder` | Browse, upload/download and share files |
| Photos | `photo` | Timeline, albums, smart albums, collections, face & scene recognition, similar-photo grouping, GPS geotagging, footprint map, "On this day", trash; **isolated per user**, each user sees only their own photos |
| Movies | `movie` | Movies and TV shows, common video formats, multiple libraries (movie / TV / photo / mixed); photo and mixed libraries support sorting (natural order), waterfall/grid views and folder hierarchy |
| Books | `book` | E-book reader supporting EPUB / MOBI / AZW3 / PDF / TXT |
| Music | `music` | Songs, albums, artists, playlists, collections and favorites, with a built-in full-screen player (dynamic lyrics, disc animation, background playback) |
| Notes | `note` | Rich-text notes |
| Encrypted | `encrypted` | AES-encrypted storage; the password is stored encrypted in the local database |
| Media Tool | `media_tool` | Batch image compression and video conversion |
| Sync | `sync` | Folder sync between your computer and the NAS: two-way / download-only / upload-only, with filter rules |
| Terminal | `terminal` | Remote terminal with sensitive commands (rm, unlink, ...) blocked |
| Transmission | `transmission` | BitTorrent download management |
| Docker | `docker` | Images, containers and tasks on the host |
| Backup | `backup` | Phone photo and file backup |
| Mounts | `mounts` | Mount network disks into server directories |
| Share | `share` | Share disks over WebDAV / FTP / SFTP |
| Monitor | `monitor` | Real-time hardware usage |
| Task Center | `task_center` | Background jobs |
| Security | `security` | Login and security settings |
| Users | `user` | Users and permissions |
| Process | `process` | Process viewer |
| Service | `nascab_service` | Server status and account |
| Settings | `setting` | Global settings |

> `transmission`, `terminal`, `user`, `mounts`, `docker`, `nascab_service`, `monitor` and `process`
> are hidden from regular users by default and visible only to administrators. If an app is missing
> from the home screen, it is most likely filtered out by the "hidden apps" setting — restore it in
> Settings.

## Project Structure

This repository contains the following projects:

| Project | Description |
| --- | --- |
| electron_server | Backend, uses electron + express to provide local services |
| flutter_client | Android + iOS + Windows + Mac clients, built with flutter for cross-platform support |
| harmony_client | HarmonyOS client, in development |
| tv_android | Android TV client |
| tv_apple | Apple TV client |
| sync_client | Standalone Windows sync client |
| photo_client | Standalone Windows Photos client (reuses `flutter_client` by path) |
| music_client | Standalone Windows Music client (reuses `flutter_client` by path) |
| packages/nascab_sync_core | Shared sync core package used by the PC client and the standalone sync client |
| tool | Development environment scripts and static self-check scripts |

## Running

Server:

First, download the dependency libraries and plugins provided in the releases (<https://github.com/colaKot/WaterNasOS/releases>), then extract the `libs` and `onnx_models` of the corresponding platform to the root directory of `electron_server`. `libs` contains third-party plugins, and `onnx_models` contains OCR model files used for image recognition.

```bash
npm i;
npm start;
```

Client:

```bash
flutter pub get;
flutter run -d win/ios/android/mac
```

To serve the compiled web client from the server (static web access):

```bash
Build the flutter web version and place it under the electron_server/web/main directory.
```

## Donations

If WaterNasOS is helpful to you, we welcome your support:

<div align="center">

<img src="qrcode-wechat.webp" width="200" alt="WeChat donation QR code" />

</div>

Business cooperation / Contact us: cola23@126.com

## License

WaterNasOS is released under the [GNU General Public License v3.0](LICENSE).

- The copyright of the original upstream work belongs to **Beijing Yunpiao Piao Technology Co., Ltd.** (© 2025) and is retained verbatim.
- The copyright of the additions and modifications in this repository belongs to **colaKot** (© 2026).
- The modifications made in this repository are licensed under GPL-3.0 as well; modification date **2026-10**.
- Any redistributor must keep the copyright notices above and the full license text, and must make the source available under GPL-3.0.

## Third-Party Assets & Acknowledgements

- [Tabler Icons](https://github.com/tabler/tabler-icons): window control buttons and other UI icons (**MIT License**, © Paweł Kuna), consumed via the Dart package `tabler_icons_plus`.
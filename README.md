<div align="center">

# CatFlix (Open Source)

Personal streaming stack for your own movies and shows.

Scan media, encode to HLS, enrich metadata, auto-generate subtitles, then watch in a browser UI built for home/family use.

<img src="https://github.com/user-attachments/assets/126ebe11-2990-4ba0-bc9d-82d54e8f70fb" width="100%">
<div style="display:flex; justify-content:center; gap:4px;">
  <img src="https://github.com/user-attachments/assets/f79250ac-0411-41cc-a4af-9064ef7e0016" width="49.5%">
  <img src="https://github.com/user-attachments/assets/94410c9c-087d-4c28-a4b5-9be2a57fb011" width="49.5%">
</div>

</div>

## What CatFlix Handles

- Detects media files from your mounted library
- Encodes streams to HLS for browser playback
- Pulls posters/details from TMDb
- Tracks watch progress and recently watched entries
- Generates subtitles with Whisper (and filters common hallucination noise)
- Pushes library updates live through WebSocket

## Services

- `catflix_backend/`: API, websocket updates, metadata orchestration, playback endpoints
- `catflix_encoding/`: FFmpeg worker that builds/updates HLS assets
- `catflix_subtitles/`: Whisper subtitle pipeline and subtitle storage
- `catflix_frontend/`: React web app
- `docker-compose.yml`: full stack wiring (includes PostgreSQL)

## Requirements

- Docker Engine + Docker Compose v2
- TMDb API key
- A host media path mountable into containers
- Enough disk for HLS output + metadata + subtitles

## Quick Start

### 1. Create the shared Docker network

```bash
docker network create catflix-net
```

### 2. Configure

```bash
git clone https://github.com/SkyeVoyant/Catflix.git
cd Catflix
cp .env.example .env
```

Required `.env` values:

```env
PASSWORD=your_secure_password
TMDB_API_KEY=your_tmdb_api_key
MEDIA_MOUNT_SOURCE=/path/to/your/media

# bundled postgres defaults
PGDATABASE=CatFlixDB
PGUSER=catflix
PGPASSWORD=catflix
PGPORT=5434

# subtitles
WHISPER_MODEL=small
```

### 3. Launch

```bash
docker compose up -d --build
```

## Media Layout

Expected structure under `MEDIA_MOUNT_SOURCE`:

```text
MEDIA_MOUNT_SOURCE/
├── movies/
│   └── Movie Title (Year)/
│       └── Movie Title (Year).mkv
└── shows/
    └── Show Title/
        └── Season 01/
            ├── Show Title - S01E01.mkv
            └── Show Title - S01E02.mkv
```

Notes:

- Movies should be in their own folders.
- Shows should be grouped by season folders.
- Existing HLS files are detected and reused.

## Subtitle Pipeline

Subtitle generation flow:

1. extract audio
2. run Whisper transcription
3. filter low-signal/repetitive artifacts
4. save JSON subtitle payload
5. serve browser-friendly subtitle format through backend

Tuning is controlled by `WHISPER_MODEL` and subtitle service env settings.

## Useful Commands

```bash
# backend logs
docker compose logs -f catflix-app

# encoder logs
docker compose logs -f catflix-encoder

# subtitle logs
docker compose logs -f catflix-subtitles

# pause heavy workers
docker compose stop catflix-encoder
docker compose stop catflix-subtitles

# resume workers
docker compose start catflix-encoder
docker compose start catflix-subtitles
```

## Troubleshooting

- No media found:
  - verify `MEDIA_MOUNT_SOURCE`
  - verify host permissions
- Missing metadata:
  - verify TMDb key
- Playback issues:
  - check encoder logs for the title
- Subtitles missing:
  - check subtitle worker logs and disk output path

## Security Notes

- Keep `.env` private.
- Use strong `PASSWORD`.
- Put HTTPS + auth in front if exposing outside your private network.

## License

GPL-2.0-only

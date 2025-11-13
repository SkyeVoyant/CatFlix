<div align="center">

# Catflix

Self-hosted HLS streaming for your personal movie + TV library.  
Catflix scans your media folders, enriches titles with TMDb metadata, and re-encodes into adaptive HLS playlists so you can stream privately from any browser while a dedicated FFmpeg worker handles heavy lifting in the background.

<img src="https://github.com/user-attachments/assets/126ebe11-2990-4ba0-bc9d-82d54e8f70fb" width="100%">
<div style="display:flex; justify-content:center; gap:4px;">
  <img src="https://github.com/user-attachments/assets/f79250ac-0411-41cc-a4af-9064ef7e0016" width="49.5%">
  <img src="https://github.com/user-attachments/assets/94410c9c-087d-4c28-a4b5-9be2a57fb011" width="49.5%">
</div>

</div>

## Highlights

- **Instant startup** – the manifest now lives in Postgres; restarts pull it straight from the DB and stream updates over websockets, so the UI fills in live without reloads.
- **Real-time ingestion** – the encoder notifies the backend as soon as an episode/movie is ready, which upserts the manifest row and pushes that single change to every connected client.
- **Dual-source playback** – HLS playlists are preferred, but direct video files stay available until encoding completes, so nothing disappears while jobs run.
- **Rich UI** – favourites, recently added/watched carousels, metadata-driven detail pages (cast, trailers, certifications) and automatic TV → movie rating translation.
- **Privacy-first** – single-password gate, no third-party telemetry, everything stays on your hardware.

## Architecture

| Component | Description |
|-----------|-------------|
| **catflix_backend/** | Express API, manifest synchroniser, metadata backfill, remux/download endpoints, websocket broadcaster. |
| **catflix_encoding/** | FFmpeg worker that watches the library, produces HLS renditions, and notifies the backend per asset. |
| **catflix_frontend/** | React SPA served as static assets; now consumes manifest updates over `/ws/manifest` so the UI updates entry-by-entry. |
| **docker-compose.yml** | Builds/ships both services plus shares media + credentials through `.env`. |

### Data flow
1. Backend boots, loads the persisted manifest from `media_manifest_entries`, and serves it immediately.
2. Background scanner diffs the filesystem against the DB table and writes only the rows that changed.
3. Clients open the websocket, receive the latest snapshot chunk-by-chunk, then stay live as new entries arrive or old ones disappear.
4. Encoder/notify endpoint can upsert a single movie or show without triggering a full rebuild.

## Feature Tour

- Full-text search, genre + decade filters, and title/release sorting.
- “Recently Added” and “Continue Watching” carousels fed by the DB timestamps (no filesystem heuristics).
- Resume points, remembered volume, favourite tagging, and quick download actions (movie or entire season).
- TMDb integration for posters, cast, trailers, and certification translation (TV ratings mapped to familiar MPAA-style descriptors).
- Native HLS playback via `<video>` on Safari/iOS and HLS.js fallback elsewhere; subtitle hook ready for future endpoint.

## Requirements
- Docker Engine (Linux host, WSL2, or a Linux VM)
- Docker Compose v2
- PostgreSQL 13+ (local container or existing server)
- TMDb API key (free account)
- Media library reachable from the Docker host

## Database Setup
Catflix expects a PostgreSQL database named `CatFlixDB` (defaults can be changed through `.env`).  
On startup the backend **creates every required table and index automatically** if they do not already exist, so you only need to provision the database and credentials.

### Option 1 – Dockerised Postgres
Create `postgres-compose.yml` (or add to an existing stack):

```yaml
services:
  catflix-db:
    image: postgres:16-alpine
    container_name: CatFlixDB
    restart: unless-stopped
    environment:
      POSTGRES_DB: CatFlixDB
      POSTGRES_USER: catflix
      POSTGRES_PASSWORD: catflix
    ports:
      - "5434:5432"
    volumes:
      - ./catflix-db-data:/var/lib/postgresql/data
    networks:
      - catflix-net

networks:
  catflix-net:
    external: true
```

Spin it up with:

```bash
docker network create catflix-net   # once per host
docker compose -f postgres-compose.yml up -d
```

### Option 2 – Existing PostgreSQL Server
Log in as an admin user and run:

```sql
CREATE DATABASE "CatFlixDB";
CREATE USER catflix WITH PASSWORD 'catflix';
GRANT ALL PRIVILEGES ON DATABASE "CatFlixDB" TO catflix;
```

Adjust names if you prefer different credentials; just reflect them in `.env`.  
The backend will take care of creating the tables (`movies`, `movie_files`, `shows`, `seasons`, `episodes`, `media_manifest_entries`) the first time it connects.

## Environment Configuration
Duplicate the sample file and edit the values to match your setup:

```bash
cp .env.example .env
```

Important keys:
- `PASSWORD` – UI login password
- `TMDB_API_KEY` – TMDb token used for metadata requests
- `MEDIA_DIR` / `MEDIA_MOUNT_SOURCE` – host path to your media (Windows paths are accepted)
- `INTERNAL_API_KEY` – shared secret between backend and encoder notifications (keep the same value for both containers)
- `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` – connection info for PostgreSQL
- `HLS_*` knobs – advanced FFmpeg/transcoder settings (defaults work well for most setups)

### Getting a TMDb API Key
TMDb offers free API access for personal, non-commercial projects.

1. Create or sign in to an account at [themoviedb.org](https://www.themoviedb.org/signup).
2. Verify your email address if prompted.
3. Visit your account settings → **API** tab and request an API key (choose the “Developer” option).
4. Copy the **API Key (v3 auth)** value into `TMDB_API_KEY` in your `.env` file.

## Media Library Layout
Catflix expects a simple folder structure so it can recognise movies and episodic content and generate the correct HLS manifests:

```
MEDIA_DIR/
├── movies/
│   ├── Movie Title (Year)/
│   │   ├── Movie Title (Year).mkv
│   │   └── ...
│   └── Another Movie/
│       └── Another Movie.mp4
└── shows/
    ├── Show Title/
    │   ├── Season 01/
    │   │   ├── Show Title - S01E01.mkv
    │   │   ├── Show Title - S01E02.mkv
    │   │   └── ...
    │   └── Season 02/
    │       └── Show Title - S02E01.mkv
    └── Another Show/
        └── Season 01/
            └── Episode 01.mp4
```

- Movies and shows must live under separate top-level folders (`movies/` and `shows/`).
- Place every movie inside its own subdirectory; the encoder assumes this layout and may fail to process loose files dropped directly under `movies/`.
- Shows should be split by season; Catflix uses the season folder name and the file name to infer episode numbering.
- Any existing HLS output (`.m3u8`, `.ts`) inside these directories will be picked up automatically; otherwise the encoder will generate them on demand.

## Manifest Persistence + Live Updates

| Layer | Purpose |
|-------|---------|
| **`media_manifest_entries` table** | Stores every movie/show manifest row (payload JSONB + timestamps). Startup simply `SELECT`s from this table—no full rescan required. |
| **Scanner** | Still walks the filesystem in the background, but now diffs against the DB and only touches rows that changed (zero cache thrash). |
| **Websocket (`/ws/manifest`)** | Streams a snapshot on connect, then pushes incremental `upsert`/`delete` events. The frontend applies them immediately, so new episodes surface seconds after encoding finishes. |
| **Source fallback** | Each episode/movie includes `sourceType` (`hls` or `direct`). Direct files remain playable until the FFmpeg worker produces an HLS master playlist, at which point the manifest automatically flips over. |

Console log example:  
`[media-cache] Manifest built: HLS=4427, Backup=2819, Total=5991` – you always know how much is fully HLS-ready vs still using backup sources.

## Age Rating Translation

The frontend automatically translates TV ratings to standardized movie ratings for clarity:

| TV Rating | Displayed As | Meaning |
|-----------|--------------|---------|
| TV-Y, TV-Y7, TV-G | **G (General Audiences)** | All ages appropriate |
| TV-PG | **PG (Parental Guidance Suggested)** | Some material may not be suitable for children |
| TV-14 | **PG-13 (Parents Strongly Cautioned)** | Some material may be inappropriate for children under 13 |
| TV-MA | **R (Restricted)** | Under 17 requires accompanying parent or adult guardian |

Movie ratings (G, PG, PG-13, R, NC-17) are displayed with their full descriptions as well. This provides consistent, easy-to-understand age ratings across all content.

## Quick Start (Docker Compose)
```bash
git clone https://github.com/SkyeVoyant/Catflix.git
cd Catflix

cp .env.example .env                      # fill in PASSWORD, TMDB_API_KEY, MEDIA paths, DB creds
docker network create catflix-net        # once per host
# start Postgres (either reuse /root/databases/catflix or run your own)
docker compose up -d --build             # builds frontend+backend+encoder
```
Visit `http://localhost:3004`, log in with the password from `.env`, and watch the library populate instantly from the DB snapshot while the background scanner/encoder keeps refining entries.

- Pause encoding to save CPU: `docker compose stop catflix-encoder`
- Resume later: `docker compose start catflix-encoder`
- Tail logs  
  - Backend: `docker compose logs -f catflix-app`  
  - Encoder: `docker compose logs -f catflix-encoder`
- Force a manual rebuild (if needed): `docker exec CatFlixApp node -e "require('./src/services/mediaCache').refreshMediaCache('manual')"`
- Back up the DB: snapshot the Postgres volume or run `pg_dump` with the credentials from `.env`.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Empty UI after login | Verify the DB is reachable (`docker logs CatFlixApp`) and `media_manifest_entries` has rows (run `SELECT count(*)` in Postgres). |
| Metadata missing | Double-check `TMDB_API_KEY` and inspect backend logs for TMDb errors/rate limits. |
| Media path problems | Confirm `MEDIA_DIR`, `MEDIA_DIR_OUT`, and `MEDIA_MOUNT_SOURCE` are aligned (Windows path ↔️ WSL mount ↔️ Docker volume). |
| Encoder hammering CPU | Lower `HLS_MAX_CONCURRENCY` in `.env` or temporarily stop the encoder container. |

---

Catflix is built for personal media servers: fast startup, resilient manifests, low-maintenance Docker workflow, and a UI that keeps pace with your library in real time.
- **Encoder idle** – check `catflix-encoder` logs; the worker reports when media paths are missing or jobs are already processed.

## Developing Without Docker
- Install dependencies:  
  `pnpm install` in `catflix_backend/` (also installs shared deps for `catflix_encoding/`), `pnpm install` in `catflix_frontend/`
- Start services:
  - Backend: `pnpm start` inside `catflix_backend/`
  - Encoder: `node ../catflix_encoding/index.js`
  - Frontend (dev server): `pnpm start` inside `catflix_frontend/`
- Ensure PostgreSQL and the `.env` file are available; the backend will still perform schema creation on launch.

## License
GPL-2.0-only

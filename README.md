<div align="center">

# Catflix (Open Source)

Self-hosted streaming platform for your personal movie and TV library.  
Automatically scan, encode, enrich with metadata, generate subtitles, and stream from any browser with a clean, Netflix-inspired interface.

<img src="https://github.com/user-attachments/assets/126ebe11-2990-4ba0-bc9d-82d54e8f70fb" width="100%">
<div style="display:flex; justify-content:center; gap:4px;">
  <img src="https://github.com/user-attachments/assets/f79250ac-0411-41cc-a4af-9064ef7e0016" width="49.5%">
  <img src="https://github.com/user-attachments/assets/94410c9c-087d-4c28-a4b5-9be2a57fb011" width="49.5%">
</div>

</div>

## Features

### Core Functionality
- **🎬 Automatic HLS Encoding** – FFmpeg worker converts your media to adaptive HLS streams for smooth playback on any device
- **📱 Universal Device Support** – Live on-the-fly remuxing for Samsung Browser and Apple devices; automatic fMP4 conversion with in-memory caching for maximum compatibility
- **⚡ Instant Loading** – WebSocket streams content one-by-one for near-instant UI population; first items appear immediately while rest loads in background
- **📊 Live Updates** – PostgreSQL-backed manifest with real-time synchronization; new content appears automatically without refresh
- **🎭 Rich Metadata** – TMDb integration for posters, cast, trailers, ratings, and genre information
- **📝 Automated Subtitles** – OpenAI Whisper generates English subtitles with smart hallucination filtering and browser-native WebVTT rendering
- **⏯️ Resume Playback** – Pick up exactly where you left off on any device
- **⭐ Personal Curation** – Favorites, recently watched carousel, and hide functionality
- **🔍 Advanced Filtering** – Search, genre filters, decade filters, and multiple sort options
- **📥 Batch Downloads** – Download individual movies or entire TV seasons with one click
- **🌐 Browser-Native Playback** – HLS.js for cross-browser support with native subtitle controls

### Modern Frontend Architecture
The React frontend is built with a clean, modular architecture for easy customization:
- **Organized Components** – Separate components for navbar, video player, cards, modals, and sections
- **Custom Hooks** – Reusable hooks for authentication, media data, filters, favorites, downloads, and video player logic
- **Utility Functions** – Dedicated modules for formatting, parsing, and storage operations
- **27 Files** – Split from a monolithic ~1,100 line file into focused, maintainable modules

### Intelligent Subtitle Generation
The subtitle service uses OpenAI Whisper with advanced anti-hallucination filtering:
- **Smart Filtering** – Removes common artifacts like "You", "Thanks for watching", and repetitive patterns
- **Pattern Detection** – Identifies and removes hallucinations that appear at regular intervals
- **Duration Analysis** – Filters out segments shorter than 0.5 seconds
- **Confidence Thresholds** – Uses Whisper's logprob and compression ratio to reject low-quality segments
- **Sequential Processing** – Movies alphabetically, then TV shows by title → season → episode
- **WebVTT Conversion** – Automatic conversion from JSON to browser-compatible WebVTT format

## Architecture

| Component | Description |
|-----------|-------------|
| **catflix_backend/** | Express API with WebSocket support, manifest synchronization, metadata backfill, subtitle proxy, remux/download endpoints |
| **catflix_encoding/** | FFmpeg worker that monitors the library, produces HLS renditions, and notifies the backend as each asset completes |
| **catflix_subtitles/** | Whisper-powered subtitle generator with hallucination filtering, multi-language translation, and WebVTT conversion |
| **catflix_frontend/** | Modular React SPA with custom hooks, organized components, and real-time manifest updates via WebSocket |
| **docker-compose.yml** | Complete stack orchestration with shared volumes and environment configuration |

### Data Flow
1. **Startup**: Backend loads persisted manifest from `media_manifest_entries` table
2. **Instant UI**: WebSocket streams items one-by-one in alphabetical order; frontend displays each immediately for fast perceived load
3. **Background Scanning**: Filesystem scanner diffs against database and updates only changed entries
4. **Live Updates**: New content appears automatically via WebSocket without page refresh
5. **Subtitle Generation**: Dedicated service processes media alphabetically, generating filtered subtitles with Whisper
6. **Subtitle Delivery**: Frontend checks subtitle availability via HEAD request and loads WebVTT format from the backend proxy

## Requirements
- Docker Engine (Linux host, WSL2, or Linux VM)
- Docker Compose v2
- PostgreSQL 13+ (containerized or external)
- TMDb API key (free tier sufficient)
- Media library accessible to Docker host
- For subtitles: FFmpeg and OpenAI Whisper (auto-installed in container)

## Quick Start

### 1. Database Setup

**Option A – Docker PostgreSQL:**
```bash
docker network create catflix-net
```

Create `postgres-compose.yml`:
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

```bash
docker compose -f postgres-compose.yml up -d
```

**Option B – Existing PostgreSQL:**
```sql
CREATE DATABASE "CatFlixDB";
CREATE USER catflix WITH PASSWORD 'catflix';
GRANT ALL PRIVILEGES ON DATABASE "CatFlixDB" TO catflix;
```

### 2. Configuration

```bash
git clone https://github.com/SkyeVoyant/Catflix.git
cd Catflix
cp .env.example .env
```

Edit `.env` with your settings:
```env
PASSWORD=your_secure_password
TMDB_API_KEY=your_tmdb_api_key
MEDIA_DIR=/path/to/your/media
PGHOST=localhost
PGPORT=5434
PGDATABASE=CatFlixDB
PGUSER=catflix
PGPASSWORD=catflix
WHISPER_MODEL=small  # tiny/base/small/medium/large-v3
```

### 3. Get TMDb API Key
1. Create account at [themoviedb.org](https://www.themoviedb.org/signup)
2. Visit account settings → **API** tab
3. Request API key (choose "Developer" option)
4. Copy **API Key (v3 auth)** into `.env`

### 4. Launch Services

```bash
docker compose up -d --build
```

Visit `http://localhost:3004` and log in with your password!

## Media Library Structure

Catflix expects this folder organization:

```
MEDIA_DIR/
├── movies/
│   ├── Movie Title (Year)/
│   │   └── Movie Title (Year).mkv
│   ├── Another Movie/
│   │   └── Another Movie.mp4
│   └── ...
└── shows/
    ├── Show Title/
    │   ├── Season 01/
    │   │   ├── Show Title - S01E01.mkv
    │   │   ├── Show Title - S01E02.mkv
    │   │   └── ...
    │   └── Season 02/
    │       └── ...
    └── ...
```

**Important Notes:**
- Movies must be in their own subdirectory
- Shows should be organized by season folders
- Episode files can use any naming convention (episode numbers are parsed automatically)
- Existing HLS output (`.m3u8`, `.ts`) will be detected and used

## Service Management

```bash
# View logs
docker compose logs -f catflix-app       # Backend
docker compose logs -f catflix-encoder   # HLS encoder
docker compose logs -f catflix-subtitles # Subtitle generator

# Control services
docker compose stop catflix-encoder      # Pause encoding (save CPU)
docker compose start catflix-encoder     # Resume encoding

docker compose stop catflix-subtitles    # Pause subtitle generation
docker compose start catflix-subtitles   # Resume subtitle generation

docker compose restart catflix-app       # Restart backend
```

## Subtitle System

### How It Works
The subtitle service automatically processes all HLS-encoded content:

1. **Extraction**: Extracts audio from HLS `.ts` segments
2. **Transcription**: Uses OpenAI Whisper to generate timestamped text
3. **Filtering**: Removes hallucinations, repetitions, and artifacts
4. **Translation**: Translates non-English audio to English (via Argos Translate)
5. **Storage**: Saves as JSON with metadata (easily editable)
6. **Delivery**: Frontend requests WebVTT format via backend proxy

### Processing Order
- **Movies**: Alphabetical by title
- **TV Shows**: By show title, then season number, then episode number
- All episodes of a season complete before moving to next show

### Anti-Hallucination Features
The service applies multiple filters to ensure clean subtitles:

**Whisper Parameters:**
- `--condition_on_previous_text False` – Prevents repetitive hallucinations
- `--logprob_threshold -1.0` – Filters low-confidence segments
- `--compression_ratio_threshold 2.4` – Rejects repetitive patterns
- `--initial_prompt` – Guides Whisper toward clean dialogue transcription

**Post-Processing Filters:**
- Pattern matching for common artifacts ("You", "Thanks for watching", etc.)
- Duration filtering (removes segments < 0.5 seconds)
- Repetition detection (identifies patterns at regular intervals)
- Confidence analysis (removes punctuation-only segments)

### Configuration
Adjust in `.env` or `docker-compose.yml`:

```env
WHISPER_MODEL=small           # tiny/base/small/medium/large-v3
                              # Larger = more accurate but slower
                              # small is recommended (good balance)

SUBTITLES_DIR=/app/subtitles  # Storage location (in container)
```

**Model Comparison:**
- `tiny`: Fastest, lowest accuracy (~1 GB RAM, ~5-10 min/hour)
- `base`: Fast, decent accuracy (~1 GB RAM, ~10-15 min/hour)
- `small`: **Recommended** – Good accuracy (~2 GB RAM, ~15-30 min/hour)
- `medium`: Better accuracy (~5 GB RAM, ~30-60 min/hour)
- `large-v3`: Best accuracy (~10 GB RAM, ~60-120 min/hour)

### Storage Structure
```
subtitles/
├── movies/
│   ├── Movie Title.json
│   └── ...
└── shows/
    ├── Show Title/
    │   ├── season 1/
    │   │   ├── Episode 1.json
    │   │   └── ...
    │   └── season 2/
    │       └── ...
    └── ...
```

Each JSON file contains:
```json
{
  "metadata": {
    "language": "en",
    "originalLanguage": "en",
    "model": "small",
    "generatedAt": "2025-11-19T10:00:00.000Z",
    "filtered": 15
  },
  "subtitles": [
    {
      "id": 1,
      "start": 12.5,
      "end": 15.8,
      "text": "This is the dialogue text"
    },
    ...
  ]
}
```

### Manual Subtitle Editing
Subtitle JSON files can be edited directly:
1. Navigate to `catflix_subtitles/subtitles/`
2. Edit the JSON file with any text editor
3. Changes take effect immediately (no restart needed)
4. Frontend will fetch updated WebVTT next time video loads

## Age Rating Translation

For consistency, TV ratings are automatically converted to movie-style ratings:

| TV Rating | Displayed As | Description |
|-----------|--------------|-------------|
| TV-Y, TV-Y7, TV-G | **G (General Audiences)** | All ages admitted |
| TV-PG | **PG (Parental Guidance Suggested)** | Some material may not be suitable for children |
| TV-14 | **PG-13 (Parents Strongly Cautioned)** | Some material may be inappropriate for children under 13 |
| TV-MA | **R (Restricted)** | Under 17 requires accompanying parent or adult guardian |

Movie ratings (G, PG, PG-13, R, NC-17) display with full MPAA descriptions.

## Frontend Architecture

The React frontend is built with a clean, modular structure for easy customization and contributions:

```
src/
├── App.js (292 lines - orchestration layer)
├── constants.js (global constants)
├── utils/
│   ├── formatters.js (time & episode formatting)
│   ├── parsers.js (URL & key parsing)
│   └── storage.js (localStorage helpers)
├── hooks/
│   ├── useAuth.js (authentication)
│   ├── useMediaData.js (fetch movies/shows/metadata)
│   ├── useRecentWatched.js (recent watch tracking)
│   ├── useFavorites.js (favorites management)
│   ├── useDownloads.js (movie/season downloads)
│   ├── useFilters.js (filtering & sorting logic)
│   └── useVideoPlayer.js (HLS player, resume, events)
└── components/
    ├── layout/
    │   ├── Navbar.jsx
    │   └── FilterBar.jsx
    ├── video/
    │   ├── VideoPlayer.jsx
    │   └── NextEpisodeOverlay.jsx
    ├── cards/
    │   ├── MediaCard.jsx
    │   └── RecentCard.jsx
    ├── modals/
    │   └── DetailModal.jsx
    └── sections/
        ├── RecentlyWatchedSection.jsx
        ├── FavoritesSection.jsx
        ├── RecentlyAddedSection.jsx
        └── AllResultsSection.jsx
```

**Benefits:**
- Easy to find and modify specific features
- Reusable hooks across components
- Clear separation of concerns
- Simple to add new features or customize UI
- Perfect for open-source contributions

## API Endpoints

### Backend (Port 3004)
- `POST /auth/login` – Authenticate with password
- `POST /auth/logout` – Clear session
- `GET /api/media` – Get full media manifest
- `GET /api/metadata` – Fetch TMDb metadata for a title
- `GET /api/subtitles` – Proxy to subtitle service (returns WebVTT)
- `GET /ws/manifest` – WebSocket for live manifest updates
- `POST /api/downloads/movies/:id/prepare` – Prepare movie download
- `GET /api/downloads/movies/:id/file` – Download movie file
- `POST /api/downloads/episodes/:id/prepare` – Prepare episode download
- `GET /api/downloads/episodes/:id/file` – Download episode file

### Subtitle Service (Port 3006)
- `GET /api/subtitles/movie/:entryId` – Get movie subtitle (JSON)
- `GET /api/subtitles/episode/:entryId` – Get episode subtitle (JSON)
- `GET /api/subtitles/movie/:entryId/vtt` – Get movie subtitle (WebVTT)
- `GET /api/subtitles/episode/:entryId/vtt` – Get episode subtitle (WebVTT)
- `GET /api/subtitles/status/movie/:entryId` – Check availability
- `GET /api/subtitles/status/episode/:entryId` – Check availability
- `GET /health` – Service health check

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Empty UI after login | Check database connection in logs (`docker logs CatFlixApp`). Verify `media_manifest_entries` table has rows. |
| No metadata/posters | Verify `TMDB_API_KEY` is correct. Check backend logs for API errors or rate limits. |
| Media not found | Confirm `MEDIA_DIR` paths are correct and accessible from Docker containers. Check volume mounts in `docker-compose.yml`. |
| High CPU usage | Lower `HLS_MAX_CONCURRENCY` in `.env` or stop encoder: `docker compose stop catflix-encoder` |
| Subtitles not appearing | Check subtitle service logs: `docker logs CatFlixSubtitles`. Verify Whisper is installed and `WHISPER_MODEL` is valid. |
| Subtitles have errors | Try regenerating with different Whisper model, or manually edit JSON files in `subtitles/` directory. |
| Slow subtitle generation | Use smaller Whisper model (`tiny` or `base`) or allocate more CPU/RAM to container. |
| Database connection failed | Verify PostgreSQL is running and credentials in `.env` match database configuration. |

## Developing Without Docker

### Backend & Encoder
```bash
cd catflix_backend
pnpm install
pnpm start  # Backend

# In separate terminal
cd catflix_encoding
node index.js  # Encoder
```

### Subtitle Service
```bash
cd catflix_subtitles
pnpm install

# Install Whisper
pip install openai-whisper

# Install Argos Translate
pip install argostranslate
# Download English translation model (run in Python):
# import argostranslate.package
# argostranslate.package.update_package_index()
# available = argostranslate.package.get_available_packages()
# to_en = list(filter(lambda x: x.to_code == 'en', available))
# for pkg in to_en: argostranslate.package.install_from_path(pkg.download())

node src/index.js  # Start service
```

### Frontend
```bash
cd catflix_frontend
pnpm install
pnpm start  # Dev server on http://localhost:3000
```

Ensure PostgreSQL is running and `.env` is configured. All services will perform automatic schema creation on first launch.

## Performance Tips

### Encoding Performance
- Set `HLS_MAX_CONCURRENCY` based on CPU cores (default: 2)
- Use hardware encoding if available (configure FFmpeg flags in encoder)
- Process library in batches by temporarily moving files

### Subtitle Performance
- Use `small` model for best speed/accuracy balance
- Monitor RAM usage (Whisper loads entire model into memory)
- Pause subtitle generation during peak usage times

### Database Performance
- Regularly vacuum PostgreSQL: `VACUUM ANALYZE;`
- Create indexes on frequently queried fields
- Consider dedicated PostgreSQL server for large libraries (1000+ items)

## Backup & Recovery

### Database Backup
```bash
# Dump database
docker exec CatFlixDB pg_dump -U catflix CatFlixDB > catflix_backup.sql

# Restore database
docker exec -i CatFlixDB psql -U catflix CatFlixDB < catflix_backup.sql
```

### Subtitle Backup
Subtitles are stored as JSON files in `catflix_subtitles/subtitles/`. Simply backup this directory:
```bash
tar -czf subtitles_backup.tar.gz catflix_subtitles/subtitles/
```

## Contributing

Catflix is designed for easy customization and contributions:

1. **Frontend**: Modular React components make it easy to add features or change UI
2. **Backend**: Clean Express routes with separated business logic
3. **Subtitles**: Pluggable architecture allows custom filters or alternative transcription engines
4. **Encoder**: FFmpeg pipeline can be extended with custom presets

Feel free to open issues or pull requests!

## License

GPL-2.0-only

---

**Catflix** – Your personal streaming platform with automated subtitles, smart encoding, and a beautiful interface. All running on your hardware, with your rules.

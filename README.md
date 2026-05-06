# MCP Gemma Monolith

A local chat and RAG app that connects a React frontend, an Express/WebSocket backend, Ollama models, Weaviate vector search, and PostgreSQL with pgvector.

The app can run against Ollama on your host machine or an Ollama Docker container. It can use an NVIDIA GPU when available and falls back to CPU mode when it is not.

## Features

- Streaming chat over WebSockets with a Stop button.
- Ollama model selection with installed-model detection and fallback notices.
- Host Ollama mode for using models already installed on your system.
- Docker Ollama mode for isolated container-based model storage.
- Weaviate-backed file and repository upload for RAG.
- PostgreSQL 16 with pgvector in the Docker stack for relational/vector storage.
- Repo upload filtering for generated folders, binary files, large files, and duplicate `filePath` values.
- RAG answers with source metadata and clickable source links.
- Saved chats in browser storage.
- Markdown and JSON chat export.
- MCP-style REST endpoint with model and Weaviate tools.

## Requirements

- Node.js 20+
- npm
- Ollama, if using host Ollama or local dev mode
- Docker and Docker Compose, if using the Docker stack
- NVIDIA Container Toolkit, if using GPU acceleration in Docker

GPU is optional. CPU mode works, but model and embedding generation will be slower.

## Quick Start

Install dependencies:

```bash
npm run install-all
```

Start the full Docker stack:

```bash
./docker-start.sh
```

The startup script builds `frontend/dist` first, then bind-mounts it into the backend container. This keeps `http://localhost:3000` aligned with the current frontend source.

Open:

- App: http://localhost:3000
- Backend API: http://localhost:3000/api
- Weaviate: http://localhost:8080
- PostgreSQL: localhost:5432

For local development without Docker:

```bash
ollama serve
npm run dev
```

Open:

- Frontend: http://localhost:5173
- Backend API: http://localhost:3002/api

## Docker Startup Modes

Use `docker-start.sh` as the normal entry point:

```bash
./docker-start.sh
```

The script checks for:

- Docker Compose
- RTX 5080 plus Docker NVIDIA runtime
- host Ollama at `http://localhost:11434/api/tags`

If host Ollama is running and already has models, the backend uses your host models automatically. Otherwise it uses the Docker Ollama service.

Force GPU mode:

```bash
MCP_ACCELERATOR=gpu ./docker-start.sh
```

Force CPU mode:

```bash
MCP_ACCELERATOR=cpu ./docker-start.sh
```

Force host Ollama:

```bash
MCP_OLLAMA_MODE=host ./docker-start.sh
```

Force Docker Ollama:

```bash
MCP_OLLAMA_MODE=container ./docker-start.sh
```

Use both overrides together:

```bash
MCP_ACCELERATOR=gpu MCP_OLLAMA_MODE=host ./docker-start.sh
```

## Models

The selected model only affects chat answers. File uploads to Weaviate use Weaviate's embedding sidecar, not the selected Ollama model.

Install a model on host Ollama:

```bash
ollama pull gemma4:26b
ollama list
```

Install a model inside Docker Ollama:

```bash
docker exec -it mcp-ollama ollama pull gemma4:26b
docker exec -it mcp-ollama ollama list
```

Default/suggested models are controlled with:

```env
MODEL_NAME=gemma3:4b
SUGGESTED_MODELS=gemma4:e4b,gemma4:26b,gemma4:31b
```

If you select a model that is not installed, the backend falls back to an installed model and the UI shows what was used.

## Configuration

For local dev, create or edit `backend/.env`:

```env
OLLAMA_BASE_URL=http://localhost:11434
MODEL_NAME=gemma3:4b
API_PORT=3002
MCP_PORT=3001
WEAVIATE_URL=http://localhost:8080
DATABASE_URL=postgresql://mcp:mcp_dev_password@localhost:5432/mcp_gemma
PGHOST=localhost
PGPORT=5432
PGDATABASE=mcp_gemma
PGUSER=mcp
PGPASSWORD=mcp_dev_password
WEAVIATE_ENABLE_PQ=false
WEAVIATE_PQ_TRAINING_LIMIT=50000
WEAVIATE_CONTEXT_RESULTS=12
WEAVIATE_CONTEXT_CHARS=12000
WEAVIATE_RERANK_CANDIDATE_MULTIPLIER=2
WEAVIATE_SEARCH_MAX_CANDIDATES=24
WEAVIATE_SEARCH_MODE=hybrid
WEAVIATE_SEARCH_SNIPPET_CHARS=1200
WEAVIATE_UPLOAD_CHUNK_CHARS=300
WEAVIATE_UPLOAD_CHUNK_OVERLAP_CHARS=50
WEAVIATE_UPLOAD_MIN_CHUNK_CHARS=200
WEAVIATE_UPLOAD_CHUNK_DELAY_MS=20
WEAVIATE_UPLOAD_CHUNK_RETRIES=3
MAX_UPLOAD_FILE_BYTES=20971520
OLLAMA_MODEL_CACHE_MS=30000
OLLAMA_KEEP_ALIVE=10m
SUGGESTED_MODELS=gemma4:e4b,gemma4:26b,gemma4:31b
NODE_ENV=development
```

For Docker, the backend environment is in `docker-compose.yml`.

## PostgreSQL And pgvector

The Docker stack includes a PostgreSQL 16 container with pgvector enabled:

```text
Service: postgres
Container: mcp-postgres
Database: mcp_gemma
User: mcp
Password: mcp_dev_password
Host from Docker network: postgres:5432
Host from your machine: localhost:5432
```

Use the Docker network connection string from containers:

```env
DATABASE_URL=postgresql://mcp:mcp_dev_password@postgres:5432/mcp_gemma
```

Use the localhost connection string from local development:

```env
DATABASE_URL=postgresql://mcp:mcp_dev_password@localhost:5432/mcp_gemma
```

The init script at `docker/postgres/init/001-enable-pgvector.sql` runs on first database creation and enables the `vector` extension. If you already have an existing `postgres_data` volume from before this setup, recreate the volume or run `CREATE EXTENSION IF NOT EXISTS vector;` manually.

Check pgvector:

```bash
docker exec -it mcp-postgres psql -U mcp -d mcp_gemma -c "SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';"
```

PostgreSQL is on the same Docker network as the backend, Weaviate, and Ollama. The current app still uses Weaviate for uploaded-document RAG and Ollama for model responses; PostgreSQL is ready for additional app persistence or custom pgvector workflows.

## Uploads And RAG

Use **Upload files** for selected PDFs and text/code files.

Use **Upload repo** to choose a folder or repository. The frontend preserves repo-relative paths and sends them as `filePath`.

Upload behavior:

- PDFs are parsed in the browser with `pdfjs-dist`.
- Text/code files are read in the browser.
- Repo uploads skip common generated folders such as `.git`, `node_modules`, `dist`, `build`, `coverage`, virtualenvs, and cache folders.
- Repo uploads skip unsupported binary files. Supported document uploads include PDF, PowerPoint `.pptx`, and selected text/code files.
- Repo uploads skip files larger than 20 MB by default.
- Backend skips duplicates already in the target Weaviate collection with the same `filePath`.
- Uploads are batched to avoid oversized JSON requests.
- The expert library manager modal can list files in each Weaviate library and delete individual files.

The visible collection selector was removed from the UI. The app uses the default Weaviate class:

```text
uploaded_files
```

Stored properties include:

```text
content
fileName
filePath
mimeType
size
uploadedAt
```

## RAG Context Size

Tune how much Weaviate context is retrieved:

```env
WEAVIATE_CONTEXT_RESULTS=12
WEAVIATE_CONTEXT_CHARS=12000
WEAVIATE_RERANK_CANDIDATE_MULTIPLIER=2
WEAVIATE_SEARCH_MAX_CANDIDATES=24
WEAVIATE_SEARCH_MODE=hybrid
WEAVIATE_SEARCH_SNIPPET_CHARS=1200
```

For more information per answer:

```env
WEAVIATE_CONTEXT_RESULTS=12
WEAVIATE_CONTEXT_CHARS=20000
WEAVIATE_SEARCH_MODE=both
```

Tune how uploaded files are split before indexing:

```env
WEAVIATE_UPLOAD_CHUNK_CHARS=300
WEAVIATE_UPLOAD_CHUNK_OVERLAP_CHARS=50
WEAVIATE_UPLOAD_MIN_CHUNK_CHARS=200
WEAVIATE_UPLOAD_CHUNK_DELAY_MS=20
WEAVIATE_UPLOAD_CHUNK_RETRIES=3
```

Chunk settings apply only to newly uploaded files. Delete and re-upload an existing library if you want it re-indexed with the new chunk size.

Larger values give the model more source material but can slow responses and may reduce focus on smaller models.

RAG answers include source cards under the assistant response. Source links open the copy stored in Weaviate:

```text
/api/weaviate/source/:className/:id
```

They do not open arbitrary local filesystem paths directly, because browsers block that for security.

## Chat Features

- **Stop** closes the active WebSocket stream, marks the partial answer complete, and reconnects for the next message.
- **Temperature**, **Top P**, and **Context chars** tune generation and retrieved-context budget per message.
- **Save chat** stores the current chat in browser `localStorage`.
- **Saved chats** loads a previously saved local chat.
- **Rename chat** renames the selected saved chat.
- **Delete selected chat** removes the selected saved chat.
- **Export MD** downloads the current chat as Markdown.
- **Export JSON** downloads the full chat state, including RAG source metadata.

Saved chats are local to the browser/profile. They are not stored in the backend.

## Dropping Or Cleaning Weaviate

Drop the whole Weaviate database by deleting the Docker volume:

```bash
docker compose down
docker volume ls | grep weaviate
docker volume rm mono_gemma_weaviate_data
./docker-start.sh
```

If your volume name differs, replace `mono_gemma_weaviate_data` with the value from `docker volume ls`.

Delete specific files by object ID:

```bash
curl -X DELETE http://localhost:8080/v1/objects/uploaded_files/YOUR_OBJECT_ID
```

Find objects by `filePath`:

```bash
curl -s http://localhost:8080/v1/graphql \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "{ Get { uploaded_files(where: { path: [\"filePath\"], operator: Like, valueText: \"*cve*\" }) { fileName filePath _additional { id } } } }"
  }'
```

## API

Health:

```bash
curl http://localhost:3000/api/health
```

List models:

```bash
curl http://localhost:3000/api/models
```

One-shot chat:

```bash
curl -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "message": "Summarize the uploaded repo",
    "className": "uploaded_files",
    "model": "gemma4:26b",
    "useWeaviateContext": true
  }'
```

Upload files:

```bash
curl -X POST http://localhost:3000/api/weaviate/upload \
  -H 'Content-Type: application/json' \
  -d '{
    "className": "uploaded_files",
    "files": [
      {
        "name": "notes.txt",
        "path": "notes.txt",
        "type": "text/plain",
        "size": 12,
        "content": "hello world"
      }
    ]
  }'
```

Source lookup:

```bash
curl http://localhost:3000/api/weaviate/source/uploaded_files/YOUR_OBJECT_ID
```

MCP request endpoint:

```bash
curl -X POST http://localhost:3000/mcp/request \
  -H 'Content-Type: application/json' \
  -d '{ "method": "tools/list", "params": {} }'
```

Available MCP tools:

- `query_model`
- `weaviate_create_collection`
- `weaviate_add_document`
- `weaviate_search`
- `weaviate_list_collections`

Available MCP resources:

- `gemma://model`
- `weaviate://collections`

## Project Structure

```text
mono_gemma/
├── backend/
│   ├── src/
│   │   ├── index.js
│   │   └── index.ts
│   ├── .env.example
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   ├── App.jsx
│   │   └── main.jsx
│   ├── package.json
│   └── vite.config.js
├── docker-compose.yml
├── docker-compose.gpu.yml
├── docker-compose.host-ollama.yml
├── docker-start.sh
├── dev.sh
├── setup.sh
├── Dockerfile
└── README.md
```

## Development Commands

Install dependencies:

```bash
npm run install-all
```

Start dev servers:

```bash
npm run dev
```

Build everything:

```bash
npm run build
```

Build backend:

```bash
cd backend && npm run build
```

Build frontend:

```bash
cd frontend && npm run build
```

## Troubleshooting

Check host Ollama:

```bash
ollama list
curl http://localhost:11434/api/tags
```

Check Docker Ollama:

```bash
docker exec -it mcp-ollama ollama list
```

Check Weaviate:

```bash
curl http://localhost:8080/v1/schema
curl http://localhost:3000/api/weaviate/health
```

Check PostgreSQL and pgvector:

```bash
docker exec -it mcp-postgres pg_isready -U mcp -d mcp_gemma
docker exec -it mcp-postgres psql -U mcp -d mcp_gemma -c "SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';"
```

Check GPU:

```bash
nvidia-smi
docker run --rm --gpus all nvidia/cuda:12.0-runtime-ubuntu22.04 nvidia-smi
```

Rebuild/restart Docker:

```bash
docker compose down
./docker-start.sh
```

## Notes

- The selected Ollama model is used for answering questions, not for uploading files.
- Weaviate vectorization is handled by the `t2v-transformers` sidecar.
- PostgreSQL with pgvector is available for app data or custom vector tables, but Weaviate remains the default RAG store.
- If you change the Weaviate embedding model, re-index or re-upload documents for consistent vectors.
- The frontend build may warn about large chunks because `pdfjs-dist` is large. The warning does not block the build.

## License

MIT

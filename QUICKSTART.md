# Quick Start

## 1. Install Dependencies

From the repo root:

```bash
cd /home/end/mcpCodex/mono_gemma
npm run install-all
```

## 2. Choose How Ollama Runs

Use your existing host Ollama models:

```bash
ollama serve
ollama list
MCP_OLLAMA_MODE=host ./docker-start.sh
```

Or use the Docker Ollama container:

```bash
MCP_OLLAMA_MODE=container ./docker-start.sh
```

The default `./docker-start.sh` auto-detects host Ollama when it is running and has models.

## 3. Start The App

Recommended Docker start:

```bash
./docker-start.sh
```

This builds `frontend/dist` before starting Docker, so `http://localhost:3000` serves the latest frontend changes.

Force GPU mode:

```bash
MCP_ACCELERATOR=gpu ./docker-start.sh
```

Force CPU mode:

```bash
MCP_ACCELERATOR=cpu ./docker-start.sh
```

Local dev mode:

```bash
ollama serve
npm run dev
```

## 4. Open The UI

Docker:

- http://localhost:3000

Local dev:

- http://localhost:5173

## 5. Install A Model

Host Ollama:

```bash
ollama pull gemma4:26b
ollama list
```

Docker Ollama:

```bash
docker exec -it mcp-ollama ollama pull gemma4:26b
docker exec -it mcp-ollama ollama list
```

The model selector lists installed models plus configured suggestions. If you select a model that is not installed, the backend falls back to an installed model and the UI shows the fallback.

## 6. Upload Files For RAG

Use **Upload files** for PDFs and selected text/code files.

Use **Upload repo** to upload a full folder or repository.

Repo uploads:

- Preserve relative paths as `filePath`.
- Skip `.git`, `node_modules`, `dist`, `build`, `coverage`, virtualenvs, cache folders, binaries, and large files.
- Skip duplicates already in Weaviate with the same `filePath`.
- Store documents in the default `UploadedFile` collection.

## 7. Ask Questions

Type a message and press Enter or **Send**.

Controls:

- **Stop** interrupts the current streamed response.
- **Use Weaviate context** toggles RAG context.
- **Save chat** saves the current chat in browser storage.
- **Saved chats** loads a saved chat.
- **Export MD** exports a Markdown transcript.
- **Export JSON** exports the full chat state.

RAG answers include source cards. Clicking a source opens the stored Weaviate document text.

## 8. Tune RAG Context

For local dev, edit `backend/.env`.

For Docker, edit the `backend.environment` section in `docker-compose.yml`.

Useful settings:

```env
WEAVIATE_CONTEXT_RESULTS=12
WEAVIATE_CONTEXT_CHARS=30000
```

Then restart:

```bash
docker compose down
./docker-start.sh
```

## 9. Common Checks

Check backend:

```bash
curl http://localhost:3000/api/health
```

Check models:

```bash
curl http://localhost:3000/api/models
```

Check host Ollama:

```bash
curl http://localhost:11434/api/tags
```

Check Weaviate:

```bash
curl http://localhost:8080/v1/schema
```

## 10. Reset Weaviate

Drop all uploaded documents/vectors:

```bash
docker compose down
docker volume ls | grep weaviate
docker volume rm mono_gemma_weaviate_data
./docker-start.sh
```

If the volume name differs, use the name printed by `docker volume ls`.

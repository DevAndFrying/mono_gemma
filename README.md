# Comprehensive README for MCP Gemma Monolith

# 🤖 MCP Gemma Monolith

A fully contained Model Context Protocol (MCP) monolith featuring Ollama integration and a modern React frontend to interact with the latest Gemma 2 model. Optimized for RTX 5080 GPU (16GB VRAM).

## Features

- **🚀 Full-Stack Application**
  - Express.js backend with WebSocket support
  - React 18 frontend with Vite
  - Real-time streaming responses
  
- **🤖 AI Model**
  - Gemma 4 e4B (optimized for RTX 5080)
  - Ollama integration for easy model management
  - Configurable temperature and parameters
  
- **�️ Vector Database**
  - Weaviate vector database integration
  - Semantic search capabilities
  - Document storage and retrieval
  - Text2Vec Transformers for embeddings
  
- **�💬 MCP Protocol**
  - Complete MCP implementation
  - RESTful API endpoints
  - WebSocket for real-time chat
  - Tool calling interface
  
- **🐳 Docker Support**
  - Full Docker setup with docker-compose
  - GPU support (NVIDIA CUDA)
  - Multi-stage builds for efficiency

## System Requirements

- **GPU**: RTX 5080 (16GB VRAM) or equivalent
- **CPU**: 6+ cores recommended
- **RAM**: 16GB+ system memory
- **Storage**: 20GB+ for model and dependencies
- **OS**: Linux (recommended), macOS, or Windows with WSL2
- **Docker**: Optional but recommended

## Quick Start

### Prerequisites

1. **Install Ollama**
   ```bash
   # Download from https://ollama.ai
   # Or install via package manager:
   
   # macOS
   brew install ollama
   
   # Linux
   curl https://ollama.ai/install.sh | sh
   ```

2. **Install Node.js**
   ```bash
   # NVM is recommended
   nvm install 20
   nvm use 20
   ```

3. **Install Docker (Optional)**
   ```bash
   # Follow instructions at https://docs.docker.com/get-docker/
   ```

### Local Setup (Without Docker)

1. **Clone and setup**
   ```bash
   cd /home/end/mcpCodex
   npm run install-all
   ```

2. **Start Ollama service**
   ```bash
   ollama serve
   ```

3. **In a new terminal, pull Gemma 4 model**
   ```bash
   ollama pull gemma4:e4b
   ```
   
   Note: This will take 10-30 minutes depending on your connection.

4. **In another terminal, start the application**
   ```bash
   npm run dev
   ```

5. **Access the UI**
   - Backend: http://localhost:3000
   - Frontend: http://localhost:5173
   - WebSocket: ws://localhost:3000

### Docker Setup (Recommended)

1. **Ensure NVIDIA Docker is installed**
   ```bash
   docker run --rm --gpus all nvidia/cuda:12.0-runtime-ubuntu22.04 nvidia-smi
   ```

2. **Build and run with Docker Compose**
   ```bash
   docker-compose up --build
   ```
   
   First run will:
   - Build the Docker image
   - Start Ollama service
   - Pull Gemma 2 model (10-30 minutes)
   - Start backend and frontend
   
3. **Access the application**
   - Frontend: http://localhost:3000
   - Backend API: http://localhost:3000/api
   - WebSocket: ws://localhost:3000

## Configuration

### Environment Variables

Create `.env` in the `backend/` directory:

```env
# Backend Configuration
OLLAMA_BASE_URL=http://localhost:11434
MODEL_NAME=gemma4:e4b
API_PORT=3000
MCP_PORT=3001
WEAVIATE_URL=http://localhost:8080
NODE_ENV=development

# For Docker Compose, use:
# OLLAMA_BASE_URL=http://ollama:11434
# WEAVIATE_URL=http://weaviate:8080
```

### Model Selection

For RTX 5080 (16GB VRAM):

| Model | Size | VRAM | Speed | Quality |
|-------|------|------|-------|---------|
| **gemma4:e4b** | ~6GB | 10-13GB | ⚡⚡⚡ | ⭐⭐⭐⭐⭐ |
| gemma3:12b | 8.1GB | 10-13GB | ⚡⚡⚡ | ⭐⭐⭐⭐ |
| gemma3:4b | 3.3GB | 6-8GB | ⚡⚡⚡⚡ | ⭐⭐⭐ |

To use a different model:
```bash
# Pull the model
ollama pull gemma3:12b

# Update .env
MODEL_NAME=gemma3:12b
```

## Project Structure

```
mcp-codex/
├── backend/
│   ├── src/
│   │   └── index.js          # Main backend server
│   ├── package.json
│   ├── tsconfig.json
│   └── .env.example
├── frontend/
│   ├── src/
│   │   ├── components/       # React components
│   │   ├── App.jsx
│   │   ├── main.jsx
│   │   └── index.css
│   ├── index.html
│   ├── vite.config.js
│   └── package.json
├── package.json              # Monorepo root
├── Dockerfile
├── docker-compose.yml
└── README.md
```

## API Documentation

### WebSocket Events

**Client → Server**
```json
{
  "type": "message",
  "payload": { "text": "What is AI?" }
}
```

**Server → Client**
```json
{
  "type": "stream",
  "payload": { "text": "chunk of response" }
}
```

```json
{
  "type": "complete",
  "payload": { "text": "full response" }
}
```

### REST Endpoints

#### Health Check
```bash
GET /api/health
# Response: { "status": "ok", "model": "gemma4:e4b" }
```

#### Chat (One-shot)
```bash
POST /api/chat
Content-Type: application/json

{ "message": "What is the capital of France?" }
```

#### List Models
```bash
GET /api/models
```

#### Pull Model
```bash
POST /api/pull-model
Content-Type: application/json

{ "model": "gemma3:4b" }
```

#### MCP Protocol
```bash
POST /mcp/request
Content-Type: application/json

{ "method": "resources/list", "params": {} }
```

**Available Tools:**

- `query_model`: Query the Gemma model
  ```json
  {
    "method": "tools/call",
    "params": {
      "name": "query_model",
      "arguments": {
        "prompt": "What is AI?",
        "temperature": 0.7
      }
    }
  }
  ```

- `weaviate_create_collection`: Create a new Weaviate collection
  ```json
  {
    "method": "tools/call",
    "params": {
      "name": "weaviate_create_collection",
      "arguments": {
        "className": "Documents",
        "description": "General document collection",
        "vectorizer": "text2vec-transformers"
      }
    }
  }
  ```

- `weaviate_add_document`: Add a document to a collection
  ```json
  {
    "method": "tools/call",
    "params": {
      "name": "weaviate_add_document",
      "arguments": {
        "className": "Documents",
        "content": "This is a sample document about AI.",
        "properties": { "title": "AI Document", "author": "System" }
      }
    }
  }
  ```

- `weaviate_search`: Search documents semantically
  ```json
  {
    "method": "tools/call",
    "params": {
      "name": "weaviate_search",
      "arguments": {
        "className": "Documents",
        "query": "artificial intelligence",
        "limit": 5
      }
    }
  }
  ```

- `weaviate_list_collections`: List all collections
  ```json
  {
    "method": "tools/call",
    "params": {
      "name": "weaviate_list_collections",
      "arguments": {}
    }
  }
  ```

**Available Resources:**

- `gemma://model`: Gemma model interface
- `weaviate://collections`: List of Weaviate collections

## Development

### Backend Development

```bash
# Watch mode
cd backend && npm run dev

# Build TypeScript
npm run build

# Run built version
npm start
```

### Frontend Development

```bash
# Vite dev server with hot reload
cd frontend && npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

### Full Stack Development

```bash
# Start everything at once
npm run dev

# Runs:
# - Backend: npm run dev:backend (http://localhost:3000)
# - Frontend: npm run dev:frontend (http://localhost:5173)
```

## Troubleshooting

### Ollama Connection Issues
```bash
# Check if Ollama is running
ollama list

# Verify endpoint
curl http://localhost:11434/api/tags

# Restart Ollama
killall ollama
ollama serve
```

### Model Memory Issues
```bash
# For RTX 5080, if you get OOM:
# 1. Use smaller model: gemma3:4b
# 2. Reduce batch size in backend
# 3. Limit context length

# Check GPU memory
nvidia-smi
```

### Frontend Not Connecting
```bash
# Clear browser cache
# Check console for WebSocket errors
# Verify backend is running on port 3000
# Check browser console: DevTools → Console

# In browser console:
curl('http://localhost:3000/api/health')
```

### Docker Issues
```bash
# Rebuild containers
docker-compose down
docker-compose up --build

# View logs
docker-compose logs -f

# GPU not detected
docker run --rm --gpus all nvidia/cuda:12.0-runtime nvidia-smi
```

## Performance Optimization

### For RTX 5080

1. **GPU Memory**
   - Gemma 2 9B runs efficiently at 10-12GB
   - Enable GPU memory optimization in production

2. **Streaming**
   - WebSocket streaming is enabled for real-time responses
   - Reduces perceived latency

3. **Model Quantization**
   - Models are already quantized for efficiency
   - Consider GGUF format for faster loading

### Production Deployment

```bash
# Build optimized containers
npm run build

# Run with production settings
docker-compose -f docker-compose.yml up -d

# Monitor resources
watch -n 1 'docker stats'
```

## Common Commands

```bash
# Install all dependencies
npm run install-all

# Start development
npm run dev

# Build for production
npm run build

# Docker operations
npm run docker:build
npm run docker:run

# Pull different model
ollama pull gemma3:4b
```

## Architecture

### Backend
- **Express.js** with WebSocket support
- **Ollama** for model hosting
- **MCP Protocol** implementation
- Real-time streaming via WebSockets
- REST API for compatibility

### Frontend
- **React 18** with hooks
- **Vite** for fast development
- **CSS-in-JS** styling
- Real-time WebSocket communication
- Responsive design

## Known Limitations

- Gemma 2 27B may cause occasional OOM on RTX 5080
- Context length limited to prevent memory issues
- Single-user session (no persistence)
- No authentication implemented

## Future Enhancements

- [ ] Add chat history persistence
- [ ] Implement user authentication
- [ ] Add more model options
- [ ] Support for custom prompts/templates
- [ ] Model fine-tuning interface
- [ ] Multi-user support
- [ ] Deployment guides (AWS, GCP, Azure)

## Support & Resources

- [Ollama Documentation](https://github.com/ollama/ollama)
- [Gemma Model Card](https://huggingface.co/google/gemma-1.1-2b)
- [MCP Specification](https://modelcontextprotocol.io)
- [React Documentation](https://react.dev)
- [Vite Documentation](https://vitejs.dev)

## License

MIT

## Contributing

Contributions welcome! Please feel free to submit issues and PRs.

---

**Built with ❤️ for AI enthusiasts using RTX 5080**

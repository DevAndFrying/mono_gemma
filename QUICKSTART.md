# 🚀 Quick Start Guide

## 1. Initial Setup (First Time Only)

### Option A: Local Setup (Recommended for Development)

```bash
# Navigate to project directory
cd /home/end/mcpCodex

# Run setup script (installs Ollama, pulls Gemma 2 model, installs dependencies)
./setup.sh

# This will:
# ✓ Check for Ollama installation
# ✓ Start Ollama service
# ✓ Pull Gemma 2 9B model (~5.5GB, takes 10-30 min first time)
# ✓ Install all npm dependencies
```

### Option B: Docker Setup (All-in-one)

```bash
cd /home/end/mcpCodex

# Start with Docker (requires Docker and NVIDIA Docker)
./docker-start.sh

# This will:
# ✓ Build Docker image
# ✓ Start Ollama container
# ✓ Pull Gemma 4 model
# ✓ Start backend and frontend
# ✓ Takes 15-40 minutes on first run
```

---

## 2. Start Development

### Local Development
```bash
cd /home/end/mcpCodex

# Start everything with live reload
./dev.sh

# Opens:
# Frontend: http://localhost:5173
# Backend:  http://localhost:3000
# WebSocket: ws://localhost:3000
```

### Docker Development
```bash
cd /home/end/mcpCodex

# In separate terminals:
# Terminal 1: Backend
cd backend && npm run dev

# Terminal 2: Frontend
cd frontend && npm run dev
```

### Manual Setup (Advanced)

**Terminal 1 - Ollama:**
```bash
ollama serve
```

**Terminal 2 - Backend:**
```bash
cd backend
npm install
npm run dev
```

**Terminal 3 - Frontend:**
```bash
cd frontend
npm install
npm run dev
```

---

## 3. Verify Installation

### Check Backend
```bash
curl http://localhost:3000/api/health
# Expected response: {"status":"ok","model":"gemma4:e4b"}
```

### Check Models in Ollama
```bash
ollama list
# Should show: gemma4:e4b
```

### Open in Browser
- **Frontend**: http://localhost:5173
- **Backend API**: http://localhost:3000/api

---

## 4. First Conversation

1. Open http://localhost:5173 in browser
2. Type a message: "What is the capital of France?"
3. Hit Enter or click Send button
4. Watch the response stream in real-time

---

## 5. Common Issues & Solutions

### Issue: "Connection refused" at localhost:3000
**Solution:**
```bash
# Make sure backend is running
ps aux | grep "node"

# If not running, start it:
cd backend && npm run dev
```

### Issue: "Ollama not found"
**Solution:**
```bash
# Install Ollama from https://ollama.ai
# Or use Homebrew:
brew install ollama

# Or Linux:
curl https://ollama.ai/install.sh | sh
```

### Issue: Model taking too long to load
**Solution:**
- Gemma 4 e4B: Normal first load is 10-30 minutes
- Subsequent loads: 2-5 seconds
- Responses: 10-30 seconds depending on prompt length

### Issue: Out of Memory (OOM) errors
**Solution:**
```bash
# For RTX 5080, use gemma4:e4b (recommended)
# If you have issues, switch to lighter model:

# In backend/.env:
MODEL_NAME=gemma3:4b

# Restart backend
```

### Issue: Frontend shows "Backend not connected"
**Solution:**
```bash
# Check backend is running on port 3000
lsof -i :3000

# Check WebSocket connection in browser DevTools
# Open DevTools → Console, check for errors
```

---

## 6. Configuration

### Environment Variables

Edit `backend/.env`:

```env
# Ollama connection
OLLAMA_BASE_URL=http://localhost:11434
MODEL_NAME=gemma4:e4b

# Server ports
API_PORT=3000
MCP_PORT=3001

# Environment
NODE_ENV=development
```

### Model Selection

For RTX 5080:
- **✅ Recommended**: `gemma4:e4b` - Best balance of performance and quality
- **Lighter**: `gemma3:4b` (3.3GB, 6-8GB VRAM) - Faster, lower quality
- **Alternative**: `llama2:7b` (3.8GB, 10GB VRAM - lighter)

Change model:
```bash
# Pull new model
ollama pull gemma3:4b

# Update backend/.env
MODEL_NAME=gemma3:4b

# Restart backend
```

---

## 7. Project Structure

```
mcpCodex/
├── backend/                 # Node.js MCP server
│   ├── src/
│   │   └── index.js        # Main server with WebSocket
│   ├── .env                # Configuration
│   └── package.json
├── frontend/               # React + Vite app
│   ├── src/
│   │   ├── App.jsx        # Main React component
│   │   ├── components/    # Chat, Header, Message, Input
│   │   └── index.css      # Theme styles
│   └── vite.config.js
├── setup.sh               # Setup script
├── dev.sh                 # Development launcher
├── docker-compose.yml     # Docker orchestration
├── Dockerfile            # Container image
└── README.md             # Full documentation
```

---

## 8. Advanced Usage

### Manual API Calls

**Chat via REST:**
```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"What is AI?"}'
```

**WebSocket Chat (via wscat):**
```bash
# Install wscat: npm install -g wscat
wscat -c ws://localhost:3000

# Send message:
> {"type":"message","payload":{"text":"Hello"}}
```

### View Server Logs
```bash
# Backend logs
cd backend && npm run dev

# Frontend dev server output
cd frontend && npm run dev

# Docker logs
docker-compose logs -f
```

### Production Build
```bash
# Build both backend and frontend
npm run build

# Start production server
cd backend && npm start
```

---

## 9. Troubleshooting Commands

```bash
# Check Ollama service
ollama list
ollama pull gemma4:9b

# Check ports
lsof -i :3000
lsof -i :3001
lsof -i :5173
lsof -i :11434

# Kill processes if needed
killall node
killall ollama

# View system resources
nvidia-smi          # GPU usage
top                 # System resources
```

---

## 10. Next Steps

- ✅ Application is ready to use
- 📚 Read full [README.md](README.md) for advanced usage
- 🔧 Check configuration in `backend/.env`
- 🚀 Deploy with Docker for production
- 💡 Customize the frontend in `frontend/src/`

---

**Need Help?**
- Check logs in terminal windows
- Ensure all services are running (Ollama, Backend, Frontend)
- Verify model is loaded: `ollama list`
- Test API: `curl http://localhost:3000/api/health`

**Happy Chatting! 🤖**

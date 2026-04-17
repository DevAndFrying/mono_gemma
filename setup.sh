#!/bin/bash

# MCP Gemma Monolith Startup Script

set -e

echo "🤖 MCP Gemma Monolith - Startup"
echo "================================"

# Check prerequisites
echo ""
echo "✓ Checking prerequisites..."

# Check Ollama
if ! command -v ollama &> /dev/null; then
    echo "❌ Ollama not found. Please install from https://ollama.ai"
    exit 1
fi
echo "✓ Ollama found"

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Please install from https://nodejs.org"
    exit 1
fi
echo "✓ Node.js $(node -v) found"

# Start Ollama if not running
echo ""
echo "🚀 Starting Ollama..."
if pgrep -x "ollama" > /dev/null; then
    echo "✓ Ollama already running"
else
    ollama serve &
    OLLAMA_PID=$!
    sleep 2
    echo "✓ Ollama started (PID: $OLLAMA_PID)"
fi

# Wait for Ollama to be ready
echo ""
echo "⏳ Waiting for Ollama to be ready..."
max_attempts=30
attempt=0
while [ $attempt -lt $max_attempts ]; do
    if curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
        echo "✓ Ollama is ready!"
        break
    fi
    attempt=$((attempt+1))
    sleep 1
done

# Check if model exists
echo ""
echo "🤖 Checking for Gemma 3 4B model..."
if curl -s http://localhost:11434/api/tags | grep -q "gemma3:4b"; then
    echo "✓ Gemma 3 4B model found"
else
    echo "⬇️  Pulling Gemma 3 4B model (this may take several minutes)..."
    ollama pull gemma3:4b
fi

# Create .env file if doesn't exist
echo ""
echo "📝 Configuring backend..."
if [ ! -f "backend/.env" ]; then
    cp backend/.env.example backend/.env
    echo "✓ Created backend/.env"
else
    echo "✓ backend/.env already exists"
fi

# Install dependencies if needed
echo ""
echo "📦 Installing dependencies..."
if [ ! -d "node_modules" ] || [ ! -d "backend/node_modules" ] || [ ! -d "frontend/node_modules" ]; then
    npm run install-all
else
    echo "✓ Dependencies already installed"
fi

# All set!
echo ""
echo "✅ Setup complete!"
echo ""
echo "🎯 To start the application, run:"
echo "   npm run dev"
echo ""
echo "📍 Access the application:"
echo "   Frontend: http://localhost:5173"
echo "   Backend:  http://localhost:3000"
echo "   WebSocket: ws://localhost:3000"
echo ""

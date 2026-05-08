#!/bin/bash

# MCP Gemma Monolith - Docker Startup

set -e

echo "🐳 MCP Gemma Monolith - Docker Mode"
echo "==================================="
echo ""

# Check Docker
if ! command -v docker &> /dev/null; then
    echo "❌ Docker not found. Please install from https://docs.docker.com/get-docker/"
    exit 1
fi
echo "✓ Docker found: $(docker --version)"

# Check Docker Compose
if docker compose version > /dev/null 2>&1; then
    COMPOSE_CMD=(docker compose)
    echo "✓ Docker Compose found: $(docker compose version --short)"
elif command -v docker-compose &> /dev/null; then
    COMPOSE_CMD=(docker-compose)
    echo "✓ Docker Compose found: $(docker-compose --version)"
else
    echo "❌ Docker Compose not found. Please install from https://docs.docker.com/compose/install/"
    exit 1
fi

COMPOSE_FILES=(-f docker-compose.yml)
ACCELERATOR="${MCP_ACCELERATOR:-auto}"
OLLAMA_MODE="${MCP_OLLAMA_MODE:-auto}"

detect_nvidia_gpu_runtime() {
    if ! command -v nvidia-smi > /dev/null 2>&1; then
        return 1
    fi

    if ! nvidia-smi --query-gpu=name --format=csv,noheader | grep -q .; then
        return 1
    fi

    if ! docker info --format '{{json .Runtimes}}' 2> /dev/null | grep -qi "nvidia"; then
        return 1
    fi

    return 0
}

validate_docker_gpu() {
    docker run --rm --gpus all nvidia/cuda:12.0.0-runtime-ubuntu22.04 nvidia-smi > /dev/null
}

if [ "$ACCELERATOR" = "gpu" ]; then
    echo "✓ MCP_ACCELERATOR=gpu set. Enabling GPU for Ollama and Weaviate transformer embeddings."
    if ! command -v nvidia-smi > /dev/null 2>&1; then
        echo "❌ nvidia-smi not found on host. Install/repair the NVIDIA driver before using GPU mode."
        exit 1
    fi
    if ! validate_docker_gpu; then
        echo "❌ Docker cannot access the NVIDIA GPU. Run ./scripts/bootstrap-g6e-ubuntu.sh, then restart Docker and retry."
        exit 1
    fi
    COMPOSE_FILES+=(-f docker-compose.gpu.yml)
elif [ "$ACCELERATOR" = "cpu" ]; then
    echo "✓ MCP_ACCELERATOR=cpu set. Using CPU for Ollama and Weaviate embeddings."
elif detect_nvidia_gpu_runtime; then
    GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -n 1)
    if validate_docker_gpu; then
        echo "✓ NVIDIA GPU detected: $GPU_NAME"
        echo "✓ Enabling GPU for Ollama and Weaviate transformer embeddings"
        COMPOSE_FILES+=(-f docker-compose.gpu.yml)
    else
        echo "⚠️  NVIDIA GPU was detected, but Docker could not access it. Using CPU for Ollama and Weaviate embeddings."
    fi
else
    echo "⚠️  NVIDIA GPU with Docker NVIDIA runtime not detected. Using CPU for Ollama and Weaviate embeddings."
fi

host_ollama_has_models() {
    if ! command -v curl > /dev/null 2>&1; then
        return 1
    fi

    curl -fsS http://localhost:11434/api/tags 2> /dev/null | grep -q '"name":'
}

if [ "$OLLAMA_MODE" = "host" ]; then
    echo "✓ MCP_OLLAMA_MODE=host set. Backend will use Ollama on this host."
    COMPOSE_FILES+=(-f docker-compose.host-ollama.yml)
elif [ "$OLLAMA_MODE" = "container" ]; then
    echo "✓ MCP_OLLAMA_MODE=container set. Backend will use the Docker Ollama service."
elif host_ollama_has_models; then
    echo "✓ Host Ollama is running with local models. Backend will use your existing host models."
    COMPOSE_FILES+=(-f docker-compose.host-ollama.yml)
else
    echo "ℹ️  Host Ollama with local models not detected. Backend will use the Docker Ollama service."
fi

echo ""
echo "Building frontend assets for http://localhost:3000..."
if ! command -v npm > /dev/null 2>&1; then
    echo "npm not found. Install Node.js/npm or run Docker without the frontend bind mount."
    exit 1
fi

npm run build:frontend

echo ""
echo "🚀 Starting Docker containers..."
echo ""

# Build and run
"${COMPOSE_CMD[@]}" "${COMPOSE_FILES[@]}" up --build

echo ""
echo "✅ Application started!"
echo ""
echo "📍 Access the application:"
echo "   Frontend: http://localhost:3000"
echo "   Backend API: http://localhost:3000/api"
echo "   Weaviate: http://localhost:8080"
echo "   PostgreSQL: localhost:5432"
echo ""
echo "Press Ctrl+C to stop"

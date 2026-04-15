#!/bin/bash

# MCP Gemma Monolith Development Startup

set -e

echo "🤖 MCP Gemma Monolith - Development Mode"
echo "========================================"
echo ""

# Check if backend directory exists
if [ ! -d "backend" ] || [ ! -d "frontend" ]; then
    echo "❌ Project structure not found. Run setup.sh first."
    exit 1
fi

# Create .env if doesn't exist
if [ ! -f "backend/.env" ]; then
    echo "📝 Creating backend/.env..."
    cp backend/.env.example backend/.env
fi

echo "🚀 Starting development servers..."
echo ""
echo "Backend URL:  http://localhost:3000"
echo "Frontend URL: http://localhost:5173"
echo ""
echo "Press Ctrl+C to stop all servers"
echo ""

# Use concurrently to run both servers
exec npm run dev
